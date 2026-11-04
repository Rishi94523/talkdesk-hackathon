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
