import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TOKEN_PREFIX = '//npm.pkg.github.com/:_authToken=';
const PATTERNS = [/ghp_/, /github_pat_/, /-----BEGIN/, /AKIA[0-9A-Z]{16}/, /xox[bp]-/, /\/\/npm\.pkg\.github\.com\/:_authToken/];

// GitHub Packages token from ~/.npmrc, or null.
export function npmrcToken(readFile = readFileSync) {
  try {
    const line = readFile(join(homedir(), '.npmrc'), 'utf8').split('\n').find((l) => l.startsWith(TOKEN_PREFIX));
    return line ? line.slice(TOKEN_PREFIX.length).trim() || null : null;
  } catch {
    return null;
  }
}

// Trust boundary for everything the bridge sends: true if `text` looks like it carries a secret.
// The token is re-read on every check so a rotated token is still caught. secrets: extra literal values (the portal token,
// the GitHub token), or a function returning them, called on every check so a value set later is caught too.
export function createSecretGuard({ readFile = readFileSync, secrets = [] } = {}) {
  const extra = () => (typeof secrets === 'function' ? secrets() : secrets).filter(Boolean);
  return (text) => {
    if (PATTERNS.some((re) => re.test(text)) || extra().some((s) => text.includes(s))) return true;
    const token = npmrcToken(readFile);
    return !!token && text.includes(token);
  };
}
