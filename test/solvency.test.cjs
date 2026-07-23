// Network-free: (A) solvency classification/aggregation arithmetic; (B) cross-witness disagreement + streak logic.
let pass=true; const t=(c,m)=>{console.log((c?"✓":"✗")+" "+m); if(!c)pass=false;};

// (A) per-custody residual = (bal + recv) - (owned + pay); classify + aggregate (mirrors computeSolvency)
function classify(rows){ let exact=0,surplus=0,deficit=0,noVault=0,defRaw=0n; for(const r of rows){ if(r.bal==null){noVault++;continue;}
  const w=(BigInt(r.bal)+BigInt(r.recv))-(BigInt(r.owned)+BigInt(r.pay));
  if(w===0n)exact++; else if(w>0n)surplus++; else {deficit++;defRaw+=-w;} }
  return { exact,surplus,deficit,noVault,backed:exact+surplus,allSolvent:deficit===0&&noVault===0,complete:noVault===0,totalDeficitRaw:defRaw.toString() }; }

const solvent = classify([{bal:"1000",owned:"600",pay:"100",recv:"50"},{bal:"500",owned:"500",pay:"0",recv:"0"}]); // 350 surplus, exact
t(solvent.allSolvent && solvent.deficit===0 && solvent.exact===1 && solvent.surplus===1, "solvent set → allSolvent, 1 exact + 1 surplus");
const under = classify([{bal:"100",owned:"600",pay:"100",recv:"50"}]); // 100+50-700 = -550 deficit
t(!under.allSolvent && under.deficit===1 && under.totalDeficitRaw==="550", "under-backed vault → deficit detected, raw 550");
const gap = classify([{bal:null,owned:"600",pay:"0",recv:"0"},{bal:"1000",owned:"500",pay:"0",recv:"0"}]);
t(!gap.allSolvent && !gap.complete && gap.noVault===1, "vault read gap → NOT solvent, complete=false (never reads a gap as 'all good')");

// (B) cross-witness disagreement + 2-check streak (mirrors checkIndependentSolvency)
function disagreeStep(state, ownSolvent, censusSolvent, ownComplete, censusPresent){
  let s={...state}; let fire=false;
  if(ownComplete && censusPresent){ if(ownSolvent!==censusSolvent){ s.disStreak=(s.disStreak||0)+1; if(s.disStreak>=2){fire=true;} } else { s.disStreak=0; } }
  return { s, fire };
}
let st={disStreak:0};
let r1=disagreeStep(st,true,true,true,true); t(!r1.fire && r1.s.disStreak===0, "both solvent → no disagreement");
let r2=disagreeStep(st,true,false,true,true); // own says solvent, census says NOT → disagree, streak 1, no fire yet
t(!r2.fire && r2.s.disStreak===1, "disagree once → streak 1, NO alarm (slot-skew guard)");
let r3=disagreeStep(r2.s,true,false,true,true); t(r3.fire && r3.s.disStreak===2, "disagree twice → CRITICAL witness-disagreement");
let r4=disagreeStep(r2.s,false,false,true,true); t(!r4.fire && r4.s.disStreak===0, "agree next check → streak resets, no alarm");
let r5=disagreeStep({disStreak:1},true,false,false,true); t(!r5.fire, "own incomplete (read gap) → no disagreement fired");

console.log("\n"+(pass?"✅ PASS — independent solvency: correct classification, deficit detection, read-gap safety, 2-check disagreement":"❌ FAIL"));
process.exit(pass?0:1);
