// Research for the owner negotiation call: real comparable listings from the portal, the local market spread,
// and what residents and recent posts (Reddit, forums, news) say about rents and the locality. It runs just
// before the owner is dialled (in the queue), so the tenant's call never waits on it.
import { searchNoBroker, plausibleListing, researchLocality, getListing } from './sources.js';
import { median, pct, parseAmounts } from './util.js';

const inr = n => '₹' + Number(n).toLocaleString('en-IN');
const within = (p, ms) => Promise.race([p.catch(() => null), new Promise(r => setTimeout(() => r(null), ms))]);
const furn = f => !f ? '' : /^(none|un)/i.test(f) ? 'unfurnished' : `${String(f).replace(/-?furnished$/i, '')}-furnished`;

export function spokenListing(l) {
  return [`${l.bhk ? l.bhk + ' BHK' : 'Flat'} in ${l.locality || 'the area'}`, furn(l.furnishing), l.size_sqft ? `${l.size_sqft} sq ft` : '', `listed at ${inr(l.rent)} a month`, l.deposit ? `${inr(l.deposit)} deposit` : '']
    .filter(Boolean).join(', ');
}

// Same-size real listings at least 5% cheaper than this one, most similar (closest in rent) first.
// Same-size real listings at least 5% cheaper than this one; those nearest the local median first (they make the
// strongest "this is the going rate" argument), preferring ones with a known size.
export function comparables(listing, peers, n = 3) {
  const same = peers.filter(l => !l.is_showcase && l.id !== listing.id && plausibleListing(l) && (!listing.bhk || l.bhk === listing.bhk));
  const med = median(same.map(l => l.rent)) ?? listing.rent * 0.85;
  return same.filter(l => listing.rent && l.rent <= listing.rent * 0.95 && l.rent >= listing.rent * 0.5)
    .sort((a, b) => Math.abs(a.rent - med) - Math.abs(b.rent - med) || (b.size_sqft ? 1 : 0) - (a.size_sqft ? 1 : 0))
    .slice(0, n);
}

const PRICE = /rent|₹|rs\.?\s?\d|\d+\s?k\b|deposit|per month|lakh|bhk/i;
const DOWNSIDE = /traffic|water|tanker|flood|power cut|noise|construction|commute|pothole|overpriced|expensive|vacan|oversupply/i;
const clip = s => String(s || '').replace(/\s+/g, ' ').slice(0, 220);

// Turn search results into a few short, attributable points. Only pricing and downside evidence is useful here.
export function researchPoints(research, listing = {}) {
  const otherSize = listing.bhk ? new RegExp(`\\b(?!${listing.bhk}\\s?bhk)\\d\\s?bhk`, 'i') : null;
  const tooHigh = x => listing.rent && parseAmounts(`${x.title} ${x.snippet}`).some(n => n > listing.rent && n < listing.rent * 3);
  const fits = (x, re) => re.test(`${x.title} ${x.snippet}`) && (re !== PRICE || (!(otherSize && otherSize.test(`${x.title} ${x.snippet}`)) && !tooHigh(x)));
  const pick = (items, re, n) => (items || []).filter(x => fits(x, re)).slice(0, n)
    .map(x => ({ source: clip(x.title).slice(0, 90) || 'web source', point: clip(x.snippet) }));
  return [...pick(research?.pricing, PRICE, 2), ...pick(research?.reviews, DOWNSIDE, 2)];
}

export function negotiationLevers(listing, { peers = [], market = null, comps = [], research = [] }) {
  const rents = peers.filter(l => !l.is_showcase && plausibleListing(l) && (!listing.bhk || l.bhk === listing.bhk)).map(l => l.rent);
  const m = rents.length >= 3 ? { median_rent: median(rents), p25_rent: pct(rents, 0.25), p75_rent: pct(rents, 0.75), sample: rents.length } : market;
  const levers = [];
  if (m?.median_rent && listing.rent > m.median_rent * 1.02)
    levers.push(`The median asking rent for ${listing.bhk ? listing.bhk + ' BHK ' : ''}flats in ${listing.locality} is ${inr(m.median_rent)} across ${m.sample} current listings, about ${Math.round((listing.rent / m.median_rent - 1) * 100)}% below this asking rent of ${inr(listing.rent)}.`);
  if (comps.length) levers.push(`The tenant has cheaper options nearby, for example ${comps.map(spokenListing).join('; ')}.`);
  const months = listing.deposit && listing.rent ? +(listing.deposit / listing.rent).toFixed(1) : null;
  if (months && months > 3) levers.push(`The deposit is ${months} months of rent; 2 to 3 months is a reasonable ask.`);
  for (const r of research) levers.push(`From ${r.source}: ${r.point}`);
  return { market: m, levers };
}

export async function enrichNegotiation(env, briefing) {
  if (briefing?.task !== 'negotiation' || briefing.research_done) return briefing;
  const cached = (await getListing(env, briefing.listing?.id)) || {};
  const listing = { ...cached, ...briefing.listing, rent: briefing.listed_terms?.rent ?? cached.rent, deposit: briefing.listed_terms?.deposit ?? cached.deposit };
  const [nb, web] = await Promise.all([
    within(searchNoBroker(env, { locality: listing.locality, bhk: listing.bhk }), 15000),
    within(researchLocality(env, listing.locality, 'Bengaluru', ['pricing', 'reviews']), 20000),
  ]);
  const peers = nb?.results || [];
  const comps = comparables(listing, peers);
  const research = researchPoints(web, listing);
  const { market, levers } = negotiationLevers(listing, { peers, market: listing.market_comparison, comps, research });
  return { ...briefing, research_done: true, market, comparable_listings: comps.map(spokenListing), web_research: research,
    levers: [...levers, ...(briefing.levers || [])],
    examples_to_quote: comps.map(spokenListing),
    how_to_use_research: 'If the owner asks for examples, read examples_to_quote one by one. Argue with these facts, one at a time, starting with the strongest: the local median, then a cheaper comparable listing, then the deposit, then a resident or market point. Say where each point comes from in plain words (for example "listings on NoBroker" or "residents on Reddit"). Never invent figures, never read a URL and never claim the tenant has seen a listing.' };
}
