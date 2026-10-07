// node:fs for the Cloudflare Workers build of the API (wrangler.jsonc aliases `node:fs` here).
//
// A Worker has no disk: node:fs in workerd is an in-memory /tmp that is gone with the request.
// The API's data — db.json, state-<uid>.json, secret, vapid.json, audit.log — has to live in the
// Durable Object's own storage instead, and this module is the seam: it implements the slice of
// node:fs that api/ actually calls, on top of the object's synchronous key-value API
// (ctx.storage.kv). Synchronous matters. server.js relies on "no await between the read and the
// write" for PUT /api/data's compare-and-write and on write-temp-then-rename for every save; with
// a sync store both keep their meaning, and the runtime commits every write made in one
// synchronous stretch together, so a rename never lands without the write before it.
//
// Layout, all under one prefix so nothing else in the object's storage can collide:
//   fs:f:<path>       file metadata  { size, mtimeMs, mode, blob, n }
//   fs:b:<blob>:<i>   file content   n chunks of at most CHUNK bytes (a value is capped at 2 MB)
//   fs:d:<path>       directory      { mtimeMs, mode }
// A rename moves only the metadata row, so atomicWrite's temp-then-rename costs no second copy.
//
// Media uploads stream through createWriteStream/createReadStream, which are not implemented:
// the Worker runs with MEDIA_UPLOADS=0 and the app already treats that as "this server keeps no
// photos" (docs/SELF_HOSTING_CLOUDFLARE.md).

import path from 'node:path';
import { Buffer } from 'node:buffer';

const CHUNK = 1024 * 1024;
const F = 'fs:f:', B = 'fs:b:', D = 'fs:d:';

let kv = null;
/** Point the module at a Durable Object's `ctx.storage.kv`. Called before api/server.js loads. */
export function bindStorage(storageKv) { kv = storageKv; }
function store() {
  if (!kv) throw new Error('fs-shim: no storage bound (bindStorage was not called)');
  return kv;
}

const MSG = {
  ENOENT: 'no such file or directory', EEXIST: 'file already exists', EISDIR: 'illegal operation on a directory',
  ENOTDIR: 'not a directory', ENOTEMPTY: 'directory not empty', EBADF: 'bad file descriptor',
  ENOTSUP: 'operation not supported on this platform',
};
const ERRNO = { ENOENT: -2, EEXIST: -17, EISDIR: -21, ENOTDIR: -20, ENOTEMPTY: -39, EBADF: -9, ENOTSUP: -95 };
function fsError(code, syscall, p) {
  const e = new Error(`${code}: ${MSG[code]}, ${syscall}${p == null ? '' : ` '${p}'`}`);
  e.code = code; e.errno = ERRNO[code]; e.syscall = syscall;
  if (p != null) e.path = p;
  return e;
}

function abs(p) {
  if (p instanceof URL) p = p.pathname;
  if (Buffer.isBuffer(p)) p = p.toString();
  if (typeof p !== 'string') throw new TypeError(`The "path" argument must be of type string. Received ${typeof p}`);
  return path.posix.resolve('/', p);
}
const parentOf = p => path.posix.dirname(p);
const childPrefix = dir => (dir === '/' ? '/' : dir + '/');

const fileMeta = p => store().get(F + p);
// / and /tmp always exist, as on any system (the Coach's admin test makes a temp dir in /tmp).
const BUILTIN_DIRS = new Set(['/', '/tmp']);
const dirMeta = p => (BUILTIN_DIRS.has(p) ? store().get(D + p) || { mtimeMs: 0, mode: 0o41777 } : store().get(D + p));

function encodingOf(opts) {
  if (typeof opts === 'string') return opts;
  return opts && opts.encoding ? opts.encoding : null;
}
function toBytes(data, encoding) {
  if (typeof data === 'string') return Buffer.from(data, encoding || 'utf8');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError('The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView.');
}

function readBlob(meta) {
  const s = store(), parts = [];
  for (let i = 0; i < meta.n; i++) {
    const c = s.get(`${B}${meta.blob}:${i}`);
    if (c) parts.push(Buffer.from(c.buffer, c.byteOffset, c.byteLength));
  }
  return Buffer.concat(parts, meta.size);
}
// Copies each chunk into its own buffer: a typed-array view is stored with its whole underlying
// ArrayBuffer, so a subarray of a big (or pooled) buffer would store far more than its length.
function writeChunks(blob, bytes, from = 0) {
  const s = store();
  let n = from;
  for (let off = from * CHUNK; off < bytes.length; off += CHUNK, n++) {
    s.put(`${B}${blob}:${n}`, new Uint8Array(bytes.subarray(off, Math.min(off + CHUNK, bytes.length))));
  }
  return n;
}
function dropBlob(meta) {
  const s = store();
  for (let i = 0; i < meta.n; i++) s.delete(`${B}${meta.blob}:${i}`);
}

function requireParent(p, syscall) {
  const parent = parentOf(p);
  if (dirMeta(parent)) return;
  throw fsError(fileMeta(parent) ? 'ENOTDIR' : 'ENOENT', syscall, p);
}

function putFile(p, bytes, mode, syscall) {
  if (dirMeta(p)) throw fsError('EISDIR', syscall, p);
  requireParent(p, syscall);
  const s = store(), old = fileMeta(p);
  const blob = crypto.randomUUID();
  const n = writeChunks(blob, bytes);
  s.put(F + p, { size: bytes.length, mtimeMs: Date.now(), mode: mode ?? old?.mode ?? 0o100644, blob, n });
  if (old) dropBlob(old);
}

class Stats {
  constructor(meta, dir) {
    this.size = dir ? 4096 : meta.size;
    this.mode = meta.mode ?? (dir ? 0o40755 : 0o100644);
    this.mtimeMs = this.atimeMs = this.ctimeMs = this.birthtimeMs = meta.mtimeMs;
    this.mtime = this.atime = this.ctime = this.birthtime = new Date(meta.mtimeMs);
    this.uid = this.gid = 0; this.nlink = 1; this.blksize = 4096; this.blocks = Math.ceil(this.size / 512);
    this._dir = dir;
  }
  isFile() { return !this._dir; }
  isDirectory() { return this._dir; }
  isSymbolicLink() { return false; }
  isFIFO() { return false; }
  isSocket() { return false; }
  isBlockDevice() { return false; }
  isCharacterDevice() { return false; }
}
class Dirent {
  constructor(name, dir, parent) { this.name = name; this.parentPath = this.path = parent; this._dir = dir; }
  isFile() { return !this._dir; }
  isDirectory() { return this._dir; }
  isSymbolicLink() { return false; }
}

export function existsSync(p) {
  try { p = abs(p); } catch { return false; }
  return !!(fileMeta(p) || dirMeta(p));
}

export function statSync(p, opts) {
  p = abs(p);
  const f = fileMeta(p);
  if (f) return new Stats(f, false);
  const d = dirMeta(p);
  if (d) return new Stats(d, true);
  if (opts && opts.throwIfNoEntry === false) return undefined;
  throw fsError('ENOENT', 'stat', p);
}
export const lstatSync = statSync;

export function readFileSync(p, opts) {
  if (typeof p === 'number') return readFd(p, encodingOf(opts));
  p = abs(p);
  const meta = fileMeta(p);
  if (!meta) throw fsError(dirMeta(p) ? 'EISDIR' : 'ENOENT', dirMeta(p) ? 'read' : 'open', p);
  const buf = readBlob(meta);
  const enc = encodingOf(opts);
  return enc ? buf.toString(enc) : buf;
}

export function writeFileSync(p, data, opts) {
  p = abs(p);
  const enc = encodingOf(opts);
  const flag = (opts && typeof opts === 'object' && opts.flag) || 'w';
  if (flag.startsWith('a')) return appendFileSync(p, data, opts);
  if (flag.includes('x') && (fileMeta(p) || dirMeta(p))) throw fsError('EEXIST', 'open', p);
  putFile(p, toBytes(data, enc), opts && typeof opts === 'object' ? opts.mode : undefined, 'open');
}

export function appendFileSync(p, data, opts) {
  p = abs(p);
  const bytes = toBytes(data, encodingOf(opts));
  const meta = fileMeta(p);
  if (!meta) return putFile(p, bytes, opts && typeof opts === 'object' ? opts.mode : undefined, 'open');
  // Rewrite only the last chunk: an append to a 1 MB audit log stays one or two row writes.
  const s = store();
  const last = Math.max(0, meta.n - 1);
  const lastBytes = meta.n ? s.get(`${B}${meta.blob}:${last}`) : null;
  const tail = Buffer.concat([lastBytes ? Buffer.from(lastBytes.buffer, lastBytes.byteOffset, lastBytes.byteLength) : Buffer.alloc(0), bytes]);
  let n = last;
  for (let off = 0; off < tail.length; off += CHUNK, n++) {
    s.put(`${B}${meta.blob}:${n}`, new Uint8Array(tail.subarray(off, Math.min(off + CHUNK, tail.length))));
  }
  s.put(F + p, { ...meta, size: meta.size + bytes.length, mtimeMs: Date.now(), n: Math.max(n, meta.n) });
}

export function renameSync(from, to) {
  from = abs(from); to = abs(to);
  if (from === to) return;
  const s = store();
  const f = fileMeta(from);
  if (f) {
    if (dirMeta(to)) throw fsError('EISDIR', 'rename', from);
    requireParent(to, 'rename');
    const old = fileMeta(to);
    s.put(F + to, { ...f, mtimeMs: Date.now() });
    s.delete(F + from);
    if (old && old.blob !== f.blob) dropBlob(old);
    return;
  }
  const d = dirMeta(from);
  if (!d || BUILTIN_DIRS.has(from)) throw fsError('ENOENT', 'rename', from);
  if (fileMeta(to)) throw fsError('ENOTDIR', 'rename', from);
  if (dirMeta(to) && [...s.list({ prefix: F + childPrefix(to) })].length + [...s.list({ prefix: D + childPrefix(to) })].length) {
    throw fsError('ENOTEMPTY', 'rename', from);
  }
  requireParent(to, 'rename');
  const moves = [];
  for (const kind of [F, D]) {
    for (const [k, v] of s.list({ prefix: kind + childPrefix(from) })) moves.push([k, kind + to + k.slice(kind.length + from.length), v]);
  }
  s.put(D + to, d);
  s.delete(D + from);
  for (const [k, nk, v] of moves) { s.put(nk, v); s.delete(k); }
}

export function unlinkSync(p) {
  p = abs(p);
  const meta = fileMeta(p);
  if (!meta) throw fsError(dirMeta(p) ? 'EISDIR' : 'ENOENT', 'unlink', p);
  store().delete(F + p);
  dropBlob(meta);
}

export function mkdirSync(p, opts) {
  p = abs(p);
  const recursive = !!(opts && typeof opts === 'object' && opts.recursive);
  const mode = typeof opts === 'number' ? opts : (opts && opts.mode) || 0o777;
  if (dirMeta(p)) {
    if (recursive) return undefined;
    throw fsError('EEXIST', 'mkdir', p);
  }
  if (fileMeta(p)) throw fsError('EEXIST', 'mkdir', p);
  if (!recursive) {
    requireParent(p, 'mkdir');
    store().put(D + p, { mtimeMs: Date.now(), mode: 0o40000 | (mode & 0o777) });
    return undefined;
  }
  const missing = [];
  for (let d = p; !dirMeta(d); d = parentOf(d)) {
    if (fileMeta(d)) throw fsError('ENOTDIR', 'mkdir', p);
    missing.unshift(d);
  }
  for (const d of missing) store().put(D + d, { mtimeMs: Date.now(), mode: 0o40000 | (mode & 0o777) });
  return missing[0];
}

export function mkdtempSync(prefix) {
  const ABC = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    const p = abs(prefix + Array.from(bytes, b => ABC[b % ABC.length]).join(''));
    if (!existsSync(p)) { mkdirSync(p, { mode: 0o700 }); return p; }
  }
}

export function readdirSync(p, opts) {
  p = abs(p);
  if (!dirMeta(p)) throw fsError(fileMeta(p) ? 'ENOTDIR' : 'ENOENT', 'scandir', p);
  const pre = childPrefix(p), out = new Map(), s = store();
  for (const [kind, dir] of [[F, false], [D, true]]) {
    for (const [k] of s.list({ prefix: kind + pre })) {
      const rest = k.slice(kind.length + pre.length);
      if (rest && !rest.includes('/')) out.set(rest, dir);
    }
  }
  const names = [...out.keys()].sort();
  if (opts && typeof opts === 'object' && opts.withFileTypes) return names.map(n => new Dirent(n, out.get(n), p));
  return names;
}

export function rmSync(p, opts) {
  p = abs(p);
  const force = !!(opts && opts.force), recursive = !!(opts && opts.recursive);
  if (fileMeta(p)) return unlinkSync(p);
  if (!dirMeta(p) || BUILTIN_DIRS.has(p)) {
    if (force) return;
    throw fsError('ENOENT', 'rm', p);
  }
  const s = store(), pre = childPrefix(p);
  const files = [...s.list({ prefix: F + pre })], dirs = [...s.list({ prefix: D + pre })];
  if (!recursive && (files.length || dirs.length)) {
    const e = new Error(`Path is a directory: rm returned EISDIR (is a directory) ${p}`);
    e.code = 'ERR_FS_EISDIR';
    throw e;
  }
  for (const [k, meta] of files) { s.delete(k); dropBlob(meta); }
  for (const [k] of dirs) s.delete(k);
  s.delete(D + p);
}
export function rmdirSync(p, opts) {
  p = abs(p);
  if (!dirMeta(p)) throw fsError(fileMeta(p) ? 'ENOTDIR' : 'ENOENT', 'rmdir', p);
  if (!(opts && opts.recursive) && readdirSync(p).length) throw fsError('ENOTEMPTY', 'rmdir', p);
  rmSync(p, { recursive: true });
}

export function chmodSync(p, mode) {
  p = abs(p);
  const s = store(), f = fileMeta(p);
  if (f) { s.put(F + p, { ...f, mode: 0o100000 | (mode & 0o777) }); return; }
  const d = dirMeta(p);
  if (!d) throw fsError('ENOENT', 'chmod', p);
  if (p !== '/') s.put(D + p, { ...d, mode: 0o40000 | (mode & 0o777) });
}
export function chownSync(p) {
  if (!existsSync(p)) throw fsError('ENOENT', 'chown', abs(p));
}

// There is no disk to fill; report plenty so media.js's free-space floor never trips.
export function statfsSync() {
  const blocks = 2 ** 28;
  return { type: 0, bsize: 4096, blocks, bfree: blocks, bavail: blocks, files: 2 ** 20, ffree: 2 ** 20 };
}

// Read-only descriptors: enough for mp4Info's positioned reads and readFileSync(fd).
const fds = new Map();
let nextFd = 100;
export function openSync(p, flags = 'r') {
  p = abs(p);
  if (flags !== 'r' && flags !== 'rs') throw fsError('ENOTSUP', 'open', p);
  const meta = fileMeta(p);
  if (!meta) throw fsError(dirMeta(p) ? 'EISDIR' : 'ENOENT', 'open', p);
  const fd = nextFd++;
  fds.set(fd, { p, meta, buf: null, pos: 0 });
  return fd;
}
function fdEntry(fd, syscall) {
  const e = fds.get(fd);
  if (!e) throw fsError('EBADF', syscall);
  if (!e.buf) e.buf = readBlob(e.meta);
  return e;
}
export function readSync(fd, buffer, offset = 0, length = buffer.byteLength - offset, position = null) {
  if (offset && typeof offset === 'object') ({ offset = 0, length = buffer.byteLength - offset, position = null } = offset);
  const e = fdEntry(fd, 'read');
  const at = position == null ? e.pos : Number(position);
  const n = Math.max(0, Math.min(length, e.buf.length - at));
  if (n === 0) return 0;
  e.buf.copy(Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength), offset, at, at + n);
  if (position == null) e.pos += n;
  return n;
}
function readFd(fd, enc) {
  const e = fdEntry(fd, 'read');
  const rest = e.buf.subarray(e.pos);
  e.pos = e.buf.length;
  return enc ? rest.toString(enc) : Buffer.from(rest);
}
export function fstatSync(fd) {
  const e = fds.get(fd);
  if (!e) throw fsError('EBADF', 'fstat');
  return new Stats(e.meta, false);
}
export function closeSync(fd) {
  if (!fds.delete(fd)) throw fsError('EBADF', 'close');
}

function unsupported(name) {
  return () => { throw fsError('ENOTSUP', name); };
}
export const createReadStream = unsupported('createReadStream');
export const createWriteStream = unsupported('createWriteStream');

export const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 };

export default {
  existsSync, statSync, lstatSync, readFileSync, writeFileSync, appendFileSync, renameSync, unlinkSync,
  mkdirSync, mkdtempSync, readdirSync, rmSync, rmdirSync, chmodSync, chownSync, statfsSync,
  openSync, readSync, fstatSync, closeSync, createReadStream, createWriteStream, constants,
};
