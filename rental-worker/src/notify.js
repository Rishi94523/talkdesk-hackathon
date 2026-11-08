// Outbound calls go through Talkdesk Studio flows that use the "API request" trigger
// (POST /flows/{flow_id}/interactions, scope flows-interactions:start).
// Each call is recorded as an "outreach" row whose id is passed to the flow, so the AI agent
// on the call can load its briefing with the get_outreach_context tool.
import { tmo, j } from './util.js';
import { enrichNegotiation } from './negotiation.js';

let cached = { token: null, exp: 0 };
async function talkdeskToken(env) {
  if (cached.token && Date.now() < cached.exp) return cached.token;
  const r = await fetch(`https://${env.TALKDESK_ACCOUNT}.talkdeskid.com/oauth/token`, {
    method: 'POST', signal: tmo(15000),
    headers: { Authorization: 'Basic ' + btoa(`${env.TALKDESK_CLIENT_ID}:${env.TALKDESK_CLIENT_SECRET}`), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'flows-interactions:start' }),
  });
  if (!r.ok) throw new Error('Talkdesk auth failed: HTTP ' + r.status);
  const d = await r.json();
  cached = { token: d.access_token, exp: Date.now() + (d.expires_in - 60) * 1000 };
  return cached.token;
}

// kind -> env var holding the Studio flow id
export const FLOW_ENV = { owner_ai: 'TD_FLOW_OWNER_AI', owner_bridge: 'TD_FLOW_OWNER_BRIDGE', tenant_ai: 'TD_FLOW_TENANT_AI' };

// Owner negotiation and signing calls go to the ElevenLabs voice flow when it is configured.
export const flowFor = (env, kind, purpose) => (kind === 'owner_ai' && env.TD_FLOW_OWNER_VOICE && ['negotiation', 'signing_intent'].includes(purpose)) ? env.TD_FLOW_OWNER_VOICE : env[FLOW_ENV[kind]];

async function startFlow(env, flowId, args) {
  const r = await fetch(`${env.TALKDESK_API || 'https://api.talkdeskapp.com'}/flows/${flowId}/interactions`, {
    method: 'POST', signal: tmo(20000),
    headers: { Authorization: 'Bearer ' + (await talkdeskToken(env)), 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.fromEntries(Object.entries(args).map(([k, v]) => [k, String(v ?? '')]))),
  });
  const d = await r.json().catch(() => ({}));
  return r.ok ? { ok: true, id: d.interaction_id } : { ok: false, error: d.message || 'HTTP ' + r.status };
}

/**
 * Place an outbound call via Talkdesk.
 * kind: owner_ai (AI agent talks to owner) | owner_bridge (owner is called, then connected to the tenant) | tenant_ai (AI agent talks to tenant)
 */
export async function placeCall(env, { kind, to, tenant_phone = null, owner_phone = null, visit_id = null, alert_id = null, purpose, briefing = {} }) {
  const flowId = flowFor(env, kind, purpose);
  const ready = !!(flowId && env.TALKDESK_CLIENT_ID);
  // Deferred calls let the current conversation end first (the demo tenant and owner share one phone).
  const defer = ready && callDelaySeconds(env) > 0;
  const ins = await env.DB.prepare('INSERT INTO outreach(kind,to_phone,tenant_phone,owner_phone,visit_id,alert_id,purpose,briefing,status) VALUES(?,?,?,?,?,?,?,?,?)')
    .bind(kind, to, tenant_phone, owner_phone, visit_id, alert_id, purpose, JSON.stringify(briefing), !ready ? 'dry_run' : defer ? 'queued' : 'initiating').run();
  const id = ins.meta.last_row_id;
  if (defer) return { outreach_id: id, kind, to, status: 'queued', note: `The call will be placed about ${callDelaySeconds(env)}-${callDelaySeconds(env) + 60} seconds after this request, once the current call has ended.` };
  let status = 'dry_run', interaction_id = null, error = null;
  if (ready) { await closeEarlierCalls(env, to, id); const o = { id, kind, briefing: JSON.stringify(briefing) }; await researchBeforeDial(env, o); briefing = j(o.briefing); }
  if (ready) {
    try {
      const res = await startFlow(env, flowId, { to_number: to, tenant_number: tenant_phone, owner_number: owner_phone, outreach_id: id, intro: briefing.spoken_intro || purpose });
      status = res.ok ? 'dialing' : 'failed'; interaction_id = res.id || null; error = res.error || null;
    } catch (e) { status = 'failed'; error = e.message; }
  }
  await env.DB.prepare("UPDATE outreach SET status=CASE WHEN status IN ('in_progress','completed') AND ?='dialing' THEN status ELSE ? END, interaction_id=?, error=? WHERE id=?").bind(status, status, interaction_id, error, id).run();
  return { outreach_id: id, kind, to, status, ...(error ? { error } : {}), ...(status === 'dry_run' ? { note: `Talkdesk flow for ${kind} not configured (${FLOW_ENV[kind]}); call recorded, not placed.` } : {}) };
}

export const callDelaySeconds = env => Math.max(0, +(env.CALL_DELAY_SECONDS ?? 60) || 0);
export const callStarted = call => ['dialing', 'queued'].includes(call?.status);

// Cron: start queued calls whose delay has elapsed. Each row is claimed atomically so a call is started at most once.
// Talkdesk does not tell us when a call ends, so the AI's last tool call on a line stands in for it. A queued
// call to a number waits until that line has been quiet for LINE_QUIET_SECONDS (goodbye plus hang-up), so it
// never rings a phone that is still on the previous call.
export async function touchLine(env, phone) {
  if (!phone) return;
  try { await env.DB.prepare("INSERT INTO line_activity(phone,at) VALUES(?,CURRENT_TIMESTAMP) ON CONFLICT(phone) DO UPDATE SET at=CURRENT_TIMESTAMP").bind(phone).run(); } catch {}
}
export const lineQuietSeconds = env => Math.max(0, +(env.LINE_QUIET_SECONDS ?? 45) || 0);

export async function dispatchQueued(env) {
  const rows = (await env.DB.prepare("SELECT * FROM outreach WHERE status='queued' AND created_at <= datetime('now', ?) AND NOT EXISTS (SELECT 1 FROM line_activity la WHERE la.phone=outreach.to_phone AND la.at > datetime('now', ?)) ORDER BY id LIMIT 5")
    .bind(`-${callDelaySeconds(env)} seconds`, `-${lineQuietSeconds(env)} seconds`).all()).results;
  const out = [];
  for (const o of rows) {
    const claim = await env.DB.prepare("UPDATE outreach SET status='initiating' WHERE id=? AND status='queued'").bind(o.id).run();
    if (!claim.meta.changes) continue;
    await closeEarlierCalls(env, o.to_phone, o.id);
    await researchBeforeDial(env, o);
    const flowId = flowFor(env, o.kind, o.purpose);
    let status = 'failed', interaction_id = null, error = null;
    if (!flowId || !env.TALKDESK_CLIENT_ID) error = `Flow for ${o.kind} is no longer configured.`;
    else {
      try {
        const briefing = j(o.briefing);
        const res = await startFlow(env, flowId, { to_number: o.to_phone, tenant_number: o.tenant_phone, owner_number: o.owner_phone, outreach_id: o.id, intro: briefing.spoken_intro || o.purpose });
        status = res.ok ? 'dialing' : 'failed'; interaction_id = res.id || null; error = res.error || null;
      } catch (e) { error = e.message; }
    }
    await env.DB.prepare("UPDATE outreach SET status=CASE WHEN status IN ('in_progress','completed') AND ?='dialing' THEN status ELSE ? END, interaction_id=?, error=? WHERE id=?").bind(status, status, interaction_id, error, o.id).run();
    out.push({ outreach_id: o.id, kind: o.kind, status, ...(error ? { error } : {}) });
  }
  return out;
}

// A negotiation call is researched (comparables, market, web) right before the owner is dialled.
async function researchBeforeDial(env, o) {
  const b = j(o.briefing);
  if (o.kind !== 'owner_ai' || b.task !== 'negotiation' || b.research_done) return;
  try {
    const enriched = await enrichNegotiation(env, b);
    o.briefing = JSON.stringify(enriched);
    await env.DB.prepare('UPDATE outreach SET briefing=? WHERE id=?').bind(o.briefing, o.id).run();
  } catch (e) { console.log('negotiation research failed', e.message); }
}

// A phone is on one call at a time: starting a call to a number ends any earlier open call to it, so the
// next agent's context lookup by phone is never ambiguous (the demo tenant and owner share one phone).
export async function closeEarlierCalls(env, to, id) {
  await env.DB.prepare("UPDATE outreach SET status='completed', summary=COALESCE(summary,'Call ended') WHERE to_phone=? AND id<>? AND status IN ('initiating','dialing','in_progress')").bind(to, id).run();
}

// The shared thread between owner and tenant: every call about the same viewing or deal, in order,
// with what was asked and what the other side answered. Each agent loads it with its briefing.
export async function conversationThread(env, o) {
  if (!o?.tenant_phone) return [];
  const rows = (await env.DB.prepare("SELECT id,kind,purpose,briefing,summary,status,created_at FROM outreach WHERE tenant_phone=? AND (visit_id IS ? OR visit_id=? OR purpose IN ('negotiation','signing_intent')) AND created_at >= datetime('now','-2 days') AND status NOT IN ('dry_run','failed') AND id<=? ORDER BY id")
    .bind(o.tenant_phone, o.visit_id ?? null, o.visit_id ?? -1, o.id).all()).results;
  return rows.map(r => {
    const b = j(r.briefing);
    const asked = b.what_to_say || (r.kind === 'tenant_ai' ? r.purpose : b.goal) || r.purpose;
    return { call: r.id === o.id ? 'this call' : `call ${r.id}`, with: r.kind === 'owner_ai' ? 'owner' : 'tenant', asked: String(asked || '').slice(0, 300), answer: r.id === o.id ? null : (r.summary || 'no answer recorded') };
  });
}

// Record what one side said on the call in progress, so the next call's thread carries it.
export async function noteOnCall(env, { tenant_phone, kind, visit_id = null, text }) {
  const q = visit_id
    ? env.DB.prepare("SELECT id FROM outreach WHERE kind=? AND visit_id=? AND status IN ('dialing','in_progress') ORDER BY id DESC LIMIT 1").bind(kind, visit_id)
    : env.DB.prepare("SELECT id FROM outreach WHERE kind=? AND tenant_phone=? AND status IN ('dialing','in_progress') ORDER BY id DESC LIMIT 1").bind(kind, tenant_phone);
  const row = await env.DB.prepare('SELECT id,to_phone FROM outreach WHERE id=?').bind((await q.first())?.id ?? -1).first();
  if (row) { await env.DB.prepare('UPDATE outreach SET summary=? WHERE id=?').bind(String(text).slice(0, 500), row.id).run(); await touchLine(env, row.to_phone); }
}

export async function getOutreach(env, { outreach_id, phone, kind, interaction_id }) {
  let r;
  if (outreach_id) r = await env.DB.prepare('SELECT * FROM outreach WHERE id=?').bind(outreach_id).first();
  else if (interaction_id) r = await env.DB.prepare('SELECT * FROM outreach WHERE interaction_id=?').bind(interaction_id).first();
  else if (phone && (!kind || ['owner_ai', 'tenant_ai'].includes(kind))) {
    // A destination number is only a demo routing hint, not proof of identity. Refuse
    // ambiguous, stale and dry-run records instead of selecting an arbitrary caller.
    const rows = kind
      ? await env.DB.prepare("SELECT * FROM outreach WHERE to_phone=? AND kind=? AND status IN ('initiating','dialing','in_progress') AND created_at >= datetime('now','-10 minutes') ORDER BY id DESC LIMIT 2").bind(phone, kind).all()
      : await env.DB.prepare("SELECT * FROM outreach WHERE to_phone=? AND kind IN ('owner_ai','tenant_ai') AND status IN ('initiating','dialing','in_progress') AND created_at >= datetime('now','-10 minutes') ORDER BY id DESC LIMIT 2").bind(phone).all();
    if (rows.results.length === 1) r = rows.results[0];
    // Demo fallback for callbacks rerouted away from the tenant's own number (the callback agent's phone input is
    // fixed and it sends no role): if exactly one tenant callback is active, use it.
    else if (!rows.results.length && (kind === 'tenant_ai' || !kind)) {
      const any = await env.DB.prepare("SELECT * FROM outreach WHERE kind='tenant_ai' AND status IN ('initiating','dialing','in_progress') AND created_at >= datetime('now','-10 minutes') ORDER BY id DESC LIMIT 2").bind().all();
      if (any.results.length === 1) r = any.results[0];
    }
  }
  return r ? { ...r, briefing: j(r.briefing) } : null;
}
