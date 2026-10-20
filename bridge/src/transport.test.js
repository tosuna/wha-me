import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from './transport.js';

function fake(name, log) {
  const listeners = [];
  return {
    selfJid: `${name}-self`,
    emit: (m) => listeners.forEach((cb) => cb(m)),
    onMessage: (cb) => listeners.push(cb),
    sendText: async (jid, text, opts) => { log.push([name, 'send', jid, text, opts]); return `${name}-id`; },
    sendSticker: async (jid) => { log.push([name, 'sticker', jid]); return `${name}-id`; },
    sendPresence: async (jid, type) => { log.push([name, 'presence', jid, type]); },
    markRead: async (keys) => { log.push([name, 'read', keys.length]); },
    fetchGroups: async () => ({ [`${name}-g`]: { id: `${name}-g` } }),
  };
}

test('router: sends, presence and read receipts go to the transport that owns the chat; the self-chat stays WhatsApp', async () => {
  const log = [];
  const wa = fake('wa', log);
  const tg = fake('tg', log);
  const r = createRouter({ wa, tg });
  assert.equal(r.selfJid, 'wa-self');
  assert.equal(await r.sendText('tg:42', 'hola', { quoted: 'q' }), 'tg-id');
  assert.equal(await r.sendText('bea@s.whatsapp.net', 'hola'), 'wa-id');
  await r.sendSticker('tg:42', Buffer.alloc(1));
  await r.sendPresence('tg:-100555', 'composing');
  await r.markRead([{ remoteJid: 'tg:42', id: 1 }]);
  await r.markRead([{ remoteJid: 'bea@lid', id: 'X' }]);
  assert.deepEqual(log, [
    ['tg', 'send', 'tg:42', 'hola', { quoted: 'q' }], ['wa', 'send', 'bea@s.whatsapp.net', 'hola', undefined], ['tg', 'sticker', 'tg:42'],
    ['tg', 'presence', 'tg:-100555', 'composing'], ['tg', 'read', 1], ['wa', 'read', 1],
  ]);
});

test('router: fan-in of both transports and groups from both', async () => {
  const wa = fake('wa', []);
  const tg = fake('tg', []);
  const r = createRouter({ wa, tg });
  const got = [];
  r.onMessage((m) => got.push(m.chatJid));
  wa.emit({ chatJid: 'bea@s.whatsapp.net' });
  tg.emit({ chatJid: 'tg:42' });
  assert.deepEqual(got, ['bea@s.whatsapp.net', 'tg:42']);
  assert.deepEqual(Object.keys(await r.fetchGroups()), ['wa-g', 'tg-g']);
});

test('router without Telegram: WhatsApp unchanged; a tg: chat fails loudly instead of going out on WhatsApp', async () => {
  const log = [];
  const r = createRouter({ wa: fake('wa', log) });
  assert.equal(await r.sendText('bea@s.whatsapp.net', 'hola'), 'wa-id');
  await assert.rejects(r.sendText('tg:42', 'hola'), /Telegram/);
  assert.equal(log.length, 1);
});

test('router over a real connectTg (fake gramjs client): a Telegram message reaches the bridge handler; the reply leaves via Telegram', async () => {
  const { Api, helpers } = await import('telegram');
  const { connectTg } = await import('./tg.js');
  let handler;
  const tgSent = [];
  const client = {
    connect: async () => {}, checkAuthorization: async () => true, getDialogs: async () => [],
    addEventHandler: (fn) => { handler = fn; },
    sendMessage: async (peer, opts) => { tgSent.push([String(peer), opts.message]); return { id: 8 }; },
  };
  const log = [];
  const r = createRouter({ wa: fake('wa', log), tg: await connectTg({ client }) });
  const got = [];
  r.onMessage((m) => got.push(m));
  await handler({ message: new Api.Message({ id: 7, date: 1, message: 'hola', peerId: new Api.PeerUser({ userId: helpers.returnBigInt(42) }) }) });
  assert.deepEqual(got.map((m) => [m.chatJid, m.text, m.fromMe]), [['tg:42', 'hola', false]]);
  assert.equal(await r.sendText(got[0].chatJid, 'va'), 'tg:42:8');
  assert.deepEqual([tgSent, log], [[['42', 'va']], []]);
});
