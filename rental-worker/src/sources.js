import { LOCALITIES, CITY, tmo, median, pct, j } from './util.js';
import { apiShFetch } from './apish_cache.js';

export const DEMO = [
  { id: 'MC-001', locality: 'Whitefield', bhk: 2, rent: 32000, deposit: 150000, furnishing: 'semi', parking: 'car', features: 'Near metro; covered parking' },
  { id: 'MC-002', locality: 'Whitefield', bhk: 2, rent: 35000, deposit: 180000, furnishing: 'full', parking: 'car', features: 'Balcony; gym', gym: true },
  { id: 'MC-003', locality: 'Brookefield', bhk: 2, rent: 29000, deposit: 120000, furnishing: 'semi', parking: 'none', features: 'Balcony' },
  { id: 'MC-004', locality: 'Indiranagar', bhk: 1, rent: 28000, deposit: 140000, furnishing: 'full', parking: 'none', features: 'Near metro' },
  { id: 'MC-005', locality: 'Sarjapur Road', bhk: 3, rent: 48000, deposit: 240000, furnishing: 'semi', parking: 'car', features: 'Pool; parking', swimming_pool: true },
  { id: 'MC-006', locality: 'Bellandur', bhk: 2, rent: 39000, deposit: 200000, furnishing: 'none', parking: 'car', features: 'Lift; parking', lift: true },
].map(x => ({ ...x, source: 'demo', url: null, verified: false, note: 'Fictional demo listing; not real or bookable.' }));

// The showcase is synthetic, not a real Prestige property. Keep its contact in a Worker secret.
export function showcaseListing(criteria = {}) {
  const c = typeof criteria === 'string' ? { locality: criteria } : criteria;
  const area = (c.locality || 'Bengaluru').trim().slice(0, 60);
  const slug = area.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'bengaluru';
  const selected = { bhk: c.bhk || 2, max_rent: c.max_rent || null, max_deposit: c.max_deposit || null, furnishing: c.furnishing || null, amenities: [...(c.amenities || [])].sort(), property_type: c.property_type || null, move_in_date: c.move_in_date || null, pets: c.pets ?? null, requested_preferences: c.requested_preferences || null };
  // Different simulated configurations must not overwrite one another in the shared cache.
  let hash = 2166136261;
  for (const ch of JSON.stringify(selected)) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619);
  const amenities = [...new Set(['Balcony', 'lift', 'gym', 'swimming pool', 'covered parking', ...selected.amenities])];
  return { id: `MC-SHOWCASE-${slug}-${(hash >>> 0).toString(36)}`, source: 'demo', is_showcase: true, title: 'MergeConflicts Garden Residences', locality: area, bhk: selected.bhk, rent: Math.min(45000, selected.max_rent || 45000), deposit: Math.min(180000, selected.max_deposit || 180000), furnishing: selected.furnishing || 'semi', property_type: selected.property_type || 'apartment', available_from: selected.move_in_date, pets_allowed: selected.pets, size_sqft: 1150, floor: 4, parking: 'car', lift: true, gym: true, swimming_pool: true, amenities, features: amenities.join(', '), demo_requested_preferences: selected.requested_preferences, owner_name: 'Rishi D V', owner_contact_available: true, url: null, note: 'Fictional demo property. Its details are generated from the search preferences and do not describe a real property.',
    details: {
      address: `Tower B, MergeConflicts Garden Residences, off the main road in ${area}, Bengaluru (fictional)`,
      owner: 'Rishi D V, the owner, manages the flat directly (no broker, no brokerage fee).',
      layout: `${selected.bhk} BHK, about 1,150 sq ft, 4th floor of 12, east-facing, ${selected.bhk} bathrooms, two balconies.`,
      furnishing_items: (selected.furnishing || 'semi') === 'full' ? 'Fully furnished: beds, sofa, dining table, fridge, washing machine, TV, ACs in bedrooms.' : (selected.furnishing === 'none' ? 'Unfurnished: kitchen cabinets and lights only.' : 'Semi-furnished: modular kitchen, wardrobes, geysers, fans and lights.'),
      maintenance: 'About Rs 3,500 per month, paid separately.',
      lease: '11-month agreement, 6-month lock-in, 2 months notice.',
      society: 'Gated society with 24x7 security, full power backup, clubhouse, swimming pool, gym, kids play area and covered car parking.',
      water: 'Borewell plus Cauvery water supply.',
      pets: selected.pets === false ? 'Pets not required.' : 'Small pets allowed with prior permission.',
      availability: selected.move_in_date ? `Available from ${selected.move_in_date}.` : 'Available immediately.',
      preferred_tenants: 'Families or working professionals.',
      viewing: 'The owner can usually show the flat on weekday evenings and weekends; viewings are arranged through this assistant.',
    } };
}

const fur = f => ({ Full: 'full', Semi: 'semi', None: 'none' }[f] ?? (f ? String(f).toLowerCase() : null));
export function normNoBroker(r) {
  return {
    id: 'nb-' + r.id, source: 'nobroker', url: r.url, title: r.title, locality: r.nb_locality || r.locality, street: r.street,
    bhk: parseInt(r.type) || null, rent: r.rent, deposit: r.deposit, negotiable: r.negotiable, maintenance: r.maintenance,
    maintenance_included: r.maintenance_included, size_sqft: r.size_sqft, floor: r.floor, total_floors: r.total_floors,
    furnishing: fur(r.furnishing), parking: r.parking == null ? null : String(r.parking).toLowerCase(), lift: r.lift == null ? null : !!r.lift, gym: r.gym == null ? null : !!r.gym,
    swimming_pool: r.swimming_pool == null ? null : !!r.swimming_pool, amenities: r.amenities || [], available_from: r.available_from, posted: r.created,
    updated: r.updated, lat: r.latitude, lon: r.longitude, image: r.image, verified: r.verified ?? false,
    note: 'Third-party portal listing: may be stale; owner contact not provided; verify before paying anything.',
  };
}

export async function searchNoBroker(env, { locality, bhk, city = 'bangalore', page = 1 }) {
  if (!env.API_SH) return { error: 'API_SH not configured', results: [] };
  const c = LOCALITIES[(locality || '').toLowerCase()] || CITY[city.toLowerCase()] || CITY.bangalore;
  const u = new URL('https://api.api.sh/nobroker/v1/search');
  u.search = new URLSearchParams({ city, kind: 'rent', ...(bhk ? { bhk } : {}), lat: c[0], lon: c[1], page }).toString();
  try {
    const res = await apiShFetch(env, u, { headers: { 'x-api-key': env.API_SH, Accept: 'application/json' }, signal: tmo(25000) });
    if (!res.ok) return { error: 'NoBroker search failed: HTTP ' + res.status, results: [] };
    const d = await res.json();
    return { total: d.total, results: (d.results || []).map(normNoBroker) };
  } catch (e) { return { error: 'NoBroker search unavailable', results: [] }; }
}

export function score(l, p = {}) {
  let s = 100; const miss = [];
  if (p.max_rent && l.rent > p.max_rent) { s -= 40; miss.push(`rent ${l.rent} > budget ${p.max_rent}`); }
  if (p.max_deposit && l.deposit > p.max_deposit) { s -= 20; miss.push(`deposit ${l.deposit} > ${p.max_deposit}`); }
  if (p.bhk && l.bhk !== p.bhk) { s -= 25; miss.push(`${l.bhk} BHK`); }
  for (const a of p.amenities || []) {
    const k = a.toLowerCase();
    const unknown = k.includes('park') ? l.parking == null : k.includes('gym') ? l.gym == null : k.includes('pool') ? l.swimming_pool == null : k.includes('lift') ? l.lift == null : false;
    if (unknown) { s -= 4; miss.push(a + ' not specified'); continue; }
    const has = k.includes('park') ? l.parking && l.parking !== 'none' : k.includes('gym') ? l.gym : k.includes('pool') ? l.swimming_pool : k.includes('lift') ? l.lift : (l.amenities || []).join(' ').toLowerCase().includes(k) || (l.features || '').toLowerCase().includes(k);
    if (!has) { s -= 8; miss.push('no ' + a); }
  }
  if (p.furnishing && l.furnishing && l.furnishing !== p.furnishing) { s -= 8; miss.push('furnishing ' + l.furnishing); }
  return { match_score: Math.max(0, s), mismatches: miss };
}

export async function cacheListings(env, list) {
  if (!list.length) return;
  await env.DB.batch(list.map(l => env.DB.prepare('INSERT INTO listings_cache(id,source,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data, fetched_at=CURRENT_TIMESTAMP').bind(l.id, l.source, JSON.stringify(l))));
}
export async function getListing(env, id) {
  const d = DEMO.find(x => x.id === id); if (d) return d;
  const r = await env.DB.prepare('SELECT data FROM listings_cache WHERE id=?').bind(id).first();
  return r ? j(r.data) : null;
}


// Portal data includes lease listings with no monthly rent, lakh-scale lease amounts and implausible sizes.
const MIN_SQFT = { 1: 350, 2: 650, 3: 950, 4: 1300, 5: 1600 };
export function plausibleListing(l) {
  if (!l.rent || l.rent < 8000 || l.rent > 500000) return false;
  if (/\blease\b/i.test(l.title || '')) return false;
  if (l.size_sqft && l.bhk && l.size_sqft < (MIN_SQFT[l.bhk] || 0)) return false;
  return true;
}
// Prefer well-kept apartments in a society near the tenant's budget over the cheapest standalone houses.
export function qualityScore(l, c = {}) {
  let q = 0;
  const t = `${l.title || ''} ${l.street || ''}`.toLowerCase();
  if (l.lift) q += 10; if (l.gym) q += 10; if (l.swimming_pool) q += 10;
  if (l.parking && l.parking !== 'none') q += 4;
  if (/apartment|residen|society|enclave|heights|towers|gardens|homes|villa/.test(t)) q += 8;
  if (/stand ?alone|independent house|house for rent/.test(t)) q -= 8;
  if (l.furnishing === 'semi' || l.furnishing === 'full') q += 4;
  if (l.verified) q += 6;
  if (l.size_sqft && l.bhk) q += Math.max(-10, Math.min(10, Math.round((l.size_sqft / (MIN_SQFT[l.bhk] || 650) - 1.4) * 15)));
  if (c.max_rent && l.rent) { const r = l.rent / c.max_rent; q += r >= 0.7 && r <= 1.05 ? 12 : r >= 0.5 ? 4 : -10; }
  return q;
}

export async function findListings(env, c, { includeDemo = false, includeShowcase = false } = {}) {
  const nb = await searchNoBroker(env, c);
  let list = nb.results;
  if (includeDemo) list = list.concat(DEMO.filter(d => !c.locality || d.locality.toLowerCase().includes(c.locality.toLowerCase())));
  if (includeShowcase) list = list.concat([showcaseListing(c)]);
  await cacheListings(env, list);
  const want = c.locality?.toLowerCase();
  const ranked = list
    .filter(l => l.is_showcase || plausibleListing(l))
    .filter(l => l.is_showcase || !c.max_rent || l.rent >= c.max_rent * 0.4) // far below budget is usually bad data or a different market
    .filter(l => l.is_showcase || !c.bhk || l.bhk === c.bhk)
    .filter(l => l.is_showcase || !c.max_rent || l.rent <= c.max_rent * 1.1)
    .map(l => ({ ...l, ...score(l, c), quality: qualityScore(l, c), locality_match: want ? (l.locality || '').toLowerCase().includes(want) : null }))
    .sort((a, b) => Number(b.is_showcase || 0) - Number(a.is_showcase || 0) || b.match_score - a.match_score || b.quality - a.quality || b.rent - a.rent);
  return { total_on_portal: nb.total, warning: nb.error, results: ranked };
}

export async function marketStats(env, { locality, bhk }) {
  const nb = await searchNoBroker(env, { locality, bhk });
  const rows = nb.results.filter(l => l.rent && (!bhk || l.bhk === bhk));
  const rents = rows.map(l => l.rent), deps = rows.filter(l => l.deposit).map(l => l.deposit / l.rent);
  return {
    sample: rows.length, median_rent: median(rents), p25_rent: pct(rents, .25), p75_rent: pct(rents, .75),
    median_deposit_months: deps.length ? +(median(deps.map(x => Math.round(x * 100))) / 100).toFixed(1) : null,
    negotiable_share: rows.length ? +(rows.filter(l => l.negotiable).length / rows.length).toFixed(2) : null,
    per_sqft_median: median(rows.filter(l => l.size_sqft).map(l => Math.round(l.rent / l.size_sqft))),
    warning: nb.error,
  };
}

const trim = (s, n = 400) => (s || '').toString().replace(/\s+/g, ' ').slice(0, n);
export async function firecrawlSearch(env, query, limit = 4) {
  if (!env.FIRECRAWL_API) return [];
  try {
    const r = await fetch('https://api.firecrawl.dev/v2/search', { method: 'POST', headers: { Authorization: 'Bearer ' + env.FIRECRAWL_API, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, limit }), signal: tmo(25000) });
    if (!r.ok) return [];
    const d = await r.json();
    return (d.data?.web || []).map(x => ({ provider: 'firecrawl', url: x.url, title: trim(x.title, 150), snippet: trim(x.description) }));
  } catch { return []; }
}
export async function parallelSearch(env, objective) {
  if (!env.PARALLEL_API_KEY) return [];
  try {
    const r = await fetch('https://api.parallel.ai/v1/search', { method: 'POST', headers: { 'x-api-key': env.PARALLEL_API_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ objective, search_queries: [objective], mode: 'fast' }), signal: tmo(30000) });
    if (!r.ok) return [];
    const d = await r.json();
    return (d.results || []).slice(0, 5).map(x => ({ provider: 'parallel', url: x.url, title: trim(x.title, 150), snippet: trim(Array.isArray(x.excerpts) ? x.excerpts.join(' ') : x.excerpt || x.snippet, 500) }));
  } catch { return []; }
}
export async function scrapeMarkdown(env, url, max = 3500) {
  if (!env.FIRECRAWL_API) return null;
  try {
    const r = await fetch('https://api.firecrawl.dev/v2/scrape', { method: 'POST', headers: { Authorization: 'Bearer ' + env.FIRECRAWL_API, 'Content-Type': 'application/json' }, body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true }), signal: tmo(40000) });
    if (!r.ok) return null; const d = await r.json(); return trim(d.data?.markdown, max);
  } catch { return null; }
}

const TOPICS = {
  reviews: (l, c) => [`${l} ${c} living experience reviews reddit`, `What do residents say about living in ${l}, ${c}? Pros and cons from Reddit and local forums.`],
  safety: (l, c) => [`${l} ${c} safety crime night women reddit`, `Is ${l}, ${c} safe? Reports on crime, street safety, and women's safety from residents.`],
  scams: (l, c) => [`${l} ${c} rental scam broker deposit refund complaint`, `Rental scams, deposit non-refund complaints, and shady broker practices in ${l}, ${c}.`],
  pricing: (l, c) => [`${l} ${c} 2bhk rent deposit 2026`, `Current typical rent and security deposit for apartments in ${l}, ${c}, 2026.`],
  schools: (l, c) => [`best schools near ${l} ${c}`, `Schools near ${l}, ${c} with ratings.`],
  amenities: (l, c) => [`${l} ${c} hospitals metro supermarkets connectivity traffic`, `Hospitals, metro or bus connectivity, shopping and traffic situation in ${l}, ${c}.`],
};
export const TOPIC_NAMES = Object.keys(TOPICS);
// Orchestrated fan-out: every topic x (Firecrawl + Parallel) runs concurrently.
export async function researchLocality(env, locality, city, topics) {
  const names = (topics?.length ? topics : TOPIC_NAMES).filter(t => TOPICS[t]);
  const out = await Promise.all(names.map(async t => {
    const [fq, pq] = TOPICS[t](locality, city);
    const [fc, pa] = await Promise.all([firecrawlSearch(env, fq), parallelSearch(env, pq)]);
    const seen = new Set(), items = [];
    for (const x of [...fc, ...pa]) if (x.url && !seen.has(x.url)) { seen.add(x.url); items.push(x); }
    return [t, items];
  }));
  return Object.fromEntries(out);
}

const inrShort = n => n >= 100000 ? `${+(n / 100000).toFixed(1)} lakh rupees` : `${Number(n).toLocaleString('en-IN')} rupees`;
// One-line spoken description of a listing (no URLs).
export function briefOf(l) {
  if (l.source === 'web') return `${l.title || 'Web listing'}${l.snippet ? ': ' + l.snippet.slice(0, 140) : ''}`;
  const am = [l.swimming_pool && 'swimming pool', l.gym && 'gym', l.lift && 'lift', l.parking && l.parking !== 'none' && `${l.parking} parking`].filter(Boolean);
  return [
    `${l.bhk ? l.bhk + ' BHK' : 'Home'} in ${l.locality || 'Bengaluru'}`,
    l.rent ? `${inrShort(l.rent)} a month` : null,
    l.deposit ? `${inrShort(l.deposit)} deposit` : null,
    l.furnishing ? (/^(none|un)/.test(l.furnishing) ? 'unfurnished' : `${l.furnishing.replace(/-?furnished$/, '')}-furnished`) : null,
    l.size_sqft ? `${l.size_sqft} sq ft` : null,
    am.length ? 'with ' + am.slice(0, 3).join(', ') : null,
  ].filter(Boolean).join(', ');
}
export function webLeadListing(x) {
  let h = 2166136261; for (const ch of x.url) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return { id: 'web-' + (h >>> 0).toString(36), source: 'web', provider: x.provider, title: x.title, snippet: x.snippet, url: x.url, note: 'Web search lead, not a verified listing; details and availability unconfirmed and no owner contact.' };
}

// Compact facts for describing one option in detail; never includes phone numbers or URLs.
export function factsOf(l) {
  if (l.source === 'web') return { kind: 'web lead (unverified, no owner contact)', snippet: l.snippet || null };
  const keep = ['locality', 'bhk', 'rent', 'deposit', 'negotiable', 'maintenance', 'maintenance_included', 'size_sqft', 'floor', 'total_floors', 'furnishing', 'parking', 'lift', 'gym', 'swimming_pool', 'amenities', 'available_from', 'property_type', 'owner_name', 'details'];
  const f = Object.fromEntries(keep.filter(k => l[k] != null && !(Array.isArray(l[k]) && !l[k].length)).map(k => [k, l[k]]));
  if (Array.isArray(f.amenities)) f.amenities = f.amenities.slice(0, 10);
  f.viewing_can_be_arranged = !!l.owner_contact_available;
  return f;
}
