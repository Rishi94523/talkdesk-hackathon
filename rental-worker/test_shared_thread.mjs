// Demo tenant and owner share one phone. After the tenant accepts on a callback, the owner confirmation
// call must load its own briefing plus the thread of what each side said.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { scheduleVisit, applyOwnerResponse, resolveVisit, tenantVisitReply } from './src/flows.js';
import { getOutreach, conversationThread, dispatchQueued, touchLine } from './src/notify.js';

const db = new DatabaseSync(':memory:');
for (const f of ['schema.sql', 'memory.sql']) db.exec(readFileSync(new URL(f, import.meta.url), 'utf8'));
const DB = { prepare(sql) { return { bind(...args) { const stmt = db.prepare(sql); return {
  async first() { return stmt.get(...args) || null; },
  async all() { return { results: stmt.all(...args) }; },
  async run() { const r = stmt.run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
}; } }; } };
globalThis.fetch = async url => String(url).includes('oauth') ? { ok: true, json: async () => ({ access_token: 't', expires_in: 3600 }) } : { ok: true, json: async () => ({ interaction_id: 'ix' }) };
const PHONE = '+919900000009';
const env = { DB, TD_FLOW_OWNER_AI: 'f1', TD_FLOW_TENANT_AI: 'f2', TALKDESK_CLIENT_ID: 'id', TALKDESK_CLIENT_SECRET: 's', TALKDESK_ACCOUNT: 'a', CALL_DELAY_SECONDS: '20' };
const L = 'MC-TEST-2';
db.prepare('INSERT INTO listings_cache(id,source,data) VALUES(?,?,?)').run(L, 'test', JSON.stringify({ id: L, title: 'Garden Residences', bhk: 2, locality: 'Whitefield' }));
const age = () => db.prepare("UPDATE outreach SET created_at=datetime('now','-1 minutes') WHERE status='queued'").run();
const answer = async () => { // the next queued call rings and its agent loads context by phone, as Talkdesk does
  age();
  if (db.prepare('SELECT COUNT(*) n FROM line_activity').get().n) {
    assert.deepEqual(await dispatchQueued(env), [], 'must not ring a line that was active seconds ago');
    db.prepare("UPDATE line_activity SET at=datetime('now','-31 seconds')").run();
  }
  await dispatchQueued(env);
  const o = await getOutreach(env, { phone: PHONE });
  assert.ok(o, 'context must load for the shared phone');
  db.prepare("UPDATE outreach SET status='in_progress' WHERE id=?").run(o.id);
  await touchLine(env, PHONE);
  return o;
};

const when = new Date(Date.now() + 864e5); when.setUTCHours(8, 30, 0, 0);
const { visit_id } = await scheduleVisit(env, { phone: PHONE, listing_id: L, owner_phone: PHONE, requested_time: when.toISOString() });
const o1 = await answer();
assert.equal(o1.kind, 'owner_ai');
await applyOwnerResponse(env, visit_id, 'reschedule', 'Owner cannot do 2 pm but is free from 3 pm');
const o2 = await answer();
assert.equal(o2.kind, 'tenant_ai');
await tenantVisitReply(env, await resolveVisit(env, PHONE), { reply: 'accept' });
// The tenant callback has not been marked finished, exactly as in the live call.
const o3 = await answer();
assert.equal(o3.kind, 'owner_ai');
assert.equal(o3.briefing.task, 'viewing_confirmation');
assert.match(o3.briefing.what_to_say, /agreed to your time: .*3:00 pm/);
const thread = await conversationThread(env, o3);
assert.deepEqual(thread.map(t => t.with), ['owner', 'tenant', 'owner']);
assert.match(thread[0].answer, /free from 3 pm/);
assert.match(thread[1].answer, /Tenant agreed to the owner's time/);
assert.equal(thread[2].call, 'this call');
console.log('PASS shared-phone calls load the right briefing and the owner-tenant thread');
