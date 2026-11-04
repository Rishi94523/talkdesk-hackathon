// Outbound calls go through Talkdesk Studio flows that use the "API request" trigger
// (POST /flows/{flow_id}/interactions, scope flows-interactions:start).
// Each call is recorded as an "outreach" row whose id is passed to the flow, so the AI agent
// on the call can load its briefing with the get_outreach_context tool.
import { tmo, j } from './util.js';

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
  const flowId = env[FLOW_ENV[kind]];
  const ready = !!(flowId && env.TALKDESK_CLIENT_ID);
  const ins = await env.DB.prepare('INSERT INTO outreach(kind,to_phone,tenant_phone,owner_phone,visit_id,alert_id,purpose,briefing,status) VALUES(?,?,?,?,?,?,?,?,?)')
    .bind(kind, to, tenant_phone, owner_phone, visit_id, alert_id, purpose, JSON.stringify(briefing), ready ? 'initiating' : 'dry_run').run();
  const id = ins.meta.last_row_id;
  let status = 'dry_run', interaction_id = null, error = null;
  if (ready) {
    try {
      const res = await startFlow(env, flowId, { to_number: to, tenant_number: tenant_phone, owner_number: owner_phone, outreach_id: id, intro: briefing.spoken_intro || purpose });
      status = res.ok ? 'dialing' : 'failed'; interaction_id = res.id || null; error = res.error || null;
    } catch (e) { status = 'failed'; error = e.message; }
  }
  await env.DB.prepare("UPDATE outreach SET status=CASE WHEN status IN ('in_progress','completed') AND ?='dialing' THEN status ELSE ? END, interaction_id=?, error=? WHERE id=?").bind(status, status, interaction_id, error, id).run();
  return { outreach_id: id, kind, to, status, ...(error ? { error } : {}), ...(status === 'dry_run' ? { note: `Talkdesk flow for ${kind} not configured (${FLOW_ENV[kind]}); call recorded, not placed.` } : {}) };
}

export async function getOutreach(env, { outreach_id, phone, kind, interaction_id }) {
  let r;
  if (outreach_id) r = await env.DB.prepare('SELECT * FROM outreach WHERE id=?').bind(outreach_id).first();
  else if (interaction_id) r = await env.DB.prepare('SELECT * FROM outreach WHERE interaction_id=?').bind(interaction_id).first();
  else if (phone && ['owner_ai', 'tenant_ai'].includes(kind)) {
    // A destination number is only a demo routing hint, not proof of identity. Refuse
    // ambiguous, stale and dry-run records instead of selecting an arbitrary caller.
    const rows = await env.DB.prepare("SELECT * FROM outreach WHERE to_phone=? AND kind=? AND status IN ('initiating','dialing','in_progress') AND created_at >= datetime('now','-10 minutes') ORDER BY id DESC LIMIT 2").bind(phone, kind).all();
    if (rows.results.length === 1) r = rows.results[0];
  }
  return r ? { ...r, briefing: j(r.briefing) } : null;
}
