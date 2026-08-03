"use strict";
// Origin attribution for probe-cluster detection.
//
// WHY THIS EXISTS — the 2026-07-27 false positive:
// checkProbeCluster() used to call any account that merely PAID THE MOST LAMPORTS in a
// wallet's earliest transaction its "funder". On Flash V2 that is always the relayer
// (`21awFG…`), because Flash sponsors user fees and pays the rent to create each user's
// basket/ledger/ATA. The three wallets it flagged hold ZERO lamports and do not exist as
// on-chain accounts at all — nobody ever funded them. The alert's two "independent
// proofs" (fresh wallet + shared funder) were the same artifact counted twice: under
// sponsored fees, EVERY new user is low-tx-count AND shares one fee payer, by construction.
//
// A funder is an account that actually SENT THE WALLET SOL. A fee payer is not a funder.
// So attribution now requires proof of inbound lamports, and a shared fee payer with
// wide fan-out is classified as infrastructure rather than coordination.

// Normalise accountKeys across encodings (jsonParsed → {pubkey}, legacy → string).
function keysOf(t) {
  const k = (t && t.transaction && t.transaction.message && t.transaction.message.accountKeys) || [];
  return k.map((x) => (typeof x === "string" ? x : x && x.pubkey));
}

// Every instruction, top-level + inner (a transfer to the wallet is usually a CPI).
function allIxs(t) {
  const m = (t && t.transaction && t.transaction.message) || {};
  const inner = ((t && t.meta && t.meta.innerInstructions) || []).flatMap((i) => i.instructions || []);
  return [...(m.instructions || []), ...inner];
}

// Attribute a wallet's FUNDER from its earliest transaction.
// Returns { funder, sponsor, lamportsIn, reason }:
//   funder   — the account that provably sent this wallet SOL, else null
//   sponsor  — the fee payer (accountKeys[0]); recorded for context, never treated as a funder
//   reason   — why we did or did not attribute, so the log explains itself
function attributeFunder(t, wallet) {
  const sponsorOf = (ks) => ks[0] || null;
  if (!t || !t.meta || !t.transaction) return { funder: null, sponsor: null, lamportsIn: null, reason: "no-tx" };
  const keys = keysOf(t);
  const sponsor = sponsorOf(keys);
  const idx = keys.indexOf(wallet);
  if (idx < 0) return { funder: null, sponsor, lamportsIn: null, reason: "wallet-not-in-tx" };

  const pre = t.meta.preBalances || [], post = t.meta.postBalances || [];
  const lamportsIn = (post[idx] || 0) - (pre[idx] || 0);

  // PROOF GATE: no inbound SOL → this wallet was never funded here. A sponsored user whose
  // fees and account rent are paid by a relayer lands exactly here, which is the whole point.
  if (lamportsIn <= 0) return { funder: null, sponsor, lamportsIn, reason: "no-inbound-lamports" };

  // Prefer an explicit System transfer / account creation whose destination is the wallet.
  for (const ix of allIxs(t)) {
    const p = ix && ix.parsed;
    if (!p || !p.info) continue;
    const i = p.info;
    if ((p.type === "transfer" || p.type === "transferWithSeed") && i.destination === wallet && i.source && i.source !== wallet)
      return { funder: i.source, sponsor, lamportsIn, reason: "system-transfer" };
    if ((p.type === "createAccount" || p.type === "createAccountWithSeed") && i.newAccount === wallet && i.source && i.source !== wallet)
      return { funder: i.source, sponsor, lamportsIn, reason: "create-account" };
  }

  // Fallback (non-jsonParsed encodings): the wallet demonstrably gained SOL, so infer the
  // payer from balance deltas. Still gated on lamportsIn > 0, so a pure fee payer never qualifies.
  let maxDrop = 0, funder = null;
  for (let i = 0; i < keys.length; i++) {
    const drop = (pre[i] || 0) - (post[i] || 0);
    if (keys[i] !== wallet && drop > maxDrop) { maxDrop = drop; funder = keys[i]; }
  }
  return funder ? { funder, sponsor, lamportsIn, reason: "balance-inferred" }
                : { funder: null, sponsor, lamportsIn, reason: "no-payer-found" };
}

// Classify a candidate funder by FAN-OUT. A relayer/sponsor co-signs for a large, open-ended
// population; an attacker spinning up disposable wallets co-signs for a handful. `cosigners`
// is the distinct set observed across a sample of the candidate's recent transactions.
// Returns true when the candidate looks like shared infrastructure (→ must not alarm).
function isSharedInfrastructure(distinctCosigners, clusterSize, threshold) {
  const n = Number(distinctCosigners) || 0;
  const min = Number(threshold) || 10;
  // Serves far more wallets than the cluster it was flagged for → infrastructure, not coordination.
  return n >= min && n > clusterSize * 2;
}

module.exports = { attributeFunder, isSharedInfrastructure, keysOf, allIxs };
