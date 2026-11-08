export const reply = v => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });
export const fail = (error, extra = {}) => ({ isError: true, ...reply({ error, ...extra }) });
export const normPhone = p => { const s = String(p || '').replace(/[^\d+]/g, ''); return s.startsWith('+') ? s : (s.length === 10 ? '+91' + s : '+' + s); };
export const tmo = ms => AbortSignal.timeout(ms);
export const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
export const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
export const j = s => { try { return JSON.parse(s); } catch { return {}; } };
// Approximate centres of Bengaluru localities (lat, lon). City centre is the fallback.
export const LOCALITIES = {
  'whitefield': [12.9698, 77.75], 'brookefield': [12.9654, 77.7157], 'indiranagar': [12.9784, 77.6408], 'koramangala': [12.9352, 77.6245],
  'hsr layout': [12.9116, 77.6474], 'bellandur': [12.9304, 77.6784], 'marathahalli': [12.9591, 77.6974], 'sarjapur road': [12.9100, 77.6870],
  'electronic city': [12.8452, 77.6602], 'jayanagar': [12.9250, 77.5938], 'jp nagar': [12.9063, 77.5857], 'btm layout': [12.9166, 77.6101],
  'hebbal': [13.0358, 77.597], 'yelahanka': [13.1007, 77.5963], 'malleshwaram': [13.0035, 77.5646], 'rajajinagar': [12.9916, 77.5521],
  'banashankari': [12.9255, 77.5468], 'bannerghatta road': [12.8934, 77.5970], 'kr puram': [13.0073, 77.6958], 'mahadevapura': [12.9912, 77.6966],
  'kadugodi': [12.9978, 77.7616], 'varthur': [12.9411, 77.7410], 'hennur': [13.0358, 77.6400], 'domlur': [12.9609, 77.6387], 'mg road': [12.9756, 77.6068],
};
export const CITY = { bangalore: [12.9716, 77.5946], bengaluru: [12.9716, 77.5946] };

// Spoken times from owners and tenants ("3 pm", "an hour later", "Sunday at 4:30") resolved against the
// visit's current time in India. Returns an ISO timestamp or null when no time is stated.
const IST_MS = 330 * 60000;
const NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, half: 0.5 };
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
export function parseSpokenTime(text, baseIso) {
  if (!text) return null;
  // Agents often send "2026-11-09T15:00:00" or "...15:00:00Z" meaning India time; a UTC reading would be 8:30 pm.
  let iso = String(text).trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z?$/.test(iso)) iso = iso.replace(/Z$/, '') + '+05:30';
  const direct = new Date(iso);
  if (/\d{4}-\d{2}-\d{2}T/.test(iso) && !isNaN(direct)) return direct.toISOString();
  const t = String(text).toLowerCase();
  const base = new Date(baseIso || Date.now());
  const shift = t.match(/\b(\d+(?:\.\d+)?|an?|one|two|three|four|half an?)\s*(hours?|hrs?)\s*(later|after|earlier|before)\b|\bby\s+(\d+(?:\.\d+)?|an?|one|two|three)\s*(hours?|hrs?)\b/);
  if (shift && !/\b\d{1,2}(:\d{2})?\s*(am|pm|a\.m\.|p\.m\.)/.test(t)) {
    const n = shift[1] || shift[4]; const h = NUM[n.split(' ')[0]] ?? parseFloat(n);
    const sign = /earlier|before/.test(shift[3] || '') ? -1 : 1;
    return new Date(base.getTime() + sign * h * 3600000).toISOString();
  }
  // "Can't do 2 pm, free from 3 pm": collect every stated time and prefer one that differs from the current time.
  const re = [/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|o'?clock)\b/g, /\b(\d{1,2}):(\d{2})\b/g, /\b(?:at|from|after|by|around)\s+(\d{1,2})\b(?!\s*(?:hours?|hrs?|days?|bhk|minutes?|:|\.\d|\s*(?:am|pm|a\.m|p\.m|o'?clock)))/g];
  const found = re.flatMap(r => [...t.matchAll(r)]).sort((a, b) => a.index - b.index);
  const local = new Date(base.getTime() + IST_MS); // wall-clock fields in IST via UTC getters
  let dayShift = 0;
  const todayN = Math.floor((Date.now() + IST_MS) / 864e5), baseN = Math.floor(local.getTime() / 864e5);
  if (/\btomorrow\b/.test(t)) dayShift = todayN + 1 - baseN;
  else if (/\btoday\b/.test(t)) dayShift = todayN - baseN;
  else { const d = DAYS.findIndex(x => t.includes(x)); if (d >= 0) dayShift = (d - local.getUTCDay() + 7) % 7; }
  const times = found.map(m => {
    let h = +m[1]; const min = +(m[2] || 0); const ap = (m[3] || '').replace(/\./g, '');
    if (h > 23 || min > 59) return null;
    if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0;
    if (!/am|pm/.test(ap) && h >= 1 && h <= 7) h += 12; // "at 3" means afternoon for a viewing
    return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + dayShift, h, min) - IST_MS).toISOString();
  });
  if (!times.some(Boolean)) return null;
  // "Cannot do 2 pm but free at 3 pm": the time after free / available / instead / works is the proposal, never one
  // the owner rejected ("cannot do 2 pm"); for a range ("free from 1 to 3 pm") the start of the range.
  const offer = t.search(/(?<!\b(?:not|n't|never)\s)\b(free|available|instead|works|work for|how about|can do|okay with|ok with|prefer|let'?s do|make it)\b/);
  const rejected = new Set(found.filter(m => /\b(can'?t|cannot|can not|not|busy|unavailable|won'?t)\b(?:(?!\b(?:but|free|available|instead|works?|only)\b)[^.,;]){0,20}$/.test(t.slice(Math.max(0, m.index - 30), m.index))).map(m => m.index));
  const tagged = found.map((m, i) => ({ m, x: times[i] })).filter(o => o.x);
  const pick = (offer >= 0 && tagged.find(o => o.m.index > offer && !rejected.has(o.m.index)))
    || tagged.find(o => !rejected.has(o.m.index) && (!baseIso || Math.abs(new Date(o.x) - base) > 5 * 60000));
  if (pick) return pick.x;
  return (baseIso && times.find(x => Math.abs(new Date(x) - base) > 5 * 60000)) || times[0];
}

// Talkdesk fills outcomes from LLM-extracted variables, so accept loose wording.
export function normOutcome(raw, text = '') {
  const a = String(raw || '').toLowerCase().trim();
  if (['yes', 'no', 'reschedule', 'other'].includes(a)) return a;
  const s = `${a} ${String(text).toLowerCase()}`;
  if (/reschedul|another time|different time|instead|later|earlier|move|shift|postpone|prepone/.test(a)) return 'reschedule';
  if (/counter|condition|maybe|depends/.test(a)) return 'other';
  if (/^(y|ok|okay|sure|accept|agree|confirm|fine|works)/.test(a)) return 'yes';
  if (/^(n|not|decline|reject|cannot|can't|busy|unavailable)/.test(a)) return 'no';
  if (/counter/.test(s)) return 'other';
  return a ? 'other' : null;
}

// Rupee amounts said in words: "35k", "35,000", "35 thousand", "1.2 lakh". Returns every amount >= 1000 in order.
export function parseAmounts(text) {
  const out = [];
  const re = /(\d+(?:[.,]\d+)*)\s*(k\b|thousand|lakh|lac)?/gi;
  for (const m of String(text || '').matchAll(re)) {
    let n = parseFloat(m[1].replace(/,/g, ''));
    const u = (m[2] || '').toLowerCase();
    if (u === 'k' || u === 'thousand') n *= 1000; else if (u === 'lakh' || u === 'lac') n *= 100000;
    if (n >= 1000) out.push(Math.round(n));
  }
  return out;
}

// The tenant's goal, for example "ideal rent 35000 with 2 months deposit": first rent amount, and deposit months if said.
export function parseRentGoal(text) {
  const s = String(text || '');
  const months = s.match(/(\d+(?:\.\d+)?)\s*-?\s*months?(?:'|’)?\s*(?:of\s+)?(?:deposit|advance)|(?:deposit|advance)\D{0,20}?(\d+(?:\.\d+)?)\s*months?/i);
  const noMonths = s.replace(/(\d+(?:\.\d+)?)\s*-?\s*months?/gi, ' ');
  const depAmount = noMonths.match(/(?:deposit|advance)\D{0,20}?(\d[\d,.]*\s*(?:k\b|thousand|lakh|lac)?)/i);
  const rentText = depAmount ? noMonths.replace(depAmount[0], ' ') : noMonths;
  return {
    rent: parseAmounts(rentText)[0] ?? null,
    deposit_months: months ? +(months[1] || months[2]) : null,
    deposit: depAmount ? parseAmounts(depAmount[1])[0] ?? null : null,
  };
}

// Concession ladder from the tenant's goal up to their private maximum (never above the asking rent), rounded to 500.
export function rentLadder(goal, max, listed) {
  const cap = listed && listed < max ? listed : max;
  const open = Math.min(goal, cap);
  if (open >= cap) return [cap];
  const r = n => Math.round(n / 500) * 500;
  const steps = [open, r(open + (cap - open) * 0.4), r(open + (cap - open) * 0.75), cap].filter(x => x >= open && x <= cap);
  return [...new Set(steps)].sort((a, b) => a - b);
}
