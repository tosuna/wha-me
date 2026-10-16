// Office hours come from the owner profile: { timezone, hours: { open: 'HH:MM', close: 'HH:MM', days: [0..6] } }.
const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
const DAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function localParts(date, tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    }).formatToParts(date).map(({ type, value }) => [type, value]),
  );
  return {
    y: +p.year, m: +p.month, d: +p.day, hh: +p.hour, mm: +p.minute, ss: +p.second,
    dow: DAYS[p.weekday],
  };
}

export function isWithinHours(date, { timezone, hours }) {
  const { hh, mm, dow } = localParts(date, timezone);
  const t = hh * 60 + mm;
  return hours.days.includes(dow) && t >= minutesOf(hours.open) && t < minutesOf(hours.close);
}

// Local wall-clock time in `tz` -> Date.
function zonedToDate(y, m, d, hh, mm, tz) {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const p = localParts(new Date(guess), tz);
  const offset = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - guess;
  return new Date(guess - offset);
}

export function nextOpening(date, profile) {
  if (isWithinHours(date, profile)) return date;
  const { timezone: tz, hours } = profile;
  const open = minutesOf(hours.open);
  const { y, m, d, hh, mm, dow } = localParts(date, tz);
  let add = hours.days.includes(dow) && hh * 60 + mm < open ? 0 : 1;
  while (!hours.days.includes((dow + add) % 7)) add++;
  const day = new Date(Date.UTC(y, m - 1, d + add));
  return zonedToDate(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), Math.floor(open / 60), open % 60, tz);
}
