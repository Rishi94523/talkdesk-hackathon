import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { z } from 'zod';
import { reply, fail, normPhone, j } from './util.js';
import { findListings, getListing, marketStats, researchLocality, firecrawlSearch, parallelSearch, scrapeMarkdown, TOPIC_NAMES, briefOf, factsOf, webLeadListing, cacheListings } from './sources.js';
import { getOutreach, dispatchQueued } from './notify.js';
import { getMemory, saveSummary, recordProperty, previouslyDiscussed, searchMemory } from './memory.js';
import { registerLegacy } from './legacy.js';
import { getProfile, saveProfile, scheduleVisit, applyOwnerResponse, parseReply, confirmProposedTime, callOwner, callTenant, updateDeal, STAGES, negotiationBrief, draftAgreement, runAlerts, escalateVisits, startOwnerDiscussion, recordOwnerDiscussion } from './flows.js';

// Talkdesk orchestrations allow 5 skills and each MCP skill binds ONE tool, so the server exposes a few
// multi-action tools. Each Talkdesk agent picks the subset it needs:
//   Concierge (inbound):      tenant, listings, research, visits, deal
//   Owner liaison (outbound): call_context, owner_response, listings
//   Tenant callback (outbound): call_context, tenant, listings, visits, research
const nowIst = () => new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' });
const opt = z.string().max(100).optional();
const spokenTime = iso => new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' });
// A short spoken recap of the caller's open threads so a returning call can continue where it left off.
async function callerRecap(env, visits, deals) {
  const parts = [];
  for (const v of visits.filter(v => v.status !== 'cancelled').slice(0, 2)) {
    const l = await getListing(env, v.listing_id);
    const name = l ? `${l.title || 'the property'} (${l.bhk ? l.bhk + ' BHK, ' : ''}${l.locality || ''})` : v.listing_id;
    const st = { confirmed: 'the owner confirmed', pending: 'waiting for the owner', declined: 'the owner declined', owner_proposed_time: 'the owner proposed another time', needs_attention: 'the owner needs more information' }[v.status] || v.status;
    parts.push(`Viewing of ${name} on ${spokenTime(v.requested_time)}: ${st}.`);
  }
  for (const d of deals.slice(0, 2)) {
    const t = j(d.terms);
    const bits = [d.stage && `stage ${d.stage.replace(/_/g, ' ')}`, t.tenant_offer && `your offer ${t.tenant_offer}`, t.authorized_max_rent && `your limit ${t.authorized_max_rent}`, t.owner_response && `owner said ${t.owner_response}${t.owner_response_details && t.owner_response_details !== t.owner_response ? ' (' + t.owner_response_details + ')' : ''}`].filter(Boolean);
    if (bits.length) parts.push(`Deal on ${d.listing_id.startsWith('MC-SHOWCASE') ? 'MergeConflicts Garden Residences' : d.listing_id}: ${bits.join(', ')}.`);
  }
  return parts.length ? parts.join(' ') : null;
}


function makeServer(env) {
  const s = new McpServer({ name: 'MergeConflicts Rentals', version: '2.0.0' });
  const REQ = { tenant: ['action', 'phone'], listings: ['action'], research: ['action'], visits: ['action'], deal: ['action', 'phone'], call_context: ['action'], owner_response: ['outcome'] };
  const tool = (name, description, shape, fn, required = REQ[name] || []) => s.registerTool(name, { description, inputSchema: z.object(shape) }, async a => {
    const missing = required.filter(k => a[k] == null || a[k] === '');
    if (missing.length) return fail('Missing required: ' + missing.join(', '));
    try { return reply(await fn(a)); } catch (e) { return fail('Tool failed: ' + (e.message || 'unknown').slice(0, 200)); }
  });

  // ---------------------------------------------------------------- tenant
  tool('tenant', 'Tenant memory keyed by phone. Actions: get (call first), save_preferences, record_property (when actually discussed, with status and reason), save_summary (at end of every call, with session_id), wishlist_add, wishlist_list, alert_create, alert_list, alert_cancel. Never claim a visit happened unless the tenant says so.', {
    action: z.enum(['get', 'save_preferences', 'record_property', 'save_summary', 'search_history', 'wishlist_add', 'wishlist_list', 'alert_create', 'alert_list', 'alert_cancel']).optional(),
    phone: z.string().max(20).optional().describe('Tenant phone number (Caller ID)'),
    name: z.string().max(80).optional(), locality: opt, bhk: z.number().int().min(1).max(5).optional(),
    max_rent: z.number().int().positive().optional(), max_deposit: z.number().int().positive().optional(),
    amenities: z.array(z.string().max(30)).max(8).optional(), furnishing: z.enum(['none', 'semi', 'full']).optional(),
    move_in_date: opt, pets: z.boolean().optional(), notes: z.string().max(500).optional(),
    listing_id: z.string().max(60).optional(), note: z.string().max(200).optional(),
    alert_id: z.number().int().optional(), consent: z.boolean().optional(), session_id: z.string().max(120).optional(), summary: z.string().max(1600).optional(),
    property_status: z.enum(['discussed','shortlisted','rejected','visit_requested','visit_confirmed','visited','liked','unavailable']).optional(), event_key: z.string().max(120).optional(), history_query: z.string().max(100).optional(),
  }, async ({ action, phone: p, listing_id, note, alert_id, consent, name, session_id, summary, property_status, event_key, history_query, ...prefs }) => {
    const n = normPhone(p);
    if (action === 'get') {
      const q = sql => env.DB.prepare(sql).bind(n).all().then(r => r.results);
      const [wishlist, visits, deals, alerts] = await Promise.all([q('SELECT listing_id,note FROM wishlist WHERE phone=?'), q('SELECT id,listing_id,owner_name,requested_time,status FROM visits WHERE phone=? ORDER BY id DESC LIMIT 10'), q('SELECT listing_id,stage,terms FROM deals WHERE phone=?'), q('SELECT id,criteria,active FROM alerts WHERE phone=? AND active=1')]);
      return { now_ist: nowIst(), now_iso: new Date().toISOString(), returning_caller_recap: await callerRecap(env, visits, deals), profile: await getProfile(env, n), wishlist: wishlist.slice(0,10), visits, deals: deals.slice(0,10).map(d => ({ ...d, terms: j(d.terms) })), alerts, memory: await getMemory(env, n) };
    }
    if (action === 'save_summary') return saveSummary(env, n, session_id, summary);
    if (action === 'record_property') return recordProperty(env, n, listing_id, property_status, note, session_id, event_key);
    if (action === 'search_history') return searchMemory(env, n, history_query, listing_id);
    if (action === 'save_preferences') return { profile: await saveProfile(env, n, name, prefs, null) };
    if (action === 'wishlist_add') {
      if (!listing_id || !(await getListing(env, listing_id))) return { error: 'Unknown listing_id; search first.' };
      await env.DB.prepare('INSERT INTO wishlist(phone,listing_id,note) VALUES(?,?,?) ON CONFLICT(phone,listing_id) DO UPDATE SET note=excluded.note').bind(n, listing_id, note ?? null).run();
      await recordProperty(env, n, listing_id, 'shortlisted', note, session_id, event_key);
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
  tool('listings', 'Rental listings. action: search (locality, bhk, max_rent, max_deposit, amenities, furnishing; offset for more) returns up to 5 short options with a one-line brief each: the fictional MergeConflicts showcase first, then NoBroker listings, then web leads. details (listing_id) returns full facts for one option. check_new runs the alert check.', {
    action: z.enum(['search', 'details', 'check_new']).optional(),
    locality: opt, bhk: z.number().int().min(1).max(5).optional(), max_rent: z.number().int().positive().optional(),
    max_deposit: z.number().int().positive().optional(), amenities: z.array(z.string().max(30)).max(8).optional(),
    furnishing: z.enum(['none', 'semi', 'full']).optional(), property_type: z.string().max(40).optional(), move_in_date: z.string().max(40).optional(), pets: z.boolean().optional(), requested_preferences: z.string().max(500).optional(), include_demo: z.boolean().optional(),
    limit: z.number().int().min(1).max(10).optional(), offset: z.number().int().min(0).max(50).optional(), listing_id: z.string().max(60).optional(), phone: z.string().max(20).optional(), include_previously_discussed: z.boolean().optional(),
  }, async ({ action, include_demo, limit = 5, offset = 0, listing_id, phone: p, include_previously_discussed, ...c }) => {
    if (action === 'details') {
      const listing = await getListing(env, listing_id);
      if (!listing) return { error: 'Unknown listing_id; search first.' };
      const { lat, lon, image, url, ...facts } = listing;
      const text = listing.source === 'web' && url ? await scrapeMarkdown(env, url, 1500) : null;
      return { listing: facts, ...(text ? { page_text: text } : {}), speak: 'Describe these facts conversationally; never read a URL aloud. For the showcase, mention once that it is a demo listing, then offer to arrange a viewing with the owner.' };
    }
    if (action === 'check_new') return { report: await runAlerts(env) };
    const query = `${c.bhk ? c.bhk + ' BHK ' : ''}flat for rent in ${c.locality || 'Bengaluru'} Bengaluru${c.max_rent ? ' under ' + c.max_rent : ''}`;
    const [r, fc, pa] = await Promise.all([
      findListings(env, c, { includeDemo: !!include_demo, includeShowcase: true }),
      firecrawlSearch(env, query, 4), parallelSearch(env, query),
    ]);
    const seen = p ? await previouslyDiscussed(env, normPhone(p), r.results.map(x => x.id)) : new Set();
    const portal = include_previously_discussed ? r.results : r.results.filter(x => x.is_showcase || !seen.has(x.id));
    const web = [...new Map([...fc, ...pa].filter(x => x.url && x.title).map(x => [x.url, webLeadListing(x)])).values()];
    await cacheListings(env, web);
    // Talkdesk can only pass fixed or variable-mapped inputs, so one search returns everything the
    // conversation needs: 10 options with facts; the agent reads 5 now and keeps 5 for "more".
    const showcase = portal.filter(x => x.is_showcase), rest = [...portal.filter(x => !x.is_showcase), ...web];
    const all = [...showcase, ...rest].slice(offset, offset + Math.max(limit, 10));
    const options = all.map((x, i) => ({ number: offset + i + 1, group: i < 5 ? 'read_now' : 'more', listing_id: x.id, source: x.is_showcase ? 'demo_showcase' : x.source, title: x.title, brief: briefOf(x), facts: factsOf(x), ...(x.mismatches?.length ? { mismatches: x.mismatches } : {}) }));
    return {
      options, ...(r.warning ? { warning: r.warning } : {}),
      speak: 'Read the read_now options as a short numbered list using only each brief (option 1 is the MergeConflicts demo listing; say so once). Never read URLs. Ask whether any interests them or whether to keep searching. If they want more, read the more options; do not search again unless the criteria change. When they pick one, describe it in detail from its facts.',
    };
  });

  // ---------------------------------------------------------------- research
  tool('research', 'Research + negotiation via parallel Firecrawl/Parallel web search. action: locality (Reddit/forum reviews, safety, scams, pricing, schools, amenities), dossier (listing_id: all of it + negotiation plan), market, negotiate (listing_id), web (query), read_page (url).', {
    action: z.enum(['locality', 'dossier', 'market', 'negotiate', 'web', 'read_page']).optional(),
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
  tool('visits', 'Coordinate a viewing through a separate owner AI call. action: schedule (phone, listing_id, owner_phone, owner_name, requested_time ISO+05:30), status, accept_owner_time, demo_owner_reply (visit_id). Do not promise confirmation until the owner agrees.', {
    action: z.enum(['schedule', 'status', 'accept_owner_time', 'demo_owner_reply']).optional(),
    phone: z.string().max(20).optional(), listing_id: z.string().max(60).optional(), owner_phone: z.string().max(20).optional(),
    owner_name: z.string().max(80).optional(), requested_time: z.string().max(40).optional(),
    notes: z.string().max(300).optional(), dry_run_only: z.boolean().optional().describe('For tests: record the request without placing any calls.'),
    visit_id: z.number().int().optional(), text: z.string().max(200).optional(),
  }, async ({ action, visit_id, text, ...a }) => {
    if (action === 'schedule') {
      if (!a.phone || !a.listing_id || !a.requested_time) return { error: 'schedule needs phone, listing_id and requested_time' };
      if (!a.owner_phone && a.listing_id.startsWith('MC-SHOWCASE-')) { a.owner_phone = env.DEMO_OWNER_PHONE; a.owner_name ||= 'Rishi D V'; }
      if (!a.owner_phone) return { error: 'No owner contact is available for this listing.' };
      return scheduleVisit(a.dry_run_only ? { ...env, TD_FLOW_OWNER_AI: null, TD_FLOW_OWNER_BRIDGE: null } : env, a);
    }
    if (!visit_id) return { error: 'visit_id required' };
    if (action === 'status') return { visit: await env.DB.prepare('SELECT * FROM visits WHERE id=?').bind(visit_id).first() };
    if (action === 'accept_owner_time') return confirmProposedTime(env, visit_id);
    if (action === 'demo_owner_reply') return applyOwnerResponse(env, visit_id, parseReply(text), text);
  });

  // ---------------------------------------------------------------- deal
  tool('deal', 'Deal tracking. Actions: update; negotiate_owner (phone, listing_id, offer and explicit max_rent and/or max_deposit); communicate_intent (phone, listing_id, move_in_date); draft_agreement; call_tenant_later. Owner outreach is a separate two-way AI call; never promise the call or agreement succeeded unless its result confirms it.', {
    action: z.enum(['update', 'draft_agreement', 'call_tenant_later', 'negotiate_owner', 'communicate_intent']).optional(),
    phone: z.string().max(20).optional(), listing_id: z.string().max(60).optional(), stage: z.enum(STAGES).optional(),
    terms: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    landlord_name: z.string().max(100).optional(), tenant_name: z.string().max(100).optional(), property_address: z.string().max(300).optional(),
    rent: z.number().int().positive().optional(), deposit: z.number().int().min(0).optional(), start_date: z.string().max(20).optional(),
    months: z.number().int().min(1).max(60).optional(), maintenance: z.number().int().min(0).optional(), lock_in_months: z.number().int().min(0).optional(),
    notice_months: z.number().int().min(0).optional(), escalation_pct: z.number().min(0).max(20).optional(), extra_terms: z.array(z.string().max(200)).max(8).optional(),
    purpose: z.string().max(400).optional(), offer: z.string().max(400).optional(), max_rent: z.number().int().positive().optional(), max_deposit: z.number().int().positive().optional(), move_in_date: z.string().max(40).optional(), notes: z.string().max(400).optional(),
  }, async ({ action, phone: p, listing_id, stage, terms, purpose, ...t }) => {
    const n = normPhone(p);
    if (action === 'call_tenant_later') return callTenant(env, { phone: n, purpose: purpose || 'Follow-up' });
    if (!listing_id && (action === 'negotiate_owner' || action === 'communicate_intent')) listing_id = (await env.DB.prepare("SELECT listing_id FROM visits WHERE phone=? AND status NOT IN ('cancelled') ORDER BY id DESC LIMIT 1").bind(n).first())?.listing_id;
    if (!listing_id) return { error: 'listing_id required' };
    if (action === 'negotiate_owner' || action === 'communicate_intent') return startOwnerDiscussion(env, { phone: n, listing_id, purpose: action === 'negotiate_owner' ? 'negotiation' : 'signing_intent', offer: t.offer, max_rent: t.max_rent, max_deposit: t.max_deposit, move_in_date: t.move_in_date, notes: t.notes });
    if (action === 'update') { const d = await updateDeal(env, n, listing_id, stage, terms); return { deal: { ...d, terms: j(d.terms) } }; }
    for (const k of ['landlord_name', 'tenant_name', 'property_address', 'rent', 'deposit', 'start_date']) if (t[k] == null) return { error: `draft_agreement needs ${k}` };
    const text = draftAgreement(t);
    await updateDeal(env, n, listing_id, 'agreement_drafted', { agreed_rent: t.rent, agreed_deposit: t.deposit, start_date: t.start_date });
    return { agreement_text: text, next_steps: ['Both parties review the draft', 'Verify owner ID and ownership documents', 'E-stamp and sign', 'Pay deposit by bank transfer against a receipt'] };
  });

  // ---------------------------------------------------------------- outbound-call agents
  tool('call_context', 'For outbound call agents: load the briefing by outreach_id or interaction_id. For demo calls only, phone and call_role can locate exactly one recent active outreach. Phone is not identity authentication. Complete an outreach with its ID and summary.', {
    action: z.enum(['load', 'complete']).optional(),
    phone: z.string().max(20).optional(), outreach_id: z.number().int().optional(), interaction_id: z.string().max(120).optional(), call_role: z.enum(['owner_ai', 'tenant_ai']).optional(), summary: z.string().max(600).optional(),
  }, async ({ action, phone: p, outreach_id, interaction_id, call_role, summary }) => {
    const o = await getOutreach(env, { outreach_id, interaction_id, phone: p ? normPhone(p) : null, kind: call_role });
    if (!o) return { error: 'No active outbound call found for that number.' };
    if (call_role && o.kind !== call_role) return { error: 'Outreach role does not match this agent.' };
    if (action === 'load') { await env.DB.prepare("UPDATE outreach SET status='in_progress' WHERE id=? AND status IN ('initiating','dialing')").bind(o.id).run(); return { now_ist: nowIst(), outreach: o }; }
    await env.DB.prepare("UPDATE outreach SET status='completed', summary=? WHERE id=?").bind(summary || '', o.id).run();
    return { ok: true };
  });

  tool('owner_response', "Owner-Liaison agent: record the owner's answer to the viewing request: outcome yes / no / reschedule (with proposed_time ISO+05:30) / other, plus quoted_rent/quoted_deposit if mentioned. Our tenant agent then calls the tenant back.", {
    visit_id: z.number().int().optional(), outreach_id: z.number().int().optional(), owner_phone: z.string().max(20).optional(), outcome: z.enum(['yes', 'no', 'reschedule', 'other']).optional(), details: z.string().max(400).optional(), dry_run_only: z.boolean().optional().describe('For tests: record the response without placing any callback.'),
    proposed_time: z.string().max(40).optional(), quoted_rent: z.number().int().optional(), quoted_deposit: z.number().int().optional(),
  }, async ({ visit_id, outreach_id, owner_phone, outcome, details, proposed_time, quoted_rent, quoted_deposit, dry_run_only }) => {
    const responseEnv = dry_run_only ? { ...env, TD_FLOW_TENANT_AI: null } : env;
    if (outreach_id || owner_phone) {
      const outreach = await getOutreach(env, { outreach_id, phone: owner_phone ? normPhone(owner_phone) : null, kind: 'owner_ai' });
      if (!outreach) return { error: 'Outreach not found; do not record an owner response.' };
      if (outreach.kind !== 'owner_ai') return { error: 'Outreach is not an owner call.' };
      if (outreach && ['negotiation', 'signing_intent'].includes(outreach.purpose)) return recordOwnerDiscussion(responseEnv, outreach, { outcome, details, quoted_rent, quoted_deposit });
      visit_id ||= outreach?.visit_id;
    }
    if (!visit_id) return { error: 'visit_id or valid outreach_id required' };
    const r = await applyOwnerResponse(responseEnv, visit_id, outcome, details, proposed_time);
    if (!r.error && (quoted_rent || quoted_deposit)) {
      const v = await env.DB.prepare('SELECT phone,listing_id FROM visits WHERE id=?').bind(visit_id).first();
      await updateDeal(env, v.phone, v.listing_id, null, { owner_quoted_rent: quoted_rent, owner_quoted_deposit: quoted_deposit });
    }
    return r;
  });
  // Keep the published V1 Talkdesk orchestration operational until its replacement is tested.
  registerLegacy(s, env);
  return s;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.MCP_BEARER_TOKEN || request.headers.get('Authorization') !== `Bearer ${env.MCP_BEARER_TOKEN}`) return new Response('Unauthorized', { status: 401, headers: { 'Cache-Control': 'no-store' } });
    if (url.pathname !== '/mcp') return new Response('Not found', { status: 404 });
    return createMcpHandler(() => makeServer(env))(request, env, ctx);
  },
  async scheduled(event, env, ctx) {
    // Runs every minute so queued calls start promptly; alerts and escalation keep their 10-minute cadence.
    const tenMinute = new Date(event.scheduledTime || Date.now()).getUTCMinutes() % 10 === 0;
    ctx.waitUntil((async () => { await dispatchQueued(env); if (tenMinute) { await runAlerts(env); await escalateVisits(env); } })());
  },
};
