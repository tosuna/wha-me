import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  isJidBroadcast,
  isJidGroup,
  isLidUser,
  isPnUser,
  jidNormalizedUser,
  normalizeMessageContent,
  useMultiFileAuthState,
} from 'baileys';
import { readdirSync, rmSync } from 'node:fs';
import { basename, join, resolve as resolvePath } from 'node:path';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { createTranscriber } from './stt.js';

const toNumber = (n) => (n && typeof n === 'object' ? n.toNumber() : Number(n));
const toMs = (t) => toNumber(t) * 1000;

const MAX_AUDIO_SECONDS = 600;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const TOO_BIG = '[audio] (demasiado grande, no transcrito)';
const MAX_DOC_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const withCaption = (label, caption) => (caption ? `[${label}: ${caption}]` : `[${label}]`);
const docText = (label, { fileName, caption }) => `${withCaption(label, fileName)}${caption ? ` ${caption}` : ''}`;

// Text for the transcript; non-text media become placeholders. '' = ignore (reactions, protocol messages, ...).
export function messageText(message) {
  const c = normalizeMessageContent(message);
  if (!c) return '';
  if (c.conversation || c.extendedTextMessage?.text) return c.conversation || c.extendedTextMessage.text;
  if (c.imageMessage) return withCaption('imagen', c.imageMessage.caption);
  if (c.videoMessage) return withCaption('video', c.videoMessage.caption);
  if (c.audioMessage) return '[audio]';
  if (c.stickerMessage) return '[sticker]';
  if (c.documentMessage) return docText('documento', c.documentMessage);
  if (c.locationMessage) return '[ubicacion]';
  if (c.contactMessage || c.contactsArrayMessage) return '[contacto]';
  return '';
}

// Empties the Baileys auth folder so the next connect asks for a new QR. Guarded: anything not named auth is refused.
function wipeAuth(dir) {
  if (basename(resolvePath(dir)) !== 'auth') throw new Error(`refusing to wipe ${dir}: not an auth dir`);
  for (const f of readdirSync(dir)) rmSync(join(dir, f), { recursive: true, force: true });
}

// Chats addressed by LID are resolved to the phone-number jid (allowlist format) through Baileys'
// LID mapping store (sock.signalRepository.lidMapping.getPNForLID, baileys/lib/Signal/lid-mapping.js).
// remoteJidAlt is only a fallback for incoming messages; for fromMe it can point at ourselves.
// NEEDS LIVE VERIFICATION AT GO-LIVE: confirm real contacts and the self-chat resolve as expected.
// shouldTranscribe(chatJid, participantIds?) gates the download: only the self-chat and approved chats (in a group:
// approved participants) spend CPU on STT (fails closed). allowGroup(groupJid): groups are dropped unless allowlisted;
// onSkippedGroup(groupJid, timestampMs) hears each dropped group message (no text).
// Documents in chats shouldTranscribe allows (not the self-chat) go to saveDocument({ id, fileName, at, buf }) -> path, and
// notice(text) tells the self-chat where (nameOf(chatJid) names the chat). The content never enters the text.
// Images in chats shouldDescribe(chatJid) allows (the self-chat included; never groups) go to
// describeImage({ id, at, chatJid, caption, mimetype, buf }) -> description, kept in the text like an audio transcript.
export function createNormalizer({
  self, pnForLid, onUnresolved, download, transcribe, shouldTranscribe = () => false, allowGroup = () => false,
  onSkippedGroup = () => {}, logError = console.error, log = console.log, saveDocument, notice = () => {}, nameOf = (jid) => jid,
  describeImage, shouldDescribe = () => false,
}) {
  const noted = new Set();

  // Voice notes/audios are transcribed locally; the audio bytes are never kept. Only the error is logged, never the text.
  // seconds and fileLength are sender-declared: cheap first filters; the buffer size and the real duration (stt) are rechecked.
  async function audioText(m, { seconds, fileLength }) {
    if (seconds > MAX_AUDIO_SECONDS) return `[audio de ${Math.ceil(seconds / 60)} min, no transcrito]`;
    if (!(toNumber(fileLength) <= MAX_AUDIO_BYTES)) return TOO_BIG;
    try {
      const buf = await download(m);
      if (buf.length > MAX_AUDIO_BYTES) return TOO_BIG;
      return `[audio] ${(await transcribe(buf)) || '(sin voz)'}`;
    } catch (e) {
      if (e.tooLong) return '[audio de más de 10 min, no transcrito]';
      logError('audio transcription failed:', e.message);
      return '[audio] (no se pudo transcribir)';
    }
  }

  // fileLength is sender-declared: first filter, the buffer size is rechecked. Failures are announced, never thrown.
  async function documentText(m, chatJid, doc) {
    if (!(toNumber(doc.fileLength) <= MAX_DOC_BYTES)) return docText('documento demasiado grande', doc);
    const name = doc.fileName || 'documento';
    let line;
    try {
      const buf = await download(m);
      if (buf.length > MAX_DOC_BYTES) return docText('documento demasiado grande', doc);
      const path = await saveDocument({ id: m.key.id, fileName: doc.fileName, at: toMs(m.messageTimestamp), buf });
      line = `📎 ${nameOf(chatJid)}: ${name} guardado en ${path}`;
    } catch (e) {
      logError('document download failed:', e.message);
      line = `📎 ${nameOf(chatJid)}: no pude descargar ${name} (${String(e.message).slice(0, 80)})`;
    }
    Promise.resolve().then(() => notice(line)).catch((e) => logError('document notice failed:', e.message));
    return docText('documento', doc);
  }

  // fileLength is sender-declared: first filter, the buffer size is rechecked. Failures never throw; only the error is logged.
  async function imageText(m, chatJid, { caption, mimetype, fileLength }) {
    const label = withCaption('imagen', caption);
    if (!(toNumber(fileLength) <= MAX_IMAGE_BYTES)) return `${label} (demasiado grande, no descrita)`;
    try {
      const buf = await download(m);
      if (buf.length > MAX_IMAGE_BYTES) return `${label} (demasiado grande, no descrita)`;
      const description = await describeImage({ id: m.key.id, at: toMs(m.messageTimestamp), chatJid, caption, mimetype, buf });
      if (description) return `${label} ${description}`;
    } catch (e) {
      logError('image description failed:', e.message);
    }
    return `${label} (no se pudo describir)`;
  }

  // Audio, documents and images are only fetched for gated chats; the gate is asked lazily (only for those message types).
  // Images: participantIds is set only for groups, which are never described.
  async function textOf(m, chatJid, participantIds) {
    const c = normalizeMessageContent(m.message);
    const isSelf = chatJid === self().selfJid;
    if (c?.imageMessage && describeImage && !participantIds && shouldDescribe(chatJid)) return imageText(m, chatJid, c.imageMessage);
    if (c?.audioMessage && (isSelf || shouldTranscribe(chatJid, participantIds))) return audioText(m, c.audioMessage);
    if (c?.documentMessage && saveDocument && !isSelf && shouldTranscribe(chatJid, participantIds)) return documentText(m, chatJid, c.documentMessage);
    return messageText(m.message);
  }

  async function chatJidOf(key) {
    const { selfJid, selfLid } = self();
    const jid = jidNormalizedUser(key.remoteJid);
    if (jid === selfLid) return selfJid;
    if (!isLidUser(jid)) return jid;
    const pn = await pnForLid(jid);
    if (pn) return jidNormalizedUser(pn);
    if (!key.fromMe && isPnUser(key.remoteJidAlt)) return jidNormalizedUser(key.remoteJidAlt);
    if (!noted.has(jid)) { noted.add(jid); onUnresolved(jid); }
    return null;
  }

  // Group sender: key.participant (usually LID) and key.participantAlt (usually PN); both kept for respondTo matching.
  async function participantOf(key) {
    const ids = [key.participant, key.participantAlt].filter(Boolean).map(jidNormalizedUser);
    if (!ids.some(isPnUser)) {
      const lid = ids.find(isLidUser);
      const pn = lid && await pnForLid(lid);
      if (pn) ids.push(jidNormalizedUser(pn));
    }
    const participantIds = [...new Set(ids)];
    return { participant: participantIds.find(isPnUser) ?? participantIds[0] ?? null, participantIds };
  }

  async function groupMessage(m) {
    const { key } = m;
    const chatJid = jidNormalizedUser(key.remoteJid);
    if (!allowGroup(chatJid)) {
      if (!noted.has(chatJid)) { noted.add(chatJid); log(`group not allowlisted, ignored: ${chatJid} (send /grupos for the list)`); }
      onSkippedGroup(chatJid, toMs(m.messageTimestamp));
      return null;
    }
    const { participant, participantIds } = await participantOf(key);
    return {
      id: key.id,
      chatJid,
      fromMe: !!key.fromMe,
      participant,
      participantIds,
      text: await textOf(m, chatJid, participantIds),
      timestamp: toMs(m.messageTimestamp),
      pushName: m.pushName ?? null,
      key,
      message: m.message, // the bridge quotes it when it replies
    };
  }

  return async function normalize(m) {
    const { key } = m;
    if (!key?.remoteJid || isJidBroadcast(key.remoteJid)) return null;
    if (isJidGroup(key.remoteJid)) return groupMessage(m);
    const chatJid = await chatJidOf(key);
    if (!chatJid) return null;
    return {
      id: key.id,
      chatJid,
      fromMe: !!key.fromMe,
      text: await textOf(m, chatJid),
      timestamp: toMs(m.messageTimestamp),
      pushName: m.pushName ?? null,
      key,
    };
  };
}

// Resolves once the socket is open (after QR linking on first run).
// onStatus({ state: connecting|qr|open|logged_out|replaced|wrong_number, qr?, selfJid?, expected?, at }) feeds the portal.
// onSkippedGroup(groupJid, timestampMs, subject|null): a message from a group outside allowGroup (seen-chats registry).
export async function connectWa({
  authDir, onStatus = () => {}, exit = (code) => process.exit(code),
  makeSocket = makeWASocket, useAuth = useMultiFileAuthState, retryMs = 3000,
  printQr = (qr) => qrcode.generate(qr, { small: true }),
  download = (m) => downloadMediaMessage(m, 'buffer', {}), transcribe = createTranscriber(), shouldTranscribe, allowGroup, onSkippedGroup = () => {},
  saveDocument, notice, nameOf, describeImage, shouldDescribe,
}) {
  let auth = await useAuth(authDir);
  const report = (s) => onStatus({ ...s, at: new Date().toISOString() });
  const logger = pino({ level: 'warn' });
  const listeners = [];
  let sock;
  let selfJid;
  let selfLid;
  let linkedJid; // the number this process started with: the bridge captured it, so a relink must match
  const subjects = new Map(); // group jid -> subject promise; a failed fetch is retried on the next message
  const subjectOf = (jid) => {
    if (!subjects.has(jid)) subjects.set(jid, sock.groupMetadata(jid).then((g) => g.subject ?? null, () => { subjects.delete(jid); return null; }));
    return subjects.get(jid);
  };

  const normalize = createNormalizer({
    self: () => ({ selfJid, selfLid }),
    pnForLid: (lid) => sock.signalRepository.lidMapping.getPNForLID(lid),
    onUnresolved: (jid) => api.sendText(selfJid, `unresolved LID ${jid}: message dropped`).catch((e) => console.error('self-chat send failed:', e.message)),
    download,
    transcribe,
    shouldTranscribe,
    allowGroup,
    saveDocument,
    notice,
    nameOf,
    describeImage,
    shouldDescribe,
    onSkippedGroup: (jid, at) => subjectOf(jid).then((subject) => onSkippedGroup(jid, at, subject))
      .catch((e) => console.error('skipped group record failed:', e.message)),
  });

  const api = {
    get selfJid() { return selfJid; },
    onMessage: (cb) => { listeners.push(cb); },
    // quoted: a received message ({ key, message }) shown as the reply's quote.
    sendText: async (jid, text, { quoted } = {}) => (await sock.sendMessage(jid, { text }, quoted ? { quoted } : undefined)).key.id,
    // buffer: a webp file, re-uploaded by Baileys.
    sendSticker: async (jid, buffer) => (await sock.sendMessage(jid, { sticker: buffer })).key.id,
    fetchGroups: () => sock.groupFetchAllParticipating(),
    sendPresence: (jid, type) => sock.sendPresenceUpdate(type, jid),
    markRead: (keys) => sock.readMessages(keys),
  };

  return new Promise((resolve) => {
    function connect() {
      report({ state: 'connecting' });
      sock = makeSocket({
        auth: auth.state,
        logger,
        // Our own sends are not re-emitted as fromMe messages (they are not the owner activity).
        emitOwnEvents: false,
        // Staying "online" would silence notifications on the owner's phone.
        markOnlineOnConnect: false,
        syncFullHistory: false,
      });
      sock.ev.on('creds.update', auth.saveCreds);
      sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) { printQr(qr); report({ state: 'qr', qr }); }
        if (connection === 'open') {
          const jid = jidNormalizedUser(sock.user.id);
          if (linkedJid && jid !== linkedJid) {
            report({ state: 'wrong_number', selfJid: jid, expected: linkedJid });
            console.error(`WhatsApp relinked as ${jid}, but this bridge started as ${linkedJid}; restart it (npm start).`);
            return exit(1);
          }
          linkedJid = selfJid = jid;
          selfLid = sock.user.lid ? jidNormalizedUser(sock.user.lid) : null;
          report({ state: 'open', selfJid });
          resolve(api);
        }
        if (connection === 'close') {
          const code = lastDisconnect?.error?.output?.statusCode;
          if (code === DisconnectReason.connectionReplaced) {
            report({ state: 'replaced' });
            console.error(`WhatsApp connection closed (${code}, replaced by another session); not reconnecting.`);
            return exit(1);
          }
          if (code === DisconnectReason.loggedOut) {
            wipeAuth(authDir);
            report({ state: 'logged_out' });
            console.error('WhatsApp logged out: bridge/auth/ wiped; scan the new QR (portal or terminal) to relink.');
            useAuth(authDir).then((a) => { auth = a; setTimeout(connect, retryMs); })
              .catch((e) => { console.error('auth reload failed:', e.message); exit(1); });
            return;
          }
          setTimeout(connect, retryMs);
        }
      });
      sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const m of messages) {
          try {
            const msg = await normalize(m);
            if (msg) for (const cb of listeners) cb(msg);
          } catch (e) {
            console.error('normalize failed:', e);
          }
        }
      });
    }
    connect();
  });
}
