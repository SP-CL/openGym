// openGym on Cloudflare Workers: the same app and the same API as the Docker stack, on one origin.
//
//   static app   Workers Static Assets serve frontend/dist (wrangler.jsonc `assets`), with the
//                security and cache headers nginx would add coming from cloudflare/_headers.
//   /api/*       forwarded to one Durable Object, which runs api/server.js itself through the
//                runtime's node:http bridge. One object, because the API is written for one
//                process: the in-memory db, the passkey challenges, the rate limits and the
//                compare-and-write on PUT /api/data all assume a single writer.
//   ./data       the object's own storage, through cloudflare/fs-shim.js (aliased as node:fs).
//
// server.js runs unmodified. Everything it does at import time (create the secret, load db.json,
// start its timers, listen) is only allowed inside a request in a Worker, so it is imported
// lazily on the object's first request rather than at module scope.

import http from 'node:http';
import { DurableObject } from 'cloudflare:workers';
import { handleAsNodeRequest } from 'cloudflare:node';
import { bindStorage, readFileSync } from './fs-shim.js';

const PORT = 3000;          // a routing key for handleAsNodeRequest, not a network port
const TICK_MS = 60_000;     // keep-warm alarm, see alarm() below
// server.js answers 413 above 5 MiB and reads on to twice that before it cuts the client off;
// anything bigger is refused here without being held in memory.
const MAX_FORWARD = 10 * 1024 * 1024;

const json = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

/* ---------- the API's process, once per isolate ---------- */

let booted = null;          // Promise of api/server.js having run its top level
let bootOrigin = null;      // the ORIGIN it was started with
let owner = null;           // the object instance whose lifetime the server's timers belong to
const intervals = [];       // setInterval calls server.js made while loading: [fn, ms, args]

class ConfigError extends Error {}

// The object's settings become the process environment server.js reads at import. Every string
// var set in wrangler.jsonc or the dashboard is passed through; the rest are fixed by this build.
function applyEnv(env, origin) {
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') process.env[k] = v;
  process.env.ORIGIN = origin;
  process.env.RP_ID = env.RP_ID || new URL(origin).hostname;
  process.env.DATA_DIR = '/data';
  process.env.PORT = String(PORT);
  process.env.COACH_DISABLED = '1';   // spawns provider runtimes; see docs/SELF_HOSTING_CLOUDFLARE.md
  process.env.MEDIA_UPLOADS = '0';    // streams files to disk; the app then offers links only
  // Cloudflare sets CF-Connecting-IP itself and drops any a client sent. Without this the
  // sign-in throttle falls back to the socket address, which the runtime no longer has once a
  // body has been read, and every client would share one bucket.
  process.env.TRUST_PROXY = '1';
}

// A failure while server.js evaluates cannot be retried: the bundler runs a module's top level
// once per isolate and replays its error after that. So what can be wrong is checked first,
// while it can still be answered with a clear message and tried again on the next request.
function preflight(env, origin) {
  let url;
  try { url = new URL(origin); } catch { throw new ConfigError(`ORIGIN is not a URL: ${origin}`); }
  if (url.origin !== origin) throw new ConfigError(`ORIGIN must be scheme and host only, e.g. https://gym.example.com (got ${origin})`);
  if (env.VAPID_SUBJECT) {
    let s = null;
    try { s = new URL(env.VAPID_SUBJECT); } catch { /* reported below */ }
    if (!s || !['https:', 'mailto:'].includes(s.protocol)) throw new ConfigError(`VAPID_SUBJECT must be an https: URL or a mailto: address (got ${env.VAPID_SUBJECT})`);
  }
}

// Behind Cloudflare a browser reaches the app over HTTPS. A plain-http first request (a script,
// a scanner) must not decide that passkeys belong to an http origin nobody can sign in at.
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
function originOf(requestUrl) {
  const u = new URL(requestUrl);
  return u.protocol === 'http:' && !LOOPBACK.has(u.hostname) ? `https://${u.host}` : u.origin;
}

async function loadServer() {
  // Timers belong to the object instance that set them and die with it. The object can be
  // recreated in an isolate where server.js has already run (it is only imported once), so the
  // intervals it starts at import — the day-reminder tick and the housekeeping sweeps — are
  // recorded here and started again for the new instance (rearm below).
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn, ms, ...args) => {
    intervals.push([fn, ms, args]);
    return realSetInterval(fn, ms, ...args);
  };
  // Node marks a request complete once its body is parsed, empty or not; here that only happens
  // when the body is read. server.js arms a 5-minute body deadline per request and clears it on
  // 'end', so a GET would leave its timer behind. Reading the (empty) body gives it its 'end'.
  if (!http.Server.prototype.emit.openGym) {
    const emit = http.Server.prototype.emit;
    http.Server.prototype.emit = Object.assign(function (event, req, ...rest) {
      if (event === 'request' && (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS')) req.resume();
      return emit.call(this, event, req, ...rest);
    }, { openGym: true });
  }
  try {
    await import('../api/server.js');
  } finally {
    globalThis.setInterval = realSetInterval;
  }
}

function rearm() {
  for (const [fn, ms, args] of intervals) setInterval(fn, ms, ...args);
}

/* ---------- the Durable Object ---------- */

export class OpenGymApi extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    bindStorage(ctx.storage.kv);
    this.alarmAt = 0;
  }

  // Passkeys are bound to one origin, and server.js reads it once, at import. ORIGIN set in the
  // Worker's settings wins (and is remembered). Otherwise the address the app is opened at is
  // used, and kept for good once the app itself has called the API from it — so the
  // *.workers.dev address works with no configuration. An alarm that fires before anyone ever
  // opened the app finds no origin and does nothing.
  async ready(request) {
    if (!booted) {
      const kv = this.ctx.storage.kv;
      const pinned = kv.get('cf:origin');
      let origin = pinned;
      if (this.env.ORIGIN) {
        origin = this.env.ORIGIN.replace(/\/+$/, '');
      } else if (!origin) {
        if (!request) return false;
        origin = originOf(request.url);
      }
      preflight(this.env, origin);
      if (this.env.ORIGIN && pinned !== origin) kv.put('cf:origin', origin);
      // Touch what server.js reads first, so a storage hiccup fails here, retryably.
      for (const f of ['secret', 'db.json', 'vapid.json']) kv.get(`fs:f:/data/${f}`);
      applyEnv(this.env, origin);
      bootOrigin = origin;
      owner = this;
      booted = loadServer();
      booted.catch(() => {});
    }
    await booted;
    if (owner !== this) { owner = this; rearm(); }
    if (request && request.headers.get('sec-fetch-site') === 'same-origin' && !this.env.ORIGIN && originOf(request.url) === bootOrigin) {
      const kv = this.ctx.storage.kv;
      if (kv.get('cf:origin') !== bootOrigin) {
        kv.put('cf:origin', bootOrigin);
        console.log(`openGym: passkeys are now bound to ${bootOrigin} (set ORIGIN to change it)`);
      }
    }
    return true;
  }

  async fetch(request) {
    try {
      await this.ready(request);
    } catch (e) {
      if (e instanceof ConfigError) {
        console.error('openGym: bad setting:', e.message);
        return json(503, { error: e.message });
      }
      console.error('openGym: the API failed to start:', e);
      return json(503, { error: 'the server failed to start; see the Worker logs' });
    }
    await this.keepWarm();
    try {
      return await handleAsNodeRequest(PORT, request, this.env, this.ctx);
    } catch (e) {
      // server.js was evaluated but never reached listen() (it was cut off mid-start). Only a new
      // isolate can run it again: redeploying, or saving any variable, starts one.
      console.error('openGym: the API is not running:', e);
      return json(503, { error: 'the server is not running; redeploy the Worker' });
    }
  }

  async keepWarm() {
    if (this.env.KEEP_WARM === '0' || this.alarmAt > Date.now()) return;
    this.alarmAt = Date.now() + TICK_MS;
    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(this.alarmAt);
  }

  // An object with nothing to do is evicted a minute or two after its last event, and its timers
  // go with it — including the one that sends day reminders. While any device has notifications
  // on, the alarm wakes it every minute, so reminders and rest-timer notifications go out while
  // nobody has the app open; with none, the object is left to sleep until the next request.
  // It also brings the API back up after a deploy without waiting for a visitor.
  async alarm() {
    try {
      if (!(await this.ready(null))) return;
      if (this.env.KEEP_WARM === '0' || !hasPushSubscriptions()) return;
      this.alarmAt = Date.now() + TICK_MS;
      await this.ctx.storage.setAlarm(this.alarmAt);
    } catch (e) {
      console.error('openGym: keep-warm alarm failed:', e);
    }
  }
}

function hasPushSubscriptions() {
  try { return (JSON.parse(readFileSync('/data/db.json', 'utf8')).subs || []).length > 0; }
  catch { return false; }
}

/* ---------- the Worker ---------- */

const SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "frame-ancestors 'none'",
};
function withSecurityHeaders(res) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!out.headers.has(k)) out.headers.set(k, v);
  return out;
}

// The body is read here, whole, before the object sees the request. Streamed through instead,
// a body the API answers without reading (a 401 or 403 before readBody, sign-out's '{}') is
// still being pumped after the response has gone, which the runtime treats as an error — and
// for a large body that turned the real status into a 500.
async function readCapped(request) {
  if (!request.body) return null;
  if (Number(request.headers.get('content-length')) > MAX_FORWARD) return undefined;
  const reader = request.body.getReader(), parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_FORWARD) { reader.cancel().catch(() => {}); return undefined; }
    parts.push(value);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { body.set(p, at); at += p.byteLength; }
  return body;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      const body = await readCapped(request);
      if (body === undefined) return withSecurityHeaders(json(413, { error: 'body too large' }));
      try {
        const api = env.API.get(env.API.idFromName('main'));
        return withSecurityHeaders(await api.fetch(new Request(request, { body })));
      } catch (e) {
        console.error('openGym: request to the API object failed:', e);
        return withSecurityHeaders(json(502, { error: 'server unavailable, try again' }));
      }
    }
    // Only paths that are not a file in frontend/dist get this far. The app is hash-routed with
    // relative asset URLs, so a deep path must not be answered with index.html (its assets would
    // resolve against the wrong directory): like web/nginx.conf.template, the root serves the
    // app and anything else is sent back to it, query string kept.
    if (url.pathname === '/') {
      return withSecurityHeaders(await env.ASSETS.fetch(new Request(new URL('/index.html', url), request)));
    }
    return withSecurityHeaders(new Response(null, { status: 302, headers: { Location: '/' + url.search } }));
  },
};
