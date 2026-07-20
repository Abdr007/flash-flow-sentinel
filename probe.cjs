"use strict";
/*
 * PROBE — empirically validate the vault-flow data path before building the sentinel.
 *   1. Enumerate FLASH6 custodies from the mainnet ER (same decoder as the census).
 *   2. For the largest real vaults, pull recent signatures on the BASE chain.
 *   3. Decode actual transactions: exact u64 vault delta from pre/postTokenBalances,
 *      instruction name from program logs, counterparty wallet from same-mint balance changes.
 * Everything printed here is a real mainnet transaction.
 */
const https = require("https");
const anchor = require("@coral-xyz/anchor");
const IDL = require("./lib/flash6_idl.json");
const SYMBOLS = require("./lib/symbol_map.json");

const ER = "https://flashtrade.magicblock.app";
const PROG = "FLASH6Lo6h3iasJKWDs2F8TkW2UKf3s15C8PMGuVfgBn";
const MAIN = process.env.RPC_URL || (process.env.HELIUS_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_KEY}` : "https://api.mainnet-beta.solana.com");

const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58 = (buf) => { let d = [0]; for (const x of buf) { let c = x; for (let i = 0; i < d.length; i++) { c += d[i] << 8; d[i] = c % 58; c = (c / 58) | 0; } while (c) { d.push(c % 58); c = (c / 58) | 0; } } let z = 0; for (const x of buf) { if (x === 0) z++; else break; } return "1".repeat(z) + d.reverse().map((i) => A[i]).join(""); };
const discOf = (name) => { const a = IDL.accounts.find((x) => x.name === name); return b58(Buffer.from(a.discriminator)); };

const rpc = (method, params, url = ER) => new Promise((res, rej) => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const u = new URL(url);
  const rq = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (r) => { let d = ""; r.on("data", (c) => d += c); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(new Error("bad json " + method)); } }); });
  rq.on("error", rej); rq.setTimeout(30000, () => rq.destroy(new Error("timeout " + method))); rq.write(body); rq.end();
});

(async () => {
  // 1. custodies from ER
  const coder = new anchor.BorshAccountsCoder(IDL);
  const cu = await rpc("getProgramAccounts", [PROG, { encoding: "base64", filters: [{ memcmp: { offset: 0, bytes: discOf("Custody") } }] }]);
  const pl = await rpc("getProgramAccounts", [PROG, { encoding: "base64", filters: [{ memcmp: { offset: 0, bytes: discOf("Pool") } }] }]);
  const poolName = {};
  for (const a of pl.result || []) { try { const d = coder.decode("Pool", Buffer.from(a.account.data[0], "base64")); poolName[a.pubkey] = d.name; } catch (e) {} }
  const custodies = [];
  for (const a of cu.result || []) {
    try {
      const d = coder.decode("Custody", Buffer.from(a.account.data[0], "base64"));
      if (d.is_virtual) continue;
      const mint = d.mint.toBase58();
      custodies.push({ custody: a.pubkey, pool: poolName[d.pool.toBase58()] || "?", mint, symbol: (SYMBOLS[mint] || {}).symbol || mint.slice(0, 4), decimals: d.decimals, vault: d.token_account.toBase58() });
    } catch (e) {}
  }
  console.log(`custodies (non-virtual): ${custodies.length}`);

  // 2. vault balances from base chain to find the busiest ones
  const vaults = custodies.map((c) => c.vault);
  const bal = await rpc("getMultipleAccounts", [vaults, { encoding: "base64" }], MAIN);
  custodies.forEach((c, i) => { const v = bal.result.value[i]; c.balance = v ? Buffer.from(v.data[0], "base64").readBigUInt64LE(64) : null; });
  custodies.sort((a, b) => Number((b.balance || 0n) - (a.balance || 0n)));
  console.log("top vaults:", custodies.slice(0, 5).map((c) => `${c.pool}/${c.symbol} ${c.balance} raw (${c.vault.slice(0, 8)}…)`).join("\n            "));

  // 3. recent signatures for the busiest vault (base chain — where SPL transfers actually happen)
  const top = custodies.find((c) => c.symbol === "USDC" && c.pool === "Crypto.1") || custodies[0];
  const sigs = await rpc("getSignaturesForAddress", [top.vault, { limit: 15 }], MAIN);
  const list = (sigs.result || []).filter((s) => !s.err);
  console.log(`\n${top.pool}/${top.symbol} vault ${top.vault}: ${list.length} recent ok signatures`);
  for (const s of list.slice(0, 6)) {
    const tx = await rpc("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }], MAIN);
    const t = tx.result; if (!t) { console.log("  (tx fetch miss)", s.signature); continue; }
    const keys = t.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
    const pre = t.meta.preTokenBalances || [], post = t.meta.postTokenBalances || [];
    const at = (arr, ai) => arr.find((b) => b.accountIndex === ai);
    // vault delta
    const vi = keys.indexOf(top.vault);
    const pv = at(pre, vi), qv = at(post, vi);
    const delta = BigInt(qv ? qv.uiTokenAmount.amount : "0") - BigInt(pv ? pv.uiTokenAmount.amount : "0");
    // instruction names from logs
    const ixNames = [...new Set((t.meta.logMessages || []).map((l) => (l.match(/^Program log: Instruction: (\w+)/) || [])[1]).filter(Boolean))];
    // counterparties: same-mint accounts with opposite-sign delta
    const cps = [];
    for (const q of post) {
      if (q.accountIndex === vi || q.mint !== top.mint) continue;
      const p = at(pre, q.accountIndex);
      const d = BigInt(q.uiTokenAmount.amount) - BigInt(p ? p.uiTokenAmount.amount : "0");
      if (d !== 0n && (d > 0n) !== (delta > 0n)) cps.push({ owner: q.owner, delta: d.toString() });
    }
    console.log(`  ${new Date(s.blockTime * 1000).toISOString()} ${delta === 0n ? "·  no-delta" : delta > 0n ? "IN " : "OUT"} ${delta} raw | ix=[${ixNames.join(",")}] | cp=${cps.map((c) => `${c.owner.slice(0, 6)}…(${c.delta})`).join(", ") || "-"} | feePayer=${keys[0].slice(0, 6)}… | ${s.signature.slice(0, 20)}…`);
  }
})().catch((e) => { console.error("PROBE FAIL:", e.message || e); process.exit(1); });
