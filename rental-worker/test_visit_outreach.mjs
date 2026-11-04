import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { applyOwnerResponse } from './src/flows.js';

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE visits(id INTEGER PRIMARY KEY, phone TEXT, listing_id TEXT, requested_time TEXT, status TEXT, notes TEXT, updated_at TEXT);
CREATE TABLE outreach(id INTEGER PRIMARY KEY, visit_id INTEGER, kind TEXT, purpose TEXT, status TEXT, summary TEXT);
CREATE TABLE listings_cache(id TEXT, data TEXT);
INSERT INTO visits(id,phone,listing_id,requested_time,status) VALUES(1,'+911111111111','example','2026-11-07T05:30:00.000Z','pending');
INSERT INTO outreach VALUES(1,1,'owner_ai','Viewing request for listing example','initiating',NULL);
INSERT INTO outreach VALUES(2,1,'owner_ai','negotiation','in_progress',NULL);`);
const env = { DB: { prepare(sql) { return { bind(...args) { const stmt = db.prepare(sql); return {
  async first() { return stmt.get(...args) || null; },
  async run() { const result = stmt.run(...args); return { meta: { changes: Number(result.changes) } }; },
}; } }; } } };
await applyOwnerResponse(env, 1, 'no', 'Unavailable', null, { notifyTenant: false });
assert.equal(db.prepare('SELECT status FROM outreach WHERE id=1').get().status, 'completed');
assert.equal(db.prepare('SELECT status FROM outreach WHERE id=2').get().status, 'in_progress');
console.log('PASS visit response closes an initiating viewing call without closing negotiation');
