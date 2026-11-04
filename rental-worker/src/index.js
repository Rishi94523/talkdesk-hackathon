import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { z } from 'zod';
import { reply, fail, normPhone, j } from './util.js';
import { findListings, getListing, marketStats, researchLocality, firecrawlSearch, parallelSearch, scrapeMarkdown, TOPIC_NAMES } from './sources.js';
import { getOutreach } from './notify.js';
import { getProfile, saveProfile, scheduleVisit, applyOwnerResponse, parseReply, confirmProposedTime, callOwner, callTenant, updateDeal, STAGES, negotiationBrief, draftAgreement, runAlerts, escalateVisits } from './flows.js';

// Talkdesk orchestrations allow 5 skills and each MCP skill binds ONE tool, so the server exposes a few
// multi-action tools. Each Talkdesk agent picks the subset it needs:
//   Concierge (inbound):      tenant, listings, research, visits, deal
//   Owner liaison (outbound): call_context, owner_response, listings
//   Tenant callback (outbound): call_context, tenant, listings, visits, research
const nowIst = () => new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' });
const opt = z.string().max(100).optional();

function makeServer(env) {
  const s = new McpServer({ name: 'MergeConflicts Rentals', version: '2.0.0' });
  const tool = (name, description, shape, fn) => s.registerTool(name, { description, inputSchema: z.object(shape) }, async a => {
    try { return reply(await fn(a)); } catch (e) { return fail('Tool failed: ' + (e.message || 'unknown').slice(0, 200)); }
  });

  // ---------------------------------------------------------------- tenant
  tool('tenant', `Tenant memory. Actions:
- get: profile, wishlist, visits, deals and alerts for a caller (also returns current IST time). Call at the start of every conversation with the caller's phone (Caller ID).
- save_preferences: store/merge name and preferences (locality, bhk, max_rent, max_deposit, amenities, furnishing, move_in_date, pets, notes).
- wishlist_add (listing_id, note) / wishlist_list.
- alert_create: watch for NEW listings matching the saved/passed criteria; on new matches our AI agent phones the tenant for a two-way conversation. Requires consent=true.
- alert_list / alert_cancel (alert_id).`, {
    action: z.enum(['get', 'save_preferences', 'wishlist_add', 'wishlist_list', 'alert_create', 'alert_list', 'alert_cancel']),
    phone: z.string().min(8).max(20).describe('Tenant phone number (Caller ID)'),
    name: z.string().max(80).optional(), locality: opt, bhk: z.number().int().min(1).max(5).optional(),
    max_rent: z.number().int().positive().optional(), max_deposit: z.number().int().positive().optional(),
    amenities: z.array(z.string().max(30)).max(8).optional(), furnishing: z.enum(['none', 'semi', 'full']).optional(),
    move_in_date: opt, pets: z.boolean().optional(), notes: z.string().max(500).optional(),
    listing_id: z.string().max(60).optional(), note: z.string().max(200).optional(),
    alert_id: z.number().int().optional(), consent: z.boolean().optional(),
  }, async ({ action, phone: p, listing_id, note, alert_id, consent, name, ...prefs }) => {
    const n = normPhone(p);
    if (action === 'get') {
      const q = sql => env.DB.prepare(sql).bind(n).all().then(r => r.results);
      const [wishlist, visits, deals, alerts] = await Promise.all([q('SELECT listing_id,note FROM wishlist WHERE phone=?'), q('SELECT id,listing_id,owner_name,requested_time,status FROM visits WHERE phone=? ORDER BY id DESC LIMIT 10'), q('SELECT listing_id,stage,terms FROM deals WHERE phone=?'), q('SELECT id,criteria,active FROM alerts WHERE phone=? AND active=1')]);
      return { now_ist: nowIst(), now_iso: new Date().toISOString(), profile: await getProfile(env, n), wishlist, visits, deals: deals.map(d => ({ ...d, terms: j(d.terms) })), alerts: alerts.map(a => ({ ...a, criteria: j(a.criteria) })) };
    }
    if (action === 'save_preferences') return { profile: await saveProfile(env, n, name, prefs, null) };
    if (action === 'wishlist_add') {
      if (!listing_id || !(await getListing(env, listing_id))) return { error: 'Unknown listing_id; search first.' };
      await env.DB.prepare('INSERT INTO wishlist(phone,listing_id,note) VALUES(?,?,?) ON CONFLICT(phone,listing_id) DO UPDATE SET note=excluded.note').bind(n, listing_id, note ?? null).run();
      await updateDeal(env, n, listing_id, null, {});
      return { ok: true };
    }
    if (action === 'wishlist_list') {
      const rows = (await env.DB.prepare('SELECT listing_id,note FROM wishlist WHERE phone=?').bind(n).all()).results;
      return { wishlist: await Promise.all(rows.map(async r => ({ ...r, listing: await getListing(env, r.listing_id) }))) };
    }
    if (action === 'alert_create') {
      if (!consent) return { error: 'Ask the tenant for consent to be called about new listings, then pass consent=true.' };
      const saved = await getProfile(env, n) || {};
      const crit = Object.fromEntries(['locality', 'bhk', 'max_rent', 'max_deposit', 'amenities', 'furnishing'].map(k => [k, prefs[k] ?? saved[k]]).filter(([, v]) => v != null));
      const r = await env.DB.prepare('INSERT INTO alerts(phone,criteria,channel,call_if_urgent) VALUES(?,?,?,?)').bind(n, JSON.stringify(crit), 'call', 0).run();
      return { alert_id: r.meta.last_row_id, criteria: crit, note: 'Checked every 10 minutes; current listings form the baseline, only new ones trigger a call.' };
    }
    if (action === 'alert_list') return { alerts: (await env.DB.prepare('SELECT id,criteria,active,last_run FROM alerts WHERE phone=?').bind(n).all()).results.map(a => ({ ...a, criteria: j(a.criteria) })) };
    if (action === 'alert_cancel') { await env.DB.prepare('UPDATE alerts SET active=0 WHERE id=? AND phone=?').bind(alert_id, n).run(); return { ok: true }; }
  });

  // ---------------------------------------------------------------- listings
  tool('listings', `Rental listings. Actions:
- search: live NoBroker listings (via API.SH) ranked against criteria (locality, bhk, max_rent, max_deposit, amenities, furnishing). Returns listing ids and match_score. Owner contacts are not provided by the source.
- details: full record for listing_id.
- check_new: run the new-listing alert check now (normally automatic).`, {
    action: z.enum(['search', 'details', 'check_new']),
    locality: opt, bhk: z.number().int().min(1).max(5).optional(), max_rent: z.number().int().positive().optional(),
    max_deposit: z.number().int().positive().optional(), amenities: z.array(z.string().max(30)).max(8).optional(),
    furnishing: z.enum(['none', 'semi', 'full']).optional(), include_demo: z.boolean().optional(),
    limit: z.number().int().min(1).max(10).optional(), listing_id: z.string().max(60).optional(),
  }, async ({ action, include_demo, limit = 5, listing_id, ...c }) => {
    if (action === 'details') return { listing: await getListing(env, listing_id) };
    if (action === 'check_new') return { report: await runAlerts(env) };
    const r = await findListings(env, c, { includeDemo: !!include_demo });
    return { total_on_portal: r.total_on_portal, warning: r.warning, results: r.results.slice(0, limit).map(({ lat, lon, image, amenities, street, updated, ...x }) => x) };
  });

  // ---------------------------------------------------------------- research
  tool('research', `Research & negotiation specialist (runs Firecrawl + Parallel searches concurrently). Actions:
- locality: resident reviews (Reddit/forums), safety, rental scams/shady practices, pricing, schools, amenities for a locality (optionally limit topics).
- dossier: for listing_id, in parallel: market comparison + locality research + negotiation plan. Use before a visit or negotiation.
- market: rent/deposit statistics for locality+bhk from live comparables.
- negotiate: negotiation plan for listing_id (opening offer, target, walk-away, deposit plan, leverage, owner script). Pass red_flags from research.
- web: free-form web search (query). - read_page: read a URL.
Summarise for the caller in plain speech; say opinions online are unverified.`, {
    action: z.enum(['locality', 'dossier', 'market', 'negotiate', 'web', 'read_page']),
    locality: opt, bhk: z.number().int().min(1).max(5).optional(), topics: z.array(z.enum(TOPIC_NAMES)).max(6).optional(),
    listing_id: z.string().max(60).optional(), max_rent: z.number().int().positive().optional(),
    max_deposit_months: z.number().min(1).max(12).optional(), red_flags: z.array(z.string().max(200)).max(6).optional(),
    query: z.string().max(300).optional(), url: z.string().max(500).optional(),
  }, async ({ action, locality, bhk, topics, listing_id, max_rent, max_deposit_months, red_flags, query, url }) => {
    if (action === 'locality') return { locality, findings: await researchLocality(env, locality, 'Bengaluru', topics) };
    if (action === 'market') return marketStats(env, { locality, bhk });
    if (action === 'web') { const [a, b] = await Promise.all([firecrawlSearch(env, query, 5), parallelSearch(env, query)]); return { results: [...a, ...b] }; }
    if (action === 'read_page') return { url, text: (await scrapeMarkdown(env, url)) ?? 'Could not fetch this page.' };
    const listing = await getListing(env, listing_id); if (!listing) return { error: 'Unknown listing_id' };
    if (action === 'negotiate') return negotiationBrief(env, { listing, max_rent, max_deposit_months, red_flags });
    const [research, negotiation] = await Promise.all([researchLocality(env, listing.locality, 'Bengaluru', topics), negotiationBrief(env, { listing, max_rent, max_deposit_months, red_flags })]);
    return { listing, negotiation, locality_research: research };
  });

  // ---------------------------------------------------------------- visits
  tool('visits', `Viewing coordination through outbound Talkdesk calls. Actions:
- schedule: phone, listing_id, owner_phone, owner_name, requested_time (ISO 8601 with +05:30) and mode:
    "ai_call" (default) = our Owner-Liaison AI agent phones the owner on a separate call, confirms/renegotiates the time, then our agent calls the tenant back with the result;
    "direct_connect" = the owner is phoned and connected straight to the tenant's phone to talk directly (end your call first so the line is free).
  Always ask the tenant which mode they want.
- connect_owner: visit_id; connect tenant and owner directly now (same as direct_connect for an existing visit).
- status: visit_id. - accept_owner_time: visit_id; tenant accepts the owner's proposed time.
- demo_owner_reply: visit_id, text; DEMO ONLY, simulates the owner's answer.`, {
    action: z.enum(['schedule', 'connect_owner', 'status', 'accept_owner_time', 'demo_owner_reply']),
    phone: z.string().max(20).optional(), listing_id: z.string().max(60).optional(), owner_phone: z.string().max(20).optional(),
    owner_name: z.string().max(80).optional(), requested_time: z.string().max(40).optional(),
    mode: z.enum(['ai_call', 'direct_connect']).optional(), notes: z.string().max(300).optional(),
    visit_id: z.number().int().optional(), text: z.string().max(200).optional(),
  }, async ({ action, visit_id, text, ...a }) => {
    if (action === 'schedule') {
      if (!a.phone || !a.listing_id || !a.owner_phone || !a.requested_time) return { error: 'schedule needs phone, listing_id, owner_phone and requested_time' };
      return scheduleVisit(env, a);
    }
    if (!visit_id) return { error: 'visit_id required' };
    if (action === 'connect_owner') return { call: await callOwner(env, visit_id, 'owner_bridge'), say: 'Tell the caller their phone will ring shortly with the owner on the line, then end this call.' };
    if (action === 'status') return { visit: await env.DB.prepare('SELECT * FROM visits WHERE id=?').bind(visit_id).first() };
    if (action === 'accept_owner_time') return confirmProposedTime(env, visit_id);
    if (action === 'demo_owner_reply') return applyOwnerResponse(env, visit_id, parseReply(text), text);
  });

  // ---------------------------------------------------------------- deal
  tool('deal', `Deal tracking and closing. Actions:
- update: phone, listing_id, stage (${STAGES.join(', ')}) and terms (agreed_rent, agreed_deposit, move_in...).
- draft_agreement: phone, listing_id, landlord_name, tenant_name, property_address, rent, deposit, start_date (YYYY-MM-DD), optional months/maintenance/lock_in_months/notice_months/escalation_pct/extra_terms. Draft only, not legal advice.
- call_tenant_later: phone, purpose; schedule an outbound AI follow-up call to the tenant.`, {
    action: z.enum(['update', 'draft_agreement', 'call_tenant_later']),
    phone: z.string().min(8).max(20), listing_id: z.string().max(60).optional(), stage: z.enum(STAGES).optional(),
    terms: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    landlord_name: z.string().max(100).optional(), tenant_name: z.string().max(100).optional(), property_address: z.string().max(300).optional(),
    rent: z.number().int().positive().optional(), deposit: z.number().int().min(0).optional(), start_date: z.string().max(20).optional(),
    months: z.number().int().min(1).max(60).optional(), maintenance: z.number().int().min(0).optional(), lock_in_months: z.number().int().min(0).optional(),
    notice_months: z.number().int().min(0).optional(), escalation_pct: z.number().min(0).max(20).optional(), extra_terms: z.array(z.string().max(200)).max(8).optional(),
    purpose: z.string().max(400).optional(),
  }, async ({ action, phone: p, listing_id, stage, terms, purpose, ...t }) => {
    const n = normPhone(p);
    if (action === 'call_tenant_later') return callTenant(env, { phone: n, purpose: purpose || 'Follow-up' });
    if (!listing_id) return { error: 'listing_id required' };
    if (action === 'update') { const d = await updateDeal(env, n, listing_id, stage, terms); return { deal: { ...d, terms: j(d.terms) } }; }
    for (const k of ['landlord_name', 'tenant_name', 'property_address', 'rent', 'deposit', 'start_date']) if (t[k] == null) return { error: `draft_agreement needs ${k}` };
    const text = draftAgreement(t);
    await updateDeal(env, n, listing_id, 'agreement_drafted', { agreed_rent: t.rent, agreed_deposit: t.deposit, start_date: t.start_date });
    return { agreement_text: text, next_steps: ['Both parties review the draft', 'Verify owner ID and ownership documents', 'E-stamp and sign', 'Pay deposit by bank transfer against a receipt'] };
  });

  // ---------------------------------------------------------------- outbound-call agents
  tool('call_context', `For OUTBOUND call agents. Actions:
- load: FIRST thing on every outbound call. Pass the number you are speaking with (Caller ID) or outreach_id. Returns who you called, why, the briefing and what to do. Also returns current IST time.
- connect_tenant: the OWNER asked to speak to the tenant directly on this call; returns the tenant number. Then tell the owner you are connecting them and end with the transfer/escalation exit so the flow forwards the call.
- complete: outreach_id, summary; store a short summary at the end of the call.`, {
    action: z.enum(['load', 'connect_tenant', 'complete']),
    phone: z.string().max(20).optional(), outreach_id: z.number().int().optional(), summary: z.string().max(600).optional(),
  }, async ({ action, phone: p, outreach_id, summary }) => {
    const o = await getOutreach(env, { outreach_id, phone: p ? normPhone(p) : null });
    if (!o) return { error: 'No active outbound call found for that number.' };
    if (action === 'load') { await env.DB.prepare("UPDATE outreach SET status='in_progress' WHERE id=? AND status IN ('dialing','dry_run')").bind(o.id).run(); return { now_ist: nowIst(), outreach: o }; }
    if (action === 'connect_tenant') { await env.DB.prepare("UPDATE outreach SET status='transferred' WHERE id=?").bind(o.id).run(); return { forward_to: o.tenant_phone }; }
    await env.DB.prepare("UPDATE outreach SET status='completed', summary=? WHERE id=?").bind(summary || '', o.id).run();
    return { ok: true };
  });

  tool('owner_response', 'Owner-Liaison agent: record the owner\'s answer to the viewing request. outcome yes / no / reschedule (with proposed_time ISO 8601 +05:30) / other. Optionally the rent/deposit the owner quoted. The tenant is then called back automatically by our tenant agent.', {
    visit_id: z.number().int(), outcome: z.enum(['yes', 'no', 'reschedule', 'other']), details: z.string().max(400).optional(),
    proposed_time: z.string().max(40).optional(), quoted_rent: z.number().int().optional(), quoted_deposit: z.number().int().optional(),
  }, async ({ visit_id, outcome, details, proposed_time, quoted_rent, quoted_deposit }) => {
    const r = await applyOwnerResponse(env, visit_id, outcome, details, proposed_time);
    if (!r.error && (quoted_rent || quoted_deposit)) {
      const v = await env.DB.prepare('SELECT phone,listing_id FROM visits WHERE id=?').bind(visit_id).first();
      await updateDeal(env, v.phone, v.listing_id, null, { owner_quoted_rent: quoted_rent, owner_quoted_deposit: quoted_deposit });
    }
    return r;
  });
  return s;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.MCP_BEARER_TOKEN || request.headers.get('Authorization') !== `Bearer ${env.MCP_BEARER_TOKEN}`) return new Response('Unauthorized', { status: 401, headers: { 'Cache-Control': 'no-store' } });
    if (url.pathname !== '/mcp') return new Response('Not found', { status: 404 });
    return createMcpHandler(() => makeServer(env))(request, env, ctx);
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil((async () => { await runAlerts(env); await escalateVisits(env); })());
  },
};
