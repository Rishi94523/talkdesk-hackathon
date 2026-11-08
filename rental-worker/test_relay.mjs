// Viewing and negotiation relay: owner and tenant are called in turn until both agree.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { scheduleVisit, applyOwnerResponse, resolveVisit, tenantVisitReply, startOwnerDiscussion, recordOwnerDiscussion } from './src/flows.js';
import { parseSpokenTime, normOutcome } from './src/util.js';
import { visitAction } from './src/index.js';

const db = new DatabaseSync(':memory:');
for (const f of ['schema.sql', 'memory.sql']) db.exec(readFileSync(new URL(f, import.meta.url), 'utf8'));
const DB = { prepare(sql) { return { bind(...args) { const stmt = db.prepare(sql); return {
  async first() { return stmt.get(...args) || null; },
  async all() { return { results: stmt.all(...args) }; },
  async run() { const r = stmt.run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
}; } }; } };
// No flow IDs: calls are recorded as dry runs, which is all the relay needs.
const env = { DB };
const T = '+12185145620', O = '+919900000002', L = 'MC-TEST-1';
db.prepare('INSERT INTO listings_cache(id,source,data) VALUES(?,?,?)').run(L, 'test', JSON.stringify({ id: L, title: 'Garden Residences', bhk: 2, locality: 'Marathahalli', rent: 45000, deposit: 180000 }));
const outreach = () => db.prepare('SELECT id,kind,purpose,status,to_phone,briefing FROM outreach ORDER BY id').all();
const last = () => outreach().at(-1);
const visit = id => db.prepare('SELECT * FROM visits WHERE id=?').get(id);
const ist = iso => new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' });

// Parser and loose outcomes.
const base = '2026-11-08T08:30:00.000Z'; // 2 pm IST
assert.equal(ist(parseSpokenTime('free from 3pm instead', base)), '3:00 pm');
assert.equal(ist(parseSpokenTime('can we move it by 1 hour', base)), '3:00 pm');
assert.equal(ist(parseSpokenTime('at 4:30', base)), '4:30 pm');
assert.equal(parseSpokenTime('the owner is busy', base), null);
assert.equal(normOutcome('Counter offer'), 'other');
assert.equal(normOutcome('reschedule please'), 'reschedule');
assert.equal(visitAction('Accept the owner time'), 'accept_owner_time');
assert.equal(visitAction('', { requested_time: 'x' }), 'schedule');

// 1. Tenant asks for tomorrow 2 pm -> owner call.
const tomorrow2pm = new Date(Date.now() + 864e5); tomorrow2pm.setUTCHours(8, 30, 0, 0);
const s = await scheduleVisit(env, { phone: T, listing_id: L, owner_phone: O, owner_name: 'Rishi', requested_time: tomorrow2pm.toISOString() });
const vid = s.visit_id;
assert.equal(last().purpose, `Viewing request for listing ${L}`);

// 2. Owner: "not 2, I'm free from 3 pm" (outcome left loose, time only in details) -> tenant callback.
const r1 = await applyOwnerResponse(env, vid, 'no', 'Owner cannot do 2 pm but is free from 3 pm instead');
assert.equal(r1.status, 'owner_proposed_time');
assert.equal(ist(visit(vid).requested_time), '3:00 pm');
assert.match(r1.say, /call back/);
assert.equal(last().kind, 'tenant_ai');
assert.match(JSON.parse(last().briefing).purpose, /cannot do .*2:00 pm.*3:00 pm/);

// 3. Tenant callback (visit found without a visit_id) asks for 4 pm instead -> owner called again.
db.prepare("UPDATE outreach SET status='in_progress' WHERE id=?").run(last().id);
const open = await resolveVisit(env, T);
assert.equal(open.id, vid);
const r2 = await tenantVisitReply(env, open, { reply: 'accept', requested_time: 'how about 4 pm' });
assert.equal(r2.status, 'pending');
assert.equal(ist(visit(vid).requested_time), '4:00 pm');
assert.equal(last().kind, 'owner_ai');
assert.match(JSON.parse(last().briefing).what_to_say, /cannot make .*3:00 pm.*4:00 pm/);

// 4. Owner: "4 doesn't work, 5 is fine" -> tenant again.
const r3 = await applyOwnerResponse(env, vid, 'reschedule', 'Owner can only do 5 pm');
assert.equal(r3.status, 'owner_proposed_time');
assert.equal(last().kind, 'tenant_ai');

// 5. Tenant accepts 5 pm -> visit confirmed and owner gets a confirmation call.
db.prepare("UPDATE outreach SET status='in_progress' WHERE id=?").run(last().id);
const r4 = await tenantVisitReply(env, await resolveVisit(env, T), { reply: 'accept' });
assert.equal(r4.status, 'confirmed');
assert.equal(visit(vid).status, 'confirmed');
assert.equal(last().purpose, `Viewing confirmation for listing ${L}`);
assert.match(JSON.parse(last().briefing).what_to_say, /agreed to your time: .*5:00 pm/);

// 6. Owner acknowledges -> done, no further tenant call.
const before = outreach().length;
db.prepare("UPDATE outreach SET status='in_progress' WHERE id=?").run(last().id);
const r5 = await applyOwnerResponse(env, vid, 'yes', 'Owner says see you then', null, { confirmation: true });
assert.equal(r5.status, 'confirmed');
assert.equal(outreach().length, before);
assert.equal(last().status, 'completed');

// 7. Negotiation on the tenant's behalf: goal 40000, max 43000, asking 45000. The Worker drives the rounds:
// a refusal or a figure mentioned in passing is never final, and the tenant is called once, with the result.
const n1 = await startOwnerDiscussion(env, { phone: T, listing_id: L, purpose: 'negotiation', offer: 'goal rent 40k with 2 months deposit', max_rent: 43000 });
assert.equal(n1.call.kind, 'owner_ai');
assert.match(n1.say, /negotiate/);
const b1 = JSON.parse(last().briefing);
assert.deepEqual(b1.negotiation_plan.offers_in_order, [40000, 41000, 42500, 43000]);
assert.equal(b1.negotiation_plan.deposit_goal, '2 months');
assert.match(b1.what_to_say, /Open by offering ₹40,000/);
assert.ok(!b1.what_to_say.includes('43,000'), 'opening line never names the maximum');
db.prepare("UPDATE outreach SET status='in_progress' WHERE id=?").run(n1.call.outreach_id);
const row = () => db.prepare('SELECT * FROM outreach WHERE id=?').get(n1.call.outreach_id);
const calls = () => outreach().length;
const before7 = calls();
// The live failure: the owner refuses the opening and mentions what the previous tenant paid.
const q1 = await recordOwnerDiscussion(env, row(), { outcome: 'no', details: 'Owner refuses 40,000; the previous tenant paid 44,000 and there are renovation costs' });
assert.equal(q1.recorded, false);
assert.match(q1.say, /Offer ₹41,000/);
assert.equal(row().status, 'in_progress', 'a refusal mid-negotiation is not final');
assert.equal(calls(), before7, 'no tenant callback yet');
const q2 = await recordOwnerDiscussion(env, row(), { outcome: 'no', details: 'Owner says 42,000 is the lowest', quoted_rent: 42000 });
assert.equal(q2.recorded, false);
assert.match(q2.say, /₹42,000 is acceptable. Ask the owner to confirm/);
const q3 = await recordOwnerDiscussion(env, row(), { outcome: 'yes', details: 'Owner confirmed 42000', quoted_rent: 42000 });
assert.equal(q3.result, 'agreed');
assert.match(q3.say, /agreed at ₹42,000/);
assert.equal(row().status, 'completed');
assert.equal(calls(), before7 + 1, 'exactly one tenant callback');
assert.equal(last().kind, 'tenant_ai');
assert.match(last().purpose, /agreed to a rent of ₹42,000 .*₹3,000 a month below/);
assert.match(JSON.parse(last().briefing).next, /go ahead and rent/);
assert.equal(JSON.parse(db.prepare('SELECT terms FROM deals WHERE phone=? AND listing_id=?').get(T, L).terms).agreed_rent, 42000);

// 8. Owner will not come down to the maximum: offers climb to 43000, then the owner's lowest is asked; 44000 is above it.
const n2 = await startOwnerDiscussion(env, { phone: T, listing_id: L, purpose: 'negotiation', offer: 'goal rent 40000', max_rent: 43000 });
const row2 = () => db.prepare('SELECT * FROM outreach WHERE id=?').get(n2.call.outreach_id);
const says = [];
for (let i = 0; i < 4; i++) says.push((await recordOwnerDiscussion(env, row2(), { outcome: 'no', details: 'No, too low' })).say);
assert.match(says[0], /Offer ₹41,000/); assert.match(says[1], /Offer ₹42,500/); assert.match(says[2], /Offer ₹43,000/);
assert.match(says[3], /lowest monthly rent/);
const c2 = await recordOwnerDiscussion(env, row2(), { outcome: 'no', details: 'Owner will not go below 44000', quoted_rent: 44000 });
assert.equal(c2.result, 'above_limit');
assert.match(c2.say, /Do not agree/);
assert.match(last().purpose, /lowest rent is ₹44,000/);
assert.match(JSON.parse(last().briefing).next, /goal rent 44000" and max_rent 44000/);
// An agent "yes" above the maximum is never a deal: it is told to make the next offer instead.
const n3 = await startOwnerDiscussion(env, { phone: T, listing_id: L, purpose: 'negotiation', offer: 'goal rent 40000', max_rent: 43000 });
const r33 = await recordOwnerDiscussion(env, db.prepare('SELECT * FROM outreach WHERE id=?').get(n3.call.outreach_id), { outcome: 'yes', details: 'Agreed at 44500', quoted_rent: 44500 });
assert.equal(r33.recorded, false);
assert.match(r33.say, /Do not agree to the higher figure/);
const n4 = await startOwnerDiscussion(env, { phone: T, listing_id: L, purpose: 'negotiation', offer: 'goal rent 44000', max_rent: 44000 });
assert.deepEqual(JSON.parse(db.prepare('SELECT briefing FROM outreach WHERE id=?').get(n4.call.outreach_id).briefing).negotiation_plan.offers_in_order, [44000]);
assert.match((await startOwnerDiscussion(env, { phone: T, listing_id: L, purpose: 'negotiation', offer: 'goal rent 45000', max_rent: 43000 })).error, /above the maximum/);
console.log('PASS viewing relay alternates owner and tenant; negotiation runs round by round with one result call');
