// Coarse protocol-wide solvency-buffer watch (the FALLBACK when per-custody census data is absent).
// Same settled-level comparison as the per-custody layer, run over one USD series instead of many.
// Imports the REAL implementation — the buggy `reconwatch.solvencyStep` this used to exercise was
// removed on 2026-08-03; see lib/backing.cjs for why.
const backing = require("../lib/backing.cjs");

const FLOOR = 50000, CAP = 2000000, GAP = backing.DEFAULT_SAMPLE_GAP_S, WIN = backing.DEFAULT_WINDOW_S;
const N = WIN / GAP + 1, T0 = 1785000000;
let fails = 0;

// surplusUsd is already USD → mark = 1, exactly as checkSolvencyBuffer calls it.
function run(values, netOut) {
  let B = { s: [] };
  values.forEach((v, i) => { backing.pushSample(B, T0 + i * GAP, v, GAP); backing.prune(B, T0 + i * GAP, WIN); });
  return backing.evaluate(B, { now: T0 + (values.length - 1) * GAP, windowS: WIN, mark: 1, netOutUsd: netOut, cap: CAP });
}
const flat = (v, n = N) => Array.from({ length: n }, () => v);
const step = (a, b) => flat(a, Math.floor(N / 2)).concat(flat(b, N - Math.floor(N / 2)));
function check(name, cond, detail) {
  console.log((cond ? "✓" : "✗") + " " + name + (detail ? " — " + detail : ""));
  if (!cond) fails++;
}

// 1) UNBACKED DRAIN: the settled surplus falls and real money left → fires.
const drain = run(step(190000, 70000), 120000);
check("unbacked drain fires", drain.ready && drain.unbackedUsd >= FLOOR, `$${Math.round(drain.unbackedUsd)} (≥ floor)`);

// 2) LEGIT WITHDRAWALS: surplus flat, large outflow matched by obligations → silent.
check("legit withdrawals (buffer flat, $550k out) silent", run(flat(190000), 550000).unbackedUsd === 0);

// 3) MARKET MOVE: surplus falls but no tokens moved → silent.
check("market move (buffer down $130k, no tokens out) silent", run(step(190000, 60000), 0).unbackedUsd === 0);

// 4) TWO-LEG SETTLEMENT: the aggregate surplus swings up then back on an ordinary large withdrawal.
//    This is the shape that produced the 2026-08-03 false positive — must be silent.
for (const legPolls of [1, 2, 4, 8]) {
  const v = flat(190000);
  for (let i = 36; i < 36 + legPolls; i++) v[i] = 190000 + 66769;
  check(`two-leg settlement swing silent (${legPolls * 5}min in flight)`, run(v, 66769).unbackedUsd === 0);
}

// 5) RECOVERY: drain then genuine refill → self-heals.
check("drain then recovery self-heals",
  run(flat(190000, 20).concat(flat(120000, 20)).concat(flat(190000, N - 40)), 70000).unbackedUsd === 0);

// 6) BOUNDED: never reports more than the money that actually left.
check("bounded by real outflow", run(step(190000, 70000), 15000).unbackedUsd === 15000);

// 7) NEVER ALARM WHILE BLIND.
const cold = run(step(190000, 70000).slice(0, 20), 120000);
check("partial window → not ready, reports 0", !cold.ready && cold.unbackedUsd === 0, cold.reason);

// 8) The removed buggy accumulator must stay removed.
check("reconwatch no longer exports the rectified accumulator",
  require("../lib/reconwatch.cjs").solvencyStep === undefined);

console.log("\n" + (fails === 0
  ? "✅ PASS — solvency buffer: fires on a genuine unbacked drain, silent on legit withdrawals / market moves / two-leg settlement / recovery"
  : `❌ FAIL — ${fails} check(s) failed`));
process.exit(fails === 0 ? 0 : 1);
