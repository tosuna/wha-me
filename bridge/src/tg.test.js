import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Api, helpers } from 'telegram';
import { connectTg, messageText, toBridgeMessage } from './tg.js';

const big = helpers.returnBigInt;
const user = (id) => new Api.PeerUser({ userId: big(id) });
const at = 1_700_000_000;
const msg = (fields) => new Api.Message({ id: 7, date: at, message: 'hola', peerId: user(42), ...fields });
const doc = (mimeType, attributes, size = 1000) => new Api.MessageMediaDocument({
  document: new Api.Document({ id: big(1), accessHash: big(1), fileReference: Buffer.alloc(0), date: at, mimeType, size: big(size), dcId: 1, attributes }),
});
const photo = () => new Api.MessageMediaPhoto({});
const CARLOS = new Api.User({ id: big(42), firstName: 'Carlos', lastName: 'Ruiz' });

test('private incoming: tg:<peerId> chat, unique id, ms timestamp, sender name, opaque key', () => {
  assert.deepEqual(toBridgeMessage(msg({}), { sender: CARLOS }), {
    id: 'tg:42:7', chatJid: 'tg:42', fromMe: false, text: 'hola', timestamp: at * 1000, pushName: 'Carlos Ruiz', key: { remoteJid: 'tg:42', id: 7 },
  });
});

test("owner's own message from another device: fromMe true", () => {
  const m = toBridgeMessage(msg({ out: true }));
  assert.equal(m.fromMe, true);
  assert.equal(m.chatJid, 'tg:42');
});

test('group message: marked group id, participant tg:<userId>, quotable message', () => {
  const m = toBridgeMessage(msg({ peerId: new Api.PeerChannel({ channelId: big(555) }), fromId: user(42) }), { sender: CARLOS });
  assert.equal(m.chatJid, 'tg:-100555');
  assert.equal(m.id, 'tg:-100555:7');
  assert.equal(m.participant, 'tg:42');
  assert.deepEqual(m.participantIds, ['tg:42']);
  assert.ok('message' in m);
  const basic = toBridgeMessage(msg({ peerId: new Api.PeerChat({ chatId: big(9) }), fromId: user(42) }));
  assert.equal(basic.chatJid, 'tg:-9');
});

test('channel posts are not chats: ignored', () => {
  assert.equal(toBridgeMessage(msg({ peerId: new Api.PeerChannel({ channelId: big(1) }), post: true })), null);
});

test('media become the same placeholders as WhatsApp', () => {
  assert.equal(messageText(msg({ media: photo(), message: '' })), '[imagen]');
  assert.equal(messageText(msg({ media: photo(), message: 'mira' })), '[imagen: mira]');
  assert.equal(messageText(msg({ media: doc('audio/ogg', [new Api.DocumentAttributeAudio({ voice: true, duration: 3 })]), message: '' })), '[audio]');
  assert.equal(messageText(msg({ media: doc('image/webp', [new Api.DocumentAttributeSticker({ alt: ':)', stickerset: new Api.InputStickerSetEmpty() })]), message: '' })), '[sticker]');
  assert.equal(messageText(msg({ media: doc('video/mp4', [new Api.DocumentAttributeVideo({ duration: 3, w: 1, h: 1 })]), message: 've' })), '[video: ve]');
  assert.equal(messageText(msg({ media: doc('application/pdf', [new Api.DocumentAttributeFilename({ fileName: 'r.pdf' })]), message: 'ahi va' })), '[documento: r.pdf] ahi va');
  assert.equal(messageText(msg({ media: new Api.MessageMediaGeo({ geo: new Api.GeoPointEmpty() }), message: '' })), '[ubicacion]');
  assert.equal(messageText(msg({ media: new Api.MessageMediaWebPage({ webpage: new Api.WebPageEmpty({ id: big(1) }) }), message: 'https://x.mx' })), 'https://x.mx');
});

// A fake gramjs client: records calls; emit(message) plays an incoming NewMessage update.
function fakeClient({ authorized = true } = {}) {
  const calls = [];
  let handler;
  let next = 100;
  return {
    calls,
    emit: (message) => handler({ message }),
    connect: async () => { calls.push(['connect']); },
    checkAuthorization: async () => authorized,
    getDialogs: async () => [],
    addEventHandler: (fn) => { handler = fn; },
    sendMessage: async (peer, opts) => { calls.push(['send', String(peer), opts]); return { id: ++next }; },
    markAsRead: async (peer, ids) => { calls.push(['read', String(peer), ids]); },
    invoke: async (req) => { calls.push(['invoke', req.className, String(req.peer)]); },
    downloadMedia: async () => Buffer.from('audio'),
  };
}

const flush = () => new Promise((r) => setImmediate(r));

test('connectTg: emits normalized messages, incoming and the owner\'s own', async () => {
  const client = fakeClient();
  const tg = await connectTg({ client });
  const got = [];
  tg.onMessage((m) => got.push(m));
  client.emit(Object.assign(msg({}), { getSender: async () => CARLOS }));
  client.emit(msg({ id: 8, out: true, message: 'yo contesto' }));
  await flush();
  assert.deepEqual(got.map((m) => [m.chatJid, m.fromMe, m.text, m.pushName]), [['tg:42', false, 'hola', 'Carlos Ruiz'], ['tg:42', true, 'yo contesto', null]]);
});

test('connectTg: refuses a session that is not logged in', async () => {
  await assert.rejects(connectTg({ client: fakeClient({ authorized: false }) }), /login:tg/);
});

test('connectTg: groups outside allowGroup are dropped and reported', async () => {
  const client = fakeClient();
  const skipped = [];
  const tg = await connectTg({ client, allowGroup: (jid) => jid === 'tg:-100555', onSkippedGroup: (jid, ts) => skipped.push([jid, ts]) });
  const got = [];
  tg.onMessage((m) => got.push(m.chatJid));
  client.emit(msg({ peerId: new Api.PeerChannel({ channelId: big(1) }), fromId: user(42) }));
  client.emit(msg({ peerId: new Api.PeerChannel({ channelId: big(555) }), fromId: user(42) }));
  await flush();
  assert.deepEqual(got, ['tg:-100555']);
  assert.deepEqual(skipped, [['tg:-1001', at * 1000]]);
});

test('connectTg: voice notes are transcribed only for gated chats', async () => {
  const client = fakeClient();
  const voice = (peer) => msg({ peerId: user(peer), message: '', media: doc('audio/ogg', [new Api.DocumentAttributeAudio({ voice: true, duration: 3 })]) });
  const tg = await connectTg({ client, transcribe: async (buf) => `dijo ${buf}`, shouldTranscribe: (jid) => jid === 'tg:42' });
  const got = [];
  tg.onMessage((m) => got.push(m.text));
  client.emit(voice(42));
  client.emit(voice(43));
  await flush();
  assert.deepEqual(got, ['[audio] dijo audio', '[audio]']);
});

test('connectTg: photos are described only where shouldDescribe allows', async () => {
  const client = fakeClient();
  const seen = [];
  const tg = await connectTg({
    client, shouldDescribe: (jid) => jid === 'tg:42',
    describeImage: async (a) => { seen.push([a.id, a.chatJid, a.caption, a.mimetype, String(a.buf)]); return 'un perro'; },
  });
  const got = [];
  tg.onMessage((m) => got.push(m.text));
  client.emit(msg({ media: photo(), message: 'mira' }));
  client.emit(msg({ peerId: user(43), media: photo(), message: '' }));
  await flush();
  assert.deepEqual(got, ['[imagen: mira] un perro', '[imagen]']);
  assert.deepEqual(seen, [['tg:42:7', 'tg:42', 'mira', 'image/jpeg', 'audio']]);
});

test('connectTg: sendText goes to the peer id, quotes with replyTo and returns a cross-transport unique id', async () => {
  const client = fakeClient();
  const tg = await connectTg({ client });
  assert.equal(await tg.sendText('tg:-100555', 'va', { quoted: { key: { remoteJid: 'tg:-100555', id: 7 } } }), 'tg:-100555:101');
  assert.equal(await tg.sendText('tg:42', 'listo'), 'tg:42:102');
  assert.deepEqual(client.calls.filter((c) => c[0] === 'send'), [['send', '-100555', { message: 'va', replyTo: 7 }], ['send', '42', { message: 'listo' }]]);
});

test('connectTg: markRead marks up to the newest key; presence types now and again in 4 s; no stickers', async () => {
  const client = fakeClient();
  const timers = [];
  const tg = await connectTg({ client, setTimer: (fn, ms) => { timers.push([fn, ms]); return { unref() {} }; } });
  await tg.markRead([{ remoteJid: 'tg:42', id: 7 }, { remoteJid: 'tg:42', id: 9 }]);
  await tg.sendPresence('tg:42', 'composing');
  assert.deepEqual(timers.map((t) => t[1]), [4000]);
  await timers[0][0]();
  assert.deepEqual(client.calls.filter((c) => c[0] !== 'connect'), [
    ['read', '42', 9], ['invoke', 'messages.SetTyping', '42'], ['invoke', 'messages.SetTyping', '42'],
  ]);
  await assert.rejects(tg.sendSticker('tg:42', Buffer.alloc(1)), /stickers not supported on Telegram/);
});
