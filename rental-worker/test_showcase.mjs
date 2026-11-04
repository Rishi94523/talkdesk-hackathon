import assert from 'node:assert/strict';
import { showcaseListing, findListings } from './src/sources.js';

const saved = new Map();
const env = { DB: {
  prepare(sql) { return { bind(...args) { return { sql, args }; } }; },
  async batch(statements) { for (const s of statements) saved.set(s.args[0], JSON.parse(s.args[2])); },
} };
for (const area of ['Whitefield', 'Koramangala']) {
  const d = showcaseListing(area);
  assert.equal(d.locality, area);
  assert.equal(d.source, 'demo');
  assert.equal(d.owner_name, 'Rishi D V');
  assert.ok(d.note.includes('Fictional'));
  assert.ok(!JSON.stringify(d).includes('9900000003'));
  const result = await findListings(env, { locality: area, bhk: 1, max_rent: 10000 }, { includeShowcase: true });
  assert.equal(result.results[0].id, d.id);
  assert.ok(result.results[0].mismatches.length > 0);
  assert.equal(saved.get(d.id).locality, area);
}
const alert = await findListings(env, { locality: 'Whitefield' });
assert.equal(alert.results.some(x => x.is_showcase), false);
console.log('PASS adaptive showcase, mismatch disclosure, secret isolation and alert exclusion');
