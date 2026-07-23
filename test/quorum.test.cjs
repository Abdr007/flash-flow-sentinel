const q = require("../lib/quorum.cjs");
let pass=true; const t=(c,m)=>{console.log((c?"✓":"✗")+" "+m); if(!c)pass=false;};

// --- aggregateFact: the alarm-decision safety logic ---
const A=(readings)=>q.aggregateFact("f", readings.map((v,i)=>({provider:"p"+i, val:v})), x=>x);
// 0 providers responded (all rate-limited/down) → degraded, NEVER disagree/alarm
let f=A([]); t(f.degraded && !f.disagree && !f.agree, "0 responders → degraded, no alarm (production-safe)");
// 1 provider responded → degraded (can't judge a lone source), NEVER disagree
f=A(["X"]); t(f.degraded && !f.disagree, "1 responder → degraded, no disagreement (single source never alarms)");
// 2 agree → agree, no alarm
f=A(["X","X"]); t(f.agree && !f.disagree && !f.degraded, "2 agree → agree, no alarm");
// 2 disagree → disagree (this is the real signal)
f=A(["X","Y"]); t(f.disagree && !f.agree, "2 disagree → DISAGREEMENT flagged");
// 3 with one odd → disagree
f=A(["X","X","Y"]); t(f.disagree, "3 providers, one differs → DISAGREEMENT flagged");

// --- decodeUpgrade: offsets + Option handling ---
const mk=(slot,hasAuth)=>{ const b=Buffer.alloc(hasAuth?45:13); b.writeUInt32LE(3,0); b.writeBigUInt64LE(BigInt(slot),4); b[12]=hasAuth?1:0; if(hasAuth) Buffer.from("11223344556677889900aabbccddeeff00112233445566778899aabbccddeeff","hex").copy(b,13); return b.toString("base64"); };
let u=q.decodeUpgrade(mk(434554588,true)); t(u && u.slot===434554588 && typeof u.authority==="string" && u.authority.length>=32, "decodeUpgrade: slot + authority present");
let u2=q.decodeUpgrade(mk(999,false)); t(u2 && u2.slot===999 && u2.authority===null, "decodeUpgrade: Option=None → authority null (no false value)");

// --- decodeSquads: safety on garbage ---
t(q.decodeSquads(Buffer.alloc(20).toString("base64"))===null, "decodeSquads: garbage/short → null (never a fabricated threshold)");
t(q.decodeSquads(Buffer.alloc(200).toString("base64"))===null, "decodeSquads: wrong discriminator → null");

console.log("\n"+(pass?"✅ PASS — quorum: degradation-safe (no alarm without ≥2 responders), disagreement detected, decode safe":"❌ FAIL"));
process.exit(pass?0:1);
