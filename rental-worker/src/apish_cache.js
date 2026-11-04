// Cache for API.SH requests. Every API.SH page costs a credit, even when API.SH serves it from its own cache,
// so identical requests (same URL: area, BHK, page...) are answered from D1 for APISH_CACHE_MIN minutes (default 30).
//
// apiShFetch has the same shape as fetch() and returns a Response, so callers only swap `fetch(` for `apiShFetch(env, `.
// The API key travels in a header and is never part of the cache key. Only successful (2xx) responses are cached.
// If D1 is unavailable the request simply goes to API.SH, so caching can never break a search.

const inflight = new Map(); // identical requests running at the same moment share one API.SH call
let tableReady = null;

function ensureTable(env) {
  tableReady ??= env.DB.prepare('CREATE TABLE IF NOT EXISTS apish_cache (key TEXT PRIMARY KEY, body TEXT NOT NULL, fetched_at INTEGER NOT NULL)').run()
    .catch(e => { tableReady = null; throw e; });
  return tableReady;
}

const hit = (body, ageMs) => new Response(body, { status: 200, headers: { 'Content-Type': 'application/json', 'X-ApiSh-Cache': 'hit', 'X-ApiSh-Cache-Age': String(Math.round(ageMs / 1000)) } });

export async function apiShFetch(env, url, init = {}) {
  const key = String(url);
  const ttlMs = (Number(env.APISH_CACHE_MIN) || 30) * 60_000;
  const now = Date.now();

  try {
    await ensureTable(env);
    const row = await env.DB.prepare('SELECT body, fetched_at FROM apish_cache WHERE key=?').bind(key).first();
    if (row && now - row.fetched_at < ttlMs) return hit(row.body, now - row.fetched_at);
  } catch { /* no cache available: fall through to a live request */ }

  if (!inflight.has(key)) {
    inflight.set(key, (async () => {
      const res = await fetch(url, init);
      const body = await res.text();
      if (res.ok) {
        try {
          await env.DB.batch([
            env.DB.prepare('INSERT INTO apish_cache(key, body, fetched_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body, fetched_at=excluded.fetched_at').bind(key, body, Date.now()),
            env.DB.prepare('DELETE FROM apish_cache WHERE fetched_at < ?').bind(Date.now() - 24 * 3600_000), // keep the table small
          ]);
        } catch { /* caching is best effort */ }
      }
      return { status: res.status, body };
    })().finally(() => inflight.delete(key)));
  }
  const { status, body } = await inflight.get(key);
  return new Response(body, { status, headers: { 'Content-Type': 'application/json', 'X-ApiSh-Cache': 'miss' } });
}
