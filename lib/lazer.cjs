"use strict";
/*
 * Pyth Lazer (Pyth Pro) — the feed service Flash actually uses (every FLASH6 CustomOracle
 * carries a lazer_feed_id on-chain, so feeds are mapped EXACTLY, never guessed by symbol).
 *
 * Access model (verified 2026-07-19):
 *   • router  https://pyth-lazer.dourolabs.app/v1/latest_price  → Bearer token REQUIRED (403 without)
 *   • history https://history.pyth-lazer.dourolabs.app/v1/symbols → public (feed metadata + exponent)
 * With LAZER_ACCESS_TOKEN set, the oracle guard cross-checks against Lazer directly; without
 * it, the Flash V2 API Lazer feed (flashapi.trade/prices) is used and labeled as such.
 */
const ROUTER = process.env.LAZER_URL || "https://pyth-lazer.dourolabs.app";
const HISTORY = process.env.LAZER_HISTORY_URL || "https://history.pyth-lazer.dourolabs.app";

/** Public feed metadata: lazer feed id → { name, symbol, exponent, assetType }. */
async function fetchLazerMeta() {
  const r = await fetch(`${HISTORY}/v1/symbols`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`lazer symbols ${r.status}`);
  const arr = await r.json();
  const out = {};
  for (const s of arr || []) {
    if (s && s.pyth_lazer_id != null) out[s.pyth_lazer_id] = { name: s.name, symbol: s.symbol, exponent: s.exponent, assetType: s.asset_type, state: s.state };
  }
  return out;
}

/** Latest Lazer prices for a set of feed ids (Bearer token required).
 *  Response shape is parsed defensively: any object carrying a feed id + price is accepted. */
async function fetchLazerLatest(feedIds, token, meta) {
  if (!feedIds.length) return {};
  const r = await fetch(`${ROUTER}/v1/latest_price?feed_ids=${feedIds.join(",")}`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
  });
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error(`lazer auth ${r.status}`), { auth: true });
  if (!r.ok) throw new Error(`lazer ${r.status}`);
  const j = await r.json();
  const found = {};
  const scan = (o) => {
    if (Array.isArray(o)) return o.forEach(scan);
    if (o && typeof o === "object") {
      const id = o.priceFeedId != null ? o.priceFeedId : o.price_feed_id != null ? o.price_feed_id : o.feedId != null ? o.feedId : null;
      const px = o.price != null ? o.price : o.bestBidPrice != null ? o.bestBidPrice : null;
      if (id != null && px != null) { found[id] = o; return; }
      Object.values(o).forEach(scan);
    }
  };
  scan(j);
  const out = {};
  for (const [id, o] of Object.entries(found)) {
    const m = meta[id] || {};
    const expo = o.exponent != null ? o.exponent : m.exponent;
    if (expo == null) continue;
    const price = Number(o.price) * Math.pow(10, expo);
    if (!Number.isFinite(price) || price <= 0) continue;
    const tsUs = o.publishTimestampUs != null ? Number(o.publishTimestampUs) : o.timestampUs != null ? Number(o.timestampUs) : null;
    out[id] = { price, publishTime: tsUs != null ? Math.floor(tsUs / 1e6) : null };
  }
  return out;
}

module.exports = { fetchLazerMeta, fetchLazerLatest };
