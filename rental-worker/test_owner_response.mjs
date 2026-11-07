import assert from 'node:assert/strict';
import { applyOwnerResponse } from './src/flows.js';

let writes = 0;
const env = { DB: { prepare(sql) { return { bind() { return {
  async first() { return { id: 7, requested_time: '2026-11-07T05:30:00.000Z' }; },
  async run() { writes++; },
}; } }; } } };
for (const time of [null, 'invalid']) {
  const result = await applyOwnerResponse(env, 7, 'reschedule', 'another time', time, { notifyTenant: false });
  assert.match(result.error, /which day and time/);
}
assert.equal(writes, 0, 'invalid reschedules must not change the visit or notify the tenant');
console.log('Owner reschedule validation passed');
