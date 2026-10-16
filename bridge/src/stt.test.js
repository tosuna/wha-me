import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createTranscriber } from './stt.js';

// process.execPath stands in for the venv python: it exists, and the fake execFile never runs it.
function fake(result) {
  const calls = [];
  const execFile = async (file, args, opts) => {
    const audio = args.at(-1);
    calls.push({ file, args, opts, existed: existsSync(audio), bytes: existsSync(audio) ? readFileSync(audio).toString() : null });
    if (result instanceof Error) throw result;
    return { stdout: result, stderr: '' };
  };
  return { calls, transcribe: createTranscriber({ execFile, python: process.execPath, script: '/x/transcribe.py', timeoutMs: 1234 }) };
}

test('runs the script isolated on a temp copy of the audio and trims stdout', async () => {
  const f = fake('  hola mundo \n');
  assert.equal(await f.transcribe(Buffer.from('OGG')), 'hola mundo');
  const [{ file, args, opts, existed, bytes }] = f.calls;
  assert.equal(file, process.execPath);
  assert.deepEqual(args.slice(0, 2), ['-I', '/x/transcribe.py']);
  assert.ok(existed);
  assert.equal(bytes, 'OGG');
  assert.equal(opts.timeout, 1234);
  assert.ok(!existsSync(args[2]) && !existsSync(dirname(args[2])), 'temp file and dir removed');
});

test('temp file is removed when the script fails', async () => {
  const f = fake(new Error('boom'));
  await assert.rejects(f.transcribe(Buffer.from('OGG')), /boom/);
  const audio = f.calls[0].args[2];
  assert.ok(!existsSync(audio) && !existsSync(dirname(audio)));
});

test('a missing venv gives a clear error and runs nothing', async () => {
  const calls = [];
  const transcribe = createTranscriber({ execFile: async (...a) => { calls.push(a); }, python: '/nope/.venv/bin/python' });
  await assert.rejects(transcribe(Buffer.from('OGG')), /npm run setup:stt/);
  assert.equal(calls.length, 0);
});

test('exit code 3 (real duration over 10 min) is a distinguishable tooLong error', async () => {
  await assert.rejects(fake(Object.assign(new Error('Command failed'), { code: 3 })).transcribe(Buffer.from('OGG')), (e) => e.tooLong === true);
  await assert.rejects(fake(Object.assign(new Error('boom'), { code: 1 })).transcribe(Buffer.from('OGG')), (e) => !e.tooLong && /boom/.test(e.message));
});
