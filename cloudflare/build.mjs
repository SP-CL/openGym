// Builds what `wrangler deploy` uploads: the API's dependencies (bundled into the Worker) and the
// frontend (served as static assets). wrangler.jsonc runs it as its custom build, so a plain
// `npx wrangler deploy` — what Workers Builds runs on every push — is enough. It is also the root
// package.json's `build` script, for a Workers Builds project that has `npm run build` set as its
// build command; the second run in the same checkout is then skipped.
//
// The exercise images and GIFs (~140 MB, gitignored) are not part of a Worker: like the GitHub
// Pages demo and the phone app, this build points them at the pinned upstream dataset on
// jsDelivr. Set VITE_IMG_BASE / VITE_GIF_BASE as build variables to serve them from elsewhere.

import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATASET = 'https://cdn.jsdelivr.net/gh/hasaneyldrm/exercises-dataset@7455efae41b330c265e7cd4b78dfa848e7ce5ebd';

const run = (cmd, dir, env = {}) => {
  console.log(`\n> ${cmd}   (${dir})`);
  execSync(cmd, { cwd: path.join(root, dir), stdio: 'inherit', env: { ...process.env, ...env } });
};

function revision() {
  if (process.env.WORKERS_CI_COMMIT_SHA) return process.env.WORKERS_CI_COMMIT_SHA;
  try {
    const head = execSync('git rev-parse HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const dirty = execSync('git status --porcelain', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return dirty ? null : head;   // uncommitted changes: always rebuild
  } catch { return null; }
}

const rev = revision();
const stamp = path.join(root, 'frontend', 'node_modules', '.opengym-cloudflare-build');
if (rev && existsSync(path.join(root, 'frontend', 'dist', 'index.html')) && existsSync(stamp) && readFileSync(stamp, 'utf8') === rev) {
  console.log(`openGym: frontend and API already built for ${rev.slice(0, 12)}, skipping.`);
  process.exit(0);
}

// A fresh checkout (every Workers Builds run) installs; a local `wrangler dev` restart does not
// reinstall dependencies that are already there for the current lockfile.
const installed = dir => {
  const marker = path.join(root, dir, 'node_modules', '.package-lock.json');
  return existsSync(marker) && statSync(marker).mtimeMs >= statSync(path.join(root, dir, 'package-lock.json')).mtimeMs;
};
if (!installed('api')) run('npm ci --omit=optional --no-audit --no-fund', 'api');
// --ignore-scripts: the one heavy postinstall in frontend/ draws app icons for the phone builds
// and downloads libvips to do it (see web/Dockerfile).
if (!installed('frontend')) run('npm ci --ignore-scripts --no-audit --no-fund', 'frontend');
run('npm run build', 'frontend', {
  VITE_IMG_BASE: process.env.VITE_IMG_BASE || `${DATASET}/images/`,
  VITE_GIF_BASE: process.env.VITE_GIF_BASE || `${DATASET}/videos/`,
  APP_BUILD: process.env.APP_BUILD || (rev ? rev.slice(0, 7) : ''),
});
copyFileSync(path.join(root, 'cloudflare', '_headers'), path.join(root, 'frontend', 'dist', '_headers'));

if (rev) {
  mkdirSync(path.dirname(stamp), { recursive: true });
  writeFileSync(stamp, rev);
}
