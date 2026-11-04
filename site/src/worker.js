// Read-only API for the public site. Never writes to D1 and never exposes tenant or owner phone numbers.
const json = (data, maxAge = 60) => new Response(JSON.stringify(data), {
  headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${maxAge}` },
});
const parse = s => { try { return JSON.parse(s); } catch { return null; } };

// Only fields that are safe and useful to show publicly.
const PUBLIC_FIELDS = ['id', 'source', 'url', 'title', 'locality', 'street', 'bhk', 'rent', 'deposit', 'negotiable', 'maintenance',
  'maintenance_included', 'size_sqft', 'floor', 'total_floors', 'furnishing', 'parking', 'lift', 'gym', 'swimming_pool',
  'available_from', 'updated', 'image', 'verified'];
const pick = l => Object.fromEntries(PUBLIC_FIELDS.filter(k => l[k] !== undefined).map(k => [k, l[k]]));

async function listings(env, url) {
  const q = url.searchParams;
  const locality = (q.get('locality') || '').toLowerCase().slice(0, 60);
  const bhk = parseInt(q.get('bhk')) || 0;
  const maxRent = parseInt(q.get('max_rent')) || 0;
  const furnishing = q.get('furnishing') || '';
  const sort = q.get('sort') || 'rent_asc';

  const rows = (await env.DB.prepare('SELECT data, fetched_at FROM listings_cache ORDER BY fetched_at DESC LIMIT 500').all()).results;
  let list = rows.map(r => ({ ...parse(r.data), fetched_at: r.fetched_at })).filter(l => l && l.id);
  const localities = [...new Set(list.map(l => l.locality).filter(Boolean))].sort();

  list = list
    .filter(l => !locality || (l.locality || '').toLowerCase().includes(locality))
    .filter(l => !bhk || l.bhk === bhk)
    .filter(l => !maxRent || (l.rent && l.rent <= maxRent))
    .filter(l => !furnishing || l.furnishing === furnishing);

  const sorters = {
    rent_asc: (a, b) => (a.rent || 1e9) - (b.rent || 1e9),
    rent_desc: (a, b) => (b.rent || 0) - (a.rent || 0),
    size_desc: (a, b) => (b.size_sqft || 0) - (a.size_sqft || 0),
    recent: (a, b) => String(b.updated || '').localeCompare(String(a.updated || '')),
  };
  list.sort(sorters[sort] || sorters.rent_asc);

  const rents = list.map(l => l.rent).filter(Boolean).sort((a, b) => a - b);
  const median = rents.length ? rents[Math.floor(rents.length / 2)] : null;
  const lastFetched = rows[0]?.fetched_at || null;
  return json({ total: list.length, median_rent: median, localities, last_fetched: lastFetched, results: list.slice(0, 60).map(pick) });
}

async function stats(env) {
  const count = sql => env.DB.prepare(sql).first('n').catch(() => null);
  const [listingsN, visits, alerts, deals] = await Promise.all([
    count('SELECT COUNT(*) n FROM listings_cache'),
    count('SELECT COUNT(*) n FROM visits'),
    count('SELECT COUNT(*) n FROM alerts WHERE active=1'),
    count('SELECT COUNT(*) n FROM deals'),
  ]);
  return json({ listings: listingsN, visits, alerts, deals, phone: env.CONCIERGE_PHONE || null }, 30);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
    try {
      if (url.pathname === '/api/listings') return await listings(env, url);
      if (url.pathname === '/api/stats') return await stats(env);
    } catch (e) {
      return json({ error: 'Data temporarily unavailable' }, 0);
    }
    if (url.pathname.startsWith('/api/')) return new Response('Not found', { status: 404 });
    return env.ASSETS.fetch(request);
  },
};
