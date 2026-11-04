import { tmo } from './util.js';

const configured = env => !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN);
const esc = s => String(s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

async function twilio(env, path, form) {
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/${path}.json`, {
    method: 'POST', body: new URLSearchParams(form), signal: tmo(20000),
    headers: { Authorization: 'Basic ' + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`) },
  });
  const d = await r.json().catch(() => ({}));
  return r.ok ? { ok: true, id: d.sid } : { ok: false, error: d.message || 'HTTP ' + r.status };
}

// channel: 'whatsapp' | 'sms' | 'call'. Without Twilio secrets every send is recorded as dry_run only.
export async function send(env, { channel, to, body, ref_type = null, ref_id = null, voice_action = null }) {
  let status = 'dry_run', provider_id = null, error = null;
  if (configured(env)) {
    let res;
    if (channel === 'sms') res = env.TWILIO_SMS_FROM ? await twilio(env, 'Messages', { To: to, From: env.TWILIO_SMS_FROM, Body: body }) : { ok: false, error: 'TWILIO_SMS_FROM missing' };
    else if (channel === 'call') {
      const say = `<Say voice="Polly.Aditi" language="en-IN">${esc(body)}</Say>`;
      const twiml = voice_action ? `<Response><Gather numDigits="1" timeout="8" action="${esc(voice_action)}">${say}</Gather><Say>We did not get a response. Goodbye.</Say></Response>` : `<Response>${say}</Response>`;
      const from = env.TWILIO_VOICE_FROM || env.TWILIO_SMS_FROM; res = from ? await twilio(env, 'Calls', { To: to, From: from, Twiml: twiml }) : { ok: false, error: 'TWILIO_VOICE_FROM (voice-capable number) missing' };
    } else res = { ok: false, error: 'unknown channel' };
    status = res.ok ? 'sent' : 'failed'; provider_id = res.id || null; error = res.error || null;
  }
  const r = await env.DB.prepare('INSERT INTO messages(direction,channel,addr,body,status,provider_id,ref_type,ref_id) VALUES(?,?,?,?,?,?,?,?)')
    .bind('out', channel, to, body, status, provider_id, ref_type, ref_id).run();
  return { message_id: r.meta.last_row_id, channel, to, status, ...(error ? { error } : {}), ...(status === 'dry_run' ? { note: 'Voice provider not configured: call recorded, not placed.' } : {}) };
}

// Voice-only for now: WhatsApp/SMS code paths remain but are unused.
export const defaultChannel = () => 'call';

export async function verifyTwilio(env, request, form) {
  if (!env.TWILIO_AUTH_TOKEN) return false;
  const sig = request.headers.get('X-Twilio-Signature'); if (!sig) return false;
  let data = request.url; for (const k of [...form.keys()].sort()) data += k + form.get(k);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.TWILIO_AUTH_TOKEN), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
  return btoa(String.fromCharCode(...mac)) === sig;
}
