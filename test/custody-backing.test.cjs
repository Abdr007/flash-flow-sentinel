// Per-custody unbacked-outflow reconciliation.
//
// This test imports the REAL implementation (lib/backing.cjs). The previous version of this file
// re-implemented the accumulator inline, so it validated a copy of the logic rather than the logic
// itself — which is why it stayed green through the 2026-08-03 false positive. Do not reintroduce a
// local copy of the math here.
const backing = require("../lib/backing.cjs");

const FLOOR = 50000, CAP = 2000000, GAP = backing.DEFAULT_SAMPLE_GAP_S, WIN = backing.DEFAULT_WINDOW_S;
const N = WIN / GAP + 1;            // 73 samples = exactly one full 6h window at 5min spacing
const T0 = 1785000000;
let fails = 0;

/** Feed a residual series through the real push/prune/evaluate path, exactly as checkCustodyBacking does. */
function run(values, netOutUsd, mark) {
  let st = { s: [] };
  values.forEach((v, i) => { backing.pushSample(st, T0 + i * GAP, v, GAP); backing.prune(st, T0 + i * GAP, WIN); });
  return backing.evaluate(st, { now: T0 + (values.length - 1) * GAP, windowS: WIN, mark, netOutUsd, cap: CAP });
}
const flat = (v, n = N) => Array.from({ length: n }, () => v);
function check(name, cond, detail) {
  console.log((cond ? "✓" : "✗") + " " + name + (detail ? " — " + detail : ""));
  if (!cond) fails++;
}

// ── 1. REGRESSION: the exact 2026-08-03 false positive ───────────────────────────────────────────
// Governance.1/USDC, real numbers. An entitled LP redemption settles in two legs across two clocks:
// leg 1 on the ER removes the obligation (buffer RISES by the full amount), leg 2 on base chain moves
// the tokens (buffer falls back). Real sig 1RzSNUaz… RemoveLiquiditySettle, $66,768.90, verified
// on-chain as 284,637.82 LP tokens surrendered in the same atomic transaction.
const BASE = 18067.130164, W = 66776.557476, MARK = 0.9998853, OUT = 66768.8982048575;
for (const legPolls of [1, 2, 4, 8]) {   // settlement in flight for 5 / 10 / 20 / 40 minutes
  for (const where of ["old-quarter", "middle", "new-quarter"]) {
    const v = flat(BASE);
    const at = where === "old-quarter" ? 4 : where === "middle" ? Math.floor(N / 2) : N - legPolls - 1;
    for (let i = at; i < at + legPolls; i++) v[i] = BASE + W;   // in-flight: obligation gone, tokens still there
    const r = run(v, OUT, MARK);
    check(`entitled two-leg LP redemption silent (${legPolls * 5}min in flight, ${where})`,
      r.ready && r.unbackedUsd === 0, `$${Math.round(r.unbackedUsd)} unbacked`);
  }
}
// The same swing under the OLD logic produced the full withdrawal amount — assert we are nowhere near it.
const regress = run((() => { const v = flat(BASE); v[36] = BASE + W; v[37] = BASE + W; return v; })(), OUT, MARK);
check("regression: reported figure is not the withdrawal amount",
  regress.unbackedUsd < 1 && OUT > FLOOR, `$${Math.round(regress.unbackedUsd)} vs the $${Math.round(OUT)} the old accumulator reported`);

// ── 2. DETECTION PRESERVED: a real over-withdrawal still fires ────────────────────────────────────
// The settled level drops PERMANENTLY (that is what an over-withdrawal does) and real tokens left.
const drained = run(flat(100000, Math.floor(N / 2)).concat(flat(40000, N - Math.floor(N / 2))), 60000, 1);
check("real over-withdrawal detected", drained.ready && drained.unbackedUsd >= FLOOR,
  `$${Math.round(drained.unbackedUsd)} unbacked (buffer ${drained.baseline} → ${drained.current})`);

// A slow drip that never spikes in any single poll is still caught, because the LEVEL is what's compared.
const drip = run(Array.from({ length: N }, (_, i) => 100000 - i * 1200), 90000, 1);
check("slow drip detected (no single poll exceeds the floor)", drip.ready && drip.unbackedUsd >= FLOOR,
  `$${Math.round(drip.unbackedUsd)} unbacked`);

// Sensitivity, stated rather than assumed: the two medians sit at the CENTRES of the end-segments, which are
// 3/4 of a window apart. A step drain (what an over-withdrawal actually looks like) is therefore measured
// EXACTLY, while a perfectly linear ramp reads ~3/4 of its true decline. Under-reading is the deliberate bias.
check("step drain measured exactly", Math.abs(drained.unbackedUsd - 60000) < 1, `$${Math.round(drained.unbackedUsd)} of $60,000`);
const ramp = run(Array.from({ length: N }, (_, i) => 100000 - i * 1000), 1e9, 1); // 72,000 true decline
check("linear ramp under-reads by the documented 3/4 factor (never over-reads)",
  ramp.unbackedUsd > 0 && ramp.unbackedUsd <= 72000 && Math.abs(ramp.unbackedUsd - 54000) < 1,
  `$${Math.round(ramp.unbackedUsd)} of $72,000 true`);

// ── 3. ISOLATION: one custody's drain is never masked by another's surplus ────────────────────────
const gaining = run(flat(500, Math.floor(N / 2)).concat(flat(520, N - Math.floor(N / 2))), 0, 150);
check("healthy custody silent while another is drained", gaining.unbackedUsd === 0 && drained.unbackedUsd >= FLOOR,
  "per-custody, never netted");

// ── 4. FALSE-POSITIVE CONTROLS ───────────────────────────────────────────────────────────────────
check("flat buffer + heavy entitled outflow → silent", run(flat(100000), 550000, 1).unbackedUsd === 0);
check("buffer drop with NO outflow (accounting move) → silent",
  run(flat(100000, Math.floor(N / 2)).concat(flat(20000, N - Math.floor(N / 2))), 0, 1).unbackedUsd === 0);
check("deposit two-leg dip (buffer dips then recovers) → silent",
  run((() => { const v = flat(BASE); v[36] = BASE - W; v[37] = BASE - W; return v; })(), 0, MARK).unbackedUsd === 0);
const recovered = run(flat(100000, 20).concat(flat(40000, 20)).concat(flat(100000, N - 40)), 60000, 1);
check("drain then genuine recovery → self-heals", recovered.unbackedUsd === 0, `$${Math.round(recovered.unbackedUsd)}`);
check("reported figure never exceeds the money that actually left",
  run(flat(100000, Math.floor(N / 2)).concat(flat(40000, N - Math.floor(N / 2))), 5000, 1).unbackedUsd === 5000,
  "bounded by real outflow");

// ── 5. NEVER ALARM WHILE BLIND ───────────────────────────────────────────────────────────────────
check("too few samples → not ready, reports 0", (() => { const r = run(flat(100000, 10).concat(flat(20000, 5)), 60000, 1); return !r.ready && r.unbackedUsd === 0; })());
const partial = run(flat(100000, 20).concat(flat(20000, 20)), 60000, 1);
check("window not yet spanned → not ready, reports 0", !partial.ready && partial.unbackedUsd === 0, partial.reason);
check("missing mark → not ready, reports 0", (() => { const r = run(flat(100000, Math.floor(N / 2)).concat(flat(20000, N - Math.floor(N / 2))), 60000, null); return !r.ready && r.unbackedUsd === 0; })(), "no-mark");

// ── 6. STATE HYGIENE ─────────────────────────────────────────────────────────────────────────────
const migrated = backing.migrate({ lastResidualHuman: 18067.13, lastAt: T0, accumUsd: 66760 });
check("old rectified-accumulator state is dropped on migrate",
  migrated.accumUsd === undefined && migrated.lastResidualHuman === undefined && Array.isArray(migrated.s));
const bounded = (() => { let st = { s: [] }; for (let i = 0; i < N * 4; i++) { backing.pushSample(st, T0 + i * GAP, 100, GAP); backing.prune(st, T0 + i * GAP, WIN); } return st.s.length; })();
check("sample series stays bounded to the window", bounded <= N + 1, `${bounded} samples retained`);
const subsampled = (() => { let st = { s: [] }; for (let i = 0; i < 100; i++) backing.pushSample(st, T0 + i * 60, 100, GAP); return st.s.length; })();
check("fast polling is subsampled, not stacked", subsampled <= 21, `${subsampled} samples from 100 polls`);

console.log("\n" + (fails === 0
  ? "✅ PASS — per-custody backing: entitled two-leg settlement is silent, real over-withdrawals still fire, blind states report nothing"
  : `❌ FAIL — ${fails} check(s) failed`));
process.exit(fails === 0 ? 0 : 1);
