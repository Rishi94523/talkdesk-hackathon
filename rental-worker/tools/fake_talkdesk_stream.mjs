// Pretends to be Talkdesk's External Voice Stream: connect, start, send silence, count audio coming back.
import { readFileSync } from 'node:fs';
const token = readFileSync(new URL('../.voice-token', import.meta.url), 'utf8').trim();
const ws = new WebSocket(`wss://mergeconflicts-rentals-mcp.kelgis.workers.dev/voice/talkdesk?token=${encodeURIComponent(token)}`);
const sid = 'MZtest' + Date.now();
let media = 0, bytes = 0, other = [];
const silence = Buffer.alloc(160, 0xff).toString('base64'); // 20 ms of mu-law silence
ws.onopen = () => {
  ws.send(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }));
  ws.send(JSON.stringify({ event: 'start', sequenceNumber: '2', start: { streamSid: sid, accountSid: 'AC', callSid: 'CA', tracks: ['inbound', 'outbound'], customParameters: { interaction_id: 'test-no-match' }, mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 } }, streamSid: sid }));
  let n = 0; const t = setInterval(() => { if (ws.readyState !== 1 || ++n > 400) return clearInterval(t); ws.send(JSON.stringify({ event: 'media', sequenceNumber: String(n + 2), media: { track: 'inbound', chunk: String(n), timestamp: String(n * 20), payload: silence }, streamSid: sid })); }, 20);
};
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.event === 'media') { media++; bytes += Buffer.from(m.media.payload, 'base64').length; if (m.streamSid !== sid) other.push('wrong sid'); } else other.push(m.event); };
ws.onerror = e => console.log('error', e.message || e.type);
ws.onclose = e => console.log('closed', e.code, e.reason);
setTimeout(() => { console.log(JSON.stringify({ media_frames: media, audio_seconds: +(bytes / 8000).toFixed(1), other })); ws.send(JSON.stringify({ event: 'stop', sequenceNumber: '999', stop: { accountSid: 'AC', callSid: 'CA' }, streamSid: sid })); setTimeout(() => process.exit(0), 1500); }, 9000);
