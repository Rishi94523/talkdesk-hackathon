// Offline test for the API.SH cache: fake D1 + stubbed fetch, no credits used. Run: node rental-worker/test_apish_cache.mjs
import assert from 'node:assert/strict';
import { apiShFetch } from './src/apish_cache.js';
import { searchNoBroker } from './src/sources.js';

function fakeDB({ broken = false } = {}) {
  const rows = new Map();
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    async run() {
      if (broken) throw new Error('D1 down');
      if (sql.startsWith('INSERT INTO apish_cache')) rows.set(args[0], { body: args[1], fetched_at: args[2] });
      if (sql.startsWith('DELETE FROM apish_cache')) for (const [k, v] of rows) if (v.fetched_at < args[0]) rows.delete(k);
      return {};
    },
    async first() { if (broken) throw new Error('D1 down'); return rows.get(args[0]) ?? null; },
  });
  return { rows, prepare: sql => stmt(sql), async batch(list) { for (const s of list) await s.run(); } };
}

let calls = 0, nextStatus = 200;
globalThis.fetch = async (url, init) => {
  calls++;
  assert.equal(init.headers['x-api-key'], 'secret-key');
  await new Promise(r => setTimeout(r, 20));
  return new Response(JSON.stringify({ total: 268, results: [{ id: 'abc', type: 'BHK2', rent: 24000, nb_locality: 'Whitefield', url: 'u' }] }), { status: nextStatus });
};
const init = { headers: { 'x-api-key': 'secret-key' } };
const URL1 = 'https://api.api.sh/nobroker/v1/search?city=bangalore&bhk=2&page=1';

// 1. First request goes to API.SH, the repeat is served from the cache.
let env = { DB: fakeDB() };
let r = await apiShFetch(env, URL1, init);
assert.equal(r.headers.get('X-ApiSh-Cache'), 'miss');
r = await apiShFetch(env, URL1, init);
assert.equal(r.headers.get('X-ApiSh-Cache'), 'hit');
assert.equal((await r.json()).total, 268);
assert.equal(calls, 1);
assert.ok(![...env.DB.rows.keys()].some(k => k.includes('secret-key')), 'API key must not be in the cache key');
console.log('PASS repeat request served from cache (1 API.SH call)');

// 2. A different page is a different request.
await apiShFetch(env, URL1.replace('page=1', 'page=2'), init);
assert.equal(calls, 2);
console.log('PASS different page fetched separately');

// 3. Identical requests at the same moment share one call.
calls = 0; env = { DB: fakeDB() };
await Promise.all([1, 2, 3, 4, 5].map(() => apiShFetch(env, URL1, init)));
assert.equal(calls, 1);
console.log('PASS 5 simultaneous identical requests -> 1 API.SH call');

// 4. Expired entries are refreshed.
env.DB.rows.get(URL1).fetched_at -= 31 * 60_000;
await apiShFetch(env, URL1, init);
assert.equal(calls, 2);
env.APISH_CACHE_MIN = '120';
env.DB.rows.get(URL1).fetched_at -= 60 * 60_000;
assert.equal((await apiShFetch(env, URL1, init)).headers.get('X-ApiSh-Cache'), 'hit');
console.log('PASS 30-minute default expiry, APISH_CACHE_MIN override');

// 5. Errors are passed through and never cached.
calls = 0; nextStatus = 429; env = { DB: fakeDB() };
assert.equal((await apiShFetch(env, URL1, init)).status, 429);
assert.equal(env.DB.rows.size, 0);
await apiShFetch(env, URL1, init);
assert.equal(calls, 2);
nextStatus = 200;
console.log('PASS error responses (e.g. 429) are not cached');

// 6. If D1 fails, searches still work.
calls = 0; env = { DB: fakeDB({ broken: true }) };
assert.equal((await apiShFetch(env, URL1, init)).status, 200);
console.log('PASS D1 failure falls back to a live request');

// 7. End to end through Rishi's searchNoBroker.
calls = 0; env = { DB: fakeDB(), API_SH: 'secret-key' };
const a = await searchNoBroker(env, { locality: 'whitefield', bhk: 2 });
const b = await searchNoBroker(env, { locality: 'whitefield', bhk: 2 });
assert.equal(a.results[0].id, 'nb-abc');
assert.deepEqual(a, b);
assert.equal(calls, 1);
console.log('PASS searchNoBroker: same results, second search costs no credit');
