// End-to-end check of the Workers build: starts the real Worker under `wrangler dev` (workerd, the
// runtime Cloudflare runs, with the Durable Object and its SQLite storage) and walks what an
// instance needs — passkey sign-up and sign-in, sync, a state bigger than one storage value,
// CSRF, the sign-in throttle per client, early answers to large bodies, the static routes — then
// restarts it on the same storage to prove the data and the origin stay.
//
// Needs frontend/dist (run `npm run build` first; `npm run test:cloudflare:smoke` does both).
// Slow next to the unit tests (two wrangler start-ups), so it is not part of test:cloudflare.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WRANGLER = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().once('error', reject).listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

let PORT, BASE, stateDir, configFile, dev;
const devLog = [];   // both wrangler runs

// wrangler.jsonc without its build step (the test uses the frontend/dist that is there), written
// next to the real one in .wrangler/ so its relative paths still resolve.
function writeConfig() {
  const src = fs.readFileSync(path.join(ROOT, 'wrangler.jsonc'), 'utf8');
  const cfg = JSON.parse(src.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'));
  delete cfg.build;
  delete cfg.$schema;
  const up = p => path.join('..', p);
  cfg.main = up(cfg.main);
  cfg.assets.directory = up(cfg.assets.directory);
  for (const k of Object.keys(cfg.alias)) cfg.alias[k] = up(cfg.alias[k]);
  fs.mkdirSync(path.join(ROOT, '.wrangler'), { recursive: true });
  configFile = path.join(ROOT, '.wrangler', `smoke-${PORT}.json`);
  fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2));
}

async function startDev() {
  const log = [];
  dev = spawn(process.execPath, [WRANGLER, 'dev', '-c', configFile, '--port', String(PORT), '--ip', '127.0.0.1',
    '--inspector-port', '0', '--persist-to', stateDir, '--show-interactive-dev-session=false'],
  { cwd: ROOT, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [dev.stdout, dev.stderr]) stream.on('data', d => { log.push(String(d)); devLog.push(String(d)); });
  dev.log = log;
  for (let i = 0; i < 240; i++) {
    if (log.join('').includes('Ready on')) return;
    if (dev.exitCode != null) break;
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('wrangler dev did not start:\n' + log.join(''));
}
async function stopDev() {
  if (!dev || dev.exitCode != null) return;
  const done = new Promise(r => dev.once('exit', r));
  dev.kill('SIGINT');
  await Promise.race([done, new Promise(r => setTimeout(r, 10000))]);
  if (dev.exitCode == null) dev.kill('SIGKILL');
}

/* ---------- a software passkey (as in api/test/server-passkeys.test.js) ---------- */

const b64u = b => Buffer.from(b).toString('base64url');
const sha = b => crypto.createHash('sha256').update(b).digest();
const cborHead = (major, n) => n < 24 ? Buffer.from([(major << 5) | n])
  : n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
const cborText = s => Buffer.concat([cborHead(3, Buffer.byteLength(s)), Buffer.from(s)]);
const cborBytes = b => Buffer.concat([cborHead(2, b.length), b]);

function softPasskey(origin) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), Buffer.from(jwk.x, 'base64url'),
    Buffer.from([0x22, 0x58, 0x20]), Buffer.from(jwk.y, 'base64url')
  ]);
  const raw = crypto.randomBytes(16);
  const id = b64u(raw);
  let counter = 0;
  return {
    attestation(challenge) {
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin, crossOrigin: false }));
      const len = Buffer.from([raw.length >> 8, raw.length & 255]);
      const authData = Buffer.concat([sha('localhost'), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), len, raw, cose]);
      const attestationObject = Buffer.concat([
        Buffer.from([0xa3]), cborText('fmt'), cborText('none'), cborText('attStmt'), Buffer.from([0xa0]),
        cborText('authData'), cborBytes(authData)
      ]);
      return { id, rawId: id, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ['internal'] } };
    },
    assertion(challenge) {
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false }));
      const c = Buffer.alloc(4); c.writeUInt32BE(++counter);
      const authData = Buffer.concat([sha('localhost'), Buffer.from([0x05]), c]);
      const signature = crypto.sign('sha256', Buffer.concat([authData, sha(clientDataJSON)]), privateKey);
      return { id, rawId: id, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(signature), userHandle: null } };
    }
  };
}

/* ---------- requests the way the app makes them ---------- */

let cookie = '';
async function call(method, p, { body, raw, auth = true, headers = {}, base = BASE } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (method !== 'GET' && !('Sec-Fetch-Site' in headers)) Object.assign(h, { Origin: BASE, 'Sec-Fetch-Site': 'same-origin' });
  if (method === 'GET' && !('Sec-Fetch-Site' in headers)) h['Sec-Fetch-Site'] = 'same-origin';
  if (auth && cookie) h.Cookie = cookie;
  const res = await fetch(base + p, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), redirect: 'manual' });
  const set = res.headers.get('set-cookie');
  if (set && auth) cookie = set.split(';')[0];
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, headers: res.headers, text, data };
}

// A state whose JSON is about `bytes` long, with a multi-byte character on every line so a
// storage chunk boundary is bound to fall inside one.
function bigState(bytes) {
  const notes = [];
  for (let i = 0, n = 0; n < bytes; i++) {
    const s = `set ${i} — 💪 ${'x'.repeat(200)}`;
    notes.push(s);
    n += s.length + 10;
  }
  return { unit: 'kg', bodyweight: [], notes };
}

const key = { current: null };
const big = bigState(2.6 * 1024 * 1024);

before(async () => {
  PORT = await freePort();
  BASE = `http://localhost:${PORT}`;
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opengym-cf-smoke-'));
  writeConfig();
  await startDev();
  key.current = softPasskey(BASE);
});
after(async () => {
  await stopDev();
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(configFile, { force: true });
});

test('the app is served, deep paths go back to the root, index.html is not redirected', async () => {
  const root = await fetch(BASE + '/');
  assert.equal(root.status, 200);
  assert.match(root.headers.get('content-type'), /text\/html/);
  assert.equal(root.headers.get('x-frame-options'), 'DENY');
  const index = await fetch(BASE + '/index.html', { redirect: 'manual' });
  assert.equal(index.status, 200, 'sw.js precaches index.html and refuses a redirect');
  const deep = await fetch(BASE + '/plan/r/x?link=abc', { redirect: 'manual' });
  assert.equal(deep.status, 302);
  assert.equal(deep.headers.get('location'), '/?link=abc');
});

test('the API answers JSON with the security headers', async () => {
  const health = await call('GET', '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.data.ok, true);
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
  const config = await call('GET', '/api/config');
  assert.equal(config.status, 200);
  assert.equal(config.data.media, undefined, 'media uploads are off in the Worker build');
  assert.equal((await call('GET', '/api/nope')).status, 404);
});

test('sign up with a passkey, then sync, including a state bigger than one storage value', async () => {
  const opts = await call('POST', '/api/register/options', { body: { name: 'Smoke' } });
  assert.equal(opts.status, 200, opts.text);
  assert.equal(opts.data.options.rp.id, 'localhost');
  const verify = await call('POST', '/api/register/verify', { body: { cid: opts.data.cid, credential: key.current.attestation(opts.data.options.challenge) } });
  assert.equal(verify.status, 200, verify.text);
  assert.ok(cookie.startsWith('gymsid='));
  assert.equal((await call('GET', '/api/me')).status, 200);

  const first = await call('PUT', '/api/data', { body: { state: { unit: 'kg', bodyweight: [{ d: '2026-10-07', w: 82.4 }] }, baseRev: 0 } });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.data.rev, 1);
  const stale = await call('PUT', '/api/data', { body: { state: { unit: 'lb' }, baseRev: 0 } });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.state.unit, 'kg');

  const put = await call('PUT', '/api/data', { body: { state: big, baseRev: 1 } });
  assert.equal(put.status, 200, put.text);
  const got = await call('GET', '/api/data');
  assert.equal(got.status, 200);
  assert.deepEqual(got.data.state.notes, big.notes);
  assert.equal((await call('GET', '/api/data/rev')).data.rev, 2);
});

test('a cross-site write is refused', async () => {
  const res = await call('PUT', '/api/data', { body: { state: {}, baseRev: 2 }, headers: { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(res.status, 403);
});

test('a large body the API answers without reading gets the real status, every time', async () => {
  const body = JSON.stringify({ state: big, baseRev: 0 });
  for (let i = 0; i < 6; i++) {
    const res = await call('PUT', '/api/data', { raw: body, auth: false });
    assert.equal(res.status, 401, `try ${i + 1}: ${res.status} ${res.text.slice(0, 200)}`);
  }
  // Over server.js's 5 MiB limit (it answers), and over the Worker's own cap (refused unread).
  for (const mib of [7, 11]) {
    const res = await call('PUT', '/api/data', { raw: 'x'.repeat(mib * 1024 * 1024) });
    assert.equal(res.status, 413, `${mib} MiB: ${res.status} ${res.text.slice(0, 200)}`);
  }
});

test('the sign-in throttle counts each client separately', async () => {
  const from = ip => call('POST', '/api/device-link/options', { body: { code: 'WRONGCODE' }, auth: false, headers: { 'CF-Connecting-IP': ip } });
  let throttled = false;
  for (let i = 0; i < 40 && !throttled; i++) throttled = (await from('198.51.100.7')).status === 429;
  assert.ok(throttled, 'one client guessing codes is throttled');
  assert.notEqual((await from('198.51.100.8')).status, 429, 'another client is not');
});

test('sign out and back in with the passkey', async () => {
  assert.equal((await call('POST', '/api/logout', { body: {} })).status, 200);
  cookie = '';
  assert.equal((await call('GET', '/api/me')).status, 401);
  const opts = await call('POST', '/api/login/options', { body: {} });
  assert.equal(opts.status, 200);
  const verify = await call('POST', '/api/login/verify', { body: { cid: opts.data.cid, credential: key.current.assertion(opts.data.options.challenge) } });
  assert.equal(verify.status, 200, verify.text);
  assert.equal((await call('GET', '/api/me')).status, 200);
});

test('after a restart the data, the session secret and the origin are still there', async () => {
  await stopDev();
  await startDev();
  // First request after the restart arrives by IP: the origin the app pinned must win.
  const opts = await call('POST', '/api/register/options', { body: { name: 'Second' }, auth: false, base: `http://127.0.0.1:${PORT}` });
  assert.equal(opts.status, 200, opts.text);
  assert.equal(opts.data.options.rp.id, 'localhost');
  assert.equal((await call('GET', '/api/me')).status, 200, 'the cookie from before the restart still verifies');
  const got = await call('GET', '/api/data');
  assert.deepEqual(got.data.state.notes, big.notes);
  assert.equal((await call('GET', '/api/health')).data.users, 1);
});

test('the runtime logged no uncaught errors', () => {
  assert.doesNotMatch(devLog.join(''), /Uncaught|Can't read from request stream|Network connection lost/);
});
