import { LOCALITIES, CITY, tmo, median, pct, j } from './util.js';

export const DEMO = [
  { id: 'MC-001', locality: 'Whitefield', bhk: 2, rent: 32000, deposit: 150000, furnishing: 'semi', parking: 'car', features: 'Near metro; covered parking' },
  { id: 'MC-002', locality: 'Whitefield', bhk: 2, rent: 35000, deposit: 180000, furnishing: 'full', parking: 'car', features: 'Balcony; gym', gym: true },
  { id: 'MC-003', locality: 'Brookefield', bhk: 2, rent: 29000, deposit: 120000, furnishing: 'semi', parking: 'none', features: 'Balcony' },
  { id: 'MC-004', locality: 'Indiranagar', bhk: 1, rent: 28000, deposit: 140000, furnishing: 'full', parking: 'none', features: 'Near metro' },
  { id: 'MC-005', locality: 'Sarjapur Road', bhk: 3, rent: 48000, deposit: 240000, furnishing: 'semi', parking: 'car', features: 'Pool; parking', swimming_pool: true },
  { id: 'MC-006', locality: 'Bellandur', bhk: 2, rent: 39000, deposit: 200000, furnishing: 'none', parking: 'car', features: 'Lift; parking', lift: true },
].map(x => ({ ...x, source: 'demo', url: null, verified: false, note: 'Fictional demo listing; not real or bookable.' }));

// The showcase is synthetic, not a real Prestige property. Keep its contact in a Worker secret.
export function showcaseListing(locality) {
  const area = (locality || 'Bengaluru').trim().slice(0, 60);
  const slug = area.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'bengaluru';
  return { id: `MC-SHOWCASE-${slug}`, source: 'demo', is_showcase: true, title: 'Fictional Prestige-style demo apartment', locality: area, bhk: 2, rent: 45000, deposit: 180000, furnishing: 'semi', size_sqft: 1150, floor: 4, parking: 'car', lift: true, gym: true, swimming_pool: true, features: 'Balcony, lift, gym, pool and covered parking', owner_name: 'Rishi D V', owner_contact_available: true, url: null, note: 'Fictional demo property; locality is adapted to the search. No real property or Prestige affiliation is implied.' };
}

const fur = f => ({ Full: 'full', Semi: 'semi', None: 'none' }[f] ?? (f ? String(f).toLowerCase() : null));
export function normNoBroker(r) {
  return {
    id: 'nb-' + r.id, source: 'nobroker', url: r.url, title: r.title, locality: r.nb_locality || r.locality, street: r.street,
    bhk: parseInt(r.type) || null, rent: r.rent, deposit: r.deposit, negotiable: r.negotiable, maintenance: r.maintenance,
    maintenance_included: r.maintenance_included, size_sqft: r.size_sqft, floor: r.floor, total_floors: r.total_floors,
    furnishing: fur(r.furnishing), parking: (r.parking || 'none').toString().toLowerCase(), lift: !!r.lift, gym: !!r.gym,
    swimming_pool: !!r.swimming_pool, amenities: r.amenities || [], available_from: r.available_from, posted: r.created,
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
    const res = await fetch(u, { headers: { 'x-api-key': env.API_SH, Accept: 'application/json' }, signal: tmo(25000) });
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

export async function findListings(env, c, { includeDemo = false, includeShowcase = false } = {}) {
  const nb = await searchNoBroker(env, c);
  let list = nb.results;
  if (includeDemo) list = list.concat(DEMO.filter(d => !c.locality || d.locality.toLowerCase().includes(c.locality.toLowerCase())));
  if (includeShowcase) list = list.concat([showcaseListing(c.locality)]);
  await cacheListings(env, list);
  const want = c.locality?.toLowerCase();
  const ranked = list
    .filter(l => l.is_showcase || !c.bhk || l.bhk === c.bhk)
    .filter(l => l.is_showcase || !c.max_rent || l.rent <= c.max_rent * 1.1)
    .map(l => ({ ...l, ...score(l, c), locality_match: want ? (l.locality || '').toLowerCase().includes(want) : null }))
    .sort((a, b) => Number(b.is_showcase || 0) - Number(a.is_showcase || 0) || b.match_score - a.match_score || a.rent - b.rent);
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
