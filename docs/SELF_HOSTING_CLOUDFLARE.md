# Self-hosting openGym on Cloudflare Workers

The whole instance — the app, the API and your data — as one Cloudflare Worker: no server, no
Docker, HTTPS from the start, and a new deploy on every `git push`. Read the
[passkey section of SELF_HOSTING.md](SELF_HOSTING.md#2-understand-the-passkey-requirement-important)
first; the rule that a passkey belongs to one exact hostname applies here unchanged.

It is the same code as the Docker stack. `api/server.js` runs unmodified inside a
[Durable Object](https://developers.cloudflare.com/durable-objects/), and the files it would keep
in `./data` (`db.json`, `state-<uid>.json`, `secret`, `vapid.json`, `audit.log`) live in that
object's own storage instead. What changes is listed under [Differences](#differences-from-the-docker-stack).

## How it fits together

| Piece | Where it runs |
|---|---|
| The app (`frontend/`) | [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/), built from `frontend/` on every deploy |
| The API (`api/server.js`) | One Durable Object (`OpenGymApi`), reached at `/api/*` on the same origin, as passkeys require |
| `./data` | The Durable Object's built-in SQLite storage, through [`cloudflare/fs-shim.js`](../cloudflare/fs-shim.js) |
| Exercise images and GIFs | The pinned upstream dataset on jsDelivr, as in the phone app and the demo |

The files are [`wrangler.jsonc`](../wrangler.jsonc) and [`cloudflare/`](../cloudflare/):
`worker.js` (routing, the Durable Object, the keep-warm alarm), `fs-shim.js` (`node:fs` on the
object's storage), `build.mjs` (installs and builds), `_headers` (the security and cache headers
nginx sets in the Docker image).

## Deploy from GitHub

1. Have the repository on your GitHub account (a fork is fine).
2. In the Cloudflare dashboard: **Workers & Pages → Create → Import a repository**, and pick it.
   - **Project / Worker name:** the `name` in `wrangler.jsonc` (`opengym`), or change `name` there
     to the name you pick. The two have to match.
   - **Root directory:** leave empty (the repository root, where `wrangler.jsonc` is).
   - **Build command:** leave empty. `wrangler deploy` runs `cloudflare/build.mjs` itself. If one
     is already filled in, `npm run build` is fine too; the build then notices it has already run.
   - **Deploy command:** `npx wrangler deploy` (the default).
   - **Production branch:** `main`.
3. Save and deploy. The first build takes two or three minutes.
4. Open `https://opengym.<your-subdomain>.workers.dev` and create your profile with a passkey.

From then on every push to `main` deploys. Pushes to other branches only build a preview, if
preview builds are on; Workers with a Durable Object get no separate preview address.

Deploying by hand works too: `npm ci && npx wrangler login && npx wrangler deploy` from the
repository root.

## Your address, and a custom domain

Passkeys are bound to `RP_ID` and `ORIGIN`. If you set neither, the Worker takes them from the
address the app is **first opened at**, and keeps that from then on. So the `workers.dev` address
works without configuring anything.

To use your own domain, decide **before anyone creates a profile**:

1. **Settings → Domains & Routes → Add → Custom domain** on the Worker, e.g. `gym.example.com`.
2. **Settings → Variables and Secrets**: add `ORIGIN` = `https://gym.example.com`
   (`RP_ID` follows from it; set it only if it should differ).
3. Open the app on that domain.

A passkey made on the `workers.dev` address does not work on the custom domain, or the other way
round. Changing `ORIGIN` later is the same as changing it on a Docker instance: existing passkeys
stop working (SELF_HOSTING.md has the details).

## Settings

The settings are the variables in [`.env.example`](../.env.example): `ADMIN_UIDS`, `INVITE_ONLY`,
`ALLOW_GUEST`, `DEFAULT_LANG`, `SESSION_DAYS`, `AUDIT_*`, `VAPID_SUBJECT` and the rest. Set them under
**Settings → Variables and Secrets** in the dashboard. `wrangler.jsonc` has `keep_vars: true`, so a
deploy from GitHub keeps what you set there. Saving a variable deploys a new version, and the API
starts again with it.

To make yourself an admin, sign in, open `https://<your-address>/api/me` and copy the `id`, then
set `ADMIN_UIDS` to it.

Two settings are fixed by this build: `COACH_DISABLED=1` and `MEDIA_UPLOADS=0` (see below).
`KEEP_WARM=0` turns off the once-a-minute alarm (see [Notifications](#notifications)).

## Differences from the Docker stack

- **No photo or video uploads for your own exercises.** The upload routes stream files to disk,
  which a Worker does not have. The app already handles a server without uploads: the exercise
  editor offers a link field instead.
- **No AI Coach.** Its providers run as separate processes or keep long-running jobs, neither of
  which a Worker can do. The [MCP server](../mcp/README.md) needs `./data` on disk, so it does
  not apply either.
- **Exercise images come from jsDelivr**, the pinned upstream dataset the phone app uses, not
  from your instance. They are © Gym visual (see [NOTICE.md](../NOTICE.md)). Set the build
  variables `VITE_IMG_BASE` / `VITE_GIF_BASE` to serve them from somewhere else.
- **Backups.** There is no `data/` folder to archive. Every person can export everything they
  have from **Settings → Export backup (JSON)** and import it on any instance. Cloudflare also keeps
  30 days of point-in-time history of the Durable Object's storage.
- **Password sign-in** (`PASSWORD_LOGIN=1`) needs the Workers Paid plan: each password check is a
  deliberately slow hash, far above the Free plan's CPU time per request.

## Notifications

Push works as on the Docker stack: rest-timer notifications and day reminders, VAPID keys created
on first start and kept in the Durable Object.

The API sends reminders from timers, and an idle Durable Object is put to sleep after a minute or
two, timers and all. So the Worker wakes it once a minute with an
[alarm](https://developers.cloudflare.com/durable-objects/api/alarms/). That keeps it running
around the clock, which uses about 10,800 of the Free plan's 13,000 GB-s of Durable Object time
per day, or about 324,000 of the 400,000 GB-s per month included in Workers Paid. If you don't
need reminders, `KEEP_WARM=0` lets it sleep when nobody uses the app.

## Free or Paid

A personal or family instance runs on the **Workers Free** plan. The limits that matter:

| Limit (Free) | What it means here |
|---|---|
| 10 ms CPU per request | Fine for normal use. A very large history makes saving it the slowest request; the first request after a deploy also does the start-up work |
| 100,000 requests a day | `/api` calls and the minute alarm count; serving the app's files does not |
| 100,000 storage row writes a day | A sync writes a handful of rows; far more than one person needs |
| 5 GB storage | Years of workout history for many people |

The **Workers Paid** plan ($5 a month) raises the CPU limit to 30 seconds per request and lifts
the daily caps. Choose it for password sign-in, or when many people share the instance.

## Updating

Bring in the new upstream release (on GitHub: **Sync fork**) and push. The deploy builds it and
the API restarts with your data where it was.

## Developing locally

```bash
npm ci
npx wrangler dev        # http://localhost:8787 — the same Worker, Durable Object and storage, locally
npm run test:cloudflare # the fs-shim tests
```

Open it at `http://localhost:8787`, not `127.0.0.1`: the first address becomes the origin, and
browsers refuse passkeys on an IP address. Local data lives in `.wrangler/state/`.
