async function check(url, isApi, fetch, timeoutMs) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.text();
    const r = { url, status: res.status, ms: Date.now() - t0 };
    if (isApi) {
      try { JSON.parse(body); r.jsonOk = true; } catch { r.jsonOk = false; }
    }
    return r;
  } catch (e) {
    return { url, error: e.message, ms: Date.now() - t0 };
  }
}

// pages / apis: config knowledge.healthUrls (an API is healthy only if its body is JSON). Never throws: each URL reports
// either a status or an error.
export function checkHealth({ pages, apis, fetch = globalThis.fetch, timeoutMs = 10_000 }) {
  return Promise.all([
    ...pages.map((u) => check(u, false, fetch, timeoutMs)),
    ...apis.map((u) => check(u, true, fetch, timeoutMs)),
  ]);
}
