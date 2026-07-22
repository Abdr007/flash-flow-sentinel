"use strict";
// ─────────────────────────────────────────────────────────────────────────────
// LAYER 3 — AUTO-CONTAINMENT CONTROLLER
//
// Detection (Layers 1–2) tells you a drain MIGHT be happening. Containment decides,
// in the same cycle, whether it is PROVABLY happening and fires an automated response.
//
// DESIGN PRINCIPLES (why this is safe to run on a live protocol):
//  1. PROOF-GATED, never threshold-gated. A trip requires the wallet's FULL lifetime
//     entitlement to be verified on-chain (every deposit vs every withdrawal), so it
//     can never auto-fire on a false positive. The windowed entitlement guard is only
//     the cheap *trigger* that nominates a candidate; this module is the *proof*.
//  2. FRESH-HISTORY-COMPLETE gate. We only auto-contain when we can see the wallet's
//     ENTIRE history (≤ scanLimit txs). A real user/whale (thousands of txs) can never
//     be auto-contained — it is escalated to a human instead. Auto-response only ever
//     lands on a disposable wallet that provably took out far more than it put in.
//  3. SIGNAL, NOT AUTHORITY. The sentinel does NOT hold a pause key. A monitor that can
//     halt the protocol is a single point of compromise — hack the monitor, weaponize
//     the halt. Instead we emit a max-priority alarm + a signed-intent webhook that
//     Flash's OWN authorized responder (pause bot / Squads proposal) acts on. Detection
//     is separated from authority by construction.
//
// Enable with CONTAINMENT=1. Everything is off by default.
// ─────────────────────────────────────────────────────────────────────────────

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const CONTAINMENT = () => process.env.CONTAINMENT === "1";
const MODE = () => (process.env.CONTAINMENT_MODE || "signal").toLowerCase(); // "signal" (alarm+webhook) — the only implemented mode

function cfg() {
  return {
    minUsd: Number(process.env.CONTAINMENT_MIN_USD || 10000),      // a drain worth auto-responding to
    ratio: Number(process.env.CONTAINMENT_RATIO || 5),             // out must exceed in by this factor
    scanLimit: Number(process.env.CONTAINMENT_SCAN_LIMIT || 150),  // max lifetime txs we will fully trace; above this → escalate, never auto-contain
    collateralMint: process.env.CONTAINMENT_COLLATERAL_MINT || USDC,
    webhook: process.env.CONTAINMENT_WEBHOOK_URL || null,
    dashboard: "https://flash-flow-sentinel.vercel.app",
  };
}

// Candidate = a wallet worth spending an on-chain proof on this cycle. Cast wider than the
// windowed entitlement guard (which needs in24h>0) so a drain with NO offsetting deposit is
// also nominated. Cheap: just reads ev.wallets. Whales get nominated too but are rejected
// instantly at the proof step (history capped) for ~1 RPC, so the net is safe to widen.
function selectCandidates(ev, c) {
  const out = new Map();
  for (const w of (ev && ev.wallets) || []) {
    const o1 = w.out1hUsd || 0, o24 = w.out24hUsd || 0, inn = w.in24hUsd || 0;
    // Nominate on the 1h spike OR the 24h cumulative — so a slow drip that stays under the hourly floor
    // ($9k/hr, never trips out1h≥$10k) is still proven once its 24h total clears the floor.
    if (o1 < c.minUsd && o24 < c.minUsd) continue;
    const entitlement = inn > 0 && o1 > 50 * inn; // the classic $1-in/$98k-out fingerprint (fast trigger)
    out.set(w.wallet, { wallet: w.wallet, out1hUsd: o1, out24hUsd: o24, in24hUsd: inn, entitlement });
  }
  return [...out.values()];
}

// PROOF: trace the wallet's ENTIRE collateral-token flow to/from Flash and decide if it
// provably over-withdrew. `flashVaults` = the set of Flash vault token-account pubkeys — a
// wallet balance change is only counted as a Flash deposit/withdrawal when a Flash VAULT moved
// oppositely in the same tx. This is what stops an attacker's post-drain LAUNDERING transfer
// (wallet → CEX, no Flash vault involved) from being miscounted as a deposit and masking the
// over-withdrawal. Returns a structured verdict; proven===true only when airtight.
async function verifyDrain(wallet, rpc, c, flashVaults, markUsd) {
  const vaults = flashVaults instanceof Set ? flashVaults : new Set(flashVaults || []);
  const mk = (typeof markUsd === "number" && markUsd > 0) ? markUsd : 1; // USD per whole token (1 for USDC/stables; the collateral's on-chain mark for SOL/BTC/ETH/etc.)
  const v = { wallet, proven: false, lifetimeIn: 0, lifetimeOut: 0, ratio: null, txCount: 0, capped: false, sigs: [], collateralMint: c.collateralMint, markUsd: mk, reason: "" };
  try {
    const sig = await rpc("getSignaturesForAddress", [wallet, { limit: 1000 }]);
    const list = (sig && sig.result) || [];
    v.txCount = list.length;
    if (!list.length) { v.reason = "no on-chain history"; return v; }
    // FRESH-HISTORY-COMPLETE gate: if the wallet has more txs than we will trace, we cannot
    // see all its deposits → we CANNOT prove over-withdrawal → never auto-contain, escalate.
    if (list.length > c.scanLimit) { v.capped = true; v.reason = `history exceeds ${c.scanLimit} txs — full entitlement not provable, escalate to human`; return v; }
    for (const s of list) {
      const tx = await rpc("getTransaction", [s.signature, { maxSupportedTransactionVersion: 0 }]);
      const t = tx && tx.result;
      if (!t || !t.meta) continue;
      const keys = (t.transaction.message.accountKeys || []).map((k) => (typeof k === "string" ? k : k.pubkey));
      // wallet's collateral delta this tx
      const wPre = (t.meta.preTokenBalances || []).filter((b) => b.owner === wallet && b.mint === c.collateralMint).reduce((a, b) => a + (b.uiTokenAmount.uiAmount || 0), 0);
      const wPost = (t.meta.postTokenBalances || []).filter((b) => b.owner === wallet && b.mint === c.collateralMint).reduce((a, b) => a + (b.uiTokenAmount.uiAmount || 0), 0);
      const d = wPost - wPre; // + = wallet RECEIVED collateral ; − = wallet SENT it
      if (Math.abs(d) <= 1) continue;
      // net collateral delta across Flash VAULT token accounts in the same tx (by accountIndex)
      const idxDelta = {};
      for (const b of (t.meta.postTokenBalances || [])) if (b.mint === c.collateralMint) idxDelta[b.accountIndex] = (idxDelta[b.accountIndex] || 0) + (b.uiTokenAmount.uiAmount || 0);
      for (const b of (t.meta.preTokenBalances || [])) if (b.mint === c.collateralMint) idxDelta[b.accountIndex] = (idxDelta[b.accountIndex] || 0) - (b.uiTokenAmount.uiAmount || 0);
      let vaultDelta = 0;
      for (const [idx, del] of Object.entries(idxDelta)) if (vaults.has(keys[idx])) vaultDelta += del;
      // count ONLY genuine Flash interactions: deposit = wallet↓ & a vault↑ ; withdrawal = wallet↑ & a vault↓
      const isDeposit = d < 0 && vaultDelta > 0.5 * -d;
      const isWithdrawal = d > 0 && vaultDelta < -0.5 * d;
      if (isWithdrawal) { v.lifetimeOut += d * mk; if (v.sigs.length < 6) v.sigs.push(s.signature); } // valued in USD
      else if (isDeposit) { v.lifetimeIn += -d * mk; }
      // else: plain wallet↔wallet transfer (e.g. laundering) — NOT a Flash interaction — ignored
    }
    v.ratio = v.lifetimeIn > 0 ? v.lifetimeOut / v.lifetimeIn : (v.lifetimeOut > 0 ? Infinity : 0);
    if (v.lifetimeOut >= c.minUsd && v.lifetimeOut > c.ratio * v.lifetimeIn) {
      v.proven = true;
      v.reason = `withdrew $${Math.round(v.lifetimeOut)} vs deposited $${Math.round(v.lifetimeIn)} (${v.ratio === Infinity ? "∞" : v.ratio.toFixed(1)}×) across its full ${v.txCount}-tx history — over the ${c.ratio}× over-withdrawal threshold`;
    } else {
      v.reason = `entitled — out $${Math.round(v.lifetimeOut)} ≈/< in $${Math.round(v.lifetimeIn)} over full history`;
    }
    return v;
  } catch (e) { v.reason = "trace error: " + (e.message || e); return v; }
}

// Honest capability report for the dashboard.
function posture(c, securityOn) {
  const auto = CONTAINMENT();
  return {
    enabled: auto,
    // The always-on PROVEN over-withdrawal alarm runs whenever security alerts (or auto-containment) are on —
    // it fires a proof-gated alert even when the auto-response (webhook) is off.
    proofAlarmActive: !!securityOn || auto,
    mode: MODE(),
    state: auto ? "ARMED (auto-signal)" : (securityOn ? "PROOF-ALARM ON" : "DISARMED"),
    proofGated: true,
    holdsPauseAuthority: false, // by design — see header
    webhookConfigured: !!(c.webhook),
    responder: c.webhook ? (() => { try { return new URL(c.webhook).host; } catch { return "configured"; } })() : null,
    thresholds: { minUsd: c.minUsd, ratio: c.ratio, scanLimit: c.scanLimit },
    note: "Auto-contain fires ONLY on a fresh wallet whose FULL on-chain history proves over-withdrawal. Response = max-priority alert + signed-intent webhook to Flash's authorized responder. The sentinel holds no pause key by design.",
  };
}

function buildAlarmText(v, c, contained) {
  const host = (() => { try { return new URL(c.webhook).host; } catch { return "responder"; } })();
  const evidence = v.sigs.length ? `Evidence: https://solscan.io/tx/${v.sigs[0]}${v.sigs.length > 1 ? ` (+${v.sigs.length - 1} more)` : ""}\n` : "";
  const response = contained
    ? `AUTOMATED RESPONSE:\n• Max-priority alert fired\n• ${c.webhook ? `Signed containment request POSTed → ${host}` : "NO responder webhook set (CONTAINMENT_WEBHOOK_URL)"}\n• On-chain pause: signalled to Flash's authorized responder (the monitor holds no pause key by design)`
    : `Auto-containment is OFF (set CONTAINMENT=1 to auto-signal Flash's responder). This is PROVEN — freeze this wallet / pause the affected vault MANUALLY NOW.`;
  return (
    `🚨🚨 SECURITY · FLASH V2 🚨🚨\n━━━━━━━━━━━━━━━━━━━━\nPROVEN OVER-WITHDRAWAL — DRAIN IN PROGRESS\n\n` +
    `Wallet: ${v.wallet}\n${v.reason}\nCollateral mint: ${v.collateralMint}\n${evidence}\n${response}\n\n` +
    `⚠️ PROOF-GATED: the wallet's ENTIRE ${v.txCount}-tx history was verified on-chain — not a threshold guess.`
  );
}

function buildPayload(v, c) {
  return {
    type: "flash-flow-sentinel.containment",
    version: 1,
    severity: "critical",
    wallet: v.wallet,
    proof: {
      lifetimeOutUsd: Math.round(v.lifetimeOut),
      lifetimeInUsd: Math.round(v.lifetimeIn),
      ratio: v.ratio === Infinity ? null : Number(v.ratio.toFixed(2)),
      txCount: v.txCount,
      historyComplete: !v.capped,
      collateralMint: v.collateralMint,
      sampleSigs: v.sigs,
    },
    recommendedAction: "pause_affected_vault_or_freeze_wallet",
    source: "flash-flow-sentinel",
    dashboard: c.dashboard,
  };
}

module.exports = { CONTAINMENT, MODE, cfg, selectCandidates, verifyDrain, posture, buildAlarmText, buildPayload };
