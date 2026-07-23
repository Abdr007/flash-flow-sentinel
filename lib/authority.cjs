"use strict";
/*
 * Governance & authority watch — the START of the drain kill-chain.
 * Every reading is live on-chain (no synthetic data):
 *   • Program upgrade authority + last-deployed slot   → ProgramData (base chain, bpf-upgradeable-loader)
 *   • Admin multisig signer set + threshold            → Multisig account (base chain)
 *   • Global protocol permission flags                 → Perpetuals account (ER, program's own IDL)
 * A permission flip, a signer swap, an authority change, or an unexpected redeploy typically
 * precedes a manipulated-oracle drain by minutes-to-hours. This module snapshots that surface so
 * the sentinel can alert the instant any of it changes.
 */
const anchor = require("@coral-xyz/anchor");
const IDL = require("./flash6_idl.json");

const crypto = require("crypto");
const PROG = "FLASH6Lo6h3iasJKWDs2F8TkW2UKf3s15C8PMGuVfgBn";
const SYSTEM = "11111111111111111111111111111111";
const SQUADS = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf"; // Squads multisig program (verified as the upgrade executor)
// The Squads multisig CONFIG account that actually gates program upgrades (its vault PDA is the upgrade authority).
// Verified on-chain = 3-of-7. A threshold drop or member swap HERE is the real governance-takeover step and does
// NOT change the upgrade authority (still the same vault PDA), so it must be watched directly. Env-overridable.
const SQUADS_MULTISIG = process.env.SQUADS_MULTISIG_ACCOUNT || "Gb33UeQNnQ4XDuobtGq9M6PVKRVfoH77p8d6JXsgqyXF";
const SQUADS_MS_DISC = crypto.createHash("sha256").update("account:Multisig").digest().slice(0, 8); // anchor disc
// Decode a Squads v4 Multisig account: threshold (u16) + member key set. Layout after the 8-byte discriminator:
// create_key(32) config_authority(32) threshold(u16) time_lock(u32) tx_idx(u64) stale_idx(u64) rent_collector
// Option(1[+32]) bump(1) members(vec: u32 len + n×(pubkey32 + permissions1)). Returns null if not a Multisig.
function decodeSquadsMultisig(buf) {
  if (!buf || buf.length < 94 || !buf.subarray(0, 8).equals(SQUADS_MS_DISC)) return null;
  const threshold = buf.readUInt16LE(72);
  let o = 94; const hasRC = buf[o] === 1; o += 1 + (hasRC ? 32 : 0); o += 1; // rent_collector Option + bump
  if (o + 4 > buf.length) return null;
  const n = buf.readUInt32LE(o); o += 4;
  const members = [];
  for (let i = 0; i < n; i++) { if (o + 32 > buf.length) break; members.push(b58(buf.subarray(o, o + 32))); o += 33; }
  return { threshold, members: members.sort() };
}

const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58 = (buf) => { let d = [0]; for (const x of buf) { let c = x; for (let i = 0; i < d.length; i++) { c += d[i] << 8; d[i] = c % 58; c = (c / 58) | 0; } while (c) { d.push(c % 58); c = (c / 58) | 0; } } let z = 0; for (const x of buf) { if (x === 0) z++; else break; } return "1".repeat(z) + d.reverse().map((i) => A[i]).join(""); };
const discOf = (name) => { const a = IDL.accounts.find((x) => x.name === name); return b58(Buffer.from(a.discriminator)); };
const coder = new anchor.BorshAccountsCoder(IDL);

// money-path permission flags whose flip is highest-severity
const CRITICAL_PERMS = new Set(["allow_remove_liquidity", "allow_collateral_withdrawal", "allow_close_position", "allow_liquidation"]);

/** Read the complete governance surface. Returns a plain-JSON snapshot + a change fingerprint. */
async function fetchGovernance(mainRpc, erRpc) {
  const gov = { asOf: Math.floor(Date.now() / 1000), errors: [] };

  // 1) program → programData → upgrade authority + last deploy slot (base chain, authoritative)
  try {
    const pr = await mainRpc("getAccountInfo", [PROG, { encoding: "jsonParsed" }]);
    const pdAddr = pr.result.value.data.parsed.info.programData;
    gov.loader = pr.result.value.owner;
    gov.programData = pdAddr;
    const pd = await mainRpc("getAccountInfo", [pdAddr, { encoding: "jsonParsed" }]);
    const info = pd.result.value.data.parsed.info;
    gov.upgradeAuthority = info.authority || null;
    gov.lastDeploySlot = info.slot != null ? Number(info.slot) : null;
    gov.upgradeable = !!info.authority;
    // Determine HOW the upgrade authority is controlled by looking at how upgrades are actually
    // executed on-chain — the only reliable signal. A system-owned authority key can be either a
    // bare keypair OR a Squads vault PDA (also system-owned), so ownership alone is NOT sufficient
    // (this exact ambiguity produced an earlier wrong "single key" claim). We inspect the most
    // recent programData transaction: if the Squads program executed it, upgrades are multisig-gated.
    if (info.authority) {
      gov.upgradeControl = { model: "unverified", executor: null, lastUpgradeBy: null, evidenceSig: null };
      try {
        const sigs = await mainRpc("getSignaturesForAddress", [pdAddr, { limit: 5 }]);
        const newest = ((sigs && sigs.result) || []).find((s) => !s.err);
        if (newest) {
          const tx = await mainRpc("getTransaction", [newest.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
          const t = tx && tx.result;
          if (t) {
            const keys = t.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
            const progs = new Set([
              ...(t.transaction.message.instructions || []).map((i) => i.programId),
              ...((t.meta && t.meta.logMessages) || []).map((l) => (l.match(/Program (\w{32,}) invoke/) || [])[1]),
            ].filter(Boolean));
            gov.upgradeControl = {
              model: progs.has(SQUADS) ? "squads-multisig" : "direct-authority",
              executor: progs.has(SQUADS) ? SQUADS : null,
              lastUpgradeBy: keys[0], evidenceSig: newest.signature,
            };
          }
        }
      } catch (e) { gov.errors.push("upgrade-control: " + e.message); }
    }
  } catch (e) { gov.errors.push("programData: " + e.message); }

  // gpa with base-chain-then-ER fallback that survives a THROWN primary error (not just empty)
  const gpaEither = async (name) => {
    const flt = [{ memcmp: { offset: 0, bytes: discOf(name) } }];
    let accs = [];
    try { const r = await mainRpc("getProgramAccounts", [PROG, { encoding: "base64", filters: flt }]); accs = (r && r.result) || []; } catch (e) {}
    if (!accs.length) { try { const r = await erRpc("getProgramAccounts", [PROG, { encoding: "base64", filters: flt }]); accs = (r && r.result) || []; } catch (e) {} }
    return accs;
  };

  // 2) admin multisig signer set + threshold (base chain, ER fallback)
  try {
    const accs = await gpaEither("Multisig");
    if (accs.length) {
      accs.sort((a, b) => a.pubkey.localeCompare(b.pubkey)); // deterministic pick if >1 ever matches
      const d = coder.decode("Multisig", Buffer.from(accs[0].account.data[0], "base64"));
      gov.multisig = {
        account: accs[0].pubkey,
        threshold: Number(d.min_signatures),   // M in M-of-N — the ACTUAL approval bar (attack target)
        registered: Number(d.num_signers),     // N — number of registered signers
        signers: d.signers.map((s) => s.toBase58()).filter((s) => s !== SYSTEM).sort(),
      };
    }
  } catch (e) { gov.errors.push("multisig: " + e.message); }

  // 2b) the REAL upgrade-gating Squads multisig config: threshold + member set. A member swap or threshold drop
  // here is the actual governance-takeover step and does NOT change the upgrade authority (still the same Squads
  // vault PDA) — so nothing else in this snapshot would catch it. This watches it directly. (§2's Flash-internal
  // Multisig is a DIFFERENT account and governs something else; both are tracked, but THIS is the one that gates upgrades.)
  try {
    const r = await mainRpc("getAccountInfo", [SQUADS_MULTISIG, { encoding: "base64" }]);
    const v = r && r.result && r.result.value;
    if (v && v.owner === SQUADS && v.data) {
      const d = decodeSquadsMultisig(Buffer.from(v.data[0], "base64"));
      if (d) gov.squadsMultisig = { account: SQUADS_MULTISIG, threshold: d.threshold, registered: d.members.length, signers: d.members };
    }
  } catch (e) { gov.errors.push("squads-multisig: " + e.message); }

  // 3) global protocol permission flags (ER-first — the live delegated config)
  try {
    let accs = [];
    try { const r = await erRpc("getProgramAccounts", [PROG, { encoding: "base64", filters: [{ memcmp: { offset: 0, bytes: discOf("Perpetuals") } }] }]); accs = (r && r.result) || []; } catch (e) {}
    // NOTE: no base-chain fallback here — the live Perpetuals config is on the ER; a stale base-chain
    // copy could show different permission bits and cause false flips. Missing = section skipped.
    if (accs.length) {
      accs.sort((a, b) => a.pubkey.localeCompare(b.pubkey));
      const d = coder.decode("Perpetuals", Buffer.from(accs[0].account.data[0], "base64"));
      gov.perpetuals = { account: accs[0].pubkey, permissions: {} };
      for (const [k, v] of Object.entries(d.permissions || {})) gov.perpetuals.permissions[k] = !!v;
    }
  } catch (e) { gov.errors.push("perpetuals: " + e.message); }

  gov.fingerprint = fingerprintOf(gov);
  return gov;
}

/** Stable string over exactly the fields whose change must alert. Only sections that were
 *  successfully read (present) contribute — a section absent due to RPC failure is omitted so
 *  a transient read gap can't masquerade as a change (see diffGovernance's section guards). */
function fingerprintOf(g) {
  return JSON.stringify({
    ua: g.upgradeAuthority !== undefined ? g.upgradeAuthority : "∅",
    ctrl: g.upgradeControl ? g.upgradeControl.model : "∅",
    deploy: g.lastDeploySlot != null ? g.lastDeploySlot : "∅",
    msThreshold: g.multisig ? g.multisig.threshold : "∅",
    msRegistered: g.multisig ? g.multisig.registered : "∅",
    msSigners: g.multisig ? g.multisig.signers : "∅",
    sqThreshold: g.squadsMultisig ? g.squadsMultisig.threshold : "∅",
    sqRegistered: g.squadsMultisig ? g.squadsMultisig.registered : "∅",
    sqSigners: g.squadsMultisig ? g.squadsMultisig.signers : "∅",
    perms: g.perpetuals ? g.perpetuals.permissions : "∅",
  });
}

/** Diff two governance snapshots → array of { key, severity, detail } changes.
 *  A section is compared ONLY when it was successfully read in BOTH snapshots — a section that
 *  failed to read this cycle (undefined) is skipped, never treated as a change. */
function diffGovernance(prev, cur) {
  const out = [];
  if (!prev || !cur) return out;

  // upgrade authority — compare only when both reads succeeded
  if (prev.upgradeAuthority != null && cur.upgradeAuthority != null && prev.upgradeAuthority !== cur.upgradeAuthority)
    out.push({ key: "gov:upgrade-authority", severity: "critical", detail: `upgrade authority changed ${short(prev.upgradeAuthority)} → ${short(cur.upgradeAuthority)}` });

  // upgrade control model — e.g. squads-multisig → direct-authority would mean upgrades stopped being multisig-gated
  const pc = prev.upgradeControl && prev.upgradeControl.model, cc = cur.upgradeControl && cur.upgradeControl.model;
  if (pc && cc && pc !== "unverified" && cc !== "unverified" && pc !== cc)
    out.push({ key: "gov:upgrade-control", severity: "critical", detail: `upgrade control model changed ${pc} → ${cc}` });

  // program redeploy — both slots must be real numbers. AUTO-VERIFY authorization rather than blindly firing
  // critical: an upgrade is AUTHORIZED iff it went through the SAME known upgrade authority, that authority is
  // still governed by the multisig (control model unchanged, not a raw/unverified key), and — if pinned — it
  // matches EXPECTED_UPGRADE_AUTHORITY. Only the current upgrade authority CAN upgrade the program, so an
  // unchanged multisig-controlled authority means the deploy was executed through the legitimate process.
  // (This verifies AUTHORIZATION, not bytecode safety — the new code still warrants human/audit review.)
  if (prev.lastDeploySlot != null && cur.lastDeploySlot != null && prev.lastDeploySlot !== cur.lastDeploySlot) {
    const authorityUnchanged = cur.upgradeAuthority && prev.upgradeAuthority && cur.upgradeAuthority === prev.upgradeAuthority;
    const cModel = cur.upgradeControl && cur.upgradeControl.model;
    const controlIntact = cModel && cModel === pc && cModel !== "unverified" && cModel !== "direct-authority" && cModel !== "single-key";
    const expected = process.env.EXPECTED_UPGRADE_AUTHORITY;
    const matchesExpected = !expected || cur.upgradeAuthority === expected;
    const authorized = !!(authorityUnchanged && controlIntact && matchesExpected);
    const by = cur.upgradeControl && cur.upgradeControl.lastUpgradeBy ? short(cur.upgradeControl.lastUpgradeBy) : "?";
    const sig = cur.upgradeControl && cur.upgradeControl.evidenceSig ? cur.upgradeControl.evidenceSig.slice(0, 8) + "…" : "?";
    if (authorized)
      out.push({ key: "gov:program-deploy", severity: "notice", authorized: true, detail: `program upgraded (slot ${prev.lastDeploySlot} → ${cur.lastDeploySlot}) via ${cModel} — authority ${short(cur.upgradeAuthority)} UNCHANGED, executed by ${by} (${sig}). AUTHORIZED by the multisig — review the new bytecode.` });
    else
      out.push({ key: "gov:program-deploy", severity: "critical", authorized: false, detail: `program REDEPLOYED (slot ${prev.lastDeploySlot} → ${cur.lastDeploySlot}) — NOT verifiably authorized (${!authorityUnchanged ? "upgrade authority CHANGED" : !controlIntact ? "upgrade control now " + (cModel || "unverified") : "authority ≠ expected"}). Investigate immediately.` });
  }

  const pm = prev.multisig, cm = cur.multisig;
  if (pm && cm) {
    // guard != null so a baseline written by an older schema (missing a field) can't fire a false change
    if (pm.threshold != null && cm.threshold != null && pm.threshold !== cm.threshold) out.push({ key: "gov:multisig-threshold", severity: "critical", detail: `admin multisig APPROVAL THRESHOLD ${pm.threshold} → ${cm.threshold} (min_signatures) — lowering this is a classic takeover step` });
    if (pm.registered != null && cm.registered != null && pm.registered !== cm.registered) out.push({ key: "gov:multisig-count", severity: "critical", detail: `admin registered signer count ${pm.registered} → ${cm.registered}` });
    const ps = new Set(pm.signers), cs = new Set(cm.signers);
    const added = cm.signers.filter((s) => !ps.has(s)), removed = pm.signers.filter((s) => !cs.has(s));
    if (added.length || removed.length) out.push({ key: "gov:multisig-signers", severity: "critical", detail: `admin signer set changed${added.length ? " +[" + added.map(short).join(",") + "]" : ""}${removed.length ? " -[" + removed.map(short).join(",") + "]" : ""}` });
  }

  // the Squads multisig that GATES UPGRADES — a threshold drop or member swap here is the real takeover step
  // (the upgrade authority stays the same vault PDA, so nothing else would flag it).
  const psq = prev.squadsMultisig, csq = cur.squadsMultisig;
  if (psq && csq) {
    if (psq.threshold != null && csq.threshold != null && psq.threshold !== csq.threshold) out.push({ key: "gov:squads-threshold", severity: "critical", detail: `UPGRADE multisig threshold ${psq.threshold} → ${csq.threshold} (Squads ${csq.threshold}-of-${csq.registered}) — lowering who must approve a program upgrade is a classic takeover step` });
    if (psq.registered != null && csq.registered != null && psq.registered !== csq.registered) out.push({ key: "gov:squads-count", severity: "critical", detail: `UPGRADE multisig member count ${psq.registered} → ${csq.registered}` });
    const psS = new Set(psq.signers), csS = new Set(csq.signers);
    const sqAdd = csq.signers.filter((s) => !psS.has(s)), sqRem = psq.signers.filter((s) => !csS.has(s));
    if (sqAdd.length || sqRem.length) out.push({ key: "gov:squads-signers", severity: "critical", detail: `UPGRADE multisig member set changed${sqAdd.length ? " +[" + sqAdd.map(short).join(",") + "]" : ""}${sqRem.length ? " -[" + sqRem.map(short).join(",") + "]" : ""} — a new signer on the upgrade multisig can help push a malicious program` });
  }

  const pp = prev.perpetuals && prev.perpetuals.permissions, cp = cur.perpetuals && cur.perpetuals.permissions;
  if (pp && cp) {
    for (const k of new Set([...Object.keys(pp), ...Object.keys(cp)])) { // union: catch added AND removed flags
      const a = pp[k], b = cp[k];
      if (a === b) continue;
      const detail = b === undefined ? `permission ${k} REMOVED (was ${a})` : a === undefined ? `permission ${k} ADDED (${b})` : `permission ${k}: ${a} → ${b}`;
      out.push({ key: "gov:perm:" + k, severity: CRITICAL_PERMS.has(k) ? "critical" : "high", detail });
    }
  }
  return out;
}

const short = (a) => (a ? a.slice(0, 4) + "…" + a.slice(-4) : "—");

/** Carry a fresh read forward onto the last-good baseline: any section that FAILED to read this
 *  cycle keeps the baseline's value (never overwritten with undefined). Returns a complete
 *  snapshot to diff against and to store as the new baseline — so a transient RPC gap on one
 *  section can neither raise a false change nor blind a later real change on that section. */
function mergeGovernance(prev, fresh) {
  if (!prev) return fresh;
  const gotProgram = fresh.upgradeAuthority != null && fresh.lastDeploySlot != null;
  const gotMultisig = !!fresh.multisig;
  const gotSquads = !!fresh.squadsMultisig;
  const gotPerps = !!fresh.perpetuals;
  const merged = {
    asOf: fresh.asOf, errors: fresh.errors,
    loader: gotProgram ? fresh.loader : prev.loader,
    programData: gotProgram ? fresh.programData : prev.programData,
    upgradeAuthority: gotProgram ? fresh.upgradeAuthority : prev.upgradeAuthority,
    lastDeploySlot: gotProgram ? fresh.lastDeploySlot : prev.lastDeploySlot,
    upgradeable: gotProgram ? fresh.upgradeable : prev.upgradeable,
    upgradeControl: gotProgram && fresh.upgradeControl ? fresh.upgradeControl : prev.upgradeControl,
    multisig: gotMultisig ? fresh.multisig : prev.multisig,
    squadsMultisig: gotSquads ? fresh.squadsMultisig : prev.squadsMultisig,
    perpetuals: gotPerps ? fresh.perpetuals : prev.perpetuals,
    staleSections: [...(gotProgram ? [] : ["program"]), ...(gotMultisig ? [] : ["multisig"]), ...(gotSquads ? [] : ["squads"]), ...(gotPerps ? [] : ["perpetuals"])],
  };
  merged.fingerprint = fingerprintOf(merged);
  return merged;
}

module.exports = { fetchGovernance, diffGovernance, fingerprintOf, mergeGovernance, PROG };
