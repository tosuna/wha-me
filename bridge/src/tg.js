import { Api, TelegramClient, helpers, utils } from 'telegram';
import { NewMessage } from 'telegram/events/index.js';
import { Logger, LogLevel } from 'telegram/extensions/Logger.js';
import { StringSession } from 'telegram/sessions/index.js';
import { createTranscriber } from './stt.js';

// Telegram as a second transport, on the owner's own account (MTProto userbot through gramjs, not the Bot API). It exposes the
// same duck-typed interface as wa.js, with chat ids `tg:<peerId>` (gramjs "marked" ids: users positive, groups negative,
// supergroups -100…) and message ids `tg:<peerId>:<messageId>`, unique across transports.

const MAX_AUDIO_SECONDS = 600;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
// A Telegram typing action lasts ~5 s and the bridge refreshes it every 8 s: each call types now and once more 4 s later.
const TYPING_AGAIN_MS = 4000;

// A gramjs client on the owner's account; session: the StringSession string ('' to log in, see tg-login.js). Warnings only.
export const tgClient = ({ apiId, apiHash, session = '' }) =>
  new TelegramClient(new StringSession(session), Number(apiId), apiHash, { connectionRetries: 5, baseLogger: new Logger(LogLevel.WARN) });

const tgJid = (peer) => `tg:${utils.getPeerId(peer)}`;
const peerOf = (jid) => helpers.returnBigInt(String(jid).slice(3));
const withCaption = (label, caption) => (caption ? `[${label}: ${caption}]` : `[${label}]`);
const attr = (doc, name) => doc?.attributes?.find((a) => a.className === name);
const isVoice = (m) => m.media?.className === 'MessageMediaDocument' && !!attr(m.media.document, 'DocumentAttributeAudio');
const isPhoto = (m) => m.media?.className === 'MessageMediaPhoto';
const nameOf = (e) => (e ? [e.firstName, e.lastName].filter(Boolean).join(' ') || e.title || null : null);

// Text for the transcript, the same placeholders as wa.js messageText; in Telegram the caption is the message text.
export function messageText(m) {
  const caption = m.message || '';
  if (isPhoto(m)) return withCaption('imagen', caption);
  if (m.media?.className === 'MessageMediaDocument') {
    const doc = m.media.document;
    if (attr(doc, 'DocumentAttributeAudio')) return '[audio]';
    if (attr(doc, 'DocumentAttributeSticker')) return '[sticker]';
    if (attr(doc, 'DocumentAttributeVideo')) return withCaption('video', caption);
    return `${withCaption('documento', attr(doc, 'DocumentAttributeFilename')?.fileName)}${caption ? ` ${caption}` : ''}`;
  }
  if (/^MessageMedia(Geo|GeoLive|Venue)$/.test(m.media?.className ?? '')) return '[ubicacion]';
  if (m.media?.className === 'MessageMediaContact') return '[contacto]';
  return caption;
}

// Pure: a gramjs Api.Message -> the bridge message shape (wa.js). out = the owner wrote it (from any device). Channel posts
// are not chats (null). key is opaque to the bridge: it only comes back to markRead and as a reply's quote.
export function toBridgeMessage(m, { text = messageText(m), sender = null } = {}) {
  if (m.post) return null;
  const chatJid = tgJid(m.peerId);
  const msg = {
    id: `${chatJid}:${m.id}`, chatJid, fromMe: !!m.out, text, timestamp: m.date * 1000, pushName: nameOf(sender), key: { remoteJid: chatJid, id: m.id },
  };
  if (m.peerId.className === 'PeerUser') return msg;
  const participant = m.fromId ? tgJid(m.fromId) : null;
  return { ...msg, participant, participantIds: participant ? [participant] : [], message: null };
}

// Resolves once the saved session is connected. client: injectable gramjs client (tests use a fake; never the network).
// The gates are the WhatsApp ones (index.js): allowGroup(jid), onSkippedGroup(jid, at, title), shouldTranscribe(jid,
// participantIds), shouldDescribe(jid) + describeImage({ id, at, chatJid, caption, mimetype, buf }). Documents stay placeholders.
export async function connectTg({
  apiId, apiHash, session, client = tgClient({ apiId, apiHash, session }),
  transcribe = createTranscriber(), shouldTranscribe = () => false, allowGroup = () => false, onSkippedGroup = () => {},
  shouldDescribe = () => false, describeImage, logError = console.error, setTimer = setTimeout,
}) {
  await client.connect();
  if (!(await client.checkAuthorization())) throw new Error('Telegram session is not logged in: run npm run login:tg');
  // Fills gramjs' entity cache, so a chat can be answered (deferred reply, portal) before it writes again after a restart.
  await client.getDialogs({ limit: 200 }).catch((e) => logError('telegram dialogs warm-up failed:', e.message));
  const listeners = [];

  // Audio and photos are only downloaded for gated chats; failures become the placeholder, never an exception.
  async function textOf(m, chatJid, participantIds) {
    const label = messageText(m);
    try {
      if (isVoice(m) && shouldTranscribe(chatJid, participantIds)) {
        const doc = m.media.document;
        if (attr(doc, 'DocumentAttributeAudio').duration > MAX_AUDIO_SECONDS || !(Number(doc.size) <= MAX_AUDIO_BYTES)) return `${label} (demasiado largo, no transcrito)`;
        return `[audio] ${(await transcribe(await client.downloadMedia(m))) || '(sin voz)'}`;
      }
      if (isPhoto(m) && describeImage && !participantIds && shouldDescribe(chatJid)) {
        const buf = await client.downloadMedia(m);
        if (!buf || buf.length > MAX_IMAGE_BYTES) return `${label} (demasiado grande, no descrita)`;
        const description = await describeImage({ id: `${chatJid}:${m.id}`, at: m.date * 1000, chatJid, caption: m.message || '', mimetype: 'image/jpeg', buf });
        return description ? `${label} ${description}` : `${label} (no se pudo describir)`;
      }
    } catch (e) {
      logError('telegram media failed:', e.message);
      return `${label} (no se pudo procesar)`;
    }
    return label;
  }

  async function normalize(m) {
    const bare = toBridgeMessage(m, { text: '' });
    if (!bare) return null;
    if (bare.participantIds && !allowGroup(bare.chatJid)) {
      const chat = await Promise.resolve(m.getChat?.()).catch(() => null);
      onSkippedGroup(bare.chatJid, bare.timestamp, chat?.title ?? null);
      return null;
    }
    const sender = m.out ? null : await Promise.resolve(m.getSender?.()).catch(() => null);
    return toBridgeMessage(m, { text: await textOf(m, bare.chatJid, bare.participantIds), sender });
  }

  // One at a time, in arrival order: a voice note being transcribed must not let the text after it overtake it.
  let queue = Promise.resolve();
  client.addEventHandler(({ message }) => (queue = queue.then(async () => {
    const msg = await normalize(message);
    if (msg) for (const cb of listeners) cb(msg);
  }).catch((e) => logError('telegram normalize failed:', e))), new NewMessage({}));

  const typing = (jid) => client.invoke(new Api.messages.SetTyping({ peer: peerOf(jid), action: new Api.SendMessageTypingAction() }));
  return {
    selfJid: null, // the self-chat stays on WhatsApp
    onMessage: (cb) => { listeners.push(cb); },
    // quoted: a received message ({ key }) shown as the reply's quote.
    sendText: async (jid, text, { quoted } = {}) =>
      `${jid}:${(await client.sendMessage(peerOf(jid), { message: text, ...(quoted && { replyTo: quoted.key.id }) })).id}`,
    sendSticker: async () => { throw new Error('stickers not supported on Telegram'); },
    sendPresence: async (jid) => {
      await typing(jid);
      setTimer(() => typing(jid).catch(() => {}), TYPING_AGAIN_MS).unref?.();
    },
    // keys: one chat's; reading up to the newest marks them all.
    markRead: (keys) => client.markAsRead(peerOf(keys[0].remoteJid), Math.max(...keys.map((k) => k.id))),
    // /grupos: the Telegram groups, in the WhatsApp shape (members come from the bridge log line of an unknown member).
    fetchGroups: async () => Object.fromEntries((await client.getDialogs({ limit: 200 })).filter((d) => d.isGroup)
      .map((d) => { const id = tgJid(d.entity); return [id, { id, subject: d.title, participants: [] }]; })),
  };
}
