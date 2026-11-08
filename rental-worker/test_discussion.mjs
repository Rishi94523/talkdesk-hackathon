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
  async all() { return { results: [] }; },
}; } }; } } };
const base = { phone: '+911111111111', listing_id: 'demo' };
assert.match((await startOwnerDiscussion(env, { ...base, purpose: 'negotiation', offer: 'Lower rent' })).error, /explicit/);
assert.match((await startOwnerDiscussion(env, { ...base, purpose: 'signing_intent' })).error, /move-in/);
assert.equal(writes.length, 0);
const result = await startOwnerDiscussion(env, { ...base, purpose: 'negotiation', offer: 'goal rent 30000', max_rent: 32000 });
assert.equal(result.status, 'outreach_not_started');
assert.equal(result.call.status, 'dry_run');
const insert = writes.find(x => x.sql.startsWith('INSERT INTO outreach'));
const briefing = JSON.parse(insert.args[7]);
assert.equal(briefing.task, 'negotiation');
assert.deepEqual(briefing.negotiation_plan.offers_in_order, [30000, 31000, 31500, 32000]);
assert.match(briefing.instruction, /Never mention the tenant's maximum/);
assert.deepEqual(briefing.private_limit_never_say, { max_rent: 32000, max_deposit: null });
assert.match((await recordOwnerDiscussion(env, { purpose: 'negotiation', status: 'completed' }, { outcome: 'yes' })).error, /already recorded/);
const recorded = await recordOwnerDiscussion(env, { id: 8, purpose: 'negotiation', status: 'in_progress', tenant_phone: '+911111111111', visit_id: 3, briefing: { listing: { id: 'demo' }, private_limit_never_say: { max_rent: 32000 }, negotiation_plan: { offers_in_order: [30000, 32000] }, negotiation_state: { round: 0, confirm: 30000 } } }, { outcome: 'yes', details: 'Owner confirmed 30000', quoted_rent: 30000 });
assert.equal(recorded.result, 'agreed');
assert.equal(recorded.recorded, true);
assert.equal(recorded.tenant_call.status, 'dry_run');
assert.ok(writes.some(x => x.sql.startsWith('UPDATE outreach') && x.args[1] === 8));
console.log('Owner discussion validation and dry-run behavior passed');
