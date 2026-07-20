"use strict";
/*
 * Rate-limited JSON-RPC client with retry/backoff.
 * One limiter per endpoint so the ER and base chain don't starve each other.
 */
const https = require("https");

function makeRpc(url, { minGapMs = 120, timeoutMs = 30000, retries = 4 } = {}) {
  let chain = Promise.resolve();
  let lastAt = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const post = (body) => new Promise((res, rej) => {
    const u = new URL(url);
    const rq = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { if (r.statusCode === 429) return rej(Object.assign(new Error("http 429"), { retryable: true })); if (r.statusCode >= 500) return rej(Object.assign(new Error("http " + r.statusCode), { retryable: true })); try { res(JSON.parse(d)); } catch (e) { rej(Object.assign(new Error("bad json (" + d.slice(0, 120) + ")"), { retryable: true })); } }); }
    );
    rq.on("error", (e) => rej(Object.assign(e, { retryable: true })));
    rq.setTimeout(timeoutMs, () => rq.destroy(Object.assign(new Error("rpc timeout"), { retryable: true })));
    rq.write(body); rq.end();
  });

  const call = (method, params) => {
    const run = async () => {
      const wait = lastAt + minGapMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastAt = Date.now();
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
      let err;
      for (let a = 0; a <= retries; a++) {
        try {
          const j = await post(body);
          if (j && j.error) {
            const code = j.error.code;
            if (code === 429 || code === -32429 || /rate/i.test(j.error.message || "")) { err = new Error("rpc rate-limited"); await sleep(600 * (a + 1)); lastAt = Date.now(); continue; }
            return j; // structured rpc error → caller decides
          }
          return j;
        } catch (e) {
          err = e;
          if (!e.retryable) break;
          await sleep(500 * (a + 1)); lastAt = Date.now();
        }
      }
      throw err || new Error("rpc failed: " + method);
    };
    const p = chain.then(run, run);
    chain = p.catch(() => {});
    return p;
  };

  call.url = url;
  return call;
}

module.exports = { makeRpc };
