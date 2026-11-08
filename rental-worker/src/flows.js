import { placeCall, callStarted, noteOnCall } from './notify.js';
import { findListings, getListing, marketStats } from './sources.js';
import { j, normPhone, parseSpokenTime, normOutcome, parseAmounts, parseRentGoal, rentLadder } from './util.js';
import { getMemory, recordProperty } from './memory.js';

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
  const mode = 'owner_ai';
  const ins = await env.DB.prepare('INSERT INTO visits(phone,listing_id,owner_name,owner_phone,requested_time,channel,notes,escalated) VALUES(?,?,?,?,?,?,?,?)')
    .bind(phone, a.listing_id, a.owner_name ?? null, owner, when.toISOString(), mode, a.notes ?? null, a.dry_run_only ? 1 : 0).run();
  const id = ins.meta.last_row_id;
  await recordProperty(env, phone, a.listing_id, 'visit_requested', null, null, `visit:${id}`);
  // Test requests must remain non-dialing even after live flow IDs are configured.
  const callEnv = a.dry_run_only ? { ...env, TD_FLOW_OWNER_AI: null } : env;
  const call = await callOwner(callEnv, id, mode);
  return {
    visit_id: id, status: 'pending', call,
    strategy: call.status === 'queued' ? `The request is saved. The owner will be called about ${fmtTime(when)} shortly after this call ends; tell the tenant to hang up and that they will get a call back with the owner's answer. Do not say the visit is confirmed.`
      : call.status !== 'dialing' ? 'The request was saved, but no owner call has been confirmed as started.'
      : `The owner call was initiated to discuss ${fmtTime(when)}. An answered call and a confirmed appointment are separate outcomes.`,
  };
}

function ownerBriefing(v, listing, prof, followUp = null) {
  const place = listing ? `${listing.bhk ? listing.bhk + ' BHK ' : ''}${listing.locality || ''}`.trim() : 'rental';
  return {
    role: 'You are calling the PROPERTY OWNER on behalf of a prospective tenant.',
    goal: `Confirm a viewing of the ${place} property on ${fmtTime(v.requested_time)}, or agree an alternative time. Optionally confirm current rent/deposit and availability.`,
    ...(followUp ? { what_to_say: followUp } : {}),
    tenant: { name: prof?.name || 'the prospective tenant', budget: prof?.max_rent, move_in: prof?.move_in_date },
    listing: listing ? { id: listing.id, title: listing.title, locality: listing.locality, rent: listing.rent, deposit: listing.deposit, url: listing.url } : null,
    visit_id: v.id, requested_time: v.requested_time, requested_time_spoken: fmtTime(v.requested_time),
    spoken_intro: `Hello${v.owner_name ? ' ' + v.owner_name : ''}, I am calling on behalf of ${prof?.name || 'a prospective tenant'} about your ${place} rental listing.`,
    when_done: 'Call owner_response straight away: yes, no, or reschedule with the owner\'s new time written in details (for example "Owner is free from 3 pm instead"). Never ask the owner to hold: you check with the tenant after this call and call back. Do not transfer or bridge the call.',
  };
}

export async function callOwner(env, visitId, mode = 'owner_ai', followUp = null) {
  const v = await env.DB.prepare('SELECT * FROM visits WHERE id=?').bind(visitId).first();
  const listing = await getListing(env, v.listing_id), prof = await getProfile(env, v.phone);
  return placeCall(env, { kind: mode, to: v.owner_phone, tenant_phone: v.phone, owner_phone: v.owner_phone, visit_id: v.id, purpose: `Viewing request for listing ${v.listing_id}`, briefing: ownerBriefing(v, listing, prof, followUp) });
}

// ---- Tenant <-> owner relay for viewings ------------------------------------------
// Each side is called in turn; the visit row carries the current proposal between calls.

// The callback agent's inputs are partly fixed for the demo, so find the visit being discussed on this call.
export async function resolveVisit(env, phone, visitId = null) {
  if (visitId) return env.DB.prepare('SELECT * FROM visits WHERE id=?').bind(visitId).first();
  const active = await env.DB.prepare("SELECT visit_id, tenant_phone FROM outreach WHERE kind='tenant_ai' AND visit_id IS NOT NULL AND status IN ('dialing','in_progress') AND created_at >= datetime('now','-20 minutes') ORDER BY id DESC LIMIT 5").bind().all();
  const mine = active.results.filter(o => !phone || o.tenant_phone === phone);
  const pick = mine.length ? mine[0] : active.results.length === 1 ? active.results[0] : null;
  if (pick) return env.DB.prepare('SELECT * FROM visits WHERE id=?').bind(pick.visit_id).first();
  if (!phone) return null;
  return env.DB.prepare("SELECT * FROM visits WHERE phone=? AND status IN ('owner_proposed_time','pending','needs_attention','declined') ORDER BY id DESC LIMIT 1").bind(phone).first();
}

// reply: accept (the owner's proposed time) | propose (a new time from the tenant) | decline
export async function tenantVisitReply(env, v, { reply, requested_time, text }) {
  if (!v) return { error: 'No viewing is being discussed with this tenant.' };
  const listing = await getListing(env, v.listing_id);
  const place = listing ? `${listing.bhk ? listing.bhk + ' BHK ' : ''}${listing.title || ''}`.trim() : 'the property';
  const proposed = parseSpokenTime(requested_time || text, v.requested_time);
  if (reply === 'accept' && proposed && Math.abs(new Date(proposed) - new Date(v.requested_time)) > 5 * 60000) reply = 'propose';
  if (reply === 'accept') {
    if (!['owner_proposed_time', 'confirmed'].includes(v.status)) return { error: `There is no time from the owner to accept (visit status: ${v.status}). Ask the tenant for a time and call visits with action propose_time and requested_time.` };
    await confirmProposedTime(env, v.id);
    await noteOnCall(env, { tenant_phone: v.phone, kind: 'tenant_ai', visit_id: v.id, text: `Tenant agreed to the owner's time, ${fmtTime(v.requested_time)}. Viewing booked.` });
    const call = await placeCall(env, { kind: 'owner_ai', to: v.owner_phone, tenant_phone: v.phone, owner_phone: v.owner_phone, visit_id: v.id, purpose: `Viewing confirmation for listing ${v.listing_id}`, briefing: {
      role: 'You are calling the PROPERTY OWNER back on behalf of the tenant.', task: 'viewing_confirmation', visit_id: v.id,
      spoken_intro: `Hello${v.owner_name ? ' ' + v.owner_name : ''}, this is the MergeConflicts rental assistant calling back about the viewing of your ${place}.`,
      what_to_say: `The tenant has agreed to your time: ${fmtTime(v.requested_time)}. The viewing is booked for then.`,
      requested_time: v.requested_time, requested_time_spoken: fmtTime(v.requested_time),
      when_done: 'If the owner acknowledges, call owner_response with outcome yes. If they now cannot make it, record no, or reschedule with their new time in details. Thank them and end the call.',
    } });
    return { visit_id: v.id, status: 'confirmed', time: fmtTime(v.requested_time), owner_call: call,
      say: `Tell the tenant the viewing is booked for ${fmtTime(v.requested_time)} and that you will call the owner shortly after this call to let them know.` };
  }
  if (reply === 'propose') {
    if (!proposed || new Date(proposed) < Date.now()) return { error: 'Ask the tenant for a specific future day and time, then call visits again with action propose_time and requested_time.' };
    const ownerTime = v.status === 'owner_proposed_time' ? fmtTime(v.requested_time) : null;
    await noteOnCall(env, { tenant_phone: v.phone, kind: 'tenant_ai', visit_id: v.id, text: `Tenant ${ownerTime ? `cannot make ${ownerTime} and ` : ''}asked for ${fmtTime(proposed)} instead.` });
    await env.DB.prepare("UPDATE visits SET status='pending', requested_time=?, notes=COALESCE(notes||char(10),'')||?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .bind(proposed, `Tenant proposed ${proposed}${text ? ': ' + text : ''}`.slice(0, 300), v.id).run();
    const call = await callOwner(env, v.id, 'owner_ai', `${ownerTime ? `The tenant cannot make ${ownerTime}. ` : ''}The tenant would like to view the ${place} on ${fmtTime(proposed)} instead. Ask whether that works.`);
    return { visit_id: v.id, status: 'pending', proposed_time: fmtTime(proposed), owner_call: call,
      say: `Tell the tenant you will call the owner shortly after this call to ask about ${fmtTime(proposed)}, and that they will get a call back with the answer. It is not confirmed yet.` };
  }
  if (reply === 'decline') {
    await env.DB.prepare("UPDATE visits SET status='cancelled', notes=COALESCE(notes||char(10),'')||?, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(`Tenant declined${text ? ': ' + text : ''}`.slice(0, 300), v.id).run();
    await noteOnCall(env, { tenant_phone: v.phone, kind: 'tenant_ai', visit_id: v.id, text: `Tenant cancelled the viewing${text ? ': ' + text : ''}.` });
    return { visit_id: v.id, status: 'cancelled', say: 'Tell the tenant the viewing request is cancelled and ask if they would like other options.' };
  }
  return { error: "Say whether the tenant accepts the owner's time (accept_owner_time), proposes another time (propose_time with requested_time), or wants to cancel." };
}

// A negotiation or intent is a separate owner conversation, never a call bridge.
// One negotiation round. The owner agent reports every answer; the Worker decides whether it is final and,
// if not, what to offer next and which piece of evidence to use. Nothing is final until the owner explicitly
// agrees to a rent within the tenant's maximum, or has refused the last offer and named (or declined to name)
// their lowest rent.
export function negotiationStep(briefing, { outcome: rawOutcome, details, quoted_rent }) {
  const plan = briefing.negotiation_plan || {};
  const ladder = plan.offers_in_order?.length ? plan.offers_in_order : [];
  const max = briefing.private_limit_never_say?.max_rent ?? briefing.authorized_max_rent ?? ladder.at(-1) ?? null;
  const st = { round: 0, asked_lowest: false, confirm: null, ...(briefing.negotiation_state || {}) };
  const outcome = normOutcome(rawOutcome, details) || 'other';
  const amounts = parseAmounts(details);
  const named = quoted_rent ?? (outcome === 'yes' && amounts.length ? amounts.at(-1) : null);
  const offer = ladder[st.round] ?? ladder.at(-1);
  const evidence = [...(briefing.comparable_listings || []).map(c => `a ${c}`), ...(briefing.levers || [])];
  const reason = i => evidence.length ? ` Give this reason: ${evidence[i % evidence.length]}` : '';
  const ask = (n, extra = '') => `Not final yet, keep negotiating. Offer ${inr(n)} a month.${reason(st.round)}${extra} Then wait for the owner's answer and call owner_response again with it.`;
  if (st.round > 10) return { final: true, result: named && max && named > max ? 'above_limit' : 'refused', rent: named };
  // Explicit agreement within the maximum: final once the owner has confirmed the exact figure.
  if (outcome === 'yes') {
    const rent = named ?? st.confirm ?? offer;
    if (max && rent > max) return st.round >= ladder.length - 1
      ? { final: true, result: 'above_limit', rent }
      : { final: false, state: { ...st, round: st.round + 1 }, say: ask(ladder[st.round + 1], ' Do not agree to the higher figure.') };
    if (st.confirm === rent) return { final: true, result: 'agreed', rent };
    return { final: false, state: { ...st, confirm: rent }, say: `Not final yet. Ask the owner to confirm clearly: "So we are agreed at ${inr(rent)} a month${plan.deposit_goal ? ' with a ' + plan.deposit_goal + ' deposit' : ''}?" If they say yes, call owner_response with outcome yes, quoted_rent ${rent} and details "Owner confirmed ${rent}".` };
  }
  // The owner named a figure.
  if (named) {
    if (max && named <= max) {
      const nextOffer = ladder.find(x => x > offer && x < named);
      if (nextOffer) return { final: false, state: { ...st, round: ladder.indexOf(nextOffer) }, say: ask(nextOffer, ` If they insist on ${inr(named)}, you may accept it: ask them to confirm ${inr(named)} and record yes with that quoted_rent.`) };
      return { final: false, state: { ...st, confirm: named }, say: `${inr(named)} is acceptable. Ask the owner to confirm: "So we are agreed at ${inr(named)} a month?" If yes, call owner_response with outcome yes and quoted_rent ${named}.` };
    }
    if (st.round < ladder.length - 1) return { final: false, state: { ...st, round: st.round + 1 }, say: ask(ladder[st.round + 1], ` Their ${inr(named)} is too high; do not agree to it.`) };
    return { final: true, result: 'above_limit', rent: named };
  }
  // A plain refusal or other reply: next offer, then ask for their lowest rent, then stop.
  if (st.round < ladder.length - 1) return { final: false, state: { ...st, round: st.round + 1 }, say: ask(ladder[st.round + 1]) };
  if (!st.asked_lowest) return { final: false, state: { ...st, asked_lowest: true }, say: `Not final yet. ${inr(offer)} is the most you can offer. Ask the owner for the lowest monthly rent they would accept, then call owner_response with outcome no and quoted_rent as that figure (or no quoted_rent if they will not say).` };
  return { final: true, result: 'refused', rent: null };
}

// Negotiation is carried out by the owner agent on the tenant's behalf: the tenant sets a goal and a private
// maximum, the agent opens at the goal and concedes step by step, and the tenant is called only with the result.
export async function startOwnerDiscussion(env, { phone, listing_id, purpose, offer, max_rent, max_deposit, move_in_date, notes }) {
  const tenantPhone = normPhone(phone);
  const listing = await getListing(env, listing_id);
  if (!listing) return { error: 'Unknown listing_id; select a property first.' };
  const visit = await env.DB.prepare('SELECT * FROM visits WHERE phone=? AND listing_id=? ORDER BY id DESC LIMIT 1').bind(tenantPhone, listing_id).first();
  if (!visit?.owner_phone) return { error: 'No owner contact is available for this property.' };
  const goal = parseRentGoal(offer);
  if (purpose === 'negotiation' && (!max_rent || !goal.rent)) return { error: 'Negotiation needs explicit amounts: the tenant’s ideal (goal) rent in offer, for example "goal rent 35000 with 2 months deposit", and their maximum rent in max_rent.' };
  if (purpose === 'negotiation' && goal.rent > max_rent) return { error: `The goal rent ${inr(goal.rent)} is above the maximum ${inr(max_rent)}; confirm both amounts with the tenant.` };
  if (purpose === 'signing_intent' && !move_in_date) return { error: 'Ask the tenant for their preferred move-in date before informing the owner.' };
  const place = `${listing.bhk ? listing.bhk + ' BHK ' : ''}${listing.title || 'property'} in ${listing.locality || 'Bengaluru'}`;
  const intro = { role: 'You are an AI assistant calling the property owner on behalf of a prospective tenant.',
    spoken_intro: `Hello${visit.owner_name ? ' ' + visit.owner_name : ''}, I am the MergeConflicts rental assistant calling on behalf of the prospective tenant about your ${place}.` };
  const common = { listed_terms: { rent: listing.rent ?? null, deposit: listing.deposit ?? null, maintenance: listing.maintenance ?? null }, listing: { id: listing.id, title: listing.title, locality: listing.locality }, visit_id: visit.id };
  let briefing;
  if (purpose === 'negotiation') {
    const ladder = rentLadder(goal.rent, max_rent, listing.rent);
    const deposit = goal.deposit_months ? `${goal.deposit_months} months` : goal.deposit ? inr(goal.deposit) : null;
    const levers = [visit.status === 'confirmed' ? 'The tenant has a viewing arranged and is ready to decide quickly.' : 'The tenant is ready to decide quickly.',
      'The tenant can commit to an 11-month agreement with rent paid on time.'];
    await updateDeal(env, tenantPhone, listing_id, 'negotiating', { tenant_goal: offer, goal_rent: goal.rent, authorized_max_rent: max_rent, ...(max_deposit ? { authorized_max_deposit: max_deposit } : {}), ...(notes ? { tenant_instructions: notes } : {}) });
    await noteOnCall(env, { tenant_phone: tenantPhone, kind: 'tenant_ai', text: `Tenant asked the assistant to negotiate: goal ${inr(goal.rent)} a month, private maximum set.` });
    briefing = { ...intro, ...common, task: 'negotiation',
      what_to_say: `The tenant${visit.status === 'confirmed' ? ', who has a viewing arranged,' : ''} would like to rent your ${place} and has asked me to agree the terms. Open by offering ${inr(ladder[0])} a month${deposit ? ` with a ${deposit} deposit` : ''}.`,
      negotiation_plan: {
        offers_in_order: ladder, deposit_goal: deposit, max_deposit: max_deposit || null,
        how: `You negotiate for the tenant and may agree on their behalf. Offer ${inr(ladder[0])} first. If the owner refuses, give one reason from levers and ask what rent they would accept. If their figure is at or below an offer in offers_in_order, agree to their figure. Otherwise move to the next offer, one step at a time, never skipping steps and never above the last one. If the owner will not go to ${inr(ladder[ladder.length - 1])} or lower, stop and ask for their lowest rent. Aim for the lowest rent you can get.`,
      },
      levers, private_limit_never_say: { max_rent, max_deposit: max_deposit || null },
      instruction: 'Never mention the tenant\'s maximum or that there is one. Never offer more than the last amount in offers_in_order. Record the result once, at the end, with owner_response.' };
  } else {
    await updateDeal(env, tenantPhone, listing_id, null, { proposed_move_in_date: move_in_date, ...(notes ? { tenant_instructions: notes } : {}) });
    await noteOnCall(env, { tenant_phone: tenantPhone, kind: 'tenant_ai', text: `Tenant wants to go ahead and rent, moving in around ${move_in_date}.` });
    briefing = { ...intro, ...common, task: purpose, what_to_say: `The tenant would like to go ahead and rent it, moving in around ${move_in_date}.`, proposed_move_in_date: move_in_date, tenant_instructions: notes || null,
      instruction: 'Ask whether the owner agrees and what the next steps are; record the owner response.' };
  }
  const call = await placeCall(env, { kind: 'owner_ai', to: visit.owner_phone, tenant_phone: tenantPhone, owner_phone: visit.owner_phone, visit_id: visit.id, purpose, briefing });
  return { status: callStarted(call) ? 'outreach_initiated' : 'outreach_not_started', call,
    ...(purpose === 'negotiation' ? { say: `Tell the tenant you will research comparable flats and local rents, then call the owner shortly after this call ends and negotiate for them, starting from their goal and never going above their maximum, which stays private.${listing.market_comparison?.median_rent ? ` Mention that similar flats in ${listing.locality} have a median asking rent of ${inr(listing.market_comparison.median_rent)}.` : ''} They will get a call back with the final result, so they should keep their line free.` } : {}) };
}

export async function recordOwnerDiscussion(env, outreach, { outcome: rawOutcome, details, quoted_rent, quoted_deposit }) {
  if (!outreach || !['negotiation', 'signing_intent'].includes(outreach.purpose)) return { error: 'An active negotiation or signing-intent outreach is required.' };
  if (outreach.status === 'completed') return { error: 'This owner response was already recorded; do not send another callback.' };
  const briefing = typeof outreach.briefing === 'string' ? j(outreach.briefing) : (outreach.briefing || {});
  const listingId = briefing.listing?.id;
  if (!listingId || !outreach.tenant_phone) return { error: 'Outreach is missing its tenant or property.' };
  let outcome = normOutcome(rawOutcome, details) || 'other';
  if (outcome === 'reschedule') outcome = 'other';
  const note = (details || outcome).slice(0, 400);
  const title = briefing.listing?.title || 'the property';
  let result, tenantPurpose, next, say, stage = null, terms = {};
  if (outreach.purpose === 'negotiation') {
    const plan = briefing.negotiation_plan || {};
    const max = briefing.private_limit_never_say?.max_rent ?? briefing.authorized_max_rent ?? null;
    const listed = briefing.listed_terms?.rent;
    const step = negotiationStep(briefing, { outcome, details, quoted_rent });
    if (!step.final) {
      await env.DB.prepare('UPDATE outreach SET briefing=? WHERE id=?').bind(JSON.stringify({ ...briefing, negotiation_state: step.state }), outreach.id).run();
      return { recorded: false, keep_negotiating: true, say: step.say };
    }
    result = step.result;
    const rent = step.rent;
    if (result === 'agreed') {
      const at = rent ? inr(rent) : `the last offer${plan.offers_in_order ? ' of ' + inr(plan.offers_in_order.at(-1)) : ''}`;
      const saved = rent && listed && listed > rent ? ` That is ${inr(listed - rent)} a month below the asking rent of ${inr(listed)}.` : '';
      stage = 'offer_made'; terms = { agreed_rent: rent ?? null, owner_accepted_offer: note };
      tenantPurpose = `Negotiation result for ${title}: the owner agreed to a rent of ${at} a month.${saved} Owner's words: ${note}`;
      next = 'Tell the tenant the agreed rent and any terms the owner mentioned; it is agreed in principle, nothing is signed. Ask whether they want to go ahead and rent; if yes, ask their move-in date and call deal with action communicate_intent.';
      say = `Confirm back to the owner that the rent is agreed at ${at} a month, in principle, and that the tenant will be told and the next steps shared. Thank them and end the call now.`;
    } else if (result === 'above_limit') {
      stage = 'negotiating'; terms = { owner_lowest_rent: rent };
      tenantPurpose = `Negotiation result for ${title}: the owner's lowest rent is ${inr(rent)} a month, which is above the maximum the tenant set, so nothing was agreed. Owner's words: ${note}`;
      next = `Tell the tenant the owner's lowest rent. Ask whether they want to accept ${inr(rent)}, set a new goal and maximum, or stop. To accept, repeat it back, get a yes, then call deal with action negotiate_owner, offer "goal rent ${rent}" and max_rent ${rent}. For a new goal and maximum, repeat both back, get a yes, then call deal with action negotiate_owner.`;
      say = 'Tell the owner their price is above what you can agree today, that you will take it to the tenant and call back if they want to go ahead. Do not agree to it. Thank them and end the call.';
    } else if (result === 'refused') {
      stage = 'negotiating';
      tenantPurpose = `Negotiation result for ${title}: the owner would not lower the rent${listed ? ` from ${inr(listed)}` : ''}. Owner's words: ${note}`;
      next = `Tell the tenant the owner would not negotiate. Ask whether they want to rent at the asking rent (call deal with action negotiate_owner, offer "goal rent ${listed || '<asking rent>'}" and that as max_rent), try a different offer, or look at other properties.`;
      say = 'Thank the owner, say you will let the tenant know, and end the call now.';
    } else {
      stage = 'negotiating';
      tenantPurpose = `Negotiation update for ${title}: the owner replied: ${note}`;
      next = 'Tell the tenant exactly what the owner said and ask what they would like to do; for a new goal and maximum, call deal with action negotiate_owner.';
      say = 'Tell the owner you will pass this to the tenant and call back. Do not agree to anything. Thank them and end the call.';
    }
    terms = { ...terms, owner_response: outcome, owner_response_details: note, ...(quoted_rent != null ? { owner_quoted_rent: quoted_rent } : {}), ...(quoted_deposit != null ? { owner_quoted_deposit: quoted_deposit } : {}) };
  } else {
    result = outcome;
    terms = { owner_response: outcome, owner_response_details: note, ...(outcome === 'yes' ? { owner_agreed_to_proceed: true } : {}) };
    tenantPurpose = `Rental intent update: the owner ${{ yes: 'agreed to go ahead with', no: 'did not agree to' }[outcome] || 'replied about'} your intention to rent ${title}: ${note}. Tell the tenant exactly this; do not claim an agreement beyond what the owner said.`;
    next = outcome === 'yes' ? 'The owner agreed to proceed. Tell the tenant the owner will share the agreement and next steps; nothing is signed yet.' : 'Explain the owner response and ask what the tenant would like to do next.';
    say = 'Thank the owner, say the tenant will be informed, and end the call.';
  }
  await updateDeal(env, outreach.tenant_phone, listingId, stage, terms);
  await env.DB.prepare("UPDATE outreach SET status='completed', summary=? WHERE id=?").bind(`Owner response (${result}): ${note}`.slice(0, 500), outreach.id).run();
  const tenant_call = await callTenant(env, { phone: outreach.tenant_phone, purpose: tenantPurpose.slice(0, 600), visit_id: outreach.visit_id,
    details: { listing_id: listingId, owner_outcome: outcome, negotiation_result: result, owner_details: note, quoted_rent, quoted_deposit, next } });
  return { recorded: true, outcome, result, tenant_call, say };
}

// Tenant-facing AI call (alerts and visit updates). Two-way: the agent can book visits, add to wishlist and update preferences.
// A tenant who called from inside Talkdesk shows the team line as Caller ID; calling that back would land
// in our own concierge, so those callbacks ring the Talkdesk callback line (answered in the agent app) instead.
export function callbackDestination(env, phone) {
  const internal = String(env.TALKDESK_ORIGIN_NUMBERS || '').split(',').map(x => x.trim()).filter(Boolean);
  // Demo testers are in India, so any US (+1) Caller ID is a Talkdesk line or simulator, never a reachable tenant.
  const redirect = internal.includes(phone) || String(phone || '').startsWith('+1');
  return env.CALLBACK_RING_NUMBER && redirect && phone !== env.CALLBACK_RING_NUMBER ? env.CALLBACK_RING_NUMBER : phone;
}

export async function callTenant(env, { phone, purpose, details = {}, visit_id = null, alert_id = null }) {
  const prof = await getProfile(env, phone);
  const memory = await getMemory(env, phone);
  return placeCall(env, {
    kind: 'tenant_ai', to: callbackDestination(env, phone), tenant_phone: phone, visit_id, alert_id, purpose,
    briefing: {
      role: 'You are calling the TENANT (your client) back. This is a two-way conversation, not an announcement.',
      purpose, ...details, tenant_profile: prof, memory,
      spoken_intro: `Hi${prof?.name ? ' ' + prof.name : ''}, this is your rental assistant calling with an update.`,
      you_can: ['Describe the listings or update and answer questions', 'tenant action=wishlist_add', 'visits action=schedule (ask preferred time and ai_call vs direct_connect) or accept_owner_time', 'tenant action=save_preferences if preferences changed', 'research action=locality / negotiate on request', 'tenant action=alert_cancel if they want no more calls'],
      when_done: 'Call call_context action=complete with a short summary.',
    },
  });
}

export async function applyOwnerResponse(env, visitId, rawOutcome, text, rawTime = null, { notifyTenant = true, confirmation = false } = {}) {
  const v = await env.DB.prepare('SELECT * FROM visits WHERE id=?').bind(visitId).first();
  if (!v) return { error: 'visit not found' };
  let outcome = normOutcome(rawOutcome, text) || 'other';
  // Owners usually state the new time in words; the Talkdesk agent passes it in details.
  const spoken = parseSpokenTime(rawTime, v.requested_time) || parseSpokenTime(text, v.requested_time);
  const moved = !!spoken && Math.abs(new Date(spoken) - new Date(v.requested_time)) > 5 * 60000;
  if (moved && outcome !== 'yes') outcome = 'reschedule';
  if (outcome === 'reschedule' && !moved) {
    return { error: 'Ask the owner which day and time works instead, then call owner_response again with that time in details. Do not ask the owner to hold.' };
  }
  const proposed_time = outcome === 'reschedule' ? spoken : null;
  // The owner acknowledging a time the tenant already accepted needs no further call to the tenant.
  if (confirmation && outcome === 'yes') {
    await env.DB.prepare("UPDATE outreach SET status='completed', summary=? WHERE visit_id=? AND kind='owner_ai' AND purpose LIKE 'Viewing confirmation%' AND status IN ('initiating','dialing','dry_run','in_progress')").bind(`Owner acknowledged: ${text || 'yes'}`.slice(0, 500), visitId).run();
    await env.DB.prepare("UPDATE visits SET status='confirmed', updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(visitId).run();
    return { visit_id: visitId, status: 'confirmed', say: 'Thank the owner; the viewing stands. No further calls are needed.' };
  }
  const status = { yes: 'confirmed', no: 'declined', reschedule: 'owner_proposed_time', other: 'needs_attention' }[outcome] || outcome;
  let newTime = null;
  if (proposed_time && !isNaN(new Date(proposed_time))) newTime = new Date(proposed_time).toISOString();
  await env.DB.prepare('UPDATE visits SET status=?, requested_time=COALESCE(?,requested_time), notes=COALESCE(notes||char(10),\'\')||?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .bind(status, status === 'owner_proposed_time' ? newTime : null, 'Owner: ' + (text || outcome) + (newTime ? ` (proposed ${newTime})` : ''), visitId).run();
  await env.DB.prepare("UPDATE outreach SET status='completed', summary=? WHERE visit_id=? AND kind='owner_ai' AND (purpose LIKE 'Viewing request for listing %' OR purpose LIKE 'Viewing confirmation%') AND status IN ('initiating','dialing','dry_run','in_progress')").bind(`Owner said ${outcome}: ${text || ''}`.slice(0, 500), visitId).run();
  const listing = await getListing(env, v.listing_id);
  const place = listing ? `${listing.bhk} BHK in ${listing.locality}` : v.listing_id;
  const when = fmtTime(newTime || v.requested_time);
  const update = status === 'confirmed' ? `The owner confirmed the visit to the ${place} on ${when}.`
    : status === 'declined' ? `The owner cannot do ${fmtTime(v.requested_time)} for the ${place}.`
    : status === 'owner_proposed_time' ? `The owner cannot do ${fmtTime(v.requested_time)} for the ${place} but is free on ${when} instead; ask the tenant if that works.`
    : `The owner said something about the ${place} that needs the tenant's input: ${(text || '').slice(0, 160)}.`;
  if (status === 'confirmed') await env.DB.prepare("INSERT INTO deals(phone,listing_id,stage) VALUES(?,?,'visit_scheduled') ON CONFLICT(phone,listing_id) DO UPDATE SET stage='visit_scheduled', updated_at=CURRENT_TIMESTAMP").bind(v.phone, v.listing_id).run();
  if (status === 'confirmed') await recordProperty(env, v.phone, v.listing_id, 'visit_confirmed', text, null, `visit-confirmed:${visitId}`);
  const tenant_call = notifyTenant ? await callTenant(env, { phone: v.phone, visit_id: visitId, purpose: 'Visit update: ' + update, details: { visit: { id: visitId, status, time: when, listing_id: v.listing_id, owner_notes: text }, next: status === 'confirmed' ? 'Confirm the time and answer questions. Nothing else to arrange.'
    : status === 'owner_proposed_time' ? `Ask whether ${when} works. If yes, call visits with action accept_owner_time. If they want a different time, ask for it and call visits with action propose_time and requested_time. The owner is called back automatically after this call.`
    : 'Ask whether the tenant wants to propose another time (visits action propose_time with requested_time) or look at other options.' } }) : null;
  return { visit_id: visitId, status, update, tenant_call,
    say: status === 'owner_proposed_time' ? `Tell the owner you will check ${when} with the tenant and call back shortly. Then thank them and end the call; do not ask them to hold.` : 'Thank the owner, say the tenant will be informed, and end the call.' };
}

export function parseReply(body) {
  const t = (body || '').trim().toLowerCase();
  if (/^(1|y|yes|yeah|ok|okay|confirm|confirmed|sure|fine|done)\b/.test(t)) return 'yes';
  if (/^(2|n|no|nope|cannot|can't|cant|busy|unavailable|not available)\b/.test(t)) return 'no';
  return 'other';
}

// Owner proposed a time and the tenant accepted it.
export async function confirmProposedTime(env, visitId) {
  await env.DB.prepare("UPDATE visits SET status='confirmed', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='owner_proposed_time'").bind(visitId).run();
  const v = await env.DB.prepare('SELECT * FROM visits WHERE id=?').bind(visitId).first();
  if (v?.status === 'confirmed') await env.DB.prepare("INSERT INTO deals(phone,listing_id,stage) VALUES(?,?,'visit_scheduled') ON CONFLICT(phone,listing_id) DO UPDATE SET stage='visit_scheduled'").bind(v.phone, v.listing_id).run();
  return { visit: v };
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
    const { results, warning } = await findListings(env, c);
    if (warning) { report.push({ alert: al.id, error: warning }); continue; }
    const seen = new Set((await env.DB.prepare('SELECT listing_id FROM alert_seen WHERE alert_id=?').bind(al.id).all()).results.map(r => r.listing_id));
    const fresh = results.filter(l => !seen.has(l.id) && l.match_score >= 70);
    const baseline = !al.last_run;
    if (baseline) {
      if (results.length) await env.DB.batch(results.map(l => env.DB.prepare('INSERT OR IGNORE INTO alert_seen(alert_id,listing_id) VALUES(?,?)').bind(al.id, l.id)));
      await env.DB.prepare('UPDATE alerts SET last_run=CURRENT_TIMESTAMP WHERE id=?').bind(al.id).run();
      report.push({ alert: al.id, new: 0, baseline }); continue;
    }
    if (!fresh.length) { report.push({ alert: al.id, new: 0 }); continue; }
    if (!env.TD_FLOW_TENANT_AI || !env.TALKDESK_CLIENT_ID) { report.push({ alert: al.id, error: 'Tenant callback flow is not configured; no call placed.' }); continue; }
    const top = fresh.slice(0, 3).map(({ id, title, locality, bhk, rent, deposit, furnishing, parking, match_score, mismatches, url, available_from }) => ({ id, title, locality, bhk, rent, deposit, furnishing, parking, match_score, mismatches, url, available_from }));
    const call = await callTenant(env, { phone: al.phone, alert_id: al.id, purpose: `New listing alert: ${fresh.length} new match${fresh.length > 1 ? 'es' : ''} for the tenant's saved search.`, details: { new_listings: top, criteria: c, next: 'Walk through the listings one by one, ask which they like, offer to add to wishlist, research the area, or schedule a visit. Ask if their preferences changed.' } });
    if (callStarted(call)) await env.DB.batch(top.map(l => env.DB.prepare('INSERT OR IGNORE INTO alert_seen(alert_id,listing_id) VALUES(?,?)').bind(al.id, l.id)));
    report.push({ alert: al.id, new: fresh.length, call });
  }
  return report;
}

// Retry an unanswered owner call once (the owner-liaison agent records an outcome when the call connects).
export async function escalateVisits(env) {
  const mins = +(env.ESCALATE_MIN || 30);
  const rows = (await env.DB.prepare("SELECT * FROM visits WHERE status='pending' AND escalated=0 AND channel='owner_ai' AND created_at <= datetime('now', ?)").bind(`-${mins} minutes`).all()).results;
  const out = [];
  for (const v of rows) {
    await env.DB.prepare('UPDATE visits SET escalated=1 WHERE id=?').bind(v.id).run();
    out.push(await callOwner(env, v.id, 'owner_ai'));
  }
  return out;
}
