// `undici` for the Cloudflare Workers build (aliased in wrangler.jsonc). api/coach/node-fetch.js
// imports it for the Coach's HTTP adapters; undici is a Node socket client that cannot run in a
// Worker, which has a native fetch instead. The Coach is switched off in this build
// (COACH_DISABLED=1), so this only has to let the module load: fetch is the platform's, and the
// Agent's timeouts are accepted and ignored.
export const fetch = (...args) => globalThis.fetch(...args);
export class Agent {
  constructor(opts) { this.options = opts; }
}
export default { fetch, Agent };
