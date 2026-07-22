"use strict";
/*
 * Entitlement-guard test — drives the REAL evaluate() → ruleStates() pipeline (no mocked `ev`) with the
 * actual on-chain amounts from the 2026-07-21 exploit, plus two legitimate-withdrawal controls that MUST
 * NOT trip. Amounts are the documented real flows, not synthetic filler.
 */
const assert = require("assert");
const { evaluate, ruleStates, DEFAULT_LIMITS } = require("../lib/limits.cjs");

const NOW = 1_753_120_000; // fixed unix ts (no Date.now — deterministic)
const t = (secAgo) => NOW - secAgo;

// one event = one real vault flow. custody left as a throwaway key (token agg not under test here).
const ev = (dir, wallet, usd, secAgo) => ({
  direction: dir, wallet, usd, amount: usd, symbol: "USDC", pool: "Flash", custody: "CUST_USDC",
  blockTime: t(secAgo), deltaRaw: "0", ix: [],
});

const events = [
  // ── the attacker (BjqHB51…) — deposited $1, then withdrew $97,988.52 ~90s later ──
  ev("in", "ATTACKER_BjqHB51", 1.0, 210),
  ev("out", "ATTACKER_BjqHB51", 97988.52, 120),
  // ── control A: legit LP — deposited $50k, withdrew $50k (ratio 1×) ──
  ev("in", "LEGIT_LP", 50000, 900),
  ev("out", "LEGIT_LP", 50000, 300),
  // ── control B: legit trader withdrawing OLD funds — big withdrawal, NO recent deposit (in24h = 0) ──
  ev("out", "LEGIT_OLD", 30000, 200),
  // ── control C: legit profit — deposited $2k, withdrew $2.4k (1.2× — real gains, under 50×) ──
  ev("in", "LEGIT_PROFIT", 2000, 800),
  ev("out", "LEGIT_PROFIT", 2400, 250),
  // ── the EVASIVE variant: withdraws $12k on a $100 deposit (120×) but stays UNDER the per-wallet cap
  //    and triggers no other signal → entitlement is the ONLY thing that can catch it. MUST fire standalone.
  ev("in", "EVASIVE", 100, 700),
  ev("out", "EVASIVE", 12000, 150),
];

const cfg = { ...DEFAULT_LIMITS, watchWallets: [] };
const pyth = { prices: {}, feeds: {} };
const out = evaluate(NOW, events, [], [], {}, {}, {}, {}, pyth, cfg, null);
const rules = ruleStates(out);

console.log("=== per-wallet flow the engine reconstructed ===");
for (const w of out.wallets) console.log(`  ${w.wallet.padEnd(20)} in24h $${String(w.in24hUsd).padStart(9)}  out24h $${String(w.out24hUsd).padStart(10)}`);

console.log("\n=== rules fired ===");
const fired = Object.entries(rules).filter(([k, v]) => v.status === "breach" || v.status === "warn");
for (const [k, v] of fired) console.log(`  [${v.severity || v.status}] ${k}\n     ${v.detail}`);

// ── assertions ──
// (1) The attacker is caught as CRITICAL. Because the $98k ALSO breaches the per-wallet cap, the composite
//     folds the entitlement signal into one louder `threat:` alert — either way it's a CRITICAL that names
//     the deposit-multiple. Accept whichever key fired.
const atk = rules["entitlement:ATTACKER_BjqHB51"] || rules["threat:ATTACKER_BjqHB51"];
assert(atk, "attacker MUST raise a CRITICAL (entitlement or folded composite)");
assert.strictEqual(atk.severity, "critical", "attacker alert must be CRITICAL");
assert(/its deposit|more out than in/.test(atk.detail), "detail must cite the withdrawal-vs-deposit multiple");

// (2) The EVASIVE variant (under the cap, no other signal) MUST be caught by the STANDALONE entitlement rule
//     — this is the case nothing else in the engine can see.
const evz = rules["entitlement:EVASIVE"];
assert(evz, "entitlement guard MUST fire standalone on the evasive under-the-cap over-withdrawal");
assert.strictEqual(evz.severity, "critical", "evasive entitlement must be CRITICAL");
assert(/120/.test(evz.detail), "detail must cite the 120× multiple");

// (3) No false positives on any legit withdrawal shape.
assert(!rules["entitlement:LEGIT_LP"], "must NOT fire on a 1× deposit/withdraw round-trip");
assert(!rules["entitlement:LEGIT_OLD"], "must NOT fire on a legit withdrawal of old funds (no recent deposit)");
assert(!rules["entitlement:LEGIT_PROFIT"], "must NOT fire on legit 1.2× trading profit");

console.log("\n✅ PASS — entitlement guard: CRITICAL on the real exploit AND the evasive under-cap variant; silent on all 3 legit controls.");
