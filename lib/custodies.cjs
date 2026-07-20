"use strict";
/*
 * FLASH6 custody enumeration + on-chain oracle marks.
 * Source: MagicBlock mainnet ER, decoded with the program's own on-chain Anchor IDL
 * (identical decode path to the verified census). No external API, no synthetic data.
 */
const anchor = require("@coral-xyz/anchor");
const IDL = require("./flash6_idl.json");
const SYMBOLS = require("./symbol_map.json");

const PROG = "FLASH6Lo6h3iasJKWDs2F8TkW2UKf3s15C8PMGuVfgBn";

const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58 = (buf) => { let d = [0]; for (const x of buf) { let c = x; for (let i = 0; i < d.length; i++) { c += d[i] << 8; d[i] = c % 58; c = (c / 58) | 0; } while (c) { d.push(c % 58); c = (c / 58) | 0; } } let z = 0; for (const x of buf) { if (x === 0) z++; else break; } return "1".repeat(z) + d.reverse().map((i) => A[i]).join(""); };
const discOf = (name) => { const a = IDL.accounts.find((x) => x.name === name); if (!a || !a.discriminator) throw new Error("no discriminator for " + name); return b58(Buffer.from(a.discriminator)); };

const coder = new anchor.BorshAccountsCoder(IDL);

/** Scan pools + ALL custodies from the ER (virtual included — they carry the oracles for
 *  synthetic markets like EUR/XAU/xStocks). Only non-virtual custodies own real SPL vaults. */
async function scanCustodies(erRpc) {
  const gpa = (name) => erRpc("getProgramAccounts", [PROG, { encoding: "base64", filters: [{ memcmp: { offset: 0, bytes: discOf(name) } }] }]);
  const [cu, pl, slot] = await Promise.all([gpa("Custody"), gpa("Pool"), erRpc("getSlot", [])]);

  const poolName = {};
  for (const a of pl.result || []) { try { const d = coder.decode("Pool", Buffer.from(a.account.data[0], "base64")); poolName[a.pubkey] = d.name; } catch (e) {} }

  const custodies = [];
  for (const a of cu.result || []) {
    try {
      const d = coder.decode("Custody", Buffer.from(a.account.data[0], "base64"));
      const mint = d.mint.toBase58();
      const meta = SYMBOLS[mint] || {};
      custodies.push({
        custody: a.pubkey,
        pool: poolName[d.pool.toBase58()] || d.pool.toBase58().slice(0, 6),
        mint,
        symbol: meta.symbol || mint.slice(0, 4) + "…",
        name: meta.name || null,
        decimals: d.decimals,
        isStable: !!d.is_stable,
        isVirtual: !!d.is_virtual,
        vault: d.is_virtual ? null : d.token_account.toBase58(),
        oracle: (d.oracle.int_oracle_account || d.oracle.intOracleAccount).toBase58(),
        kind: "custody",
      });
    } catch (e) {}
  }
  custodies.sort((x, y) => (x.pool + x.symbol).localeCompare(y.pool + y.symbol));
  return { custodies, pools: Object.keys(poolName).length, erSlot: (slot && slot.result) || null };
}

const oraclePx = (op) => { if (!op || op.price == null) return null; const e = op.exponent != null ? op.exponent : op.expo; return Number(op.price.toString()) * Math.pow(10, e); };

/** Non-custody program vaults that also hold real funds: TradeVault (single-sig trading
 *  deposits — the busiest flow surface), RebateVault, TokenVault (FAF staking/revenue).
 *  Returned shaped exactly like custody descriptors so every downstream path treats them
 *  identically (flows, limits, conservation, UI). Mark price is borrowed from a custody
 *  with the same mint when one exists; otherwise events are honestly unpriced. */
async function scanNamedVaults(erRpc, custodies) {
  const byMint = {};
  for (const c of custodies) if (!byMint[c.mint] || c.pool === "Crypto.1") byMint[c.mint] = c;
  const out = [];
  const defs = [
    { acct: "TradeVault", pool: "TradeVault", ta: (d) => d.token_account, mint: (d) => d.token_mint },
    { acct: "RebateVault", pool: "RebateVault", ta: (d) => d.token_account, mint: () => null },
    { acct: "TokenVault", pool: "FAF-Staking", ta: (d) => d.token_vault_token_account, mint: (d) => d.token_mint },
  ];
  for (const def of defs) {
    try {
      const r = await erRpc("getProgramAccounts", [PROG, { encoding: "base64", filters: [{ memcmp: { offset: 0, bytes: discOf(def.acct) } }] }]);
      for (const a of r.result || []) {
        try {
          const d = coder.decode(def.acct, Buffer.from(a.account.data[0], "base64"));
          const mintPk = def.mint(d);
          const mint = mintPk ? mintPk.toBase58() : null;
          out.push({ pda: a.pubkey, pool: def.pool, ta: def.ta(d).toBase58(), mint, kind: def.acct });
        } catch (e) {}
      }
    } catch (e) {}
  }
  return out;
}

/** Build a full custody-shaped descriptor for a token account (named vault or swept account). */
function describeVault({ pda, pool, ta, mint, kind }, custodies, taInfo) {
  const effMint = mint || (taInfo ? taInfo.mint : null);
  const meta = effMint ? (SYMBOLS[effMint] || {}) : {};
  const sameMint = effMint ? custodies.find((c) => c.mint === effMint && c.oracle && !c.isVirtual) : null;
  const decimals = meta.decimals != null ? meta.decimals : (taInfo && taInfo.decimals != null ? taInfo.decimals : (sameMint ? sameMint.decimals : 6));
  return {
    custody: pda,               // event/limit key — the vault PDA (or the TA itself for swept accounts)
    pool, mint: effMint,
    symbol: meta.symbol || (sameMint ? sameMint.symbol : ((effMint || "?").slice(0, 4) + "…")),
    name: meta.name || null, decimals,
    isStable: sameMint ? sameMint.isStable : !!meta.isStable,
    isVirtual: false, vault: ta,
    oracle: sameMint ? sameMint.oracle : null,
    kind,
  };
}

/** ALL token accounts owned by the program's vault authority (2 RPC calls) — the completeness
 *  net: any program-held token account not individually tracked is still watched by balance. */
async function sweepAuthority(mainRpc, authority) {
  const out = {};
  for (const prog of ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]) {
    try {
      const r = await mainRpc("getTokenAccountsByOwner", [authority, { programId: prog }, { encoding: "jsonParsed", commitment: "confirmed" }]);
      for (const it of ((r || {}).result || {}).value || []) {
        const info = it.account.data.parsed.info;
        out[it.pubkey] = { mint: info.mint, decimals: info.tokenAmount.decimals, amountRaw: info.tokenAmount.amount };
      }
    } catch (e) {}
  }
  return out;
}

/** Every Market account on the ER — the full live state of everything traded on Flash.
 *  collective_position is the program's own authoritative aggregate (census-verified exact). */
async function scanMarkets(erRpc, custodies, marks) {
  const byPk = {};
  for (const c of custodies) byPk[c.custody] = c;
  const r = await erRpc("getProgramAccounts", [PROG, { encoding: "base64", filters: [{ memcmp: { offset: 0, bytes: discOf("Market") } }] }]);
  const out = [];
  for (const a of r.result || []) {
    try {
      const d = coder.decode("Market", Buffer.from(a.account.data[0], "base64"));
      const cp = d.collective_position || {};
      const tcPk = d.target_custody.toBase58(), ccPk = d.collateral_custody.toBase58();
      const tc = byPk[tcPk], cc = byPk[ccPk];
      out.push({
        market: a.pubkey,
        symbol: tc ? tc.symbol : tcPk.slice(0, 4) + "…",
        side: Object.keys(d.side)[0],
        pool: tc ? tc.pool : (cc ? cc.pool : "?"),
        targetCustody: tcPk, collateralCustody: ccPk,
        collateralSymbol: cc ? cc.symbol : ccPk.slice(0, 4) + "…",
        oiUsd: Number(cp.size_usd ? cp.size_usd.toString() : 0) / 1e6,
        collateralUsd: Number(cp.collateral_liability_usd ? cp.collateral_liability_usd.toString() : 0) / 1e6,
        openPositions: Number(cp.open_positions || 0),
        lockedRaw: cp.locked_amount ? cp.locked_amount.toString() : "0",
        avgEntry: oraclePx(cp.average_entry_price),
        markUsd: marks && marks[tcPk] != null ? marks[tcPk] : null,
        targetIsVirtual: !!(tc && tc.isVirtual),
      });
    } catch (e) {}
  }
  out.sort((x, y) => y.oiUsd - x.oiUsd);
  return out;
}

/** CustomOracle marks for a custody list (ER first, base-chain fallback).
 *  Returns { marks: custody→priceUsd, markTimes: custody→publish_time (unix) } — publish_time
 *  lets the dashboard PROVE a mark is stale instead of guessing. */
async function fetchMarks(erRpc, mainRpc, allCustodies) {
  const custodies = allCustodies.filter((c) => c.oracle); // named/swept vaults may have no oracle
  const accts = custodies.map((c) => c.oracle);
  const marks = {}, markTimes = {}, lazerIds = {}, lazerMarks = {}; // lazer_* = on-chain Lazer fields per custody
  const decodeInto = (vals, idxs) => {
    idxs.forEach((ci, j) => {
      const v = vals[j];
      if (!v || !v.data) return;
      try {
        const od = coder.decode("CustomOracle", Buffer.from(v.data[0], "base64"));
        marks[custodies[ci].custody] = Number(od.price.toString()) * Math.pow(10, od.expo);
        if (od.publish_time != null) markTimes[custodies[ci].custody] = Number(od.publish_time.toString());
        if (od.lazer_feed_id != null && od.lazer_feed_id > 0) lazerIds[custodies[ci].custody] = od.lazer_feed_id;
        const lz = Number(od.lazer_price.toString()) * Math.pow(10, od.expo);
        if (Number.isFinite(lz) && lz > 0) lazerMarks[custodies[ci].custody] = lz;
      } catch (e) {}
    });
  };
  for (let i = 0; i < accts.length; i += 100) {
    const idxs = accts.slice(i, i + 100).map((_, j) => i + j);
    try { const r = await erRpc("getMultipleAccounts", [accts.slice(i, i + 100), { encoding: "base64" }]); decodeInto(((r || {}).result || {}).value || [], idxs); } catch (e) {}
  }
  const missing = custodies.map((c, i) => (marks[c.custody] == null ? i : -1)).filter((i) => i >= 0);
  if (missing.length) {
    try { const r = await mainRpc("getMultipleAccounts", [missing.map((i) => accts[i]), { encoding: "base64" }]); decodeInto(((r || {}).result || {}).value || [], missing); } catch (e) {}
  }
  return { marks, markTimes, lazerIds, lazerMarks };
}

/** Raw u64 SPL balances for all vaults from the BASE chain (authoritative). vault→BigInt|null */
async function fetchVaultBalances(mainRpc, custodies) {
  const vaults = custodies.map((c) => c.vault);
  const out = {};
  for (let i = 0; i < vaults.length; i += 100) {
    const chunk = vaults.slice(i, i + 100);
    const r = await mainRpc("getMultipleAccounts", [chunk, { encoding: "base64", commitment: "confirmed" }]);
    const vals = ((r || {}).result || {}).value || [];
    vals.forEach((v, j) => { out[chunk[j]] = v && v.data ? Buffer.from(v.data[0], "base64").readBigUInt64LE(64) : null; });
  }
  return out;
}

module.exports = { PROG, scanCustodies, scanMarkets, scanNamedVaults, describeVault, sweepAuthority, fetchMarks, fetchVaultBalances };
