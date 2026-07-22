"use strict";
/*
 * Reconciliation-anomaly watch — the 7-day-rehearsal catcher.
 *
 * The exploit was rehearsed for ~a week. Those rehearsals moved almost no money, so a flow/outflow
 * monitor was blind to them — but at least one rehearsal (2026-07-20) left a visible fingerprint: a
 * PHANTOM POSITION, i.e. a Market whose open-interest no longer matches the sum of the baskets behind
 * it (basketPositions ≠ marketOpenPositions / size gap). That mismatch sat on-chain a full day before
 * the live drain, but nothing ALERTED on it.
 *
 * This module turns the census's basket-vs-market reconciliation into a live early-warning: it flags any
 * NEW mismatch the moment it appears. A phantom position is the on-chain signature of a broken-entitlement
 * bug being exercised — exactly the class the conservation proof (movement, not entitlement) can't see.
 *
 * Alerts route to the OPERATOR DM only (private) — never the public channel — until explicitly promoted.
 */

const CENSUS_URL = process.env.CENSUS_API_URL || "https://flashtrade-v2-onchain-census.vercel.app/api/census";

// Fetch the census and extract the mismatched market-sides as a normalized list.
async function fetchReconciliation(url = CENSUS_URL, timeoutMs = 45000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`census ${r.status}`);
  const j = await r.json();
  return parseReconciliation(j);
}

// Pure parser (split out so it can be tested against a captured census payload — no network).
function parseReconciliation(j) {
  const mr = (j && j.marketReconciliation) || {};
  const rows = Array.isArray(mr.rows) ? mr.rows : [];
  const mismatched = rows
    .filter((x) => x && x.match === false)
    .map((x) => ({
      key: x.marketAccount || `${x.pool}/${x.market}/${x.side}`,
      market: x.market, side: x.side, pool: x.pool, marketAccount: x.marketAccount,
      posDiff: x.posDiff,
      sizeDiffRaw: String(x.sizeDiffRaw != null ? x.sizeDiffRaw : "0"),
      collDiffRaw: String(x.collDiffRaw != null ? x.collDiffRaw : "0"),
      basketPositions: x.basketPositions, marketOpenPositions: x.marketOpenPositions,
      basketSumSizeUsd: x.basketSumSizeUsd, marketCollectiveSizeUsd: x.marketCollectiveSizeUsd,
    }));
  return {
    mismatchedCount: typeof mr.mismatched === "number" ? mr.mismatched : mismatched.length,
    marketSides: mr.marketSidesWithState,
    allExact: !!mr.allExact,
    mismatched,
  };
}

// Diff the current mismatch set against the last-known one. MUTATES `known` (a {key → record} map that
// the daemon persists). Returns { fresh, resolved }. `firstSeen` is preserved across polls so an ongoing
// mismatch is never re-alerted — only genuinely new phantoms surface in `fresh`.
function diffMismatches(known, mismatched, nowUnix) {
  const cur = Object.create(null);
  const fresh = [];
  for (const m of mismatched) {
    cur[m.key] = true;
    if (!known[m.key]) { known[m.key] = { ...m, firstSeen: nowUnix, lastSeen: nowUnix }; fresh.push(known[m.key]); }
    else known[m.key] = { ...known[m.key], ...m, lastSeen: nowUnix }; // refresh detail, keep firstSeen
  }
  const resolved = [];
  for (const k of Object.keys(known)) if (!cur[k]) { resolved.push(known[k]); delete known[k]; }
  return { fresh, resolved };
}

// Seed the known-set from the current mismatches WITHOUT emitting alerts (cold-start / first boot, so a
// pre-existing known phantom doesn't fire as if it were new). Returns the count seeded.
function seed(known, mismatched, nowUnix) {
  let n = 0;
  for (const m of mismatched) if (!known[m.key]) { known[m.key] = { ...m, firstSeen: nowUnix, lastSeen: nowUnix, seeded: true }; n++; }
  return n;
}

function describe(m) {
  const usdGap = Math.round(Math.abs((m.basketSumSizeUsd || 0) - (m.marketCollectiveSizeUsd || 0)));
  const acct = String(m.marketAccount || "").slice(0, 6);
  return `${m.pool}/${m.market} ${m.side} — baskets ${m.basketPositions} vs market ${m.marketOpenPositions} positions (posDiff ${m.posDiff}, ~$${usdGap} size gap) · ${acct}…`;
}

module.exports = { fetchReconciliation, parseReconciliation, diffMismatches, seed, describe, CENSUS_URL };
