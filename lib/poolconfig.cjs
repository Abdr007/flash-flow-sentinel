"use strict";
/*
 * Dynamic Pool & Token config — Flash's live CDN manifest, the exact data the Flash UI/bots run on.
 * It is the source of truth for mint → symbol (the bundled SDK snapshot goes stale the moment a token
 * is listed or a custody changes). We use it ONLY to resolve real symbols so alerts/charts never show a
 * raw mint prefix (e.g. "ToNg…") when the token is actually GRAM. Prices/marks stay on-chain — this is
 * labels only.
 *   manifest = { configMeta, pools[], otherTokens[] }; each pool/token carries a `cluster` field.
 */
const MANIFEST_URL =
  process.env.POOL_CONFIG_URL ||
  "https://dxjms0h859jb3.cloudfront.net/pool-config/flash-trade-v2/prod.json";

/** Fetch the manifest and build { mint → { symbol, decimals, isStable, isVirtual } } for one cluster.
 *  Draws from every pool's custodies (real vaults) plus otherTokens (virtual/synthetic listings). */
async function fetchPoolConfigSymbols(cluster = "mainnet-beta") {
  const r = await fetch(MANIFEST_URL, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`pool-config ${r.status}`);
  const j = await r.json();
  const byMint = {};
  const add = (t) => {
    const mint = t && (t.mintKey || t.mint);
    // skip the "11111…1" placeholder mint used for not-yet-listed synthetic tokens
    if (!mint || !t.symbol || mint === "11111111111111111111111111111111") return;
    if (!byMint[mint]) {
      byMint[mint] = {
        symbol: t.symbol,
        name: t.name || null,
        decimals: t.decimals,
        isStable: !!t.isStable,
        isVirtual: !!t.isVirtual,
        symbolSource: "flash-pool-config",
      };
    }
  };
  for (const p of j.pools || []) {
    if (p.cluster && p.cluster !== cluster) continue;
    for (const c of p.custodies || []) add(c);
    for (const t of p.tokens || []) add(t);
  }
  for (const t of j.otherTokens || []) {
    if (t.cluster && t.cluster !== cluster) continue;
    add(t);
  }
  return byMint;
}

module.exports = { fetchPoolConfigSymbols, MANIFEST_URL };
