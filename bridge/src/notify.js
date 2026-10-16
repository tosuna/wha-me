import { execFile as nodeExecFile } from 'node:child_process';

const DEDUPE_MS = 10 * 60_000;
const MAX_LEN = 200;
const GENERIC = 'Revisa tu chat de WhatsApp (el detalle se oculto: parecia contener un secreto).';
// Text goes in as argv, so it never needs AppleScript escaping; `--` keeps a message starting with "-" from being read as an option.
const SCRIPT = ['-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title (item 2 of argv) sound name "Glass"', '-e', 'end run', '--'];

// macOS alert with sound for things that need the owner. Fire-and-forget: never throws into the bridge.
// The same key alerts at most once per 10 min (key defaults to title + message).
export function createNotifier({ execFile = nodeExecFile, platform = process.platform, log = console.error, leaks = () => false, now = Date.now } = {}) {
  const last = new Map(); // key -> ms of the last alert
  const run = (cmd, args) => {
    try {
      execFile(cmd, args, (e) => { if (e) log(`alert ${cmd} failed:`, e.message); });
    } catch (e) {
      log(`alert ${cmd} failed:`, e.message);
    }
  };
  function alert({ title, message, key = `${title}\n${message}` }) {
    if (platform !== 'darwin') return;
    const t = now();
    for (const [k, at] of last) if (t - at >= DEDUPE_MS) last.delete(k);
    if (last.has(key)) return;
    last.set(key, t);
    const text = leaks(`${title}\n${message}`) ? GENERIC : String(message).slice(0, MAX_LEN);
    run('osascript', [...SCRIPT, text, title]);
    // Also plays when Focus hides the banner.
    run('afplay', ['/System/Library/Sounds/Glass.aiff']);
  }
  return { alert };
}

// WhatsApp status -> alert when the link is lost (not on the first-run QR: the owner is at the terminal then).
export function createWaAlerts({ alert, url }) {
  let wasOpen = false;
  const title = 'wha-me: vincula WhatsApp';
  return ({ state }) => {
    if (state === 'open') wasOpen = true;
    if (state === 'logged_out' || (state === 'qr' && wasOpen)) alert({ title, message: `Abre el portal: ${url}`, key: 'wa:link' });
    if (state === 'replaced') alert({ title, message: `Otra sesion tomo WhatsApp y el bridge se detuvo. Reinicialo (npm start) y abre ${url}`, key: 'wa:replaced' });
  };
}
