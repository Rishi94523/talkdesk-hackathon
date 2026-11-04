import { send, defaultChannel } from './notify.js';
import { findListings, getListing, marketStats } from './sources.js';
import { j, normPhone } from './util.js';

const fmtTime = iso => new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const inr = n => '₹' + Number(n).toLocaleString('en-IN');

export async function getProfile(env, phone) {
  const r = await env.DB.prepare('SELECT * FROM profiles WHERE phone=?').bind(phone).first();
  return r ? { phone: r.phone, name: r.name, whatsapp_ok: !!r.whatsapp_ok, ...j(r.prefs) } : null;
}
export async function saveProfile(env, phone, name, prefs, whatsapp_ok) {
  const old = await getProfile(env, phone);
  const { phone: _p, name: _n, whatsapp_ok: _w, ...oldPrefs } = old || {};
  const merged = { ...oldPrefs, ...Object.fromEntries(Object.entries(prefs || {}).filter(([, v]) => v !== undefined && v !== null)) };
  await env.DB.prepare('INSERT INTO profiles(phone,name,prefs,whatsapp_ok) VALUES(?,?,?,?) ON CONFLICT(phone) DO UPDATE SET name=COALESCE(excluded.name,name), prefs=excluded.prefs, whatsapp_ok=excluded.whatsapp_ok, updated_at=CURRENT_TIMESTAMP')
    .bind(phone, name ?? old?.name ?? null, JSON.stringify(merged), whatsapp_ok == null ? Number(old?.whatsapp_ok ?? 0) : Number(whatsapp_ok)).run();
  return getProfile(env, phone);
}

// ---- Visit coordination -------------------------------------------------------
export async function scheduleVisit(env, a) {
  const when = new Date(a.requested_time);
  if (isNaN(when)) return { error: 'requested_time must be an ISO 8601 timestamp, e.g. 2026-11-07T11:00:00+05:30' };
  const leadH = (when - Date.now()) / 36e5;
  if (leadH < 0) return { error: 'requested_time is in the past' };
  const listing = await getListing(env, a.listing_id);
  if (!listing) return { error: 'Unknown listing_id. Search first so the listing is known.' };
  const phone = normPhone(a.phone), owner = normPhone(a.owner_phone);
  const prof = await getProfile(env, phone);
  const tenant = prof?.name || 'a prospective tenant';
  const mode = 'call_now';
  const ins = await env.DB.prepare('INSERT INTO visits(phone,listing_id,owner_name,owner_phone,requested_time,channel,notes) VALUES(?,?,?,?,?,?,?)')
    .bind(phone, a.listing_id, a.owner_name ?? null, owner, when.toISOString(), mode, a.notes ?? null).run();
  const id = ins.meta.last_row_id;
  const place = `${listing.bhk ? listing.bhk + ' BHK ' : ''}${listing.locality || ''}`.trim();
  const base = env.PUBLIC_URL || 'https://mergeconflicts-rentals-mcp.kelgis.workers.dev';
  const sent = [await send(env, { channel: 'call', to: owner, body: `Hello${a.owner_name ? ' ' + a.owner_name : ''}. This is the rental assistant for ${tenant}. They would like to view your ${place} property on ${fmtTime(when)}. Press 1 to confirm, or 2 if that time does not work.`, ref_type: 'visit', ref_id: id, voice_action: `${base}/webhook/twilio/voice?visit=${id}` })];
  return { visit_id: id, status: 'pending', strategy: `Owner is being called now (visit is ${Math.round(leadH)}h away); if unanswered the call is retried once after ${env.ESCALATE_MIN || 30} min.`, sent };
}

export async function applyOwnerResponse(env, visitId, outcome, text) {
  const v = await env.DB.prepare('SELECT * FROM visits WHERE id=?').bind(visitId).first();
  if (!v) return { error: 'visit not found' };
  const status = { yes: 'confirmed', no: 'declined', other: 'needs_attention' }[outcome] || outcome;
  await env.DB.prepare('UPDATE visits SET status=?, notes=COALESCE(notes||char(10),\'\')||?, updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(status, 'Owner: ' + (text || outcome), visitId).run();
  const listing = await getListing(env, v.listing_id);
  const place = listing ? `${listing.bhk} BHK in ${listing.locality}` : v.listing_id;
  const msg = status === 'confirmed' ? `Good news: the owner confirmed your visit to the ${place} on ${fmtTime(v.requested_time)}.`
    : status === 'declined' ? `The owner can't do ${fmtTime(v.requested_time)} for the ${place}. Call back with another time and I'll ask again.`
    : `The owner said something about the ${place} that needs your attention: ${(text || '').slice(0, 160)}.`;
  if (status === 'confirmed') await env.DB.prepare("INSERT INTO deals(phone,listing_id,stage) VALUES(?,?,'visit_scheduled') ON CONFLICT(phone,listing_id) DO UPDATE SET stage='visit_scheduled', updated_at=CURRENT_TIMESTAMP").bind(v.phone, v.listing_id).run();
  const note = await send(env, { channel: defaultChannel(env), to: v.phone, body: msg, ref_type: 'visit', ref_id: visitId });
  return { visit_id: visitId, status, tenant_notified: note };
}

export function parseReply(body) {
  const t = (body || '').trim().toLowerCase();
  if (/^(1|y|yes|yeah|ok|okay|confirm|confirmed|sure|fine|done)\b/.test(t)) return 'yes';
  if (/^(2|n|no|nope|cannot|can't|cant|busy|unavailable|not available)\b/.test(t)) return 'no';
  return 'other';
}

export async function handleInbound(env, from, body) {
  const addr = from.replace(/^whatsapp:/, '');
  await env.DB.prepare('INSERT INTO messages(direction,channel,addr,body,status) VALUES(?,?,?,?,?)').bind('in', from.startsWith('whatsapp:') ? 'whatsapp' : 'sms', addr, body, 'received').run();
  const ref = /\bV(\d+)\b/i.exec(body);
  const v = ref ? await env.DB.prepare('SELECT id FROM visits WHERE id=? AND owner_phone=?').bind(+ref[1], addr).first()
    : await env.DB.prepare("SELECT id FROM visits WHERE owner_phone=? AND status IN ('pending','needs_attention') ORDER BY id DESC LIMIT 1").bind(addr).first();
  if (!v) return { matched: false };
  return { matched: true, ...(await applyOwnerResponse(env, v.id, parseReply(body.replace(/\(?Ref V\d+\)?/i, '')), body)) };
}

// ---- Deals --------------------------------------------------------------------
export const STAGES = ['shortlisted', 'visit_scheduled', 'visited', 'negotiating', 'offer_made', 'agreement_drafted', 'signed', 'dropped'];
export async function updateDeal(env, phone, listing_id, stage, terms) {
  const old = await env.DB.prepare('SELECT terms FROM deals WHERE phone=? AND listing_id=?').bind(phone, listing_id).first();
  const merged = { ...j(old?.terms), ...(terms || {}) };
  await env.DB.prepare('INSERT INTO deals(phone,listing_id,stage,terms) VALUES(?,?,?,?) ON CONFLICT(phone,listing_id) DO UPDATE SET stage=COALESCE(?,stage), terms=?, updated_at=CURRENT_TIMESTAMP')
    .bind(phone, listing_id, stage || 'shortlisted', JSON.stringify(merged), stage ?? null, JSON.stringify(merged)).run();
  return env.DB.prepare('SELECT * FROM deals WHERE phone=? AND listing_id=?').bind(phone, listing_id).first();
}

// ---- Negotiation --------------------------------------------------------------
export async function negotiationBrief(env, { listing, max_rent, max_deposit_months, red_flags = [], lease_months = 11 }) {
  const stats = await marketStats(env, { locality: listing.locality, bhk: listing.bhk });
  const med = stats.median_rent, rent = listing.rent;
  const ageDays = listing.posted ? Math.floor((Date.now() - new Date(listing.posted)) / 864e5) : null;
  const depMonths = listing.deposit && rent ? +(listing.deposit / rent).toFixed(1) : null;
  const round = n => Math.round(n / 500) * 500;
  const gap = med ? +(((rent - med) / med) * 100).toFixed(1) : null;
  let target = rent, anchor = round(rent * 0.92);
  if (med && rent > med) { target = round(med + (rent - med) * 0.3); anchor = round(Math.min(med, rent * 0.92)); }
  else if (med) { target = round(rent * 0.97); anchor = round(rent * 0.93); }
  const walkaway = Math.min(max_rent || rent, rent);
  const levers = [];
  if (gap > 3) levers.push(`Asking rent is ${gap}% above the local median (${inr(med)}) from ${stats.sample} comparable listings.`);
  if (ageDays != null && ageDays > 14) levers.push(`Listing has been up for ${ageDays} days — owner likely wants a tenant.`);
  if (listing.negotiable) levers.push('Listing is flagged rent-negotiable.');
  levers.push(`Offer a firm ${lease_months}-month commitment with on-time payment (standard-form agreement) in return for a lower rent.`);
  if (depMonths && depMonths > 3) levers.push(`Deposit is ${depMonths} months of rent; ask for 2-3 months. Typical Bengaluru asks run higher, so treat 2-3 as the negotiating position and 5-6 as an acceptable fallback; the national Model Tenancy Act (2021) suggests a 2-month cap but check current Karnataka rules.`);
  if (listing.maintenance && !listing.maintenance_included) levers.push(`Maintenance (${inr(listing.maintenance)}) is extra: ask to include it or cut it.`);
  for (const f of red_flags) levers.push(`Research flag to probe: ${f}`);
  return {
    market: stats, listing_rent: rent, rent_vs_median_pct: gap,
    rent_plan: { opening_offer: anchor, target, walk_away_above: walkaway },
    deposit_plan: depMonths ? { listed_months: depMonths, opening_months: 2, target_months: Math.min(3, depMonths), accept_up_to_months: Math.min(max_deposit_months || 6, depMonths) } : null,
    leverage: levers,
    owner_script: `Open at ${inr(anchor)}/month with a ${lease_months}-month commitment and a ${depMonths ? 2 : '2-3'}-month deposit. Concede in small steps toward ${inr(target)}; do not exceed ${inr(walkaway)}. Ask for the agreement draft, owner ID proof and ownership/khata documents before any payment.`,
    safety_checklist: ['Never pay token/advance before seeing the flat and verifying the owner\'s ID and ownership documents', 'Pay by bank transfer to the owner\'s verified account, with receipts', 'Agreement must state deposit refund timeline and deductions', 'Photograph the flat condition at move-in'],
    disclaimer: 'Estimates come from a sample of portal listings, not a valuation. Not legal advice.',
  };
}

export function draftAgreement(t) {
  const d = new Date(t.start_date); const end = new Date(d); end.setMonth(end.getMonth() + (t.months || 11));
  const f = x => x.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
  return `DRAFT RESIDENTIAL RENTAL AGREEMENT (not legal advice; have it reviewed, stamped and signed by both parties)

This agreement is made on ${f(new Date())} between ${t.landlord_name} ("Landlord") and ${t.tenant_name} ("Tenant") for the premises: ${t.property_address}.

1. Term: ${t.months || 11} months from ${f(d)} to ${f(end)}.
2. Rent: ${inr(t.rent)} per month, payable by the ${t.rent_due_day || 5}th of each month by bank transfer.${t.maintenance ? ` Maintenance of ${inr(t.maintenance)} per month is payable separately.` : ' Maintenance is included in the rent.'}
3. Security deposit: ${inr(t.deposit)}, interest-free, refundable within ${t.refund_days || 30} days of vacating after deduction only of documented damages or unpaid dues.
4. Lock-in: ${t.lock_in_months ?? 3} months. Notice period thereafter: ${t.notice_months ?? 1} month(s) by either party.
5. Rent increase on renewal: not more than ${t.escalation_pct ?? 5}%.
6. Use: residential use only; no subletting without the Landlord's written consent.
7. Utilities: electricity and water are paid by the Tenant as per meter/actuals.
8. Repairs: minor repairs by the Tenant; structural repairs by the Landlord.
9. Inspection: Landlord may inspect with 24 hours' notice.
10. Inventory: as listed in Annexure A, signed at move-in with photographs.
${t.extra_terms?.length ? '11. Additional terms: ' + t.extra_terms.join('; ') + '.\n' : ''}
Signed: ______________ Landlord      ______________ Tenant
Witnesses: 1. ______________  2. ______________`;
}

// ---- Alerts (scheduled) ----------------------------------------------------------
export async function runAlerts(env) {
  const alerts = (await env.DB.prepare('SELECT * FROM alerts WHERE active=1').all()).results;
  const report = [];
  for (const al of alerts) {
    const c = j(al.criteria);
    const { results } = await findListings(env, c);
    const seen = new Set((await env.DB.prepare('SELECT listing_id FROM alert_seen WHERE alert_id=?').bind(al.id).all()).results.map(r => r.listing_id));
    const fresh = results.filter(l => !seen.has(l.id) && l.match_score >= 70);
    if (results.length) await env.DB.batch(results.map(l => env.DB.prepare('INSERT OR IGNORE INTO alert_seen(alert_id,listing_id) VALUES(?,?)').bind(al.id, l.id)));
    const baseline = !al.last_run;
    await env.DB.prepare('UPDATE alerts SET last_run=CURRENT_TIMESTAMP WHERE id=?').bind(al.id).run();
    if (baseline || !fresh.length) { report.push({ alert: al.id, new: baseline ? 0 : fresh.length, baseline }); continue; }
    const top = fresh.slice(0, 3);
    const body = `New listing alert. ${fresh.length} new place${fresh.length > 1 ? 's' : ''} match your search. ` + top.map(l => `A ${l.bhk} BHK in ${l.locality} for ${l.rent} rupees a month with a deposit of ${l.deposit}`).join('. Also, ') + '. Call us back to hear more or book a visit.';
    const sent = [await send(env, { channel: 'call', to: al.phone, body, ref_type: 'alert', ref_id: al.id })];
    report.push({ alert: al.id, new: fresh.length, sent });
  }
  return report;
}

export async function escalateVisits(env) {
  const mins = +(env.ESCALATE_MIN || 30);
  const rows = (await env.DB.prepare("SELECT * FROM visits WHERE status='pending' AND escalated=0 AND created_at <= datetime('now', ?)").bind(`-${mins} minutes`).all()).results;
  const base = env.PUBLIC_URL || 'https://mergeconflicts-rentals-mcp.kelgis.workers.dev';
  const out = [];
  for (const v of rows) {
    const l = await getListing(env, v.listing_id);
    out.push(await send(env, { channel: 'call', to: v.owner_phone, body: `Hello. We called you earlier about a viewing of your ${l?.locality || ''} property on ${fmtTime(v.requested_time)}. Press 1 to confirm, or 2 if that time does not work.`, ref_type: 'visit', ref_id: v.id, voice_action: `${base}/webhook/twilio/voice?visit=${v.id}` }));
    await env.DB.prepare('UPDATE visits SET escalated=1 WHERE id=?').bind(v.id).run();
  }
  return out;
}
