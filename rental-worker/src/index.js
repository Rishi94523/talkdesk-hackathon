import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { z } from 'zod';
import { reply, fail, normPhone, j } from './util.js';
import { findListings, getListing, marketStats, researchLocality, firecrawlSearch, parallelSearch, scrapeMarkdown, TOPIC_NAMES, DEMO } from './sources.js';
import { placeCall, getOutreach } from './notify.js';
import { getProfile, saveProfile, scheduleVisit, applyOwnerResponse, parseReply, confirmProposedTime, callOwner, callTenant, updateDeal, STAGES, negotiationBrief, draftAgreement, runAlerts, escalateVisits } from './flows.js';

const phone = z.string().min(8).max(20).describe('Tenant phone number (caller ID), e.g. +919876543210');
const criteria = {
  locality: z.string().max(100).optional().describe('Bengaluru locality, e.g. Whitefield'),
  bhk: z.number().int().min(1).max(5).optional(),
  max_rent: z.number().int().positive().optional().describe('Monthly budget in INR'),
  max_deposit: z.number().int().positive().optional().describe('Max security deposit in INR'),
  amenities: z.array(z.string().max(30)).max(8).optional().describe('e.g. parking, gym, pool, lift'),
  furnishing: z.enum(['none', 'semi', 'full']).optional(),
};

function makeServer(env) {
  const s = new McpServer({ name: 'MergeConflicts Rentals', version: '1.0.0' });
  const tool = (name, description, shape, fn) => s.registerTool(name, { description, inputSchema: z.object(shape) }, async a => { try { return reply(await fn(a)); } catch (e) { return fail('Tool failed: ' + (e.message || 'unknown').slice(0, 200)); } });

  // ---- Intake agent tools ----
  tool('get_current_time', 'Current date/time in India (IST). Call before computing visit times.', {}, async () => ({ now_ist: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' }), now_iso: new Date().toISOString() }));
  tool('save_tenant_profile', 'Store/merge the tenant\'s details and preferences (budget, deposit limit, BHK, localities, amenities). Call as soon as you learn something new.', { phone, name: z.string().max(80).optional(), calls_ok: z.boolean().optional().describe('Tenant agreed to receive outbound calls from the assistant'), ...criteria, move_in_date: z.string().max(40).optional(), pets: z.boolean().optional(), notes: z.string().max(500).optional() },
    async ({ phone: p, name, calls_ok, ...prefs }) => ({ profile: await saveProfile(env, normPhone(p), name, prefs, calls_ok) }));
  tool('get_tenant_profile', 'Fetch the saved profile, wishlist, visits and deals for a returning caller.', { phone }, async ({ phone: p }) => {
    const n = normPhone(p);
    const [wl, vs, ds] = await Promise.all(['SELECT listing_id,note FROM wishlist WHERE phone=?', 'SELECT id,listing_id,requested_time,status FROM visits WHERE phone=? ORDER BY id DESC LIMIT 10', 'SELECT listing_id,stage,terms FROM deals WHERE phone=?'].map(q => env.DB.prepare(q).bind(n).all()));
    return { profile: await getProfile(env, n), wishlist: wl.results, visits: vs.results, deals: ds.results.map(d => ({ ...d, terms: j(d.terms) })) };
  });

  // ---- Listing search agent tools ----
  tool('search_listings', 'Search live rental listings (NoBroker via API.SH) ranked against the tenant\'s preferences. Returns listing ids to use in other tools. Owner contacts are not included by the source.', { ...criteria, include_demo: z.boolean().default(false).describe('Also include fictional demo listings (for demos only)'), limit: z.number().int().min(1).max(15).default(6) },
    async ({ include_demo, limit, ...c }) => { const r = await findListings(env, c, { includeDemo: include_demo }); return { total_on_portal: r.total_on_portal, warning: r.warning, results: r.results.slice(0, limit).map(({ lat, lon, image, amenities, ...x }) => x) }; });
  tool('get_listing', 'Full details of one listing by id (from search_listings).', { listing_id: z.string().max(60) }, async ({ listing_id }) => ({ listing: await getListing(env, listing_id) }));
  tool('add_to_wishlist', 'Add a listing to the tenant\'s wishlist/shortlist.', { phone, listing_id: z.string().max(60), note: z.string().max(200).optional() }, async ({ phone: p, listing_id, note }) => {
    if (!(await getListing(env, listing_id))) return { error: 'Unknown listing_id' };
    const n = normPhone(p);
    await env.DB.prepare('INSERT INTO wishlist(phone,listing_id,note) VALUES(?,?,?) ON CONFLICT(phone,listing_id) DO UPDATE SET note=excluded.note').bind(n, listing_id, note ?? null).run();
    await updateDeal(env, n, listing_id, null, {});
    return { ok: true };
  });
  tool('get_wishlist', 'List the tenant\'s wishlist with listing details.', { phone }, async ({ phone: p }) => {
    const rows = (await env.DB.prepare('SELECT listing_id,note FROM wishlist WHERE phone=?').bind(normPhone(p)).all()).results;
    return { wishlist: await Promise.all(rows.map(async r => ({ ...r, listing: await getListing(env, r.listing_id) }))) };
  });

  // ---- Research agent tools ----
  tool('research_locality', 'Parallel web research (Firecrawl + Parallel) on a locality: resident reviews (Reddit/forums), safety, rental scams/shady practices, pricing, schools, amenities/connectivity. Returns sources with snippets; summarise them for the tenant and cite URLs.', { locality: z.string().max(100), city: z.string().max(50).default('Bengaluru'), topics: z.array(z.enum(TOPIC_NAMES)).max(6).optional() },
    async ({ locality, city, topics }) => ({ locality, city, findings: await researchLocality(env, locality, city, topics), note: 'Web snippets are unverified opinions; weigh several sources and say so.' }));
  tool('web_search', 'Free-form web search using both Firecrawl and Parallel, e.g. to check an owner, builder or society reputation.', { query: z.string().min(3).max(300) },
    async ({ query }) => { const [a, b] = await Promise.all([firecrawlSearch(env, query, 5), parallelSearch(env, query)]); return { results: [...a, ...b] }; });
  tool('read_web_page', 'Fetch the readable text of a URL (via Firecrawl). Use to read a listing page or a forum thread found in search.', { url: z.string().url().max(500) },
    async ({ url }) => ({ url, text: await scrapeMarkdown(env, url) ?? 'Could not fetch this page.' }));
  tool('market_price_estimate', 'Local rent and deposit statistics (median, quartiles, typical deposit months) from live comparable listings.', { locality: z.string().max(100), bhk: z.number().int().min(1).max(5).optional() }, ({ locality, bhk }) => marketStats(env, { locality, bhk }));
  tool('property_dossier', 'ORCHESTRATOR: for one listing run in parallel the market comparison, locality research (reviews, safety, scams, schools, amenities) and negotiation plan. Use before a visit or negotiation.', { listing_id: z.string().max(60), max_rent: z.number().int().positive().optional(), max_deposit_months: z.number().min(1).max(12).optional() },
    async ({ listing_id, max_rent, max_deposit_months }) => {
      const listing = await getListing(env, listing_id); if (!listing) return { error: 'Unknown listing_id' };
      const [research, brief] = await Promise.all([researchLocality(env, listing.locality, 'Bengaluru'), negotiationBrief(env, { listing, max_rent, max_deposit_months })]);
      return { listing, negotiation: brief, locality_research: research };
    });

  // ---- Visit scheduler agent tools ----
  tool('schedule_visit', 'Arrange a property viewing with the owner via an outbound Talkdesk call. mode "ai_call" (default): our owner-liaison AI agent phones the owner on a separate call, confirms or renegotiates the time, then the tenant is called back with the result. mode "direct_connect": the owner is phoned and connected straight to the tenant\'s phone so they talk directly (end the current call first). Ask the tenant which they prefer. Owner phone must be supplied (portal listings omit it).', { phone, listing_id: z.string().max(60), owner_phone: z.string().min(8).max(20), owner_name: z.string().max(80).optional(), requested_time: z.string().describe('ISO 8601 with offset, e.g. 2026-11-07T11:00:00+05:30'), mode: z.enum(['ai_call', 'direct_connect']).default('ai_call'), notes: z.string().max(300).optional() }, a => scheduleVisit(env, a));
  tool('connect_with_owner', 'Connect the tenant and owner directly for an existing visit: the owner is phoned and, on answering, forwarded to the tenant\'s phone. Use when the tenant (or owner) asks to talk directly.', { visit_id: z.number().int() }, async ({ visit_id }) => ({ call: await callOwner(env, visit_id, 'owner_bridge'), say: 'Tell the caller their phone will ring shortly with the owner on the line, then end this call.' }));
  tool('get_visit_status', 'Check a visit request (pending / confirmed / declined / owner_proposed_time / needs_attention) and owner notes.', { visit_id: z.number().int() }, async ({ visit_id }) => ({ visit: await env.DB.prepare('SELECT * FROM visits WHERE id=?').bind(visit_id).first() }));
  tool('confirm_proposed_time', 'Tenant accepts the alternative time the owner proposed.', { visit_id: z.number().int() }, ({ visit_id }) => confirmProposedTime(env, visit_id));
  tool('simulate_owner_reply', 'DEMO ONLY: simulate the owner answering the visit-request call (as if the owner-liaison agent recorded it).', { visit_id: z.number().int(), text: z.string().max(200) },
    async ({ visit_id, text }) => applyOwnerResponse(env, visit_id, parseReply(text), text));

  // ---- Outbound-call agent tools (owner liaison + tenant callback agents) ----
  tool('get_outreach_context', 'FIRST CALL on any outbound call: load who you are calling, why, and what to do. Pass the outreach_id from the flow; if unknown pass the number you are speaking with.', { outreach_id: z.number().int().optional(), phone: z.string().max(20).optional() },
    async ({ outreach_id, phone: p }) => {
      const o = await getOutreach(env, { outreach_id, phone: p ? normPhone(p) : null });
      if (!o) return { error: 'No active outreach found.' };
      await env.DB.prepare("UPDATE outreach SET status='in_progress' WHERE id=? AND status IN ('dialing','dry_run')").bind(o.id).run();
      return { outreach: o };
    });
  tool('record_owner_response', 'Owner-liaison agent: record the owner\'s answer to the viewing request. outcome yes / no / reschedule (give proposed_time ISO) / other. The tenant is then called back automatically.', { visit_id: z.number().int(), outcome: z.enum(['yes', 'no', 'reschedule', 'other']), details: z.string().max(400).optional(), proposed_time: z.string().optional(), confirmed_rent: z.number().int().optional(), confirmed_deposit: z.number().int().optional() },
    async ({ visit_id, outcome, details, proposed_time, confirmed_rent, confirmed_deposit }) => {
      const r = await applyOwnerResponse(env, visit_id, outcome, details, proposed_time);
      if (!r.error && (confirmed_rent || confirmed_deposit)) { const v = await env.DB.prepare('SELECT phone,listing_id FROM visits WHERE id=?').bind(visit_id).first(); await updateDeal(env, v.phone, v.listing_id, null, { owner_quoted_rent: confirmed_rent, owner_quoted_deposit: confirmed_deposit }); }
      return r;
    });
  tool('request_direct_connect', 'Owner-liaison agent: the owner wants to speak to the tenant directly on this same call. Records it and returns the number; then end your turn with the transfer exit so the flow forwards the call to tenant_number.', { outreach_id: z.number().int() },
    async ({ outreach_id }) => { const o = await getOutreach(env, { outreach_id }); if (!o) return { error: 'unknown outreach' }; await env.DB.prepare("UPDATE outreach SET status='transferred' WHERE id=?").bind(outreach_id).run(); return { forward_to: o.tenant_phone, say: 'Let the owner know you are connecting them to the tenant now.' }; });
  tool('complete_outreach', 'End-of-call: store a short summary of an outbound call.', { outreach_id: z.number().int(), summary: z.string().max(600) },
    async ({ outreach_id, summary }) => { await env.DB.prepare("UPDATE outreach SET status='completed', summary=? WHERE id=?").bind(summary, outreach_id).run(); return { ok: true }; });
  tool('list_outreach', 'Recent outbound calls (for debugging/demo).', { limit: z.number().int().min(1).max(20).default(10) }, async ({ limit }) => ({ calls: (await env.DB.prepare('SELECT id,kind,to_phone,visit_id,alert_id,purpose,status,error,summary,created_at FROM outreach ORDER BY id DESC LIMIT ?').bind(limit).all()).results }));

  // ---- Alert agent tools ----
  tool('create_listing_alert', 'Watch for NEW listings matching criteria; every 10 min the system checks and, on new matches, our AI agent phones the tenant for a two-way conversation (walk through listings, book visits, update preferences). Requires the tenant\'s consent.', { phone, ...criteria, consent: z.boolean().describe('Tenant explicitly agreed to alerts') },
    async ({ phone: p, consent, ...c }) => {
      if (!consent) return { error: 'Need tenant consent before creating alerts.' };
      const r = await env.DB.prepare('INSERT INTO alerts(phone,criteria,channel,call_if_urgent) VALUES(?,?,?,?)').bind(normPhone(p), JSON.stringify(c), 'call', 0).run();
      return { alert_id: r.meta.last_row_id, status: 'active', note: 'First check records current listings as a baseline; only listings that appear afterwards trigger alerts.' };
    });
  tool('list_listing_alerts', 'List a tenant\'s alerts.', { phone }, async ({ phone: p }) => ({ alerts: (await env.DB.prepare('SELECT id,criteria,channel,call_if_urgent,active,last_run FROM alerts WHERE phone=?').bind(normPhone(p)).all()).results.map(a => ({ ...a, criteria: j(a.criteria) })) }));
  tool('cancel_listing_alert', 'Stop an alert.', { alert_id: z.number().int(), phone }, async ({ alert_id, phone: p }) => { await env.DB.prepare('UPDATE alerts SET active=0 WHERE id=? AND phone=?').bind(alert_id, normPhone(p)).run(); return { ok: true }; });
  tool('run_alert_check_now', 'Run the new-listing check immediately (normally scheduled).', {}, async () => ({ report: await runAlerts(env) }));
  tool('call_tenant', 'Schedule an outbound AI call to the tenant (follow-up/reminder). The callback agent holds a two-way conversation using the purpose you give.', { phone, purpose: z.string().min(1).max(400) },
    async ({ phone: p, purpose }) => callTenant(env, { phone: normPhone(p), purpose }));

  // ---- Negotiator / closer agent tools ----
  tool('negotiation_brief', 'Rent and deposit negotiation plan for a listing: market comparison, opening offer, target, walk-away, leverage, owner script, safety checklist. Pass research red flags you found.', { listing_id: z.string().max(60), max_rent: z.number().int().positive().optional(), max_deposit_months: z.number().min(1).max(12).optional(), red_flags: z.array(z.string().max(200)).max(6).optional(), lease_months: z.number().int().min(1).max(36).default(11) },
    async ({ listing_id, ...r }) => { const listing = await getListing(env, listing_id); return listing ? negotiationBrief(env, { listing, ...r }) : { error: 'Unknown listing_id' }; });
  tool('update_deal', `Track a deal. Stages: ${STAGES.join(', ')}. Terms (agreed_rent, agreed_deposit, move_in, owner_name...) are merged.`, { phone, listing_id: z.string().max(60), stage: z.enum(STAGES).optional(), terms: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional() },
    async ({ phone: p, listing_id, stage, terms }) => { const d = await updateDeal(env, normPhone(p), listing_id, stage, terms); return { deal: { ...d, terms: j(d.terms) } }; });
  tool('draft_rental_agreement', 'Produce a draft rental agreement text from agreed terms. Draft only, not legal advice; must be reviewed, stamped and signed by the parties. Moves the deal to agreement_drafted.', { phone, listing_id: z.string().max(60), landlord_name: z.string().max(100), tenant_name: z.string().max(100), property_address: z.string().max(300), rent: z.number().int().positive(), deposit: z.number().int().min(0), start_date: z.string().describe('YYYY-MM-DD'), months: z.number().int().min(1).max(60).default(11), maintenance: z.number().int().min(0).optional(), lock_in_months: z.number().int().min(0).optional(), notice_months: z.number().int().min(0).optional(), escalation_pct: z.number().min(0).max(20).optional(), extra_terms: z.array(z.string().max(200)).max(8).optional() },
    async ({ phone: p, listing_id, ...t }) => {
      const text = draftAgreement(t);
      await updateDeal(env, normPhone(p), listing_id, 'agreement_drafted', { agreed_rent: t.rent, agreed_deposit: t.deposit, start_date: t.start_date });
      return { agreement_text: text, next_steps: ['Send draft to both parties for review', 'Verify owner ID and ownership documents', 'Print on stamp paper / e-stamp and sign', 'Pay deposit by bank transfer against a receipt'] };
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
