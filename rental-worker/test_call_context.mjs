import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { getOutreach } from './src/notify.js';

const db = new DatabaseSync(':memory:');
db.exec("CREATE TABLE outreach(id INTEGER PRIMARY KEY, kind TEXT, to_phone TEXT, status TEXT, interaction_id TEXT, briefing TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)");
const env = { DB: { prepare(sql) { return { bind(...args) { const s = db.prepare(sql); return {
  async first() { return s.get(...args) || null; },
  async all() { return { results: s.all(...args) }; },
}; } }; } } };
const insert = db.prepare('INSERT INTO outreach(id,kind,to_phone,status,interaction_id,briefing,created_at) VALUES(?,?,?,?,?,?,?)');
insert.run(1, 'owner_ai', '+911111111111', 'dialing', 'interaction-one', '{"task":"visit"}', new Date().toISOString());
assert.equal((await getOutreach(env, { interaction_id: 'interaction-one' })).id, 1);
assert.equal((await getOutreach(env, { phone: '+911111111111', kind: 'owner_ai' })).id, 1);
assert.equal(await getOutreach(env, { phone: '+911111111111', kind: 'tenant_ai' }), null);
insert.run(2, 'owner_ai', '+911111111111', 'initiating', null, '{}', new Date().toISOString());
assert.equal(await getOutreach(env, { phone: '+911111111111', kind: 'owner_ai' }), null, 'ambiguous calls fail closed');
db.prepare('UPDATE outreach SET status=? WHERE id=2').run('dry_run');
assert.equal((await getOutreach(env, { phone: '+911111111111', kind: 'owner_ai' })).id, 1);
db.prepare("UPDATE outreach SET created_at=datetime('now','-11 minutes') WHERE id=1").run();
assert.equal(await getOutreach(env, { phone: '+911111111111', kind: 'owner_ai' }), null, 'stale calls are not used as a fallback');
console.log('PASS explicit and unique recent outbound context matching');
