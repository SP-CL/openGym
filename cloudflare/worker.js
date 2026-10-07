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

import { DurableObject } from 'cloudflare:workers';
import { handleAsNodeRequest } from 'cloudflare:node';
import { bindStorage } from './fs-shim.js';

const PORT = 3000;          // a routing key for handleAsNodeRequest, not a network port
const TICK_MS = 60_000;     // keep-warm alarm, see alarm() below

/* ---------- the API's process, once per isolate ---------- */

let booted = null;          // Promise of api/server.js having run its top level
let owner = null;           // the object instance whose lifetime the server's timers belong to
const intervals = [];       // setInterval calls server.js made while loading: [fn, ms, args]

// The object's settings become the process environment server.js reads at import. Every string
// var set in wrangler.jsonc or the dashboard is passed through; four are fixed by this build.
function applyEnv(env, origin) {
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') process.env[k] = v;
  process.env.ORIGIN = origin;
  process.env.RP_ID = env.RP_ID || new URL(origin).hostname;
  process.env.DATA_DIR = '/data';
  process.env.PORT = String(PORT);
  process.env.COACH_DISABLED = '1';   // spawns provider runtimes; see docs/SELF_HOSTING_CLOUDFLARE.md
  process.env.MEDIA_UPLOADS = '0';    // streams files to disk; the app then offers links only
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
  }

  // Passkeys are bound to one origin, and server.js reads it once, at import. ORIGIN set in the
  // Worker's settings wins; otherwise the address the app was first opened at is used and kept,
  // so the *.workers.dev address works with no configuration at all. A request is needed to learn
  // it, so an alarm that fires before anyone ever opened the app does nothing.
  async ready(requestOrigin) {
    if (!booted) {
      const kv = this.ctx.storage.kv;
      let origin = this.env.ORIGIN ? new URL(this.env.ORIGIN).origin : kv.get('cf:origin');
      if (!origin) {
        if (!requestOrigin) return false;
        origin = requestOrigin;
        kv.put('cf:origin', origin);
      }
      applyEnv(this.env, origin);
      owner = this;
      booted = loadServer();
      booted.catch(() => { booted = null; owner = null; });
    }
    await booted;
    if (owner !== this) { owner = this; rearm(); }
    return true;
  }

  async fetch(request) {
    await this.ready(new URL(request.url).origin);
    if (!this.alarmChecked && this.env.KEEP_WARM !== '0') {
      this.alarmChecked = true;
      if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
    }
    return handleAsNodeRequest(PORT, request, this.env, this.ctx);
  }

  // An object with nothing to do is evicted a minute or two after its last event, and its timers
  // go with it — including the one that sends day reminders. The alarm wakes it every minute, so
  // reminders and rest-timer notifications are sent while nobody has the app open, and it brings
  // the API back up after a deploy without waiting for a visitor. KEEP_WARM=0 turns this off.
  async alarm() {
    if (!(await this.ready(null))) return;
    if (this.env.KEEP_WARM !== '0') await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
  }
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      const api = env.API.get(env.API.idFromName('main'));
      return withSecurityHeaders(await api.fetch(request));
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
