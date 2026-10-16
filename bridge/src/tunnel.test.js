import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tunnelUrl } from './tunnel.js';

test('tunnelUrl picks the quick tunnel URL from cloudflared output, never the API host', () => {
  assert.equal(tunnelUrl('2026-10-15T18:00:00Z INF |  https://quiet-river-1234.trycloudflare.com                                     |'), 'https://quiet-river-1234.trycloudflare.com');
  assert.equal(tunnelUrl('2026-10-15T18:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...'), null);
  assert.equal(tunnelUrl('2026-10-15T18:00:00Z ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": EOF'), null);
});
