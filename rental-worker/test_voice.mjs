// The voice bridge finds the call being dialled, hands the agent its briefing (with research) and the thread,
// and a free-negotiating agent's final result is accepted only within the tenant's maximum.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { findStreamOutreach, agentVariables, talkdeskMedia } from './src/voice.js';
import { negotiationStep } from './src/flows.js';
import { flowFor } from './src/notify.js';

const db = new DatabaseSync(':memory:');
for (const f of ['schema.sql', 'memory.sql']) db.exec(readFileSync(new URL(f, import.meta.url), 'utf8'));
const DB = { prepare(sql) { return { bind(...args) { const stmt = db.prepare(sql); return {
  async first() { return stmt.get(...args) || null; },
  async all() { return { results: stmt.all(...args) }; },
  async run() { const r = stmt.run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
}; } }; } };
const env = { DB };
const briefing = { task: 'negotiation', spoken_intro: 'Hello Rishi', negotiation_plan: { offers_in_order: [52000, 55000, 60000] }, private_limit_never_say: { max_rent: 60000 }, comparable_listings: ['3 BHK in Whitefield listed at ₹55,000 a month'] };
const ins = db.prepare("INSERT INTO outreach(kind,to_phone,tenant_phone,owner_phone,purpose,briefing,status,interaction_id) VALUES(?,?,?,?,?,?,?,?)");
ins.run('tenant_ai', '+919900000001', '+12185145620', null, 'old', '{}', 'completed', 'old-ix');
ins.run('owner_ai', '+919900000002', '+12185145620', '+919900000002', 'negotiation', JSON.stringify(briefing), 'dialing', 'ix-1');
assert.equal((await findStreamOutreach(env, 'ix-1')).purpose, 'negotiation');
assert.equal((await findStreamOutreach(env, 'unknown-ix')).kind, 'owner_ai', 'falls back to the call being dialled');
const v = await agentVariables(env, await findStreamOutreach(env, 'ix-1'));
assert.equal(v.call_with, 'owner');
assert.equal(v.first_message, 'Hello Rishi');
assert.equal(v.tenant_max_rent, 60000);
assert.ok(!v.briefing_json.includes('private_limit_never_say'), 'the maximum travels only in its own variable');
assert.match(v.briefing_json, /listed at ₹55,000/);
assert.deepEqual(JSON.parse(talkdeskMedia('MZ1', 'AAAA')), { event: 'media', streamSid: 'MZ1', media: { payload: 'AAAA' } });

assert.deepEqual(negotiationStep(briefing, { outcome: 'yes', quoted_rent: 57000, final: true }), { final: true, result: 'agreed', rent: 57000 });
assert.equal(negotiationStep(briefing, { outcome: 'yes', quoted_rent: 61000, final: true }).result, 'above_limit');
assert.equal(negotiationStep(briefing, { outcome: 'no', final: true }).result, 'refused');
assert.equal(negotiationStep(briefing, { outcome: 'yes', final: true }).final, false, 'an agreement needs the figure');

assert.equal(flowFor({ TD_FLOW_OWNER_AI: 'a', TD_FLOW_OWNER_VOICE: 'v' }, 'owner_ai', 'negotiation'), 'v');
assert.equal(flowFor({ TD_FLOW_OWNER_AI: 'a', TD_FLOW_OWNER_VOICE: 'v' }, 'owner_ai', 'Viewing request for listing X'), 'a');
assert.equal(flowFor({ TD_FLOW_OWNER_AI: 'a' }, 'owner_ai', 'negotiation'), 'a');
console.log('PASS voice bridge context, final-result guard and flow routing');
