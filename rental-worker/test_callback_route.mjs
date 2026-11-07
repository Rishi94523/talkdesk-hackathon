import assert from 'node:assert/strict';
import { callbackDestination } from './src/flows.js';
const env = { TALKDESK_ORIGIN_NUMBERS: '+12722693171', CALLBACK_RING_NUMBER: '+12232261012' };
assert.equal(callbackDestination(env, '+12722693171'), '+12232261012');
assert.equal(callbackDestination(env, '+919900000003'), '+919900000003');
assert.equal(callbackDestination({}, '+12722693171'), '+12722693171');
assert.equal(callbackDestination(env, '+12185145620'), '+12232261012'); // any US Caller ID
assert.equal(callbackDestination({ ...env, CALLBACK_RING_NUMBER: '+919900000003' }, '+12185145620'), '+919900000003');
console.log('PASS Talkdesk-originated callbacks ring the callback line');
