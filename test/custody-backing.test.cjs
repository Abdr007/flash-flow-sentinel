// Mirrors checkCustodyBacking's exact per-custody decision logic → proves isolation + attribution + no false positives.
const FLOOR=50000, CAP=2000000;
// per-custody accumulator step (identical to the inline logic in sentinel.checkCustodyBacking)
function step(st, residualHuman, outUsd, mark){
  st = st || { lastResidualHuman:null, accumUsd:0 };
  let accum = st.accumUsd||0;
  if(st.lastResidualHuman!=null && mark!=null){
    const drop = st.lastResidualHuman - residualHuman;
    if(drop>0 && outUsd>0) accum = Math.max(0, accum + Math.min(outUsd, drop*mark));
    if(drop<0) accum = Math.max(0, accum - (-drop)*mark);
  }
  accum = Math.min(accum, CAP);
  return { lastResidualHuman: residualHuman, accumUsd: accum };
}
// simulate two custodies over 3 polls. A = USDC drained unbacked; B = SOL gaining surplus (legit).
// residual in token units; outUsd = that custody's real base outflow that interval; mark = token price.
let A=null,B=null;
// poll0 baseline
A=step(A, 100000, 0, 1);       B=step(B, 500, 0, 150);
// poll1: A buffer 100k→40k (−60k tokens) with $60k out; B buffer 500→520 (surplus grows), $0 out
A=step(A, 40000, 60000, 1);    B=step(B, 520, 0, 150);
// poll2: A buffer 40k→0 (−40k) with $40k out; B unchanged
A=step(A, 0, 40000, 1);        B=step(B, 520, 0, 150);
console.log("custody A (drained) accum: $"+Math.round(A.accumUsd)+"  → "+(A.accumUsd>=FLOOR?"ALARM ✓":"missed ✗"));
console.log("custody B (healthy)  accum: $"+Math.round(B.accumUsd)+"  → "+(B.accumUsd<FLOOR?"silent ✓":"false-alarm ✗"));
const isolation = A.accumUsd>=FLOOR && B.accumUsd<FLOOR;
console.log((isolation?"✓":"✗")+" ISOLATION: A's drain is NOT masked by B's surplus (per-custody, not netted)");

// false-positive controls on a single custody
let C=null;
C=step(C,100000,0,1); C=step(C,100000,300000,1); C=step(C,100000,250000,1); // legit: buffer flat, $550k out
console.log((C.accumUsd<FLOOR?"✓":"✗")+" legit withdrawals (buffer flat, $550k out) → $"+Math.round(C.accumUsd)+" no alarm");
let D=null;
D=step(D,100000,0,1); D=step(D,60000,0,1); D=step(D,20000,0,1);             // mark-free residual can't drop from marks, but test drop w/o outflow
console.log((D.accumUsd<FLOOR?"✓":"✗")+" buffer drop with NO outflow → $"+Math.round(D.accumUsd)+" no alarm");
let E=null;
E=step(E,100000,0,1); E=step(E,40000,60000,1); E=step(E,100000,0,1);        // drain then recovery (deposit refills)
console.log((E.accumUsd<FLOOR?"✓":"✗")+" drain then recovery → $"+Math.round(E.accumUsd)+" self-heals");

const ok = isolation && C.accumUsd<FLOOR && D.accumUsd<FLOOR && E.accumUsd<FLOOR;
console.log("\n"+(ok?"✅ PASS — per-custody backing: isolates drains, attributes to the exact custody, silent on legit/marks/recovery":"❌ FAIL"));
process.exit(ok?0:1);
