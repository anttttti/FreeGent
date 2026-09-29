import type { Command } from './index';

// GNU date: +FORMAT (strftime), -u, -d STRING (@epoch, now/today/yesterday/tomorrow, ISO dates and
// times, month names, relative items such as "+1 month" or "3 days ago"), -r FILE, -I[FMT], -R,
// --rfc-3339. Default format "%a %b %e %H:%M:%S %Z %Y" (C locale). Without -u (or TZ=UTC) times
// are in the browser's local time zone.

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

interface Parts { y: number; mo: number; d: number; h: number; mi: number; s: number; ms: number; wd: number; offMin: number; zone: string }

function parts(t: Date, utc: boolean): Parts {
  if (utc) return { y: t.getUTCFullYear(), mo: t.getUTCMonth(), d: t.getUTCDate(), h: t.getUTCHours(), mi: t.getUTCMinutes(), s: t.getUTCSeconds(), ms: t.getUTCMilliseconds(), wd: t.getUTCDay(), offMin: 0, zone: 'UTC' };
  const offMin = -t.getTimezoneOffset();
  let zone = '';
  try { zone = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(t).find(p => p.type === 'timeZoneName')?.value ?? ''; } catch { /* no Intl */ }
  if (!zone || /^GMT[+-]/.test(zone)) zone = (offMin >= 0 ? '+' : '-') + String(Math.floor(Math.abs(offMin) / 60)).padStart(2, '0') + (Math.abs(offMin) % 60 ? String(Math.abs(offMin) % 60).padStart(2, '0') : '');
  return { y: t.getFullYear(), mo: t.getMonth(), d: t.getDate(), h: t.getHours(), mi: t.getMinutes(), s: t.getSeconds(), ms: t.getMilliseconds(), wd: t.getDay(), offMin, zone };
}

function dayOfYear(p: Parts) { return Math.round((Date.UTC(p.y, p.mo, p.d) - Date.UTC(p.y, 0, 1)) / 86400000) + 1; }
function isoWeek(p: Parts): [number, number] {
  const t = new Date(Date.UTC(p.y, p.mo, p.d));
  const day = (p.wd + 6) % 7;
  t.setUTCDate(t.getUTCDate() - day + 3);
  const yr = t.getUTCFullYear();
  const first = new Date(Date.UTC(yr, 0, 4));
  return [yr, 1 + Math.round(((t.getTime() - first.getTime()) / 86400000 - 3 + ((first.getUTCDay() + 6) % 7)) / 7)];
}

export function strftime(fmt: string, t: Date, utc: boolean): string {
  const p = parts(t, utc);
  const z = (off: number, colon: number) => {
    const sign = off < 0 ? '-' : '+', a = Math.abs(off);
    const hh = String(Math.floor(a / 60)).padStart(2, '0'), mm = String(a % 60).padStart(2, '0');
    return colon ? `${sign}${hh}:${mm}` : `${sign}${hh}${mm}`;
  };
  let out = '';
  for (let i = 0; i < fmt.length; i++) {
    if (fmt[i] !== '%' || i + 1 >= fmt.length) { out += fmt[i]; continue; }
    let j = i + 1;
    let flag = '';
    if ('-_0^#'.includes(fmt[j])) flag = fmt[j++];
    let colons = 0;
    while (fmt[j] === ':') { colons++; j++; }
    const c = fmt[j];
    i = j;
    const num = (n: number, w: number, pad = '0') => {
      if (flag === '-') return String(n);
      const pc = flag === '_' ? ' ' : flag === '0' ? '0' : pad;
      return String(n).padStart(w, pc);
    };
    const [isoY, isoW] = isoWeek(p);
    let v: string;
    switch (c) {
      case 'a': v = DAYS[p.wd].slice(0, 3); break;
      case 'A': v = DAYS[p.wd]; break;
      case 'b': case 'h': v = MONTHS[p.mo].slice(0, 3); break;
      case 'B': v = MONTHS[p.mo]; break;
      case 'c': v = strftime('%a %b %e %H:%M:%S %Y', t, utc); break;
      case 'C': v = num(Math.floor(p.y / 100), 2); break;
      case 'd': v = num(p.d, 2); break;
      case 'D': v = strftime('%m/%d/%y', t, utc); break;
      case 'e': v = num(p.d, 2, ' '); break;
      case 'F': v = strftime('%Y-%m-%d', t, utc); break;
      case 'g': v = num(isoY % 100, 2); break;
      case 'G': v = String(isoY); break;
      case 'H': v = num(p.h, 2); break;
      case 'I': v = num(p.h % 12 || 12, 2); break;
      case 'j': v = num(dayOfYear(p), 3); break;
      case 'k': v = num(p.h, 2, ' '); break;
      case 'l': v = num(p.h % 12 || 12, 2, ' '); break;
      case 'm': v = num(p.mo + 1, 2); break;
      case 'M': v = num(p.mi, 2); break;
      case 'n': v = '\n'; break;
      case 'N': v = String(p.ms * 1000000).padStart(9, '0'); break;
      case 'p': v = p.h < 12 ? 'AM' : 'PM'; break;
      case 'P': v = p.h < 12 ? 'am' : 'pm'; break;
      case 'r': v = strftime('%I:%M:%S %p', t, utc); break;
      case 'R': v = strftime('%H:%M', t, utc); break;
      case 's': v = String(Math.floor(t.getTime() / 1000)); break;
      case 'S': v = num(p.s, 2); break;
      case 't': v = '\t'; break;
      case 'T': v = strftime('%H:%M:%S', t, utc); break;
      case 'u': v = String(p.wd || 7); break;
      case 'U': v = num(Math.floor((dayOfYear(p) + 6 - p.wd) / 7), 2); break;
      case 'V': v = num(isoW, 2); break;
      case 'w': v = String(p.wd); break;
      case 'W': v = num(Math.floor((dayOfYear(p) + 6 - ((p.wd + 6) % 7)) / 7), 2); break;
      case 'x': v = strftime('%m/%d/%y', t, utc); break;
      case 'X': v = strftime('%H:%M:%S', t, utc); break;
      case 'y': v = num(p.y % 100, 2); break;
      case 'Y': v = String(p.y); break;
      case 'z': v = z(p.offMin, colons); break;
      case 'Z': v = p.zone; break;
      case '%': v = '%'; break;
      default: v = '%' + (flag || '') + ':'.repeat(colons) + (c ?? '');
    }
    out += flag === '^' ? v.toUpperCase() : flag === '#' ? v.toLowerCase() : v;
  }
  return out;
}

/** GNU-style date strings → Date. Returns null when not understood. */
export function parseDateString(input: string, now: Date, utc: boolean): Date | null {
  let s = input.trim().toLowerCase();
  const epoch = /^@(-?\d+(?:\.\d+)?)$/.exec(s);
  if (epoch) return new Date(parseFloat(epoch[1]) * 1000);
  // Base date/time
  let base = new Date(now.getTime());
  const setDate = (y: number, mo: number, d: number) => { if (utc) base.setUTCFullYear(y, mo, d); else base.setFullYear(y, mo, d); };
  const setTime = (h: number, mi: number, sec: number) => { if (utc) base.setUTCHours(h, mi, sec, 0); else base.setHours(h, mi, sec, 0); };
  let hadDate = false, hadTime = false;
  const take = (re: RegExp, f: (m: RegExpExecArray) => void) => { const m = re.exec(s); if (m) { f(m); s = (s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length)).trim(); return true; } return false; };
  // ISO with T and zone: 2024-03-05T07:08:09Z / +02:00
  if (take(/(\d{4})-(\d{2})-(\d{2})t(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(z|[+-]\d{2}:?\d{2})?/, m => {
    const zone = m[7];
    if (zone) {
      const off = zone === 'z' ? 0 : (zone[0] === '-' ? -1 : 1) * (parseInt(zone.slice(1, 3), 10) * 60 + parseInt(zone.slice(-2), 10));
      base = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0)) - off * 60000);
    } else { setDate(+m[1], +m[2] - 1, +m[3]); setTime(+m[4], +m[5], +(m[6] ?? 0)); }
    hadDate = hadTime = true;
  })) { /* done */ }
  if (!hadDate) take(/(\d{4})-(\d{1,2})-(\d{1,2})/, m => { setDate(+m[1], +m[2] - 1, +m[3]); hadDate = true; });
  if (!hadDate) take(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/, m => { const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; setDate(y, +m[1] - 1, +m[2]); hadDate = true; });
  if (!hadDate) take(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?/, m => {
    setDate(m[3] ? +m[3] : (utc ? base.getUTCFullYear() : base.getFullYear()), 'janfebmaraprmayjunjulaugsepoctnovdec'.indexOf(m[1]) / 3, +m[2]); hadDate = true;
  });
  if (!hadDate) take(/\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:\s+(\d{4}))?/, m => {
    setDate(m[3] ? +m[3] : (utc ? base.getUTCFullYear() : base.getFullYear()), 'janfebmaraprmayjunjulaugsepoctnovdec'.indexOf(m[2]) / 3, +m[1]); hadDate = true;
  });
  take(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?/, m => {
    let h = +m[1];
    if (m[4] === 'pm' && h < 12) h += 12;
    if (m[4] === 'am' && h === 12) h = 0;
    setTime(h, +m[2], +(m[3] ?? 0)); hadTime = true;
  });
  take(/\b(utc|gmt|z)\b/, () => { /* already UTC when given with -u; accepted */ });
  if (hadDate && !hadTime) setTime(0, 0, 0);
  // Words and relative items
  const addUnit = (n: number, unit: string) => {
    const u = unit.replace(/s$/, '');
    const g = (k: string) => (base as any)[(utc ? 'getUTC' : 'get') + k]();
    const st = (k: string, v: number) => (base as any)[(utc ? 'setUTC' : 'set') + k](v);
    if (u === 'year') st('FullYear', g('FullYear') + n);
    else if (u === 'month') st('Month', g('Month') + n);
    else if (u === 'fortnight') st('Date', g('Date') + 14 * n);
    else if (u === 'week') st('Date', g('Date') + 7 * n);
    else if (u === 'day') st('Date', g('Date') + n);
    else if (u === 'hour') base = new Date(base.getTime() + n * 3600000);
    else if (u === 'minute' || u === 'min') base = new Date(base.getTime() + n * 60000);
    else if (u === 'second' || u === 'sec') base = new Date(base.getTime() + n * 1000);
  };
  const UNIT = '(years?|months?|fortnights?|weeks?|days?|hours?|minutes?|mins?|seconds?|secs?)';
  let progress = true;
  while (s && progress) {
    progress = false;
    if (take(/^now\b/, () => {})) progress = true;
    else if (take(/^today\b/, () => {})) progress = true;
    else if (take(/^yesterday\b/, () => addUnit(-1, 'day'))) progress = true;
    else if (take(/^tomorrow\b/, () => addUnit(1, 'day'))) progress = true;
    else if (take(new RegExp('^([+-]?\\s*\\d+)\\s*' + UNIT + '(\\s+ago)?\\b'), m => addUnit(parseInt(m[1].replace(/\s/g, ''), 10) * (m[3] ? -1 : 1), m[2]))) progress = true;
    else if (take(new RegExp('^(next|last)\\s+' + UNIT + '\\b'), m => addUnit(m[1] === 'next' ? 1 : -1, m[2]))) progress = true;
    else if (take(new RegExp('^' + UNIT + '(\\s+ago)?\\b'), m => addUnit(m[2] ? -1 : 1, m[1]))) progress = true;
  }
  if (s) {
    const d = new Date(input);
    return isNaN(d.getTime()) ? null : d;
  }
  return base;
}

export const date: Command = {
  name: "date",
  description: "Display the current date and time",
  async exec(ctx) {
    let utc = ctx.env?.TZ === 'UTC' || ctx.env?.TZ === 'UTC0' || ctx.env?.TZ === 'GMT';
    let dateStr: string | null = null, refFile: string | null = null, format: string | null = null;
    let iso: string | null = null, rfc2822 = false, rfc3339: string | null = null;
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a.startsWith('+')) format = a.slice(1);
      else if (a === '-u' || a === '--utc' || a === '--universal') utc = true;
      else if (a === '-d' || a === '--date') dateStr = args[++i];
      else if (a.startsWith('--date=')) dateStr = a.slice(7);
      else if (a.startsWith('-d') && a.length > 2) dateStr = a.slice(2);
      else if (a === '-r' || a === '--reference') refFile = args[++i];
      else if (a.startsWith('--reference=')) refFile = a.slice(12);
      else if (a === '-R' || a === '--rfc-email' || a === '--rfc-2822') rfc2822 = true;
      else if (a.startsWith('-I') || a.startsWith('--iso-8601')) iso = (a.startsWith('-I') ? a.slice(2) : a.split('=')[1] ?? '') || 'date';
      else if (a.startsWith('--rfc-3339=')) rfc3339 = a.slice(11);
      else if (a === '-s' || a === '--set') { ctx.stderr += 'date: cannot set date: Operation not permitted\n'; return 1; }
      else if (/^-[uR]+$/.test(a)) { if (a.includes('u')) utc = true; if (a.includes('R')) rfc2822 = true; }
      else { ctx.stderr += `date: invalid date '${a}'\n`; return 1; }
    }
    let t = new Date();
    if (refFile) {
      try { const st = await ctx.fs.stat(ctx.fs.resolvePath(refFile, ctx.cwd)); t = new Date(+st.mtime); }
      catch { ctx.stderr += `date: ${refFile}: No such file or directory\n`; return 1; }
    }
    if (dateStr !== null) {
      const d = parseDateString(dateStr, t, utc);
      if (!d) { ctx.stderr += `date: invalid date '${dateStr}'\n`; return 1; }
      t = d;
    }
    let fmt = format ?? '%a %b %e %H:%M:%S %Z %Y';
    if (rfc2822) fmt = '%a, %d %b %Y %H:%M:%S %z';
    if (iso) fmt = { date: '%Y-%m-%d', hours: '%Y-%m-%dT%H%:z', minutes: '%Y-%m-%dT%H:%M%:z', seconds: '%Y-%m-%dT%H:%M:%S%:z', ns: '%Y-%m-%dT%H:%M:%S,%N%:z' }[iso] ?? '%Y-%m-%d';
    if (rfc3339) fmt = { date: '%Y-%m-%d', seconds: '%Y-%m-%d %H:%M:%S%:z', ns: '%Y-%m-%d %H:%M:%S.%N%:z' }[rfc3339] ?? '%Y-%m-%d';
    ctx.stdout += strftime(fmt, t, utc) + '\n';
    return 0;
  },
};
