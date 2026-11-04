// Tenant history is persisted separately from the bounded context sent to an agent.
export async function saveSummary(env, phone, sessionId, summary) {
  if (!phone || !sessionId || !summary?.trim()) throw new Error('phone, session_id and summary are required');
  await env.DB.prepare('INSERT INTO conversation_summaries(phone,session_id,summary) VALUES(?,?,?) ON CONFLICT(phone,session_id) DO UPDATE SET summary=excluded.summary, updated_at=CURRENT_TIMESTAMP').bind(phone, sessionId, summary.trim()).run();
  return { saved: true, session_id: sessionId, type: 'summary', transcript_saved: false };
}

export async function recordProperty(env, phone, listingId, status, reason, sessionId, eventKey) {
  if (!phone || !listingId || !status) throw new Error('phone, listing_id and status are required');
  const event = await env.DB.prepare('INSERT OR IGNORE INTO property_events(phone,listing_id,status,reason,session_id,event_key) VALUES(?,?,?,?,?,?)').bind(phone, listingId, status, reason || null, sessionId || null, eventKey || null).run();
  if (event.meta.changes) await env.DB.prepare('INSERT INTO property_history(phone,listing_id,status,reason,session_id) VALUES(?,?,?,?,?) ON CONFLICT(phone,listing_id) DO UPDATE SET status=excluded.status,reason=excluded.reason,session_id=excluded.session_id,updated_at=CURRENT_TIMESTAMP').bind(phone, listingId, status, reason || null, sessionId || null).run();
  return { saved: true, duplicate: !event.meta.changes };
}

export async function getMemory(env, phone, listingId) {
  const summaries = await env.DB.prepare('SELECT session_id,summary,updated_at FROM conversation_summaries WHERE phone=? ORDER BY updated_at DESC,id DESC LIMIT 2').bind(phone).all();
  const properties = listingId
    ? await env.DB.prepare('SELECT listing_id,status,reason,updated_at FROM property_history WHERE phone=? AND listing_id=? LIMIT 1').bind(phone, listingId).all()
    : await env.DB.prepare('SELECT listing_id,status,reason,updated_at FROM property_history WHERE phone=? ORDER BY updated_at DESC,id DESC LIMIT 10').bind(phone).all();
  return { recent_summaries: summaries.results, property_history: properties.results };
}

export async function previouslyDiscussed(env, phone, ids) {
  if (!phone || !ids.length) return new Set();
  const rows = await env.DB.prepare(`SELECT listing_id FROM property_history WHERE phone=? AND listing_id IN (${ids.map(() => '?').join(',')})`).bind(phone, ...ids).all();
  return new Set(rows.results.map(r => r.listing_id));
}

export async function searchMemory(env, phone, query, listingId) {
  if (!phone || (!query?.trim() && !listingId)) throw new Error('A query or listing_id is required');
  const summaries = query?.trim()
    ? await env.DB.prepare('SELECT session_id,summary,updated_at FROM conversation_summaries WHERE phone=? AND summary LIKE ? ORDER BY updated_at DESC LIMIT 5').bind(phone, `%${query.trim()}%`).all()
    : { results: [] };
  const events = listingId
    ? await env.DB.prepare('SELECT listing_id,status,reason,session_id,created_at FROM property_events WHERE phone=? AND listing_id=? ORDER BY id DESC LIMIT 10').bind(phone, listingId).all()
    : { results: [] };
  return { summaries: summaries.results, property_events: events.results };
}
