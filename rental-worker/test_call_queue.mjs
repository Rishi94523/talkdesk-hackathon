import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { placeCall, dispatchQueued } from './src/notify.js';
const db = new DatabaseSync(':memory:');
for (const f of ['schema.sql', 'memory.sql']) db.exec(readFileSync(new URL(f, import.meta.url), 'utf8'));
const DB = { prepare(sql) { return { bind(...args) { const stmt = db.prepare(sql); return {
  async first() { return stmt.get(...args) || null; },
  async all() { return { results: stmt.all(...args) }; },
  async run() { const r = stmt.run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
}; } }; } };
const env = { DB, TD_FLOW_OWNER_AI: 'flow-owner', TALKDESK_CLIENT_ID: 'id', TALKDESK_CLIENT_SECRET: 's', TALKDESK_ACCOUNT: 'acct', CALL_DELAY_SECONDS: '60' };
let flowCalls = 0;
globalThis.fetch = async url => String(url).includes('oauth') ? { ok: true, json: async () => ({ access_token: 't', expires_in: 3600 }) } : (flowCalls++, { ok: true, json: async () => ({ interaction_id: 'ix-1' }) });
const call = await placeCall(env, { kind: 'owner_ai', to: '+919900000002', purpose: 'Viewing request for listing MC-1', briefing: { spoken_intro: 'hi' } });
assert.equal(call.status, 'queued'); assert.equal(flowCalls, 0);
assert.deepEqual(await dispatchQueued(env), []); // delay not yet elapsed
db.prepare("UPDATE outreach SET created_at=datetime('now','-2 minutes') WHERE id=?").run(call.outreach_id);
const [d] = await dispatchQueued(env);
assert.equal(d.status, 'dialing'); assert.equal(flowCalls, 1);
assert.equal(db.prepare('SELECT status,interaction_id FROM outreach WHERE id=?').get(call.outreach_id).interaction_id, 'ix-1');
assert.deepEqual(await dispatchQueued(env), []); assert.equal(flowCalls, 1); // started at most once
const dry = await placeCall({ ...env, TD_FLOW_OWNER_AI: null }, { kind: 'owner_ai', to: '+919900000002', purpose: 'x' });
assert.equal(dry.status, 'dry_run');
console.log('PASS queued calls wait for the delay and start exactly once');
