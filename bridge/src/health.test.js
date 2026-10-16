import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkHealth } from './health.js';

// knowledge.healthUrls of some config.
const PAGE_URLS = ['https://example.com/', 'https://down.example.com/', 'https://busy.example.com/', 'https://admin.example.com/'];
const API_URLS = ['https://example.com/api/status', 'https://example.com/api/html'];

test('checkHealth fetches every URL in parallel with a timeout and reports status/error/ms/jsonOk', async () => {
  const seen = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetch = async (url, opts) => {
    seen.push(url);
    assert.ok(opts.signal instanceof AbortSignal);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setImmediate(r));
    inFlight--;
    if (url === PAGE_URLS[1]) throw new Error('getaddrinfo ENOTFOUND');
    if (url === API_URLS[1]) return { status: 200, text: async () => '<html>' };
    if (url === API_URLS[0]) return { status: 200, text: async () => '[]' };
    return { status: url === PAGE_URLS[2] ? 503 : 200, text: async () => 'ok' };
  };
  const out = await checkHealth({ pages: PAGE_URLS, apis: API_URLS, fetch });
  assert.deepEqual(new Set(seen), new Set([...PAGE_URLS, ...API_URLS]));
  assert.equal(maxInFlight, PAGE_URLS.length + API_URLS.length);
  const by = Object.fromEntries(out.map((r) => [r.url, r]));
  assert.equal(by[PAGE_URLS[0]].status, 200);
  assert.equal(typeof by[PAGE_URLS[0]].ms, 'number');
  assert.equal(by[PAGE_URLS[0]].jsonOk, undefined);
  assert.match(by[PAGE_URLS[1]].error, /ENOTFOUND/);
  assert.equal(by[PAGE_URLS[2]].status, 503);
  assert.equal(by[API_URLS[0]].jsonOk, true);
  assert.equal(by[API_URLS[1]].jsonOk, false);
});
