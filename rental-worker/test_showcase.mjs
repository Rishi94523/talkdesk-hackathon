import assert from 'node:assert/strict';
import { showcaseListing, findListings, normNoBroker, score } from './src/sources.js';

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
  const criteria = { locality: area, bhk: 1, max_rent: 10000, max_deposit: 40000, amenities: ['gym', 'garden'], furnishing: 'full', move_in_date: '2026-12-01', pets: true };
  const result = await findListings(env, criteria, { includeShowcase: true });
  const listing = result.results[0];
  assert.equal(listing.title, 'MergeConflicts Garden Residences');
  assert.equal(listing.bhk, 1);
  assert.ok(listing.rent <= criteria.max_rent && listing.deposit <= criteria.max_deposit);
  assert.equal(listing.furnishing, 'full');
  assert.equal(listing.available_from, criteria.move_in_date);
  assert.equal(listing.pets_allowed, true);
  assert.ok(listing.amenities.includes('garden'));
  assert.deepEqual(listing.mismatches, []);
  assert.notEqual(listing.id, d.id);
  assert.equal(saved.get(listing.id).locality, area);
}
const alert = await findListings(env, { locality: 'Whitefield' });
assert.equal(alert.results.some(x => x.is_showcase), false);
const unknown = normNoBroker({ id: 'example' });
assert.equal(unknown.lift, null);
assert.equal(unknown.gym, null);
assert.equal(unknown.parking, null);
assert.deepEqual(score(unknown, { amenities: ['gym'] }).mismatches, ['gym not specified']);
console.log('PASS adaptive showcase, mismatch disclosure, secret isolation and alert exclusion');
