"use strict";
/*
 * Cross-provider QUORUM on the crown-jewel base-chain facts — the last single-point-of-trust removed.
 *
 * Every layer trusts what an RPC returns. A single stale, buggy, or COMPROMISED RPC could feed a false view.
 * This reads the facts whose corruption would blind the whole monitor — the program upgrade authority, the
 * program-deploy slot, and the Squads governance multisig — from SEVERAL providers and compares them.
 *
 * Design is shaped by one hard rule: a stale or rate-limited RPC must NEVER stop production or false-alarm.
 *   • Each provider is polled independently with a short timeout; a slow/rate-limited/down provider is simply
 *     DROPPED from that round (Promise settles, never rejects the batch). It never counts as "disagreement".
 *   • A fact is only judged when ≥2 providers RESPONDED. Fewer → "degraded" (status only, no alarm).
 *   • Crown jewels change ~never, so provider tip-lag (staleness) does not cause spurious disagreement; only a
 *     genuinely different value does — and the caller still requires a multi-round streak before alarming.
 *   • Reliable providers (the MagicBlock endpoints, which also serve base-chain accounts) anchor the quorum, so
 *     rate-limited public RPCs dropping out can't break it.
 * This module is pure I/O + pure aggregation; it has no side effects and cannot throw into the caller's cycle
 * (quorumCheck resolves even if every provider fails — the facts just come back degraded).
 */
const crypto = require("crypto");
const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58 = (buf) => { let d = [0]; for (const x of buf) { let c = x; for (let i = 0; i < d.length; i++) { c += d[i] << 8; d[i] = c % 58; c = (c / 58) | 0; } while (c) { d.push(c % 58); c = (c / 58) | 0; } } let z = 0; for (const x of buf) { if (x === 0) z++; else break; } return "1".repeat(z) + d.reverse().map((i) => A[i]).join(""); };
const SQUADS_MS_DISC = crypto.createHash("sha256").update("account:Multisig").digest().slice(0, 8);

// programData (bpf-upgradeable-loader): u32 tag | u64 slot | Option<Pubkey> upgrade_authority (1 tag + 32).
function decodeUpgrade(dataB64) {
  const b = Buffer.from(dataB64, "base64");
  if (b.length < 13) return null;
  const slot = Number(b.readBigUInt64LE(4));
  const hasAuth = b[12] === 1;
  const authority = hasAuth && b.length >= 45 ? b58(b.subarray(13, 45)) : null;
  return { slot, authority };
}
// Squads v4 Multisig: threshold (u16 @72) + member count. (Full member set is watched by authority.cjs; here we
// only need a stable fingerprint to compare across providers.)
function decodeSquads(dataB64) {
  const b = Buffer.from(dataB64, "base64");
  if (b.length < 94 || !b.subarray(0, 8).equals(SQUADS_MS_DISC)) return null;
  const threshold = b.readUInt16LE(72);
  let o = 94; const hasRC = b[o] === 1; o += 1 + (hasRC ? 32 : 0); o += 1; // rent_collector Option + bump
  if (o + 4 > b.length) return null;
  return { threshold, members: b.readUInt32LE(o) };
}

async function readAccount(url, acct, timeoutMs) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [acct, { encoding: "base64" }] }), signal: AbortSignal.timeout(timeoutMs) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "rpc error");
  const v = j.result && j.result.value;
  if (!v || !v.data) throw new Error("null account");
  return v.data[0];
}

// Poll one account from every provider; keep only providers that RESPONDED with a decodable value. A provider that
// times out / rate-limits / errors is silently dropped (never rejects, never counts as disagreement).
async function pollFact(providers, acct, decode, timeoutMs) {
  const out = [];
  await Promise.all(providers.map(async (p) => {
    try { const data = await readAccount(p.url, acct, timeoutMs); const val = decode(data); if (val != null) out.push({ provider: p.name, val }); }
    catch (e) { /* provider unavailable this round → drop, harmless */ }
  }));
  return out;
}

// Pure: fold per-provider readings into a verdict for one fact. agree/disagree only when ≥2 responded.
function aggregateFact(label, readings, keyFn) {
  const responded = readings.length;
  const keys = readings.map((r) => keyFn(r.val));
  const distinct = new Set(keys);
  return {
    label, responded, degraded: responded < 2,
    agree: responded >= 2 && distinct.size === 1,
    disagree: responded >= 2 && distinct.size > 1,
    readings: readings.map((r) => ({ provider: r.provider, value: keyFn(r.val) })),
  };
}

// Query all crown jewels across all providers. Always resolves (never throws) — worst case, all facts degraded.
async function quorumCheck(providers, accounts, timeoutMs = 8000) {
  let upg = [], sq = [];
  try {
    [upg, sq] = await Promise.all([
      pollFact(providers, accounts.programData, decodeUpgrade, timeoutMs),
      pollFact(providers, accounts.squadsCfg, decodeSquads, timeoutMs),
    ]);
  } catch (e) { /* Promise.all can't reject here (pollFact never throws), but stay defensive */ }
  return {
    upgradeAuthority: aggregateFact("upgrade-authority", upg, (v) => v.authority || "none"),
    programDeploySlot: aggregateFact("program-deploy-slot", upg, (v) => String(v.slot)),
    squadsMultisig: aggregateFact("squads-multisig", sq, (v) => v.threshold + "-of-" + v.members),
  };
}

module.exports = { quorumCheck, pollFact, aggregateFact, decodeUpgrade, decodeSquads };
