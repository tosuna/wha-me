import { channelOf } from './core/channel.js';

// One transport for the bridge over WhatsApp and (optionally) Telegram: every call goes to the transport that owns the chat
// (channelOf), messages from both arrive through one onMessage. The self-chat stays on WhatsApp.
export function createRouter({ wa, tg = null }) {
  const pick = (jid) => {
    if (channelOf(jid) === 'whatsapp') return wa;
    if (!tg) throw new Error(`Telegram is not connected: cannot reach ${jid}`);
    return tg;
  };
  return {
    get selfJid() { return wa.selfJid; },
    onMessage: (cb) => { wa.onMessage(cb); tg?.onMessage(cb); },
    sendText: async (jid, ...rest) => pick(jid).sendText(jid, ...rest),
    sendSticker: async (jid, buffer) => pick(jid).sendSticker(jid, buffer),
    sendPresence: async (jid, type) => pick(jid).sendPresence(jid, type),
    // One chat's keys per call (bridge.js unread); Telegram keys carry their tg: remoteJid like WhatsApp's.
    markRead: async (keys) => pick(keys[0]?.remoteJid).markRead(keys),
    fetchGroups: async () => ({ ...(await wa.fetchGroups()), ...(tg ? await tg.fetchGroups() : {}) }),
  };
}
