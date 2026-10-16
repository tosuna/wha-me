// "521...:12@s.whatsapp.net" -> "521...@s.whatsapp.net"
const normalize = (jid) => String(jid).replace(/:\d+@/, '@');

export function lookupContact(contacts, jid) {
  const n = normalize(jid);
  return contacts.find((c) => normalize(c.jid) === n) ?? null;
}

// Group entries (type 'group'): the respondTo member whose jids include any of the sender's ids, else null.
export function respondToOf(group, ids = []) {
  const sender = new Set((ids ?? []).filter(Boolean).map(normalize));
  return (group.respondTo ?? []).find((m) => (m.jids ?? []).some((j) => sender.has(normalize(j)))) ?? null;
}
