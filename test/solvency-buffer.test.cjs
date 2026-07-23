const { solvencyStep } = require("../lib/reconwatch.cjs");
const FLOOR=50000, CAP=2000000;
function run(steps){ let st={accum:0,lastSurplus:null}; for(const [surplus,netOut] of steps){ st=solvencyStep(st,surplus,netOut,CAP);} return st.accum; }
// baseline surplus 190k
// 1) UNBACKED DRAIN: surplus 190k→130k→70k while $60k+$60k leaves each interval → accum ~120k → ALARM
const drain = run([[190000,0],[130000,60000],[70000,60000]]);
console.log((drain>=FLOOR?"✓":"✗")+" unbacked drain accum=$"+Math.round(drain)+" (≥floor → ALARM)");
// 2) LEGIT WITHDRAWALS: surplus flat 190k, big outflow each interval (matched by obligations) → accum 0
const legit = run([[190000,0],[190000,300000],[190000,250000]]);
console.log((legit<FLOOR?"✓":"✗")+" legit withdrawals (buffer flat, $550k out) accum=$"+Math.round(legit)+" (no alarm)");
// 3) TRADERS WINNING (marks): surplus 190k→120k→60k, NO outflow → accum 0
const marks = run([[190000,0],[120000,0],[60000,0]]);
console.log((marks<FLOOR?"✓":"✗")+" market move (buffer down $130k, no tokens out) accum=$"+Math.round(marks)+" (no alarm)");
// 4) DRAIN THEN RECOVERY: drain accumulates, then deposits refill buffer → accum decays back down
const recov = run([[190000,0],[120000,70000],[190000,0]]);
console.log((recov<FLOOR?"✓":"✗")+" drain then buffer recovers accum=$"+Math.round(recov)+" (self-heals)");
// 5) MIXED: mark drop + legit withdrawal same interval (surplus down from marks, outflow legit) → bounded by min → below floor for modest marks
const mixed = run([[190000,0],[175000,40000]]); // surplus -15k (marks), $40k legit out → contributes min(40k,15k)=15k < floor
console.log((mixed<FLOOR?"✓":"✗")+" mixed small mark+withdrawal accum=$"+Math.round(mixed)+" (below floor, no alarm)");
const ok = drain>=FLOOR && legit<FLOOR && marks<FLOOR && recov<FLOOR && mixed<FLOOR;
console.log("\n"+(ok?"✅ PASS — solvency-buffer accumulator: fires on unbacked drain, silent on legit withdrawals / market moves / recovery":"❌ FAIL"));
process.exit(ok?0:1);
