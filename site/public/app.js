const $ = (s, el = document) => el.querySelector(s);
const inr = n => (n == null ? '–' : '₹' + Number(n).toLocaleString('en-IN'));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const FURNISH = { full: 'Fully furnished', semi: 'Semi-furnished', none: 'Unfurnished' };
const HOUSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>';

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

async function loadStats() {
  try {
    const s = await fetch('/api/stats').then(r => r.json());
    let shown = 0;
    for (const k of ['listings', 'visits', 'alerts', 'deals']) {
      const el = $(`[data-stat="${k}"]`);
      if (!el) continue;
      el.textContent = s[k] ?? '–';
      el.parentElement.hidden = !s[k]; // hide counters that are still zero
      if (s[k]) shown++;
    }
    const grid = $('.stats-grid');
    grid.style.gridTemplateColumns = `repeat(${Math.max(shown, 1)}, 1fr)`;
    if (!shown) $('.stats').hidden = true;
    if (s.phone) {
      const tel = 'tel:' + s.phone.replace(/[^\d+]/g, '');
      $('[data-phone-line]').hidden = false;
      Object.assign($('[data-phone]'), { href: tel, textContent: s.phone });
      for (const el of document.querySelectorAll('[data-call], [data-call-primary]')) {
        el.href = tel;
        el.textContent = el.hasAttribute('data-call') ? 'Call now' : 'Call the concierge';
      }
    }
  } catch { /* stats are decorative */ }
}

function card(l) {
  const img = `<div class="img">${HOUSE}${l.image ? `<img src="${esc(l.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}`;
  const facts = [
    l.size_sqft && `${l.size_sqft} sq ft`,
    l.floor != null && l.total_floors && `Floor ${l.floor} of ${l.total_floors}`,
    FURNISH[l.furnishing],
    l.parking && l.parking !== 'none' && `${l.parking[0].toUpperCase() + l.parking.slice(1)} parking`,
    l.lift && 'Lift', l.gym && 'Gym', l.swimming_pool && 'Pool',
    l.negotiable && 'Negotiable',
  ].filter(Boolean);
  const maint = l.maintenance ? (l.maintenance_included ? 'maintenance incl.' : `+ ${inr(l.maintenance)} maint.`) : '';
  return `<article class="card">
    ${img}<span class="badge">${l.bhk ? l.bhk + ' BHK' : 'Flat'} · ${esc(l.locality || 'Bengaluru')}</span></div>
    <div class="body">
      <div class="price"><b>${inr(l.rent)}</b><span>/ month ${maint}</span></div>
      <h3>${esc(l.title || 'Rental flat')}</h3>
      ${l.street ? `<p class="addr">${esc(l.street)}</p>` : ''}
      <ul class="facts"><li>Deposit ${inr(l.deposit)}</li>${facts.map(f => `<li>${esc(f)}</li>`).join('')}</ul>
      <div class="foot">
        <span>${l.updated ? 'Updated ' + ago(l.updated) : ''}</span>
        ${l.url ? `<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">View source ↗</a>` : '<span>Demo listing</span>'}
      </div>
    </div>
  </article>`;
}

let first = true;
async function loadListings() {
  const grid = $('[data-grid]');
  const form = $('[data-filters]');
  const params = new URLSearchParams([...new FormData(form)].filter(([, v]) => v));
  grid.innerHTML = '<div class="skeleton"></div>'.repeat(3);
  try {
    const d = await fetch('/api/listings?' + params).then(r => r.json());
    if (d.error) throw new Error(d.error);
    if (first) {
      const sel = form.elements.locality;
      for (const loc of d.localities) sel.add(new Option(loc, loc));
      first = false;
    }
    const meta = [`${d.total} listing${d.total === 1 ? '' : 's'}`];
    if (d.median_rent) meta.push(`median rent ${inr(d.median_rent)}`);
    if (d.last_fetched) meta.push(`last refreshed ${ago(d.last_fetched)}`);
    $('[data-listing-meta]').textContent = meta.join(' · ');
    grid.innerHTML = d.results.length
      ? d.results.map(card).join('')
      : '<div class="empty">No listings match these filters yet. Call the concierge and it will search the live portal for you.</div>';
  } catch {
    $('[data-listing-meta]').textContent = 'Listings are unavailable right now.';
    grid.innerHTML = '<div class="empty">We couldn\'t load listings. Please try again in a moment.</div>';
  }
}

let timer;
$('[data-filters]').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(loadListings, 250); });
$('[data-filters]').addEventListener('submit', e => { e.preventDefault(); loadListings(); });
loadStats();
loadListings();
