import { execFile as execFileCb } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const STT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'stt');

// Local speech-to-text through bridge/stt/transcribe.py (faster-whisper, offline). The audio only lives in a temp file
// for the duration of the call.
export function createTranscriber({
  execFile = promisify(execFileCb), python = join(STT_DIR, '.venv', 'bin', 'python'),
  script = join(STT_DIR, 'transcribe.py'), timeoutMs = 180_000,
} = {}) {
  return async function transcribe(buffer) {
    if (!existsSync(python)) throw new Error(`STT venv missing (${python}): run npm run setup:stt`);
    const dir = await mkdtemp(join(tmpdir(), 'wha-stt-'));
    try {
      const audio = join(dir, 'audio.ogg');
      await writeFile(audio, buffer);
      const { stdout } = await execFile(python, ['-I', script, audio], { timeout: timeoutMs }).catch((e) => {
        throw e.code === 3 ? Object.assign(new Error('audio longer than 10 min (real duration)'), { tooLong: true }) : e;
      });
      return stdout.trim();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}
