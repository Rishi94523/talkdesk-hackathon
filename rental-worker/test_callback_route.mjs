import assert from 'node:assert/strict';
import { callbackDestination } from './src/flows.js';
const env = { TALKDESK_ORIGIN_NUMBERS: '+12722693171', CALLBACK_RING_NUMBER: '+12232261012' };
assert.equal(callbackDestination(env, '+12722693171'), '+12232261012');
assert.equal(callbackDestination(env, '+919900000003'), '+919900000003');
assert.equal(callbackDestination({}, '+12722693171'), '+12722693171');
console.log('PASS Talkdesk-originated callbacks ring the callback line');
