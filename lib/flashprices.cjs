"use strict";
/*
 * Flash V2 API price feed — https://flashapi.trade/prices (documented at docs.flash.trade
 * → Build on Flash → Flash Trade V2 API). This is Flash's own Lazer-fed price service:
 * per-symbol Lazer prices with microsecond timestamps, confidence, and marketSession
 * (regular/closed). /tokens carries the official Lazer id per token (BTC=1, SOL=6, USDC=7).
 *
 * Independence note (stated in the UI): the API is a DIFFERENT system from the on-chain
 * oracle-writing path — a forged on-chain mark diverges from it instantly — but it is still
 * Flash infrastructure. For third-party independence set LAZER_ACCESS_TOKEN (direct Lazer).
 */
const FLASH_API = process.env.FLASH_API_URL || "https://flashapi.trade";

/** symbol → { priceUi, price, exponent, confidence, publishTime (unix s), marketSession } */
async function fetchFlashLazerPrices() {
  const r = await fetch(`${FLASH_API}/prices`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`flashapi /prices ${r.status}`);
  const j = await r.json();
  const out = {};
  for (const [sym, p] of Object.entries(j || {})) {
    if (!p || p.priceUi == null || !Number.isFinite(Number(p.priceUi))) continue;
    out[sym] = {
      price: Number(p.priceUi),
      publishTime: p.timestampUs != null ? Math.floor(Number(p.timestampUs) / 1e6) : null,
      confidence: p.confidence != null ? Number(p.confidence) : null,
      marketSession: p.marketSession || null,
    };
  }
  return out;
}

/** Token registry from /tokens: bySymbol (symbol → lazerId) and byMint (mint → {symbol, lazerId}).
 *  Mint-keyed matching is exact — API symbol casing ("BONK") can differ from on-chain metadata ("Bonk"). */
async function fetchFlashLazerIds() {
  const r = await fetch(`${FLASH_API}/tokens`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`flashapi /tokens ${r.status}`);
  const arr = await r.json();
  const bySymbol = {}, byMint = {};
  for (const t of arr || []) {
    if (!t || !t.symbol) continue;
    if (t.lazerId != null) bySymbol[t.symbol] = t.lazerId;
    if (t.mint) byMint[t.mint] = { symbol: t.symbol, lazerId: t.lazerId != null ? t.lazerId : null };
  }
  return { bySymbol, byMint };
}

module.exports = { fetchFlashLazerPrices, fetchFlashLazerIds };
