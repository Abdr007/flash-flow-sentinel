"use strict";
// Layer 3 auto-containment — validated against REAL on-chain wallets (no synthetic data):
//   • the actual exploit wallet (proven over-withdrawal → WOULD contain)
//   • a real legitimate whale (full-history not provable / entitled → NEVER auto-contained)
// Run: node test/containment.test.cjs   (hits the MagicBlock mainnet RPC + the live sentinel for the vault set)
const containment = require("../lib/containment.cjs");
const RPC = process.env.RPC_URL || "https://rpc.magicblock.app/mainnet";
const STATE = process.env.STATE_URL || "https://flash-flow-sentinel.vercel.app/api/state";
const ATTACKER = "BjqHB51NRPLr4kCTrZyeqY6tehgACks3kx4kpGw3nWej"; // 2026-07-21 $1-in/$98k-out over-withdrawal
const WHALE = "3asNxk6XZzAGtmxmtzy4BSiGivVReHTVDSvo7xLgPkBW";    // legit active trader, $85k in / $85k out lifetime

async function rpc(m, p) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }), signal: AbortSignal.timeout(30000) });
  return r.json();
}

(async () => {
  const st = await (await fetch(STATE, { signal: AbortSignal.timeout(40000) })).json();
  const flashVaults = new Set((st.evaluation.tokens || []).map((t) => t.vault).filter(Boolean));
  if (!flashVaults.size) throw new Error("no Flash vault set from live state");
  const c = containment.cfg();
  let pass = 0, fail = 0;
  const check = (name, cond) => { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ FAIL: " + name); } };

  console.log(`\nAuto-containment proof — ${flashVaults.size} Flash vaults, thresholds ${JSON.stringify(c.thresholds || { minUsd: c.minUsd, ratio: c.ratio, scanLimit: c.scanLimit })}`);

  console.log("\n[attacker] must be PROVEN (over-withdrawal, full history visible):");
  const a = await containment.verifyDrain(ATTACKER, rpc, c, flashVaults);
  console.log(`  out=$${Math.round(a.lifetimeOut)} in=$${Math.round(a.lifetimeIn)} txs=${a.txCount} → proven=${a.proven}`);
  check("attacker proven", a.proven === true);
  check("attacker over-withdrew (out >> in)", a.lifetimeOut >= c.minUsd && a.lifetimeOut > c.ratio * a.lifetimeIn);
  check("attacker full history visible (not capped)", a.capped === false);

  console.log("\n[whale] must NEVER be auto-contained (real user):");
  const w = await containment.verifyDrain(WHALE, rpc, c, flashVaults);
  console.log(`  txs=${w.txCount} capped=${w.capped} → proven=${w.proven}`);
  check("whale NOT proven", w.proven === false);

  console.log(`\n${fail ? "❌" : "✅"} containment: ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("test error:", e.message); process.exit(1); });
