// The showcase is priced above its real peers (never the cheapest), and the owner negotiation call is
// armed with the local median, cheaper comparable listings, the deposit norm and web research.
import assert from 'node:assert/strict';
import { showcasePrice, showcaseListing } from './src/sources.js';
import { comparables, researchPoints, negotiationLevers, spokenListing } from './src/negotiation.js';

const peers = [52000, 55000, 58000, 60000, 62000, 64000, 65000, 70000, 72000].map((rent, i) => ({ id: 'nb' + i, rent, bhk: 3, locality: 'Bellandur', size_sqft: 1500, furnishing: 'semi', deposit: rent * 3 }));
const price = showcasePrice({ bhk: 3, max_rent: 70000 }, peers);
assert.equal(price.market.median_rent, 62000);
assert.ok(price.rent > price.market.median_rent && price.rent <= 70000, `showcase ${price.rent} sits above the median and inside the budget`);
assert.ok(peers.filter(p => p.rent < price.rent).length >= 5, 'several real listings are cheaper');
assert.equal(price.deposit, price.rent * 5);
const show = showcaseListing({ locality: 'Bellandur', bhk: 3, max_rent: 70000 }, price);
assert.equal(show.rent, price.rent);
assert.equal(show.market_comparison.median_rent, 62000);
assert.equal(showcasePrice({ bhk: 2, max_rent: 30000 }, []).rent, 29000, 'no peers: just under the budget');

const comps = comparables(show, peers);
assert.equal(comps.length, 3);
assert.ok(comps.every(c => c.rent <= show.rent * 0.95));
assert.match(spokenListing(comps[0]), /3 BHK in Bellandur, semi-furnished, 1500 sq ft, listed at ₹/);
const research = researchPoints({
  pricing: [{ title: 'Bellandur rents 2026', snippet: '3 BHK rent in Bellandur is around ₹60k per month' }, { title: 'Unrelated', snippet: 'Best cafes' }],
  reviews: [{ title: 'r/bangalore: living in Bellandur', snippet: 'Traffic on ORR is brutal and water tankers in summer' }],
});
assert.deepEqual(research.map(r => r.source), ['Bellandur rents 2026', 'r/bangalore: living in Bellandur']);
const { market, levers } = negotiationLevers(show, { peers, comps, research });
assert.equal(market.sample, 9);
assert.match(levers[0], /median asking rent .* is ₹62,000 across 9 current listings/);
assert.match(levers[1], /cheaper options nearby/);
assert.match(levers[2], /deposit is 5 months/);
assert.match(levers.at(-1), /water tankers/);
console.log('PASS showcase priced above peers; negotiation armed with market, comparables and research');
