"use strict";
/*
 * Vault flow extraction — every event is a REAL base-chain transaction.
 *   • getSignaturesForAddress pages newest→oldest until the last processed sig (or time cutoff)
 *   • getTransaction(jsonParsed) → exact u64 vault delta from pre/postTokenBalances
 *   • instruction names parsed from program logs; counterparty wallet from the
 *     same-mint token account moving opposite to the vault in the same tx.
 * Failed txs move no tokens; they are counted separately (failure spikes are a signal).
 */

/** New confirmed signatures for one vault, oldest→newest. Also returns failed-tx count. */
async function newSignatures(mainRpc, vault, untilSig, cutoffUnix) {
  const out = []; const failed = []; let before;
  outer: for (let page = 0; page < 40; page++) {
    const opts = { limit: 200, commitment: "confirmed" };
    if (before) opts.before = before;
    if (untilSig) opts.until = untilSig;
    const r = await mainRpc("getSignaturesForAddress", [vault, opts]);
    if (r && r.error) throw new Error("getSignaturesForAddress: " + r.error.message);
    const arr = (r && r.result) || [];
    if (!arr.length) break;
    for (const s of arr) {
      if (s.blockTime != null && s.blockTime < cutoffUnix) break outer;
      if (s.err) { if (s.blockTime != null) failed.push({ sig: s.signature, blockTime: s.blockTime }); continue; }
      out.push(s);
    }
    if (arr.length < 200) break;
    before = arr[arr.length - 1].signature;
  }
  return { sigs: out.reverse(), failed };
}

const IX_KIND = [
  [/Remove\w*Liquidity/i, "LP_WITHDRAW"], [/Add\w*Liquidity/i, "LP_DEPOSIT"],
  [/MigrateFlp|MigrateStake/i, "LP_MIGRATE"],
  [/Liquidat/i, "LIQUIDATION"],
  [/MoveProtocolFees|CompoundFees|DistributeTokenReward/i, "FEES"],
  [/StakeReward|CollectTokenReward/i, "REWARDS"], [/Rebate/i, "REBATE"],
  [/UnstakeInstant|UnstakeRequest|Withdraw/i, "WITHDRAW"], [/Deposit|Stake/i, "DEPOSIT"],
  [/Swap/i, "SWAP"], [/DecreaseSize|ClosePosition|Market.*Close/i, "CLOSE"],
  [/IncreaseSize|OpenPosition/i, "OPEN"],
];
const classify = (ixNames, direction) => {
  for (const [re, kind] of IX_KIND) if (ixNames.some((n) => re.test(n))) return kind;
  return direction === "in" ? "OTHER_IN" : "OTHER_OUT";
};

/** Trade vs LP vs staking/fees side, derived from the tx's own instruction names + the vault
 *  it touched. Anything not confidently attributable stays "other" — never guessed. */
function sideOf(e, kind) {
  if (e.pool === "TradeVault") return "trade";
  if (e.pool === "FAF-Staking") return "staking";
  if (e.pool === "RebateVault") return "protocol";
  switch (kind) {
    case "LP_DEPOSIT": case "LP_WITHDRAW": case "LP_MIGRATE": return "lp";
    case "DEPOSIT": case "WITHDRAW": case "OPEN": case "CLOSE": case "LIQUIDATION": case "SWAP": return "trade";
    case "REWARDS": case "REBATE": case "FEES": return "protocol";
    default: return "other";
  }
}

/** Decode one confirmed tx into a flow event for `cust` (null if the vault didn't move). */
async function decodeFlow(mainRpc, sigInfo, cust, markUsd) {
  const r = await mainRpc("getTransaction", [sigInfo.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
  if (r && r.error) throw new Error("getTransaction: " + r.error.message);
  const t = r && r.result;
  // A confirmed signature whose tx isn't served yet is a transient RPC gap — retry next
  // cycle rather than marking it processed (never silently skip a possible transfer).
  if (!t || !t.meta) throw new Error("tx not yet available on RPC");
  if (t.meta.err) return null; // failed tx — moved nothing, safe to skip permanently

  const keys = t.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
  const vi = keys.indexOf(cust.vault);
  if (vi < 0) return null;
  const pre = t.meta.preTokenBalances || [], post = t.meta.postTokenBalances || [];
  const at = (arr, ai) => arr.find((b) => b.accountIndex === ai);
  const pv = at(pre, vi), qv = at(post, vi);
  const delta = BigInt(qv ? qv.uiTokenAmount.amount : "0") - BigInt(pv ? pv.uiTokenAmount.amount : "0");
  if (delta === 0n) return null;

  const direction = delta > 0n ? "in" : "out";
  const ixNames = [...new Set((t.meta.logMessages || []).map((l) => (l.match(/^Program log: Instruction: (\w+)/) || [])[1]).filter(Boolean))];

  // counterparties: same-mint token accounts whose balance moved opposite the vault
  const cps = [];
  const seen = new Set(post.map((b) => b.accountIndex));
  const all = [...post, ...pre.filter((b) => !seen.has(b.accountIndex))];
  for (const b of all) {
    if (b.accountIndex === vi || b.mint !== cust.mint) continue;
    const p = at(pre, b.accountIndex), q = at(post, b.accountIndex);
    const d = BigInt(q ? q.uiTokenAmount.amount : "0") - BigInt(p ? p.uiTokenAmount.amount : "0");
    if (d !== 0n && (d > 0n) !== (delta > 0n)) cps.push({ owner: (q || p).owner || null, deltaRaw: d.toString() });
  }
  cps.sort((a, b) => { const x = BigInt(a.deltaRaw) < 0n ? -BigInt(a.deltaRaw) : BigInt(a.deltaRaw); const y = BigInt(b.deltaRaw) < 0n ? -BigInt(b.deltaRaw) : BigInt(b.deltaRaw); return y > x ? 1 : y < x ? -1 : 0; });

  const feePayer = keys[0];
  // primary wallet: the counterparty that received (out) / sent (in) the tokens; fall back to fee payer
  const wallet = (cps[0] && cps[0].owner) || feePayer;

  const amount = Number(delta < 0n ? -delta : delta) / Math.pow(10, cust.decimals);
  const px = markUsd != null && Number.isFinite(markUsd) ? markUsd : (cust.isStable ? 1 : null);
  return {
    sig: sigInfo.signature, slot: sigInfo.slot, blockTime: sigInfo.blockTime,
    observedAtMs: Date.now(),   // wall-clock observation time → real capture-latency metric
    custody: cust.custody, pool: cust.pool, symbol: cust.symbol, mint: cust.mint, decimals: cust.decimals,
    deltaRaw: delta.toString(), direction, amount,
    usd: px != null ? amount * px : null, markUsed: px,
    ix: ixNames, kind: classify(ixNames, direction),
    wallet, feePayer, counterparties: cps.slice(0, 4),
  };
}

module.exports = { newSignatures, decodeFlow, classify, sideOf };
