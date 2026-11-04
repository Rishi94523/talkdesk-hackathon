import assert from 'node:assert/strict';
import { startOwnerDiscussion, recordOwnerDiscussion } from './src/flows.js';

const writes = [];
const env = { DB: { prepare(sql) { return { bind(...args) { return {
  async first() {
    if (sql.includes('listings_cache')) return { data: JSON.stringify({ id: 'demo', title: 'Demo', locality: 'Whitefield' }) };
    if (sql.includes('FROM visits')) return { id: 3, owner_phone: '+910000000000' };
    if (sql.includes('SELECT terms FROM deals')) return null;
    if (sql.includes('SELECT * FROM deals')) return { terms: '{}' };
    return null;
  },
  async run() { writes.push({ sql, args }); return { meta: { last_row_id: 8 } }; },
}; } }; } } };
const base = { phone: '+911111111111', listing_id: 'demo' };
assert.match((await startOwnerDiscussion(env, { ...base, purpose: 'negotiation', offer: 'Lower rent' })).error, /explicit/);
assert.match((await startOwnerDiscussion(env, { ...base, purpose: 'signing_intent' })).error, /move-in/);
assert.equal(writes.length, 0);
const result = await startOwnerDiscussion(env, { ...base, purpose: 'negotiation', offer: 'Rent 30000', max_rent: 32000 });
assert.equal(result.status, 'outreach_not_started');
assert.equal(result.call.status, 'dry_run');
const insert = writes.find(x => x.sql.startsWith('INSERT INTO outreach'));
const briefing = JSON.parse(insert.args[7]);
assert.equal(briefing.task, 'negotiation');
assert.equal(briefing.authorized_max_rent, 32000);
assert.match(briefing.instruction, /Do not claim acceptance/);
assert.match((await recordOwnerDiscussion(env, { purpose: 'negotiation', status: 'completed' }, { outcome: 'yes' })).error, /already recorded/);
console.log('Owner discussion validation and dry-run behavior passed');
