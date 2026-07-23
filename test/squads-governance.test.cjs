// Network-free: proves the governance watch fires CRITICAL on a Squads upgrade-multisig takeover, silent otherwise.
const auth = require("../lib/authority.cjs");
const base = { upgradeAuthority:"dhfZwJfdesv7fNW3nngCSjeGbx9zWUusLtfPaWbVKvo", lastDeploySlot:434554588,
  upgradeControl:{model:"squads-multisig"},
  squadsMultisig:{ account:"Gb33UeQNnQ4XDuobtGq9M6PVKRVfoH77p8d6JXsgqyXF", threshold:3, registered:7,
    signers:["2mNoXT","5bdzVT","5xAoMY","8RKb8u","9NXhjB","DUDsso","PURmhz"].sort() } };
const clone = (x)=>JSON.parse(JSON.stringify(x));
let pass=true; const t=(c,m)=>{console.log((c?"✓":"✗")+" "+m); if(!c)pass=false;};

// unchanged → no alarm
t(auth.diffGovernance(base, clone(base)).length===0, "unchanged Squads 3-of-7 → 0 changes");
// threshold lowered → critical
const lo=clone(base); lo.squadsMultisig.threshold=1;
const d1=auth.diffGovernance(base,lo).find(x=>x.key==="gov:squads-threshold");
t(d1&&d1.severity==="critical", "threshold 3→1 → CRITICAL");
// member swapped → critical signer change
const sw=clone(base); sw.squadsMultisig.signers=["2mNoXT","5bdzVT","5xAoMY","8RKb8u","9NXhjB","DUDsso","HACKER0"].sort();
const d2=auth.diffGovernance(base,sw).find(x=>x.key==="gov:squads-signers");
t(d2&&d2.severity==="critical", "member swap → CRITICAL signer change");
// count change → critical
const add=clone(base); add.squadsMultisig.registered=8; add.squadsMultisig.signers=[...base.squadsMultisig.signers,"NEW0000"].sort();
t(auth.diffGovernance(base,add).some(x=>x.key==="gov:squads-count"&&x.severity==="critical"), "member count 7→8 → CRITICAL");
// fingerprint moves on squads change, stable otherwise
t(auth.fingerprintOf(base)===auth.fingerprintOf(clone(base)) && auth.fingerprintOf(base)!==auth.fingerprintOf(lo), "fingerprint stable/moves correctly");
// a failed squads read (undefined) must NOT masquerade as a change (section guard)
const noSq=clone(base); delete noSq.squadsMultisig;
t(!auth.diffGovernance(base,noSq).some(x=>x.key&&x.key.startsWith("gov:squads")), "missing squads read → no false change (section-guarded)");
console.log("\n"+(pass?"✅ PASS — Squads upgrade-multisig takeover watch":"❌ FAIL")); process.exit(pass?0:1);
