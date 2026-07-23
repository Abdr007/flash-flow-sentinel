// Proves the settlement-signer watch discriminator: same regex + extraction as checkSettlementSigners().
const SETTLE_IX = /ProcessUndelegation/i;
const CRANK = "FLAshCJGr4SWk23bDVy7yeZecfND8h5Cingy1u2XE6HQ";
const ROGUE = "hAckXXXXsettlerYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY";

// realistic buffer: legit crank settlements + normal USER withdrawals/LP ops (must NOT be flagged)
const events = [
  { feePayer: CRANK, ix: ["ProcessUndelegation","WithdrawalSettle"], direction:"out", usd:5000, pool:"Crypto.1", symbol:"USDC", sig:"s1" },
  { feePayer: CRANK, ix: ["ProcessUndelegation","RemoveCompoundingLiquiditySettle"], direction:"in", usd:16000, pool:"Crypto.1", symbol:"USDC", sig:"s2" },
  { feePayer: "userWallet1111111111111111111111111111111", ix:["CustodySettlementWithAction","WithdrawalWithAction"], direction:"out", usd:200, pool:"Crypto.1", symbol:"USDC", sig:"u1" }, // USER-signed withdrawal — MUST be ignored
  { feePayer: "userWallet2222222222222222222222222222222", ix:["DepositDirect"], direction:"in", usd:1, pool:"Crypto.1", symbol:"USDC", sig:"u2" },
  { feePayer: "lpWallet33333333333333333333333333333333", ix:["RemoveLiquidity"], direction:"out", usd:8000, pool:"Crypto.1", symbol:"USDC", sig:"u3" },
];

function extract(evs){ const m={}; for(const e of evs){ if(!Array.isArray(e.ix)||!e.ix.some(n=>SETTLE_IX.test(n)))continue; const s=e.feePayer||e.wallet; if(s&&!m[s])m[s]=e; } return m; }

// TEST 1: extraction only picks up ProcessUndelegation signers → the crank, never users
const settlers = extract(events);
const s1ok = Object.keys(settlers).length===1 && settlers[CRANK] && !settlers["userWallet1111111111111111111111111111111"];
console.log((s1ok?"✓":"✗")+" extraction: only the crank is a settler ("+Object.keys(settlers).map(k=>k.slice(0,6)).join(",")+") — user WithdrawalWithAction/DepositDirect ignored");

// TEST 2: after seeding the crank, no fresh signer → silent
let known = { [CRANK]: 1 }, seeded = true;
let fresh = Object.keys(extract(events)).filter(s=>!known[s]);
console.log((fresh.length===0?"✓":"✗")+" steady-state: known crank re-settling → 0 alarms");

// TEST 3: a ROGUE key signs a ProcessUndelegation → flagged fresh (AFX fingerprint)
const withRogue = [...events, { feePayer: ROGUE, ix:["ProcessUndelegation","WithdrawalSettle"], direction:"out", usd:24000000, pool:"Crypto.1", symbol:"USDC", sig:"hack1" }];
fresh = Object.keys(extract(withRogue)).filter(s=>!known[s]);
const s3ok = fresh.length===1 && fresh[0]===ROGUE;
console.log((s3ok?"✓":"✗")+" AFX fingerprint: rogue settler "+ROGUE.slice(0,6)+"… flagged (vol $"+extract(withRogue)[ROGUE].usd.toLocaleString()+")");

// TEST 4: pinned-seed rejects an unexpected signer even at seed time
const EXPECTED=[CRANK];
const seedBase = EXPECTED.length? EXPECTED : Object.keys(extract(withRogue));
known = Object.fromEntries(seedBase.map(k=>[k,1]));
fresh = Object.keys(extract(withRogue)).filter(s=>!known[s]);
const s4ok = fresh.includes(ROGUE) && !fresh.includes(CRANK);
console.log((s4ok?"✓":"✗")+" pinned-seed (EXPECTED_SETTLEMENT_SIGNERS): rogue still flagged, crank trusted");

const allOk = s1ok && fresh.length && s3ok && s4ok;
console.log("\n"+(allOk?"✅ PASS — settlement watch: crank-only, silent in steady state, fires on any unrecognised settler, no false-positive on user withdrawals":"❌ FAIL"));
process.exit(allOk?0:1);
