import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { getMemory, saveSummary, recordProperty, previouslyDiscussed, searchMemory } from './src/memory.js';

const db = new DatabaseSync(':memory:');
db.exec(readFileSync(new URL('./memory.sql', import.meta.url), 'utf8'));
const env = { DB: { prepare(sql) { return { bind(...args) { const s = db.prepare(sql); return {
  async run() { const r = s.run(...args); return { meta: { changes: Number(r.changes) } }; },
  async all() { return { results: s.all(...args) }; },
}; } }; } } };
const a = '+919000000001', b = '+919000000002';
await saveSummary(env, a, 'call-1', 'Wants Whitefield; rejected MC-002 because of parking.');
await saveSummary(env, a, 'call-2', 'Likes MC-001; visit requested.');
await recordProperty(env, a, 'MC-002', 'rejected', 'No parking', 'call-1', 'event-1');
assert.equal((await recordProperty(env, a, 'MC-002', 'discussed', null, 'call-1', 'event-1')).duplicate, true);
await recordProperty(env, a, 'MC-001', 'visit_requested', null, 'call-2', 'event-2');
const memory = await getMemory(env, a);
assert.equal(memory.recent_summaries.length, 2);
assert.equal(memory.property_history.find(x => x.listing_id === 'MC-002').status, 'rejected');
assert.deepEqual([...await previouslyDiscussed(env, a, ['MC-001', 'MC-003'])], ['MC-001']);
assert.equal((await getMemory(env, b)).property_history.length, 0);
assert.equal((await getMemory(env, b)).recent_summaries.length, 0);
assert.equal((await searchMemory(env, a, 'parking', 'MC-002')).summaries.length, 1);
assert.equal((await searchMemory(env, a, 'parking', 'MC-002')).property_events.length, 1);
assert.equal((await searchMemory(env, b, 'parking', 'MC-002')).summaries.length, 0);
console.log('PASS memory isolation, summaries, property decisions, idempotency and repeat filtering');
