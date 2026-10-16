// libsignal (under Baileys) logs whole SessionEntry objects (opening, closing, pruning, "already closed"): private keys,
// root keys and chain keys would end up in bridge.log. Whatever the message, any argument shaped like a session is
// replaced before it reaches the console.
const isSession = (a) => a !== null && typeof a === 'object' && ('currentRatchet' in a || 'indexInfo' in a || '_chains' in a);

export function quietSignalDumps(con = console) {
  for (const m of ['log', 'info', 'warn', 'error', 'debug']) {
    if (typeof con[m] !== 'function') continue;
    const orig = con[m].bind(con);
    con[m] = (...args) => orig(...args.map((a) => (isSession(a) ? '[signal session redacted]' : a)));
  }
}
