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

// Fetch ONCE and return BOTH the phantom-position reconciliation and the on-chain solvency/drain invariant
// suite (the strongest signal — a direct proof the protocol is solvent and not being drained).
async function fetchCensusFull(url = CENSUS_URL, timeoutMs = 45000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`census ${r.status}`);
  const j = await r.json();
  return { recon: parseReconciliation(j), inv: parseInvariants(j) };
}

// Parse the census's on-chain solvency + money-drain invariants. Every field is computed by the census from
// the SAME atomic mainnet-ER scan (raw u64, no synthetic data). If any invariant FAILS, the protocol is
// provably insolvent / being drained — the single strongest signal this monitor has.
function parseInvariants(j) {
  const ai = (j && j.amountInvariants) || {};
  const ps = ai.protocolSolvency || {}, vs = ai.vaultSolvency || {}, md = ai.moneyDrainInvariants || {};
  const present = typeof ai.allHold === "boolean"; // the invariant suite is actually there (schema present)
  const fails = [];
  const chk = (v, label) => { if (v === false) fails.push(label); }; // only an explicit `false` is a failure (a missing field ≠ failure)
  chk(md.allHold, "money-drain invariant");
  chk(vs.allBacked, `vault solvency${vs.deficit ? ` (deficit ${vs.deficit})` : ""}`);
  chk(ps.tokensBackedOneToOne, "tokens 1:1 backed");
  chk(ps.vaultsSolvent, "vaults solvent");
  chk(ai.lockedInvariant && ai.lockedInvariant.holds, "locked invariant");
  chk(ai.reservedInvariant && ai.reservedInvariant.holds, "reserved invariant");
  chk(ai.perMarketLockedInvariant && ai.perMarketLockedInvariant.holds, "per-market locked invariant");
  chk(ai.globalLockedInvariant && ai.globalLockedInvariant.holds, "global locked invariant");
  const mr = (j && j.marketReconciliation) || {};
  // Solvency SURPLUS buffer (USD): backing minus obligations. The withdrawable invariant is `vault >= owned`,
  // so it stays green while this buffer erodes toward zero — an unbacked drain is invisible until the last
  // dollar. Exposing the buffer VALUE lets the sentinel catch the erosion (see checkSolvencyBuffer): backing
  // (vaultUsd) and obligations (ownedUsd) come from protocolSolvency; both are mark-valued at the SAME on-chain
  // marks, so surplus = vaultUsd − ownedUsd is a consistent, real number (no synthetic data).
  const vaultUsd = Number.isFinite(ps.vaultUsd) ? ps.vaultUsd : null;
  const ownedUsd = Number.isFinite(ps.ownedUsd) ? ps.ownedUsd : null;
  const surplusUsd = vaultUsd != null && ownedUsd != null ? vaultUsd - ownedUsd : null;
  return {
    present,
    allHold: present && ai.allHold === true && fails.length === 0,
    fails,
    asOfUnix: (j && j.meta && j.meta.asOfUnix) || null,
    marketReconAllExact: mr.allExact === true,
    coveragePct: (j && j.coverage && j.coverage.pct) || null,
    deficit: vs.deficit != null ? vs.deficit : null,
    vaultUsd, ownedUsd, surplusUsd,
  };
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

// Pure per-interval solvency-BUFFER accumulator. The census `withdrawable` invariant is `vault >= owned`, so it
// stays green while the surplus buffer (vaultUsd − ownedUsd) erodes toward zero — an unbacked drain is invisible
// until the last dollar. This ties each surplus DROP to the base-chain outflow in the SAME interval:
//   • a market move changes surplus but moves NO tokens (netOut≈0)         → contributes 0
//   • a legit withdrawal drops backing AND obligations together (buffer flat) → contributes 0
//   • an unbacked drain drops the buffer AND moves tokens out, same interval → contributes min(netOut, drop)
// A buffer RECOVERY (deposits / obligations catching up) decays the accumulator, so transient blips self-heal and
// only a sustained, unmatched erosion crosses the floor. All inputs are real (census USD + decoded base outflow).
function solvencyStep(state, surplus, netOut, cap) {
  const prev = state && state.lastSurplus != null ? state.lastSurplus : null;
  let accum = (state && state.accum) || 0, contribution = 0;
  if (prev != null && Number.isFinite(surplus)) {
    const d = surplus - prev;                                   // <0 = buffer dropped this interval
    if (d < 0 && netOut > 0) contribution = Math.min(netOut, -d);
    accum = Math.max(0, accum + contribution);
    if (d > 0) accum = Math.max(0, accum - d);                  // recovery decays the accumulator
  }
  if (cap && cap > 0) accum = Math.min(accum, cap);
  return { accum, lastSurplus: Number.isFinite(surplus) ? surplus : prev, contribution };
}

function describe(m) {
  const usdGap = Math.round(Math.abs((m.basketSumSizeUsd || 0) - (m.marketCollectiveSizeUsd || 0)));
  const acct = String(m.marketAccount || "").slice(0, 6);
  return `${m.pool}/${m.market} ${m.side} — baskets ${m.basketPositions} vs market ${m.marketOpenPositions} positions (posDiff ${m.posDiff}, ~$${usdGap} size gap) · ${acct}…`;
}

module.exports = { fetchReconciliation, fetchCensusFull, parseReconciliation, parseInvariants, diffMismatches, seed, solvencyStep, describe, CENSUS_URL };
