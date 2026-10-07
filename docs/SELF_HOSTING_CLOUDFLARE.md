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
   - **Preview builds:** leave them off. Wrangler refuses to preview a Worker with a Durable Object
     unless it is given separate preview storage.
3. Save and deploy. The first build takes two or three minutes. It runs on Node 22, like the
   Docker images; `.node-version` asks Workers Builds for it.
4. Open `https://opengym.<your-subdomain>.workers.dev` and create your profile with a passkey.

From then on every push to `main` deploys.

Deploying by hand works too: `npm ci && npx wrangler login && npx wrangler deploy` from the
repository root. It deploys to the Worker named in `wrangler.jsonc`. If that is not the name
Workers Builds deploys to, you get a second Worker with its own, separate data.

## Your address, and a custom domain

Passkeys are bound to `RP_ID` and `ORIGIN`. If you set neither, the Worker takes them from the
address you **first open the app at**, and keeps that from then on. So the `workers.dev` address
works without configuring anything. Only a request the app itself makes from that page fixes the
address for good, and a public address always counts as `https://`, so a script or a scanner
calling the API over plain `http://` cannot claim it first.

To use your own domain, decide **before anyone creates a profile**:

1. **Settings → Domains & Routes → Add → Custom domain** on the Worker, e.g. `gym.example.com`.
2. **Settings → Variables and Secrets**: add `ORIGIN` = `https://gym.example.com`
   (`RP_ID` follows from it; set it only if it should differ).
3. Open the app on that domain.

A passkey made on the `workers.dev` address does not work on the custom domain, or the other way
round. Changing `ORIGIN` later is the same as changing it on a Docker instance: existing passkeys
stop working (SELF_HOSTING.md has the details). Setting `ORIGIN` is also how you move the Worker to
another address after it has picked one; it then remembers the new one.

## Settings

The settings are the variables in [`.env.example`](../.env.example): `ADMIN_UIDS`, `INVITE_ONLY`,
`ALLOW_GUEST`, `DEFAULT_LANG`, `SESSION_DAYS`, `AUDIT_*`, `VAPID_SUBJECT` and the rest. Set them under
**Settings → Variables and Secrets** in the dashboard. `wrangler.jsonc` has `keep_vars: true`, so a
deploy from GitHub keeps what you set there. Saving a variable deploys a new version, and the API
starts again with it.

To make yourself an admin, sign in, open `https://<your-address>/api/me` and copy the `id`, then
set `ADMIN_UIDS` to it.

Three settings are fixed by this build: `COACH_DISABLED=1` and `MEDIA_UPLOADS=0` (see below), and
`TRUST_PROXY=1`, because Cloudflare itself sets the visitor's address in `CF-Connecting-IP`.
`KEEP_WARM=0` turns off the once-a-minute alarm (see [Notifications](#notifications)).

If a setting is invalid (an `ORIGIN` that is not a bare `https://host`, a `VAPID_SUBJECT` that is
not a `mailto:` or `https:` address), the API answers every request with a 503 that says which
one, and the Worker's logs (**Observability**) say the same.

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
  have logged from **Settings → Export backup (JSON)** and import it on any instance. Profiles and
  passkeys themselves are not in that file: moving to another instance means creating the
  profile again there and importing the backup.
- **Password sign-in** (`PASSWORD_LOGIN=1`) needs Workers Paid; see [Free or Paid](#free-or-paid).

## Notifications

Push works as on the Docker stack: rest-timer notifications and day reminders, VAPID keys created
on first start and kept in the Durable Object.

The API sends reminders from timers, and an idle Durable Object is put to sleep after a minute or
two, timers and all. So while at least one device has notifications on, the Worker wakes it once
a minute with an [alarm](https://developers.cloudflare.com/durable-objects/api/alarms/); with none,
it is left to sleep between visits. Kept awake around the clock it uses about 10,800 GB-s of
Durable Object time a day. On the Free plan that is most of the 13,000 GB-s a day, and the
allowance is shared by every Durable Object on the account, so run one instance like this per
Free account. Workers Paid includes 400,000 GB-s a month, about 324,000 of which this uses.
`KEEP_WARM=0` lets it sleep even with notifications on, at the cost of reminders that only
arrive while someone is using the app.

On the Docker stack the API also refuses to send a push to a hostname that resolves to a private
address. In a Worker that DNS check cannot run (the runtime's HTTPS client does not resolve names
itself); the check on IP addresses still does, and a Worker on Cloudflare's network cannot reach
private networks in the first place.

## Free or Paid

The **Workers Free** plan is enough to try it and to start using it. **Workers Paid** ($5 a month)
is what keeps it working as your history grows. The limit that decides it is CPU time:

| Limit (Free) | What it means here |
|---|---|
| 10 ms CPU per request | The API reads and writes your whole training history as one JSON document on every sync, about 7 ms for 250 KB and 11 ms for 500 KB, which is a year or two of logging. Past that, saving runs over and Cloudflare starts refusing requests. Starting the API after a deploy takes about 100 ms once, usually on the minute alarm rather than on your request |
| 100,000 requests a day | `/api` calls, opening the app and the minute alarm count; the app's script and image files do not |
| 100,000 storage row writes a day | A sync writes three to eight rows; far more than one household needs |
| 5 GB storage | Years of workout history for many people |
| 128 MB memory (both plans) | Fine for a household; dozens of people with long histories and notifications on is more than one Worker should hold |

Workers Paid raises the CPU limit to 30 seconds per request and lifts the daily caps. It is also
needed for password sign-in (`PASSWORD_LOGIN=1`), whose deliberately slow hash takes far more
than 10 ms.

## Updating

Bring the new upstream release into your `main` (on GitHub: **Sync fork**). That push deploys it,
and the API starts again with your data where it was.

## Developing locally

```bash
npm ci
npx wrangler dev        # http://localhost:8787 — the same Worker, Durable Object and storage, locally
npm run test:cloudflare # the fs-shim tests
```

Open it at `http://localhost:8787`, not `127.0.0.1`: the first address becomes the origin, and
browsers refuse passkeys on an IP address. Local data lives in `.wrangler/state/`.

`npm run test:cloudflare:smoke` builds the app and runs the Worker under `wrangler dev` with a
software passkey: sign-up, sync of a state bigger than one storage value, CSRF, the sign-in
throttle, sign-in again, and a restart on the same storage. Run it after changing `api/server.js`
or anything in `cloudflare/`; the port depends on `server.js` doing nothing at import that a
Worker forbids outside a request.
