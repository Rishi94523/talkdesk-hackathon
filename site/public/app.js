const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const inr = n => (n == null ? '–' : '₹' + Number(n).toLocaleString('en-IN'));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const FURNISH = { full: 'Fully furnished', semi: 'Semi-furnished', none: 'Unfurnished' };
const HOUSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>';
const filters = $('[data-filters]');
const quick = $('[data-quick]');

function ago(iso) {
  if (!iso) return '';
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  const days = Math.round((Date.now() - d) / 864e5);
  if (isNaN(days)) return '';
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function setPhone(phone) {
  if (!phone) return;
  const tel = 'tel:' + phone.replace(/[^\d+]/g, '');
  $('[data-call]').href = tel;
  $('[data-call]').textContent = 'Call ' + phone;
  for (const el of $$('[data-call-primary]')) { el.href = tel; el.textContent = 'Call ' + phone; }
}

function setStat(key, value) {
  const el = $(`[data-stat="${key}"]`);
  if (!el) return;
  el.textContent = value ?? '–';
  el.parentElement.hidden = !value; // hide counters that are empty or zero
}

async function loadOverview() {
  try {
    const [s, all] = await Promise.all([
      fetch('/api/stats').then(r => r.json()),
      fetch('/api/listings?sort=rent_asc').then(r => r.json()),
    ]);
    setPhone(s.phone);
    for (const sel of [filters.elements.locality, quick.elements.locality])
      for (const loc of all.localities || []) sel.add(new Option(loc, loc));
    setStat('listings', s.listings);
    setStat('median', all.median_rent && inr(all.median_rent));
    setStat('cheapest', all.results?.[0]?.rent && inr(all.results[0].rent));
    setStat('visits', s.visits);
    const shown = $$('.stats-grid > div').filter(d => !d.hidden).length;
    $('.stats-grid').style.setProperty('--cols', shown || 1);
    $('[data-stats]').hidden = !s.listings;
    $('[data-live]').textContent = `live · ${s.listings ?? 0} flats`;
    $('.panel-foot .dot').classList.add('on');
    if (all.last_fetched) $('[data-quick-meta]').textContent = `Live listings from NoBroker · refreshed ${ago(all.last_fetched)}`;
  } catch {
    $('[data-live]').textContent = 'offline';
  }
}

function card(l) {
  const specs = [
    ['Deposit', inr(l.deposit)],
    ['Size', l.size_sqft && `${l.size_sqft} sq ft`],
    ['Floor', l.floor != null && l.total_floors ? `${l.floor} of ${l.total_floors}` : null],
    ['Furnish', FURNISH[l.furnishing]],
    ['Parking', l.parking && l.parking !== 'none' ? l.parking[0].toUpperCase() + l.parking.slice(1) : 'None'],
    ['Extras', [l.lift && 'Lift', l.gym && 'Gym', l.swimming_pool && 'Pool'].filter(Boolean).join(', ') || null],
  ].filter(([, v]) => v);
  const maint = l.maintenance ? (l.maintenance_included ? 'incl. maintenance' : `+ ${inr(l.maintenance)} maint.`) : '';
  const photo = l.image && !l.image.includes('/static/img/'); // NoBroker's "no photo" placeholder lives under /static/img/
  return `<article class="card">
    <div class="img">${HOUSE}${photo ?`<img src="${esc(l.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
      <span class="badge">${l.bhk ? l.bhk + ' BHK' : 'Flat'} · ${esc(l.locality || 'Bengaluru')}</span>
      ${l.negotiable ? '<span class="neg">Negotiable</span>' : ''}
    </div>
    <div class="body">
      <div class="price"><b>${inr(l.rent)}</b><span>/ month ${maint}</span></div>
      <h3>${esc(l.title || 'Rental flat')}</h3>
      ${l.street ? `<p class="addr">${esc(l.street)}</p>` : ''}
      <dl class="specs">${specs.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
      <div class="foot">
        <span>${l.updated ? 'Updated ' + ago(l.updated) : ''}</span>
        ${l.url ? `<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">See listing ↗</a>` : '<span>Demo listing</span>'}
      </div>
    </div>
  </article>`;
}

async function loadListings() {
  const grid = $('[data-grid]');
  const params = new URLSearchParams([...new FormData(filters)].filter(([, v]) => v));
  grid.innerHTML = '<div class="skeleton"></div>'.repeat(3);
  try {
    const d = await fetch('/api/listings?' + params).then(r => r.json());
    if (d.error) throw new Error(d.error);
    const meta = [`${d.total} flat${d.total === 1 ? '' : 's'}`];
    if (d.median_rent) meta.push(`median ${inr(d.median_rent)}`);
    $('[data-listing-meta]').textContent = meta.join(' · ');
    grid.innerHTML = d.results.length
      ? d.results.map(card).join('')
      : '<div class="empty">No flats match these filters yet. Give us a call and we\'ll search for you.</div>';
  } catch {
    $('[data-listing-meta]').textContent = 'Unavailable right now';
    grid.innerHTML = '<div class="empty">We couldn\'t load flats. Please try again in a moment.</div>';
  }
}

let timer;
filters.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(loadListings, 250); });
filters.addEventListener('submit', e => { e.preventDefault(); loadListings(); });

// Quick search copies its choices into the main filters, then jumps to the results.
quick.addEventListener('submit', e => {
  e.preventDefault();
  for (const k of ['locality', 'bhk', 'max_rent']) filters.elements[k].value = quick.elements[k].value;
  loadListings();
  $('#listings').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
});

loadOverview();
loadListings();
