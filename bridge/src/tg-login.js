// npm run login:tg: logs the owner's Telegram account in from the terminal (phone, code, 2FA password) and saves the session
// to bridge/auth-tg/session (0600), read by index.js at start. Needs TG_API_ID and TG_API_HASH (my.telegram.org).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { tgClient } from './tg.js';

const { TG_API_ID, TG_API_HASH } = process.env;
if (!TG_API_ID || !TG_API_HASH) {
  console.error('Set TG_API_ID and TG_API_HASH first (create them at https://my.telegram.org → API development tools).');
  process.exit(1);
}
const dir = join(dirname(dirname(fileURLToPath(import.meta.url))), 'auth-tg');
const rl = createInterface({ input: process.stdin, output: process.stdout });
const client = tgClient({ apiId: TG_API_ID, apiHash: TG_API_HASH });
await client.start({
  phoneNumber: () => rl.question('Teléfono (con código de país, ej. +52…): '),
  phoneCode: () => rl.question('Código que te llegó a Telegram: '),
  password: () => rl.question('Password de verificación en dos pasos: '),
  onError: (e) => console.error('Telegram:', e.message),
});
mkdirSync(dir, { recursive: true, mode: 0o700 });
writeFileSync(join(dir, 'session'), client.session.save(), { mode: 0o600 });
const me = await client.getMe();
console.log(`Sesión guardada en ${join(dir, 'session')} (Telegram ${me.username ? `@${me.username}` : me.id}). Reinicia el bridge.`);
rl.close();
await client.disconnect();
process.exit(0);
