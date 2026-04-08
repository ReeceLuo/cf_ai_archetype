/** Optional secret for POST /api/seed (set with `wrangler secret put SEED_SECRET`). */
declare namespace Cloudflare {
  interface Env {
    SEED_SECRET?: string;
  }
}
