// Talkdesk "Connect to Autopilot Voice" -> External Voice Stream bridge to an ElevenLabs agent.
// Talkdesk streams the call as 8 kHz mu-law in JSON frames (connected/start/media/mark/stop) and plays back the
// media frames we send; ElevenLabs is configured for ulaw_8000 in and out, so audio passes through unchanged.
// The bridge loads the outreach briefing (with the pre-call research) and the owner-tenant thread and hands them
// to the agent as dynamic variables; the agent reaches every Worker tool through the MCP server.
// It also gives us what Talkdesk AI agents never did: a real hang-up signal (the stop frame).
import { conversationThread, touchLine } from './notify.js';
import { j } from './util.js';

const nowIst = () => new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' });

// Which outreach is this call? Talkdesk's interaction id when it matches the one returned when we started the
// flow, otherwise the single call we are currently dialling (the demo places one outbound call at a time).
export async function findStreamOutreach(env, interactionId) {
  if (interactionId) {
    const r = await env.DB.prepare('SELECT * FROM outreach WHERE interaction_id=?').bind(interactionId).first();
    if (r) return r;
  }
  const rows = (await env.DB.prepare("SELECT * FROM outreach WHERE status IN ('initiating','dialing','in_progress') AND created_at >= datetime('now','-15 minutes') ORDER BY CASE status WHEN 'dialing' THEN 0 WHEN 'initiating' THEN 1 ELSE 2 END, id DESC LIMIT 3").bind().all()).results;
  return rows.find(r => r.kind === 'owner_ai') || rows[0] || null;
}

// Dynamic variables for the agent: everything it needs to pick up the conversation where it stands.
export async function agentVariables(env, o) {
  const briefing = j(o.briefing);
  const thread = await conversationThread(env, { ...o, briefing });
  const { private_limit_never_say, ...visible } = briefing;
  return {
    outreach_id: o.id,
    call_with: o.kind === 'owner_ai' ? 'owner' : 'tenant',
    task: briefing.task || o.purpose || '',
    now_ist: nowIst(),
    first_message: briefing.spoken_intro || (o.kind === 'owner_ai' ? 'Hello, I am the MergeConflicts rental assistant calling on behalf of a prospective tenant about your property.' : 'Hello, this is your MergeConflicts rental assistant with an update.'),
    briefing_json: JSON.stringify(visible).slice(0, 12000),
    tenant_max_rent: private_limit_never_say?.max_rent ?? briefing.authorized_max_rent ?? '',
    tenant_max_deposit: private_limit_never_say?.max_deposit ?? '',
    conversation_so_far: JSON.stringify(thread).slice(0, 4000),
  };
}

export const talkdeskMedia = (streamSid, payload) => JSON.stringify({ event: 'media', streamSid, media: { payload } });

export class VoiceBridge {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }

  async fetch(request) {
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    this.td = server;
    this.pending = [];
    this.transcript = [];
    server.addEventListener('message', e => this.fromTalkdesk(e.data).catch(err => console.log('voice td error', err.message)));
    server.addEventListener('close', () => this.finish('talkdesk closed'));
    return new Response(null, { status: 101, webSocket: client });
  }

  sendTd(obj) { try { this.td?.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); } catch {} }
  sendEl(obj) {
    const s = JSON.stringify(obj);
    if (this.el && this.elReady) { try { this.el.send(s); } catch {} } else if (this.pending.length < 400) this.pending.push(s);
  }

  async fromTalkdesk(raw) {
    const m = JSON.parse(raw);
    if (m.event === 'start') {
      this.streamSid = m.start?.streamSid || m.streamSid;
      const interaction = m.start?.customParameters?.interaction_id;
      this.outreach = await findStreamOutreach(this.env, interaction);
      console.log(JSON.stringify({ voice: 'start', interaction, outreach: this.outreach?.id, kind: this.outreach?.kind }));
      if (this.outreach) {
        await this.env.DB.prepare("UPDATE outreach SET status='in_progress' WHERE id=? AND status IN ('initiating','dialing')").bind(this.outreach.id).run();
        await touchLine(this.env, this.outreach.to_phone);
      }
      await this.connectAgent();
    } else if (m.event === 'media') {
      if (m.media?.track && m.media.track !== 'inbound') return;
      this.sendEl({ user_audio_chunk: m.media.payload });
      if (this.outreach && Date.now() - (this.touched || 0) > 10000) { this.touched = Date.now(); await touchLine(this.env, this.outreach.to_phone); }
    } else if (m.event === 'mark') {
      if (m.mark?.name === 'goodbye') this.stopTalkdesk('ok');
    } else if (m.event === 'stop') {
      await this.finish('caller hung up');
    }
  }

  async connectAgent() {
    const r = await fetch(`https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${this.env.ELEVENLABS_AGENT_ID}`, { headers: { 'xi-api-key': this.env.ELEVENLABS_API_KEY } });
    const d = await r.json().catch(() => ({}));
    if (!d.signed_url) { console.log('voice: no signed url', r.status, JSON.stringify(d).slice(0, 200)); return this.stopTalkdesk('error'); }
    const resp = await fetch(d.signed_url.replace(/^wss:/, 'https:'), { headers: { Upgrade: 'websocket' } });
    const el = resp.webSocket;
    if (!el) { console.log('voice: ElevenLabs upgrade failed', resp.status); return this.stopTalkdesk('error'); }
    el.accept();
    this.el = el;
    el.addEventListener('message', e => this.fromAgent(e.data));
    el.addEventListener('close', ev => { console.log(JSON.stringify({ voice: 'agent closed', code: ev.code, reason: ev.reason })); this.agentEnded(); });
    const vars = this.outreach ? await agentVariables(this.env, this.outreach) : { outreach_id: '', call_with: 'unknown', task: '', now_ist: nowIst(), first_message: 'Hello, this is the MergeConflicts rental assistant.', briefing_json: '{}', tenant_max_rent: '', tenant_max_deposit: '', conversation_so_far: '[]' };
    el.send(JSON.stringify({ type: 'conversation_initiation_client_data', dynamic_variables: vars }));
    this.elReady = true;
    for (const s of this.pending.splice(0)) { try { el.send(s); } catch {} }
  }

  fromAgent(raw) {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'audio' && m.audio_event?.audio_base_64) this.sendTd(talkdeskMedia(this.streamSid, m.audio_event.audio_base_64));
    else if (m.type === 'interruption') this.sendTd({ event: 'clear', streamSid: this.streamSid });
    else if (m.type === 'ping') this.sendEl({ type: 'pong', event_id: m.ping_event?.event_id });
    else if (m.type === 'agent_response') { this.transcript.push(`assistant: ${m.agent_response_event?.agent_response}`); console.log(JSON.stringify({ voice: 'agent', text: m.agent_response_event?.agent_response })); }
    else if (m.type === 'user_transcript') { this.transcript.push(`${this.outreach?.kind === 'tenant_ai' ? 'tenant' : 'owner'}: ${m.user_transcription_event?.user_transcript}`); console.log(JSON.stringify({ voice: 'caller', text: m.user_transcription_event?.user_transcript })); }
    else if (m.type === 'conversation_initiation_metadata') { this.conversationId = m.conversation_initiation_metadata_event?.conversation_id; console.log(JSON.stringify({ voice: 'agent ready', conversation: this.conversationId, formats: [m.conversation_initiation_metadata_event?.user_input_audio_format, m.conversation_initiation_metadata_event?.agent_output_audio_format] })); }
    else if (m.type === 'mcp_tool_call' || m.type === 'agent_tool_response' || m.type === 'client_error') console.log(JSON.stringify({ voice: m.type, data: JSON.stringify(m).slice(0, 400) }));
  }

  // The agent ended the conversation (its end_call tool): let the last words play, then hand the call back to Studio.
  agentEnded() {
    if (this.closed) return;
    this.sendTd({ event: 'mark', streamSid: this.streamSid, mark: { name: 'goodbye' } });
    setTimeout(() => this.stopTalkdesk('ok'), 8000);
  }

  stopTalkdesk(command) {
    if (this.stopped) return;
    this.stopped = true;
    this.sendTd({ event: 'stop', streamSid: this.streamSid, stop: { command } });
    setTimeout(() => { try { this.td?.close(1000, 'done'); } catch {} }, 500);
    this.finish('agent finished');
  }

  async finish(why) {
    if (this.closed) return;
    this.closed = true;
    try { this.el?.close(1000, why); } catch {}
    console.log(JSON.stringify({ voice: 'end', why, outreach: this.outreach?.id, conversation: this.conversationId, turns: this.transcript.length }));
    if (!this.outreach) return;
    const talk = this.transcript.slice(-12).join(' | ').slice(0, 1500);
    // A real hang-up: close this call (unless a result was already recorded) and free the line so queued calls can ring.
    await this.env.DB.prepare("UPDATE outreach SET status='completed', summary=COALESCE(summary, ?) WHERE id=? AND status IN ('initiating','dialing','in_progress')").bind(`Call ended without a recorded result. ${talk}`.slice(0, 500), this.outreach.id).run();
    await this.env.DB.prepare("INSERT INTO line_activity(phone,at) VALUES(?,datetime('now','-1 hour')) ON CONFLICT(phone) DO UPDATE SET at=datetime('now','-1 hour')").bind(this.outreach.to_phone).run();
    if (talk) await this.env.DB.prepare('INSERT INTO voice_transcripts(outreach_id,conversation_id,transcript) VALUES(?,?,?)').bind(this.outreach.id, this.conversationId || null, this.transcript.join('\n').slice(0, 20000)).run().catch(() => {});
  }
}
