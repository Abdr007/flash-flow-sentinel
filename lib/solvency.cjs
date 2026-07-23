"use strict";
/*
 * Independent solvency recompute — the sentinel's OWN second witness.
 *
 * The dual-witness design only holds if the two witnesses are genuinely independent. Until now the sentinel's
 * solvency check READ the census API — so if that one source were wrong, stale, or compromised, the "second
 * witness" was really the first one again. This module removes that: the sentinel scans the Flash mainnet ER
 * itself, decodes every Custody with the program's own Anchor IDL, reads the vault SPL balances, and recomputes
 * per-custody solvency from raw u64 — no census API involved.
 *
 * Per non-virtual custody (identical formula to the census, verified to match exactly on live data):
 *     withdrawable_residual = (vault_balance + trade_receivable) − (custody.owned + trade_payable)
 *     residual >= 0  ⇒ solvent (exact = 0, surplus > 0); residual < 0 ⇒ deficit (under-collateralised).
 *
 * Two things this buys:
 *   1. An INDEPENDENT deficit proof — a real insolvency is caught even if the census is down or lying.
 *   2. A CROSS-WITNESS check — if this compute and the census DISAGREE on solvency, one source is wrong or
 *      compromised, which is itself an alarm (a census hacked to show "solvent" during a drain no longer hides it).
 * (Both still read the same ER RPC; that shared dependency is addressed separately by multi-RPC quorum.)
 */
const anchor = require("@coral-xyz/anchor");
const IDL = require("./flash6_idl.json");

const PROG = "FLASH6Lo6h3iasJKWDs2F8TkW2UKf3s15C8PMGuVfgBn";
const coder = new anchor.BorshAccountsCoder(IDL);
const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58 = (buf) => { let d = [0]; for (const x of buf) { let c = x; for (let i = 0; i < d.length; i++) { c += d[i] << 8; d[i] = c % 58; c = (c / 58) | 0; } while (c) { d.push(c % 58); c = (c / 58) | 0; } } let z = 0; for (const x of buf) { if (x === 0) z++; else break; } return "1".repeat(z) + d.reverse().map((i) => A[i]).join(""); };
const DISC_CUSTODY = b58(Buffer.from(IDL.accounts.find((a) => a.name === "Custody").discriminator));

// Read SPL token-account balances (raw u64 at offset 64), ER-first because vaults are DELEGATED — their live
// balance is on the ER; the base chain holds a stale/delegated copy. Base chain is the fallback for any the ER
// doesn't return (undelegated). Chunked to stay within getMultipleAccounts limits.
async function readVaultBalances(erRpc, mainRpc, vaults) {
  const bal = {};
  const fetchFrom = async (rpc, list) => {
    for (let i = 0; i < list.length; i += 100) {
      const chunk = list.slice(i, i + 100);
      const r = await rpc("getMultipleAccounts", [chunk, { encoding: "base64" }]);
      const vals = (r && r.result && r.result.value) || [];
      vals.forEach((v, j) => { if (v && v.data) { try { bal[chunk[j]] = Buffer.from(v.data[0], "base64").readBigUInt64LE(64); } catch (e) {} } });
    }
  };
  await fetchFrom(erRpc, vaults);
  const miss = vaults.filter((v) => bal[v] == null);
  if (miss.length) await fetchFrom(mainRpc, miss);
  return bal;
}

// Independently recompute per-custody solvency from a raw ER scan. Throws on a failed scan (caller treats a throw
// as "witness unavailable", never as "solvent"). Returns a compact result; deficitRows carry the offending custodies.
async function computeSolvency(erRpc, mainRpc) {
  const cu = await erRpc("getProgramAccounts", [PROG, { encoding: "base64", filters: [{ memcmp: { offset: 0, bytes: DISC_CUSTODY } }] }]);
  if (cu && cu.error) throw new Error("custody scan: " + (cu.error.message || JSON.stringify(cu.error)));
  const accs = (cu && cu.result) || [];
  if (!accs.length) throw new Error("no custodies returned from ER scan");
  const cs = [];
  for (const a of accs) {
    try {
      const d = coder.decode("Custody", Buffer.from(a.account.data[0], "base64"));
      if (d.is_virtual) continue; // virtual custody has no vault to back
      cs.push({
        custody: a.pubkey, vault: d.token_account.toBase58(), mint: d.mint.toBase58(), decimals: d.decimals, isStable: !!d.is_stable,
        owned: BigInt(d.assets.owned.toString()), pay: BigInt(d.trade_payable.toString()), recv: BigInt(d.trade_receivable.toString()),
      });
    } catch (e) { /* undecodable account → skip, never guess */ }
  }
  if (!cs.length) throw new Error("no non-virtual custodies decoded");
  const bal = await readVaultBalances(erRpc, mainRpc, cs.map((c) => c.vault));
  let exact = 0, surplus = 0, deficit = 0, noVault = 0, totalDeficitRaw = 0n;
  const deficitRows = [];
  for (const c of cs) {
    const b = bal[c.vault];
    if (b == null) { noVault++; continue; } // couldn't read this vault this pass → don't count as solvent OR deficit
    const wres = (b + c.recv) - (c.owned + c.pay);
    if (wres === 0n) exact++;
    else if (wres > 0n) surplus++;
    else { deficit++; totalDeficitRaw += -wres; deficitRows.push({ custody: c.custody, vault: c.vault, mint: c.mint, decimals: c.decimals, deficitRaw: (-wres).toString() }); }
  }
  return {
    custodyCount: cs.length, exact, surplus, deficit, noVault,
    backed: exact + surplus, totalDeficitRaw: totalDeficitRaw.toString(),
    // solvent only if NO deficit AND every vault was actually read (a read gap must not read as "all good")
    allSolvent: deficit === 0 && noVault === 0,
    complete: noVault === 0,
    deficitRows,
  };
}

module.exports = { computeSolvency, readVaultBalances, PROG };
