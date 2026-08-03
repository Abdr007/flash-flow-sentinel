"use strict";
// ---------------------------------------------------------------------------------------------
// Unbacked-outflow reconciliation — settlement-lag safe.
//
// WHAT IT MEASURES
// A custody's "backing buffer" (the census `withdrawableResidual`) is, in raw token units:
//     residual = (vault + trade_receivable) − (owned + trade_payable)
// i.e. how much the vault holds ABOVE everything the protocol owes out of it. An over-withdrawal
// is the one event that moves real tokens out WITHOUT the obligations falling to match, so it —
// and essentially only it — lowers the SETTLED level of that buffer.
//
// WHY THE PREVIOUS PER-POLL ACCUMULATOR WAS WRONG  (false positive, 2026-08-03)
// Flash V2 withdrawals are TWO-LEG ACROSS TWO CLOCKS. The custody account is delegated, so its
// accounting (owned / payable / receivable) updates INSTANTLY on the MagicBlock ER; the SPL vault
// transfer lands LATER on base chain in the `*Settle` crank. Between the legs the buffer is
// therefore NOT flat — it RISES on leg 1 (obligations already gone, tokens still there) and FALLS
// BACK on leg 2 (tokens leave). A deposit does the same thing inverted: dip, then recover.
//
// The old code stepped the buffer per poll and floored the running total at zero:
//     if (drop > 0 && outUsd > 0) accum = Math.max(0, accum + Math.min(outUsd, drop * mark));
//     if (drop < 0)               accum = Math.max(0, accum - (-drop) * mark);
// Leg 1 is a rise, so it hit `Math.max(0, 0 − W)` = 0 and the offsetting credit was DISCARDED;
// leg 2 was a drop paired with real outflow, so it added the FULL withdrawal. Net buffer change
// across both legs was zero, yet the accumulator gained the entire amount — and never decayed.
// One entitled $66,768.90 `RemoveLiquiditySettle` LP redemption on Governance.1/USDC was reported
// as "$66,760 unbacked". The accumulator was ranking custodies by settlement volume, not by drain.
//
// THE FIX
// Never rectify per-poll deltas. Compare the buffer's SETTLED level now against its SETTLED level
// one window ago, taking the MEDIAN of the window's oldest and newest quarters. A median ignores
// transient settlement excursions in BOTH directions because those last a few polls, not a
// quarter-window — so the two-leg swing cannot register at all. A genuine over-withdrawal moves
// the settled level PERMANENTLY, which is exactly what a median does see.
//
// The result is bounded by the real money that actually left the custody over the SAME window:
// a buffer decline with no outflow is an accounting move, not a drain; an outflow with no decline
// is an ordinary entitled withdrawal. Both must be present, and the answer is the smaller of the
// two — so the reported figure can never exceed what actually left.
//
// SENSITIVITY (stated rather than assumed): the two medians sit at the CENTRES of the end-segments, which
// are 3/4 of a window apart. A step change — what an over-withdrawal actually looks like — is measured
// EXACTLY; a perfectly linear ramp reads ~3/4 of its true decline. The result is never scaled up to
// compensate: after a false positive of this kind, under-reading is the correct bias, and the figure stays
// something that actually left rather than something extrapolated.
//
// DETECTION LATENCY (stated honestly): the newest-quarter median turns over after ~half a quarter,
// so a real drain surfaces ~45min after the fact on the default 6h window, and stays visible for
// the ~4.5h it takes the drain to reach the oldest quarter. This detector is the slow EROSION
// warning — the fast proofs (census vault deficit, the sentinel's own independent recompute, and
// Layer-3 per-wallet entitlement) are the ones that fire immediately.
// ---------------------------------------------------------------------------------------------

const DEFAULT_WINDOW_S = 21600;   // 6h of buffer history per series
const DEFAULT_SAMPLE_GAP_S = 300; // keep at most one sample / 5min → bounded state
const DEFAULT_MIN_SEGMENT = 5;    // samples required in EACH end-segment before a median is trusted
const DEFAULT_MIN_SAMPLES = 12;   // total samples required — guards a sparse/gappy series
const DEFAULT_MIN_COVERAGE = 0.9; // fraction of the window the samples must actually span

function median(a) {
  if (!a.length) return null;
  const v = a.slice().sort((x, y) => x - y);
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Append a buffer observation. Subsampled to `gapS` and monotonic in time, so a fast poll loop,
 *  a repeated census snapshot, or a clock that jumps backwards cannot distort the series. */
function pushSample(st, t, value, gapS = DEFAULT_SAMPLE_GAP_S) {
  if (!st) st = {};
  if (!Array.isArray(st.s)) st.s = [];
  if (!Number.isFinite(t) || !Number.isFinite(value)) return st;
  const last = st.s[st.s.length - 1];
  if (last && t - last[0] < gapS) return st; // too soon → the series stays evenly spaced
  st.s.push([t, value]);
  return st;
}

/** Drop observations older than the window. */
function prune(st, t, windowS = DEFAULT_WINDOW_S) {
  if (!st || !Array.isArray(st.s)) return st;
  const cut = t - windowS;
  let i = 0;
  while (i < st.s.length && st.s[i][0] < cut) i++;
  if (i) st.s = st.s.slice(i);
  return st;
}

/** Settled-level comparison over the window. Returns `ready:false` (and 0) whenever the series is
 *  too short, too sparse, or doesn't yet span the window — never alarm while blind. */
function evaluate(st, opts) {
  const o = opts || {};
  const t = o.now;
  const windowS = o.windowS || DEFAULT_WINDOW_S;
  const mark = o.mark;
  const netOutUsd = o.netOutUsd;
  const minSegment = o.minSegment || DEFAULT_MIN_SEGMENT;
  const minSamples = o.minSamples || DEFAULT_MIN_SAMPLES;
  const minCoverage = o.minCoverage || DEFAULT_MIN_COVERAGE;

  const s = st && Array.isArray(st.s) ? st.s : [];
  const out = {
    ready: false, reason: "warming-up", unbackedUsd: 0,
    baseline: null, current: null, decline: 0,
    coverageS: 0, samples: s.length, netOutUsd: Number.isFinite(netOutUsd) ? netOutUsd : 0,
  };
  if (s.length < minSamples) return out;

  const span = s[s.length - 1][0] - s[0][0];
  out.coverageS = span;
  if (span < windowS * minCoverage) return out;               // not a full window of history yet
  if (!Number.isFinite(mark) || mark <= 0) { out.reason = "no-mark"; return out; }

  const q = windowS / 4;
  const first = s[0][0], last = s[s.length - 1][0];
  const oldSeg = s.filter((p) => p[0] <= first + q).map((p) => p[1]);
  const newSeg = s.filter((p) => p[0] >= last - q).map((p) => p[1]);
  if (oldSeg.length < minSegment || newSeg.length < minSegment) { out.reason = "thin-segments"; return out; }

  const baseline = median(oldSeg), current = median(newSeg);
  const decline = baseline - current;                          // >0 = the SETTLED buffer level fell
  out.ready = true; out.reason = "ok";
  out.baseline = baseline; out.current = current; out.decline = decline;
  // Both conditions required, and the smaller bound wins: the figure can never exceed either the
  // real decline in backing or the real money that left.
  out.unbackedUsd = decline > 0 && netOutUsd > 0 ? Math.min(netOutUsd, decline * mark) : 0;
  if (o.cap && o.cap > 0) out.unbackedUsd = Math.min(out.unbackedUsd, o.cap);
  return out;
}

/** Migrate a persisted entry written by the old rectified accumulator. Its `accumUsd` is not
 *  recoverable into the new representation (it was a sum of down-moves, not a level), so it is
 *  dropped and the series rebuilds — a clean warm-up beats carrying a wrong number forward. */
function migrate(st) {
  if (!st || typeof st !== "object") return { s: [] };
  if (st.accumUsd !== undefined || st.lastResidualHuman !== undefined || st.lastSurplus !== undefined) {
    delete st.accumUsd; delete st.lastResidualHuman; delete st.lastAt;
    delete st.accum; delete st.lastSurplus;
  }
  if (!Array.isArray(st.s)) st.s = [];
  return st;
}

module.exports = {
  pushSample, prune, evaluate, migrate, median,
  DEFAULT_WINDOW_S, DEFAULT_SAMPLE_GAP_S, DEFAULT_MIN_SEGMENT, DEFAULT_MIN_SAMPLES, DEFAULT_MIN_COVERAGE,
};
