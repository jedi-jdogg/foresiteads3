// A small cron matcher: five fields (minute hour day-of-month month day-of-week), with *, lists, ranges
// and steps, evaluated in the hub Mac's local time. Also the plain-English shortcuts people actually type.
const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
const NAMES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

export function parseCron(expr) {
  const text = String(expr ?? '').trim().toLowerCase();
  const shortcuts = { '@hourly': '0 * * * *', '@daily': '0 9 * * *', '@weekly': '0 9 * * 1', '@monthly': '0 9 1 * *' };
  const fields = (shortcuts[text] ?? text).split(/\s+/);
  if (fields.length !== 5) throw new Error(`Cron needs 5 fields (minute hour day month weekday), got "${expr}".`);
  return fields.map((f, i) => parseField(f, RANGES[i], i === 4));
}

function parseField(field, [lo, hi], isDow) {
  const set = new Set();
  for (const part of field.split(',')) {
    const m = /^(\*|[a-z0-9]+(?:-[a-z0-9]+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`Bad cron field "${field}".`);
    const step = m[2] ? Number(m[2]) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`Bad step in cron field "${field}".`);
    let a = lo, b = hi;
    if (m[1] !== '*') {
      const [x, y] = m[1].split('-').map((v) => (v in NAMES ? NAMES[v] : Number(v)));
      if (Number.isNaN(x) || (y !== undefined && Number.isNaN(y))) throw new Error(`Bad cron value "${part}".`);
      a = x; b = y ?? (m[2] ? hi : x);
      if (a > b) throw new Error(`Reversed range in cron field "${field}".`);
    }
    for (let v = a; v <= b; v += step) set.add(isDow && v === 7 ? 0 : v);
  }
  for (const v of set) if (v < lo || v > hi) throw new Error(`Cron value ${v} out of range in "${field}".`);
  return set;
}

export function matches(expr, date = new Date()) {
  const [min, hour, dom, mon, dow] = Array.isArray(expr) ? expr : parseCron(expr);
  return min.has(date.getMinutes()) && hour.has(date.getHours()) && dom.has(date.getDate()) && mon.has(date.getMonth() + 1) && dow.has(date.getDay());
}

// Next time this expression fires after `from` (minute precision), or null within a year. Skips whole
// days and hours that cannot match so a rare cron costs microseconds, not seconds.
export function nextRun(expr, from = new Date()) {
  const f = parseCron(expr);
  const [min, hour, dom, mon, dow] = f;
  const d = new Date(from); d.setSeconds(0, 0); d.setMinutes(d.getMinutes() + 1);
  const end = new Date(d); end.setFullYear(end.getFullYear() + 1);
  while (d < end) {
    if (!(dom.has(d.getDate()) && mon.has(d.getMonth() + 1) && dow.has(d.getDay()))) { d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); continue; }
    if (!hour.has(d.getHours())) { d.setHours(d.getHours() + 1, 0, 0, 0); continue; }
    if (min.has(d.getMinutes())) return d;
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

// "every day at 8am", "weekdays at 9:30", "every monday 7am", "every 2 hours", "every hour" → cron.
export function fromEnglish(text) {
  const t = String(text).toLowerCase().replace(/\s+/g, ' ').trim();
  const time = (s) => { const m = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/.exec(s); if (!m) return null; let h = Number(m[1]); const mi = Number(m[2] ?? 0); if (m[3] === 'pm' && h < 12) h += 12; if (m[3] === 'am' && h === 12) h = 0; return [mi, h]; };
  let m;
  if ((m = /^every (\d+) (minutes?|hours?)$/.exec(t))) {
    const n = Number(m[1]), max = m[2].startsWith('m') ? 59 : 23;
    if (n < 1 || n > max) throw new Error(`"every ${m[1]} ${m[2]}" is out of range (1-${max}).`);
    return m[2].startsWith('m') ? `*/${n} * * * *` : `0 */${n} * * *`;
  }
  if (/^(every hour|hourly)$/.test(t)) return '0 * * * *';
  if ((m = /^(every day|daily|each day)(?: at)? (.+)$/.exec(t))) { const x = time(m[2]); if (x) return `${x[0]} ${x[1]} * * *`; }
  if ((m = /^(?:every )?weekdays?(?: at)? (.+)$/.exec(t))) { const x = time(m[1]); if (x) return `${x[0]} ${x[1]} * * 1-5`; }
  if ((m = /^(?:every )?weekends?(?: at)? (.+)$/.exec(t))) { const x = time(m[1]); if (x) return `${x[0]} ${x[1]} * * 0,6`; }
  if ((m = /^every (sun|mon|tue|wed|thu|fri|sat)\w*(?: at)? (.+)$/.exec(t))) { const x = time(m[2]); if (x) return `${x[0]} ${x[1]} * * ${NAMES[m[1]]}`; }
  if ((m = /^(?:every month|monthly)(?: on the)? (\d{1,2})(?:st|nd|rd|th)?(?: at)? (.+)$/.exec(t))) { const x = time(m[2]); if (x) return `${x[0]} ${x[1]} ${m[1]} * *`; }
  parseCron(t);   // throws with a useful message if it is not already a cron line
  return t;
}
