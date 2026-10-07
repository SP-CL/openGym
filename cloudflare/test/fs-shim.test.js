/* cloudflare/fs-shim.js is node:fs for the Workers build: ./data — db.json, the state files, the
   secret, vapid.json, audit.log — lives in the Durable Object's synchronous key-value store, and
   api/server.js runs unmodified on top of it. So the shim has to behave like node:fs exactly where
   api/ leans on it: the boot sequence, atomicWrite's write-temp-then-rename, the audit log's
   appends, media.js's directory walks and positioned reads, and the error codes every `catch`
   in server.js silently relies on. It also has to respect what the store allows: no value over
   2 MiB, and a typed-array view is stored with its whole underlying ArrayBuffer. A chunk row left
   behind by an overwrite, a rename or a delete is storage nobody can ever reclaim.

   The store here is an in-memory stand-in for ctx.storage.kv: values go in and come out as
   structured clones (as the real one serializes them), keys list in ascending order, and a value
   over 2 MiB is refused. A fresh one is bound before every test. No Worker runtime needed. */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import fs, { bindStorage } from '../fs-shim.js';

const CHUNK = 1024 * 1024;              // the shim's chunk size
const MAX_VALUE = 2 * 1024 * 1024;      // the store's per-value cap
const DATA = '/data';                   // DATA_DIR in the Worker (cloudflare/worker.js)

/* ---------- the stand-in for ctx.storage.kv ---------- */

// What a value costs to store: a typed array is serialized with its whole ArrayBuffer.
const storedBytes = v => (ArrayBuffer.isView(v) ? v.buffer.byteLength : Buffer.byteLength(JSON.stringify(v) ?? ''));

function fakeKv() {
  const rows = new Map();
  const puts = [];                      // every key written, in order (for counting row writes)
  return {
    rows, puts,
    get(key) { return rows.has(key) ? structuredClone(rows.get(key)) : undefined; },
    put(key, value) {
      if (typeof key !== 'string') throw new TypeError('key must be a string');
      const v = structuredClone(value);
      const n = storedBytes(v);
      if (n > MAX_VALUE) throw new RangeError(`value for ${key} is ${n} bytes, over the ${MAX_VALUE}-byte limit`);
      rows.set(key, v);
      puts.push(key);
    },
    delete(key) { return rows.delete(key); },
    list({ prefix = '', start, end, limit = Infinity, reverse = false } = {}) {
      const keys = [...rows.keys()]
        .filter(k => k.startsWith(prefix) && (start == null || k >= start) && (end == null || k < end))
        .sort();
      if (reverse) keys.reverse();
      return keys.slice(0, limit).map(k => [k, structuredClone(rows.get(k))])[Symbol.iterator]();
    },
  };
}

let kv;
beforeEach(() => { kv = fakeKv(); bindStorage(kv); });

/* ---------- looking inside the store ---------- */

const keysWith = pre => [...kv.rows.keys()].filter(k => k.startsWith(pre)).sort();
const metaOf = p => kv.rows.get('fs:f:' + p);
const chunksOf = p => {
  const m = metaOf(p);
  return Array.from({ length: m.n }, (_, i) => kv.rows.get(`fs:b:${m.blob}:${i}`));
};
// Every chunk row belongs to a live file, and every live file has all of its chunks.
function assertNoOrphanChunks() {
  const want = [];
  for (const [k, m] of kv.rows) if (k.startsWith('fs:f:')) for (let i = 0; i < m.n; i++) want.push(`fs:b:${m.blob}:${i}`);
  assert.deepEqual(keysWith('fs:b:'), want.sort());
}
// No chunk over the chunk size, and none carrying more ArrayBuffer than its own bytes.
function assertTightChunks(p) {
  for (const c of chunksOf(p)) {
    assert.ok(c.byteLength <= CHUNK, `chunk of ${c.byteLength} bytes is over ${CHUNK}`);
    assert.equal(c.buffer.byteLength, c.byteLength, 'chunk drags a larger ArrayBuffer into storage');
  }
}

// server.js's own helper, verbatim apart from the fs it is handed.
function atomicWrite(file, content, mode) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content, mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

describe('binding', () => {
  it('refuses to run before a store is bound, rather than writing nowhere', () => {
    bindStorage(null);
    assert.throws(() => fs.readFileSync('/data/db.json', 'utf8'), /no storage bound/);
  });
});

describe('mkdirSync / existsSync', () => {
  it('creates /data recursively on an empty store, and is a no-op the next boot', () => {
    assert.equal(fs.existsSync(DATA), false);
    assert.equal(fs.mkdirSync(DATA, { recursive: true }), DATA);
    assert.equal(fs.existsSync(DATA), true);
    assert.equal(fs.statSync(DATA).isDirectory(), true);
    assert.equal(fs.mkdirSync(DATA, { recursive: true }), undefined);
    assert.deepEqual(keysWith('fs:'), ['fs:d:/data']);
  });

  it('creates every missing ancestor with the mode asked for (media.js, coach/jobs.js)', () => {
    assert.equal(fs.mkdirSync('/data/media/u1', { recursive: true, mode: 0o700 }), DATA);
    for (const d of ['/data', '/data/media', '/data/media/u1']) {
      const st = fs.statSync(d);
      assert.equal(st.isDirectory(), true, d);
      assert.equal(st.mode & 0o777, 0o700, d);
    }
  });

  it('without recursive: ENOENT for a missing parent, EEXIST for an existing entry', () => {
    assert.throws(() => fs.mkdirSync('/data/coach'), { code: 'ENOENT', syscall: 'mkdir', path: '/data/coach' });
    assert.equal(fs.existsSync('/data/coach'), false);
    fs.mkdirSync(DATA);
    assert.throws(() => fs.mkdirSync(DATA), { code: 'EEXIST', syscall: 'mkdir', errno: -17 });
    fs.writeFileSync('/data/secret', 'x');
    assert.throws(() => fs.mkdirSync('/data/secret'), { code: 'EEXIST' });
    assert.throws(() => fs.mkdirSync('/data/secret', { recursive: true }), { code: 'EEXIST' });
    assert.throws(() => fs.mkdirSync('/data/secret/sub', { recursive: true }), { code: 'ENOTDIR' });
  });

  it('existsSync answers for files, directories and the root, and never throws', () => {
    fs.mkdirSync(DATA);
    fs.writeFileSync('/data/db.json', '{}');
    assert.equal(fs.existsSync('/data/db.json'), true);
    assert.equal(fs.existsSync('/data'), true);
    assert.equal(fs.existsSync('/'), true);
    assert.equal(fs.existsSync('/data/vapid.json'), false);
    assert.equal(fs.existsSync(undefined), false);
    assert.equal(fs.existsSync(new URL('file:///data/db.json')), true);
  });
});

describe('writeFileSync / readFileSync', () => {
  beforeEach(() => fs.mkdirSync(DATA, { recursive: true }));

  it('round-trips a string with a mode; utf8 gives a string, no encoding gives a Buffer', () => {
    const text = 'héllo € 💪\n';
    fs.writeFileSync('/data/vapid.json', text, { mode: 0o600 });
    assert.equal(fs.readFileSync('/data/vapid.json', 'utf8'), text);
    assert.equal(fs.readFileSync('/data/vapid.json', { encoding: 'utf8' }), text);
    const buf = fs.readFileSync('/data/vapid.json');
    assert.ok(Buffer.isBuffer(buf));
    assert.deepEqual(buf, Buffer.from(text, 'utf8'));
    const st = fs.statSync('/data/vapid.json');
    assert.equal(st.isFile(), true);
    assert.equal(st.isDirectory(), false);
    assert.equal(st.size, Buffer.byteLength(text));
    assert.equal(st.mode & 0o777, 0o600);
  });

  it('accepts a plain Uint8Array and a DataView, not only Buffers and strings', () => {
    fs.writeFileSync('/data/a.bin', new Uint8Array([1, 2, 3]));
    fs.writeFileSync('/data/b.bin', new DataView(new Uint8Array([9, 8, 7, 6]).buffer, 1, 2));
    assert.deepEqual([...fs.readFileSync('/data/a.bin')], [1, 2, 3]);
    assert.deepEqual([...fs.readFileSync('/data/b.bin')], [8, 7]);
  });

  it("server.js's boot: lock() before the files exist, then create the secret once and keep it", () => {
    const secretFile = '/data/secret';
    // lock(): chmod on files that are not there yet must throw (and is caught), not create them.
    for (const f of ['secret', 'db.json', 'coach.json']) {
      assert.throws(() => fs.chmodSync(`/data/${f}`, 0o600), { code: 'ENOENT', syscall: 'chmod' });
    }
    assert.deepEqual(fs.readdirSync(DATA), []);
    const boot = () => {
      fs.mkdirSync(DATA, { recursive: true });
      if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, randomBytes(32).toString('hex'), { mode: 0o600 });
      return fs.readFileSync(secretFile, 'utf8').trim();
    };
    const first = boot();
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.equal(boot(), first, 'a second boot must read the same secret, not mint a new one');
    fs.chmodSync(secretFile, 0o600);
    assert.equal(fs.statSync(secretFile).mode & 0o777, 0o600);
    // db.json absent: readFileSync throws, server.js starts from an empty db.
    let db = { users: [] };
    try { db = JSON.parse(fs.readFileSync('/data/db.json', 'utf8')); } catch { /* fresh */ }
    assert.deepEqual(db, { users: [] });
  });

  it('a missing file is ENOENT with the fields node:fs sets', () => {
    assert.throws(() => fs.readFileSync('/data/state-u1.json', 'utf8'), err => {
      assert.equal(err.code, 'ENOENT');
      assert.equal(err.errno, -2);
      assert.equal(err.syscall, 'open');
      assert.equal(err.path, '/data/state-u1.json');
      assert.match(err.message, /^ENOENT: no such file or directory, open '\/data\/state-u1\.json'$/);
      return true;
    });
  });

  it('reading a directory is EISDIR', () => {
    assert.throws(() => fs.readFileSync(DATA), { code: 'EISDIR' });
    assert.throws(() => fs.readFileSync(DATA, 'utf8'), { code: 'EISDIR' });
  });

  it('writing into a missing directory is ENOENT and writes nothing; under a file is ENOTDIR', () => {
    const before = [...kv.rows.keys()].sort();
    assert.throws(() => fs.writeFileSync('/data/coach/u1.json', '{}'), { code: 'ENOENT', path: '/data/coach/u1.json' });
    assert.throws(() => fs.appendFileSync('/data/logs/audit.log', 'x\n'), { code: 'ENOENT' });
    assert.deepEqual([...kv.rows.keys()].sort(), before);
    fs.writeFileSync('/data/secret', 'x');
    assert.throws(() => fs.writeFileSync('/data/secret/x', 'y'), { code: 'ENOTDIR' });
  });

  it('writing over a directory is EISDIR', () => {
    fs.mkdirSync('/data/media');
    assert.throws(() => fs.writeFileSync('/data/media', 'x'), { code: 'EISDIR' });
    assert.equal(fs.statSync('/data/media').isDirectory(), true);
  });

  it("flag 'wx' refuses an existing file and leaves it alone, and creates a missing one", () => {
    fs.writeFileSync('/data/f', 'original');
    assert.throws(() => fs.writeFileSync('/data/f', 'clobber', { flag: 'wx' }), { code: 'EEXIST', syscall: 'open' });
    assert.equal(fs.readFileSync('/data/f', 'utf8'), 'original');
    fs.writeFileSync('/data/g', 'new', { flag: 'wx', mode: 0o600 });
    assert.equal(fs.readFileSync('/data/g', 'utf8'), 'new');
  });

  it('an overwrite replaces the content and frees the old chunks', () => {
    fs.writeFileSync('/data/db.json', 'x'.repeat(3 * CHUNK));
    fs.writeFileSync('/data/db.json', '{}');
    assert.equal(fs.readFileSync('/data/db.json', 'utf8'), '{}');
    assert.equal(keysWith('fs:b:').length, 1);
    assertNoOrphanChunks();
  });
});

describe('atomicWrite: writeFileSync(tmp) + renameSync', () => {
  beforeEach(() => fs.mkdirSync(DATA, { recursive: true }));

  it('first save, then saves over an existing file: no tmp left, no orphaned chunk', () => {
    const db = '/data/db.json';
    atomicWrite(db, JSON.stringify({ users: [] }, null, 2), 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(db, 'utf8')), { users: [] });
    for (let i = 1; i <= 5; i++) {
      const before = metaOf(db).blob;
      atomicWrite(db, JSON.stringify({ users: [{ id: 'u' + i }] }, null, 2), 0o600);
      assert.deepEqual(JSON.parse(fs.readFileSync(db, 'utf8')), { users: [{ id: 'u' + i }] });
      assert.equal(keysWith(`fs:b:${before}:`).length, 0, 'the replaced version is still stored');
    }
    assert.equal(fs.existsSync(db + '.tmp'), false);
    assert.deepEqual(keysWith('fs:f:'), ['fs:f:/data/db.json']);
    assert.deepEqual(fs.readdirSync(DATA), ['db.json']);
    assert.equal(fs.statSync(db).mode & 0o777, 0o600);
    assertNoOrphanChunks();
  });

  it('a multi-chunk state file replaced by a small one leaves only the small one stored', () => {
    const file = '/data/state-u1.json';
    atomicWrite(file, JSON.stringify({ blob: 'w'.repeat(Math.floor(2.5 * CHUNK)) }));
    assert.equal(metaOf(file).n, 3);
    atomicWrite(file, JSON.stringify({ workouts: [] }));
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { workouts: [] });
    assert.equal(keysWith('fs:b:').length, 1);
    assertNoOrphanChunks();
  });

  it('a rename moves the metadata row only: no chunk is rewritten', () => {
    fs.writeFileSync('/data/state-u1.json.tmp', 's'.repeat(CHUNK + 10));
    const blob = metaOf('/data/state-u1.json.tmp').blob;
    kv.puts.length = 0;
    fs.renameSync('/data/state-u1.json.tmp', '/data/state-u1.json');
    assert.deepEqual(kv.puts, ['fs:f:/data/state-u1.json']);
    assert.equal(metaOf('/data/state-u1.json').blob, blob);
    assert.equal(fs.readFileSync('/data/state-u1.json', 'utf8'), 's'.repeat(CHUNK + 10));
  });

  it('renaming a file onto itself keeps it whole', () => {
    fs.writeFileSync('/data/db.json', '{"users":[]}');
    const rows = new Map(kv.rows);
    fs.renameSync('/data/db.json', '/data/db.json');
    fs.renameSync('/data/db.json', '/data/../data/./db.json');
    assert.equal(fs.readFileSync('/data/db.json', 'utf8'), '{"users":[]}');
    assert.deepEqual([...kv.rows.keys()].sort(), [...rows.keys()].sort());
    assertNoOrphanChunks();
  });

  it('a rename that cannot happen changes nothing', () => {
    fs.writeFileSync('/data/db.json', 'keep');
    assert.throws(() => fs.renameSync('/data/db.json.tmp', '/data/db.json'), { code: 'ENOENT', syscall: 'rename' });
    assert.equal(fs.readFileSync('/data/db.json', 'utf8'), 'keep');
    fs.writeFileSync('/data/x.tmp', 'moving');
    assert.throws(() => fs.renameSync('/data/x.tmp', '/data/missing/x'), { code: 'ENOENT' });
    assert.equal(fs.readFileSync('/data/x.tmp', 'utf8'), 'moving');
    assertNoOrphanChunks();
  });
});

describe('appendFileSync: the audit log', () => {
  const log = '/data/audit.log';
  beforeEach(() => fs.mkdirSync(DATA, { recursive: true }));
  // About 1 KB per line, shaped like server.js's audit records.
  const line = i => JSON.stringify({ id: i, ts: 1_800_000_000_000 + i, ev: 'signin', ok: true, uid: 'u' + (i % 7), msg: 'm'.repeat(900 + (i % 13)) }) + '\n';

  it('creates the file on the first append, then appends', () => {
    assert.equal(fs.existsSync(log), false);
    fs.appendFileSync(log, line(1));
    assert.equal(fs.readFileSync(log, 'utf8'), line(1));
    fs.appendFileSync(log, line(2));
    assert.equal(fs.readFileSync(log, 'utf8'), line(1) + line(2));
    assert.equal(fs.statSync(log).size, Buffer.byteLength(line(1) + line(2)));
  });

  it('many lines across the 1 MiB chunk boundary read back intact', () => {
    let want = '';
    for (let i = 1; i <= 1200; i++) { fs.appendFileSync(log, line(i)); want += line(i); }
    assert.ok(want.length > CHUNK, 'test must cross a chunk boundary');
    const got = fs.readFileSync(log, 'utf8');
    assert.equal(got.length, want.length);
    assert.equal(got, want);
    assert.equal(fs.statSync(log).size, Buffer.byteLength(want));
    assert.equal(metaOf(log).n, 2);
    assert.equal(chunksOf(log)[0].byteLength, CHUNK, 'the first chunk is filled before a second one starts');
    // What auditLines() does with it: every line parses, in order, none torn.
    const ids = got.split('\n').filter(Boolean).map(l => JSON.parse(l).id);
    assert.deepEqual(ids, Array.from({ length: 1200 }, (_, i) => i + 1));
    assertTightChunks(log);
    assertNoOrphanChunks();
  });

  it('an append to a big log rewrites only the tail chunk, not the whole file', () => {
    fs.writeFileSync(log, 'a'.repeat(CHUNK + 500));
    const blob = metaOf(log).blob;
    kv.puts.length = 0;
    fs.appendFileSync(log, line(1));
    assert.deepEqual(kv.puts, [`fs:b:${blob}:1`, 'fs:f:' + log]);
  });

  it('a multi-byte character split across two chunks decodes whole', () => {
    fs.appendFileSync(log, 'x'.repeat(CHUNK - 1));
    fs.appendFileSync(log, '€💪\n');                 // 3 + 4 bytes, the first lands on the boundary
    assert.equal(fs.readFileSync(log, 'utf8'), 'x'.repeat(CHUNK - 1) + '€💪\n');
    assertTightChunks(log);
  });

  it('an append starting exactly on a chunk boundary, and one bigger than a chunk', () => {
    fs.appendFileSync(log, Buffer.alloc(CHUNK, 0x61));
    fs.appendFileSync(log, 'b\n');
    assert.equal(metaOf(log).n, 2);
    const big = randomBytes(Math.floor(2.5 * CHUNK));
    fs.appendFileSync(log, big);
    const got = fs.readFileSync(log);
    assert.equal(got.length, CHUNK + 2 + big.length);
    assert.ok(got.subarray(0, CHUNK).every(b => b === 0x61));
    assert.equal(got.subarray(CHUNK, CHUNK + 2).toString(), 'b\n');
    assert.ok(got.subarray(CHUNK + 2).equals(big));
    assertTightChunks(log);
    assertNoOrphanChunks();
  });

  it("writeFileSync with flag 'a' appends too", () => {
    fs.writeFileSync(log, 'one\n');
    fs.writeFileSync(log, 'two\n', { flag: 'a' });
    assert.equal(fs.readFileSync(log, 'utf8'), 'one\ntwo\n');
  });

  it('compactAudit: an atomicWrite over the log, then appends continue on the new file', () => {
    for (let i = 1; i <= 5; i++) fs.appendFileSync(log, line(i));
    atomicWrite(log, line(4) + line(5));
    fs.appendFileSync(log, line(6));
    assert.equal(fs.readFileSync(log, 'utf8'), line(4) + line(5) + line(6));
    assertNoOrphanChunks();
  });
});

describe('statSync', () => {
  beforeEach(() => fs.mkdirSync(DATA, { recursive: true }));

  it('size and mtimeMs follow every write (the reminder tick caches on them)', t => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
    const file = '/data/state-u1.json';
    atomicWrite(file, '{"_rev":1}');
    const a = fs.statSync(file);
    assert.equal(a.size, 10);
    assert.equal(a.mtimeMs, 1_800_000_000_000);
    assert.equal(a.mtime.getTime(), a.mtimeMs);

    t.mock.timers.tick(5_000);
    atomicWrite(file, '{"_rev":2,"w":[]}');
    const b = fs.statSync(file);
    assert.equal(b.size, 17);
    assert.equal(b.mtimeMs, 1_800_000_005_000);

    t.mock.timers.tick(5_000);
    fs.appendFileSync(file, '\n');
    const c = fs.statSync(file);
    assert.equal(c.size, 18);
    assert.equal(c.mtimeMs, 1_800_000_010_000);

    t.mock.timers.tick(5_000);
    fs.writeFileSync(file, 'x');
    assert.equal(fs.statSync(file).mtimeMs, 1_800_000_015_000);
    assert.equal(fs.statSync(file).size, 1);
  });

  it('throwIfNoEntry: false answers undefined; by default a missing path is ENOENT', () => {
    assert.equal(fs.statSync('/data/state-nobody.json', { throwIfNoEntry: false }), undefined);
    assert.throws(() => fs.statSync('/data/state-nobody.json'), { code: 'ENOENT', syscall: 'stat' });
  });

  it('a directory stats as one', () => {
    const st = fs.statSync(DATA);
    assert.equal(st.isDirectory(), true);
    assert.equal(st.isFile(), false);
    assert.equal(fs.statSync('/').isDirectory(), true);
  });
});

describe('readdirSync: media.js walks its upload tree', () => {
  beforeEach(() => {
    fs.mkdirSync('/data/media/u2/.tmp', { recursive: true });
    fs.mkdirSync('/data/media/u1', { recursive: true });
    fs.mkdirSync('/data/media-old', { recursive: true });    // shares a prefix with /data/media
    fs.writeFileSync('/data/media/zz.json', '{}');
    fs.writeFileSync('/data/media/.gc.json', '{}');
    fs.writeFileSync('/data/media/u1/abc.jpg', 'jpg');
    fs.writeFileSync('/data/media/u2/.tmp/up-1', 'partial');
    fs.writeFileSync('/data/media-old/stray.jpg', 'x');
  });

  it('lists direct children only, sorted', () => {
    assert.deepEqual(fs.readdirSync('/data/media'), ['.gc.json', 'u1', 'u2', 'zz.json']);
    assert.deepEqual(fs.readdirSync('/data/media/u2'), ['.tmp']);
    assert.deepEqual(fs.readdirSync('/data'), ['media', 'media-old']);
    assert.deepEqual(fs.readdirSync('/'), ['data']);
  });

  it('withFileTypes flags directories, and userDirs() picks exactly the profiles', () => {
    const ents = fs.readdirSync('/data/media', { withFileTypes: true });
    assert.deepEqual(ents.map(d => [d.name, d.isDirectory(), d.isFile()]), [
      ['.gc.json', false, true], ['u1', true, false], ['u2', true, false], ['zz.json', false, true],
    ]);
    for (const d of ents) assert.equal(d.parentPath, '/data/media');
    const userDirs = ents.filter(d => d.isDirectory() && !d.name.startsWith('.')).map(d => d.name);
    assert.deepEqual(userDirs, ['u1', 'u2']);
  });

  it('an empty directory is [], a missing one ENOENT, a file ENOTDIR', () => {
    fs.mkdirSync('/data/coach');
    assert.deepEqual(fs.readdirSync('/data/coach'), []);
    assert.throws(() => fs.readdirSync('/data/media/u3/.tmp'), { code: 'ENOENT', syscall: 'scandir' });
    assert.throws(() => fs.readdirSync('/data/media/zz.json'), { code: 'ENOTDIR' });
  });
});

describe('rmSync / unlinkSync / chmodSync', () => {
  beforeEach(() => fs.mkdirSync(DATA, { recursive: true }));

  it('rmSync recursive+force removes a whole profile tree and its chunks, and only that tree', () => {
    fs.mkdirSync('/data/media/u1/.tmp', { recursive: true });
    fs.mkdirSync('/data/media/u10', { recursive: true });
    fs.writeFileSync('/data/media/u1/a.jpg', randomBytes(CHUNK + 1));
    fs.writeFileSync('/data/media/u1/.tmp/b', 'partial');
    fs.writeFileSync('/data/media/u10/c.jpg', 'keep me');
    fs.rmSync('/data/media/u1', { recursive: true, force: true });
    assert.equal(fs.existsSync('/data/media/u1'), false);
    assert.equal(fs.existsSync('/data/media/u1/.tmp/b'), false);
    assert.deepEqual(keysWith('fs:f:/data/media/u1/'), []);
    assert.deepEqual(keysWith('fs:d:/data/media/u1/'), []);
    assert.deepEqual(fs.readdirSync('/data/media'), ['u10']);
    assert.equal(fs.readFileSync('/data/media/u10/c.jpg', 'utf8'), 'keep me');
    assertNoOrphanChunks();
  });

  it('rmSync force ignores a missing path; without force it is ENOENT', () => {
    fs.rmSync('/data/media/nobody', { recursive: true, force: true });
    assert.throws(() => fs.rmSync('/data/media/nobody'), { code: 'ENOENT' });
  });

  it('rmSync on a file removes the file', () => {
    fs.mkdirSync('/data/media/u1/.tmp', { recursive: true });
    fs.writeFileSync('/data/media/u1/.tmp/up-1', 'x'.repeat(10));
    fs.rmSync('/data/media/u1/.tmp/up-1', { recursive: true, force: true });
    assert.equal(fs.existsSync('/data/media/u1/.tmp/up-1'), false);
    assert.deepEqual(keysWith('fs:b:'), []);
  });

  it('unlinkSync removes a file and its chunks; a missing one is ENOENT', () => {
    fs.writeFileSync('/data/state-u1.json', 'x'.repeat(CHUNK * 2 + 1));
    fs.unlinkSync('/data/state-u1.json');
    assert.equal(fs.existsSync('/data/state-u1.json'), false);
    assert.deepEqual(keysWith('fs:b:'), []);
    assert.throws(() => fs.unlinkSync('/data/state-u1.json'), { code: 'ENOENT', syscall: 'unlink', path: '/data/state-u1.json' });
    assert.throws(() => fs.unlinkSync('/data'), { code: 'EISDIR' });
  });

  it('chmodSync on a missing path is ENOENT; on a file it sets the permission bits only', () => {
    assert.throws(() => fs.chmodSync('/data/coach.json', 0o600), { code: 'ENOENT', syscall: 'chmod', path: '/data/coach.json' });
    assert.equal(fs.existsSync('/data/coach.json'), false);
    fs.writeFileSync('/data/coach.json', '{}');
    fs.chmodSync('/data/coach.json', 0o600);
    const st = fs.statSync('/data/coach.json');
    assert.equal(st.mode & 0o777, 0o600);
    assert.equal(st.isFile(), true);
    assert.equal(fs.readFileSync('/data/coach.json', 'utf8'), '{}');
  });
});

describe('large files and borrowed buffers', () => {
  beforeEach(() => fs.mkdirSync(DATA, { recursive: true }));

  it('a file over 2 MB round-trips byte for byte, in chunks of at most 1 MiB', () => {
    const bytes = randomBytes(2 * CHUNK + 12345);
    fs.writeFileSync('/data/state-big.json', bytes);
    const got = fs.readFileSync('/data/state-big.json');
    assert.equal(got.length, bytes.length);
    assert.ok(got.equals(bytes));
    assert.equal(fs.statSync('/data/state-big.json').size, bytes.length);
    assert.equal(metaOf('/data/state-big.json').n, 3);
    assertTightChunks('/data/state-big.json');
    assertNoOrphanChunks();
  });

  it('a slice of a larger buffer stores only its own bytes', () => {
    const parent = randomBytes(6 * CHUNK);
    const slice = parent.subarray(CHUNK / 2, CHUNK / 2 + Math.floor(1.5 * CHUNK));
    fs.writeFileSync('/data/slice.bin', slice);           // a store that kept the parent would refuse this
    assert.ok(fs.readFileSync('/data/slice.bin').equals(slice));
    assertTightChunks('/data/slice.bin');
    const tiny = Buffer.from('tiny');                      // from Node's shared 8 KiB pool
    assert.ok(tiny.buffer.byteLength > tiny.byteLength, 'precondition: a pooled buffer');
    fs.writeFileSync('/data/tiny', tiny);
    fs.appendFileSync('/data/tiny', Buffer.from('+more'));
    assertTightChunks('/data/tiny');
    assert.equal(fs.readFileSync('/data/tiny', 'utf8'), 'tiny+more');
    fs.writeFileSync('/data/str', 'short string');         // Buffer.from(string) is pooled too
    assertTightChunks('/data/str');
  });

  it('the bytes read back are a copy: changing them does not change the file', () => {
    fs.writeFileSync('/data/f', 'abc');
    const b = fs.readFileSync('/data/f');
    b[0] = 0x7a;
    assert.equal(fs.readFileSync('/data/f', 'utf8'), 'abc');
  });
});

describe('file descriptors: media.js mp4Info, sendMediaFile', () => {
  const file = '/data/clip.mp4';
  let bytes;
  beforeEach(() => {
    fs.mkdirSync(DATA, { recursive: true });
    bytes = randomBytes(CHUNK + 4096);
    fs.writeFileSync(file, bytes);
  });

  it('openSync + fstatSync + positioned readSync, including across a chunk boundary', () => {
    const fd = fs.openSync(file, 'r');
    try {
      assert.equal(fs.fstatSync(fd).size, bytes.length);
      assert.equal(fs.fstatSync(fd).isFile(), true);
      // readAt(fd, pos, len): readSync(fd, buf, 0, len, pos) === len
      const readAt = (pos, len) => {
        const buf = Buffer.alloc(len);
        return fs.readSync(fd, buf, 0, len, pos) === len ? buf : null;
      };
      assert.ok(readAt(0, 8).equals(bytes.subarray(0, 8)));
      assert.ok(readAt(CHUNK - 8, 16).equals(bytes.subarray(CHUNK - 8, CHUNK + 8)));
      assert.ok(readAt(bytes.length - 4, 4).equals(bytes.subarray(-4)));
      assert.equal(readAt(bytes.length - 4, 8), null, 'a short read past the end');
      assert.equal(fs.readSync(fd, Buffer.alloc(4), 0, 4, bytes.length), 0, 'a read at the end');
      // offset into the target buffer
      const into = Buffer.alloc(10);
      assert.equal(fs.readSync(fd, into, 6, 4, 100), 4);
      assert.ok(into.subarray(6).equals(bytes.subarray(100, 104)));
      assert.ok(into.subarray(0, 6).equals(Buffer.alloc(6)));
    } finally {
      fs.closeSync(fd);
    }
  });

  // node:fs answers 0 for a read that starts beyond the end of the file, and readAt() above turns
  // that into "not a well-formed file". The shim hands Buffer#copy a sourceStart past the end
  // of the file (fs-shim.js readSync); workerd's Buffer#copy happens to answer 0 for that, but
  // Node's throws ERR_OUT_OF_RANGE, so the shim's result depends on whose Buffer it runs on.
  it('a positioned read that starts beyond the end of the file returns 0, as node:fs does', () => {
    const fd = fs.openSync(file, 'r');
    try {
      assert.equal(fs.readSync(fd, Buffer.alloc(4), 0, 4, bytes.length + 10), 0);
    } finally {
      fs.closeSync(fd);
    }
  });

  it('readSync without a position reads on from where it left off', () => {
    const fd = fs.openSync(file, 'r');
    const a = Buffer.alloc(5), b = Buffer.alloc(5);
    assert.equal(fs.readSync(fd, a, 0, 5, null), 5);
    assert.equal(fs.readSync(fd, b, 0, 5, 9999), 5);       // positioned: does not move the cursor
    assert.equal(fs.readSync(fd, b, 0, 5, null), 5);
    assert.ok(a.equals(bytes.subarray(0, 5)));
    assert.ok(b.equals(bytes.subarray(5, 10)));
    assert.ok(fs.readFileSync(fd).equals(bytes.subarray(10)), 'readFileSync(fd) reads the rest');
    fs.closeSync(fd);
  });

  it('a closed descriptor is EBADF; a missing file or a directory cannot be opened', () => {
    const fd = fs.openSync(file, 'r');
    fs.closeSync(fd);
    assert.throws(() => fs.readSync(fd, Buffer.alloc(1), 0, 1, 0), { code: 'EBADF' });
    assert.throws(() => fs.fstatSync(fd), { code: 'EBADF' });
    assert.throws(() => fs.closeSync(fd), { code: 'EBADF' });
    assert.throws(() => fs.openSync('/data/gone.mp4', 'r'), { code: 'ENOENT', syscall: 'open' });
    assert.throws(() => fs.openSync(DATA, 'r'), { code: 'EISDIR' });
  });

  it('streams are refused loudly (the Worker runs with MEDIA_UPLOADS=0)', () => {
    assert.throws(() => fs.createWriteStream('/data/x', { flags: 'wx' }), { code: 'ENOTSUP' });
    assert.throws(() => fs.createReadStream(null, { fd: 100 }), { code: 'ENOTSUP' });
  });

  it("statfsSync reports room, so media.js's free-space floor never trips", () => {
    const s = fs.statfsSync(DATA);
    assert.ok(Number(s.bavail) * Number(s.bsize) > 100 * 1024 * 1024 * 1024);
  });
});
