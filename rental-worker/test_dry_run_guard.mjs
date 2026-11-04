import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { scheduleVisit } from './src/flows.js';
const db = new DatabaseSync(':memory:');
for (const f of ['schema.sql', 'memory.sql']) db.exec(readFileSync(new URL(f, import.meta.url), 'utf8'));
const env = { TD_FLOW_OWNER_AI: 'configured-flow', TALKDESK_CLIENT_ID: 'configured-client', DB: { prepare(sql) { return { bind(...args) { const stmt = db.prepare(sql); return {
  async first() { return stmt.get(...args) || null; },
  async all() { return { results: stmt.all(...args) }; },
  async run() { const r = stmt.run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
}; } }; } } };
globalThis.fetch = () => { throw new Error('dry-run must never call a network service'); };
const result = await scheduleVisit(env, { phone: '+919900000001', owner_phone: '+919900000002', listing_id: 'MC-001', requested_time: new Date(Date.now() + 86400000).toISOString(), dry_run_only: true });
assert.equal(result.call.status, 'dry_run');
assert.equal(db.prepare('SELECT escalated FROM visits WHERE id=?').get(result.visit_id).escalated, 1);
console.log('PASS dry-run visit cannot dial even when the owner flow is configured');
