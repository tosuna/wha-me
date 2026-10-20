// Which messaging channel a chat or member id belongs to. Telegram ids are `tg:<peerId>`; everything else is WhatsApp.
export const channelOf = (jid) => (String(jid ?? '').startsWith('tg:') ? 'telegram' : 'whatsapp');
export const CHANNEL_LABEL = { whatsapp: 'WA', telegram: 'TG' };
