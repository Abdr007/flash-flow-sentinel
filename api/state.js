"use strict";
/*
 * FLASH FLOW SENTINEL — Vercel serverless core.
 * Serverless can't run the always-on daemon, so this function keeps warm-instance state and
 * advances it a bounded amount on every request:
 *   • forward pass  : new signatures since each vault's cursor → decoded flow events
 *   • backward pass : progressively extends history until the full 24h window is covered
 *   • conservation  : per-vault baseline set when its backfill completes; from then on
 *                     baseline + Σ new deltas must equal the live balance (raw u64)
 * The dashboard shows window coverage honestly while history is still building.
 * Routes (via vercel.json rewrites): GET /api/state · GET /api/events · GET|POST /api/limits
 */
const { PROG, scanCustodies, scanMarkets, scanNamedVaults, describeVault, sweepAuthority, fetchMarks, fetchVaultBalances } = require("../lib/custodies.cjs");
const { newSignatures, decodeFlow, classify } = require("../lib/flows.cjs");
const { fetchLazerMeta, fetchLazerLatest } = require("../lib/lazer.cjs");
const { fetchFlashLazerPrices, fetchFlashLazerIds } = require("../lib/flashprices.cjs");
const { DEFAULT_LIMITS, evaluate, ruleStates, hourlyBucketsBySide } = require("../lib/limits.cjs");
const { fetchGovernance, diffGovernance, mergeGovernance } = require("../lib/authority.cjs");
const { deliverAlert, heartbeat, channelsConfigured } = require("../lib/notify.cjs");
const { makeRpc } = require("../lib/rpc.cjs");

const ER_URL = process.env.ER_URL || "https://flashtrade.magicblock.app";
const MAIN_URL = process.env.RPC_URL || (process.env.HELIUS_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_KEY}` : "https://api.mainnet-beta.solana.com");
const WINDOW_H = Number(process.env.WINDOW_HOURS || 24);
const er = makeRpc(ER_URL, { minGapMs: 120 });
const main = makeRpc(MAIN_URL, { minGapMs: 110 });
const now = () => Math.floor(Date.now() / 1000);
const redact = (u) => { try { return new URL(u).hostname; } catch (e) { return "?"; } };

// ---------------- warm-instance state ----------------
const S = {
  inited: false, startedAt: now(),
  custodies: [], pools: 0, erSlot: null, markets: [],
  named: [], dynamic: {}, sweepBal: {}, authority: null,
  marks: {}, markTimes: {}, balances: {},
  events: [], eventKeys: new Set(), failures: [],
  cursors: {},        // vault → { lastSig, oldestSig, oldestTime, backfillDone, ready }
  conservation: {},   // vault → { baseRaw, baseTime, sumDeltas, residual, streak, status, rebases }
  governance: null, govBaseline: null, govChanges: [], lastGovCheck: 0,
  pyth: { feeds: {}, prices: {}, lastAt: 0, source: "flash-api" },
  flashLazerIds: {}, lazerIds: {},
  lazer: { token: process.env.LAZER_ACCESS_TOKEN || null, meta: {}, ok: false, reason: null },
  limits: (() => { try { return { ...DEFAULT_LIMITS, ...JSON.parse(process.env.LIMITS_JSON || "{}") }; } catch (e) { return { ...DEFAULT_LIMITS }; } })(),
  alertsActive: {}, alertsLog: [],
  lastEval: null, lastUpdate: null, cycles: 0, cycleErrors: [],
};
const realC = () => S.custodies.filter((c) => !c.isVirtual);
const tracked = () => [...realC(), ...S.named, ...Object.values(S.dynamic)];
const allDescriptors = () => [...S.custodies, ...S.named, ...Object.values(S.dynamic)];

function processAlerts(ev) {
  const next = ruleStates(ev), t = now();
  for (const [k, st] of Object.entries(next)) {
    const prev = S.alertsActive[k];
    if (!prev) { S.alertsActive[k] = { ...st, since: t }; if (st.status !== "ok") S.alertsLog.push({ time: t, rule: k, from: "ok", to: st.status, detail: st.detail }); }
    else if (prev.status !== st.status) { S.alertsActive[k] = { ...st, since: prev.since }; S.alertsLog.push({ time: t, rule: k, from: prev.status, to: st.status, detail: st.detail }); }
    else S.alertsActive[k].detail = st.detail;
  }
  for (const k of Object.keys(S.alertsActive)) { if (k.startsWith("gov:")) continue; if (!next[k]) { S.alertsLog.push({ time: t, rule: k, from: S.alertsActive[k].status, to: "ok", detail: "resolved" }); delete S.alertsActive[k]; } }
  if (S.alertsLog.length > 300) S.alertsLog = S.alertsLog.slice(-300);
}

async function ensureInit() {
  if (S.inited) return;
  const { custodies, pools, erSlot } = await scanCustodies(er);
  S.custodies = custodies; S.pools = pools; S.erSlot = erSlot;
  try {
    const rc0 = realC()[0];
    const r = await main("getMultipleAccounts", [[rc0.vault], { encoding: "jsonParsed" }]);
    S.authority = r.result.value[0].data.parsed.info.owner;
  } catch (e) {}
  const namedRaw = await scanNamedVaults(er, S.custodies);
  const sweep0 = S.authority ? await sweepAuthority(main, S.authority) : {};
  S.named = namedRaw.map((v) => describeVault(v, S.custodies, sweep0[v.ta] || null));
  for (const [ta, info] of Object.entries(sweep0)) S.sweepBal[ta] = info.amountRaw;
  try { S.flashLazerIds = await fetchFlashLazerIds(); } catch (e) {}
  S.inited = true;
}

/** Decode one batch of sigs for a vault; returns count. countConservation=false for history. */
async function decodeBatch(cust, sigs, countConservation, deadline) {
  let fresh = 0;
  for (const s of sigs) {
    if (Date.now() > deadline) break;
    const k = cust.custody + ":" + s.signature;
    if (S.eventKeys.has(k)) { continue; }
    const e = await decodeFlow(main, s, cust, S.marks[cust.custody]); // throws on transient gap → caller stops batch
    S.eventKeys.add(k);
    if (e) {
      S.events.push(e); fresh++;
      if (countConservation) { const c = S.conservation[cust.vault]; if (c) c.sumDeltas = (BigInt(c.sumDeltas) + BigInt(e.deltaRaw)).toString(); }
    }
  }
  return fresh;
}

/** Advance state within a wall-clock budget.
 *  waitForInflight=false (browser): if a build is already running, return immediately with the
 *  current snapshot instead of awaiting it — so a fetch never hangs behind a 45s keep-warm build. */
let inflight = null;
async function update(budgetMs, waitForInflight = true) {
  if (inflight) return waitForInflight ? inflight : undefined;
  inflight = (async () => {
    const deadline = Date.now() + budgetMs;
    S.cycleErrors = [];
    try {
      await ensureInit();
      const mk = await fetchMarks(er, main, allDescriptors());
      S.marks = mk.marks; S.markTimes = mk.markTimes; S.lazerIds = mk.lazerIds || {}; S.lazerMarks = mk.lazerMarks || {};
      try { S.markets = await scanMarkets(er, S.custodies, S.marks); } catch (e) { S.cycleErrors.push("markets: " + e.message); }
      const cutoff = now() - WINDOW_H * 3600;

      // -------- authority sweep: promote any moved untracked account to full tracking --------
      if (S.authority) {
        try {
          const sw = await sweepAuthority(main, S.authority);
          const tv = new Set(tracked().map((c) => c.vault));
          for (const [ta, info] of Object.entries(sw)) {
            if (!tv.has(ta) && S.sweepBal[ta] != null && S.sweepBal[ta] !== info.amountRaw) {
              S.dynamic[ta] = describeVault({ pda: ta, pool: "Authority", ta, mint: info.mint, kind: "swept" }, S.custodies, info);
            }
            S.sweepBal[ta] = info.amountRaw;
          }
        } catch (e) { S.cycleErrors.push("sweep: " + e.message); }
      }

      // -------- forward pass: new txs since each cursor --------
      // Build the highest-value vaults FIRST (TradeVault/named carry the biggest flows and the most
      // history) so the Trade-side card is populated early instead of showing a misleading $0 last.
      const buildOrder = [...S.named, ...realC(), ...Object.values(S.dynamic)];
      for (const cust of buildOrder) {
        if (Date.now() > deadline) break;
        const cur = S.cursors[cust.vault] || (S.cursors[cust.vault] = { lastSig: null, oldestSig: null, oldestTime: null, backfillDone: false, ready: false });
        try {
          const { sigs, failed } = await newSignatures(main, cust.vault, cur.lastSig, cutoff);
          for (const f of failed) if (!S.failures.some((x) => x.sig === f.sig)) S.failures.push({ vault: cust.vault, sig: f.sig, blockTime: f.blockTime });
          if (!cur.lastSig && sigs.length === 0) { cur.backfillDone = true; } // vault has no window activity
          if (sigs.length) {
            // first-ever forward pass doubles as this vault's full-window scan
            await decodeBatch(cust, sigs, cur.ready, deadline);
            // advance cursor through the fully processed prefix only
            let through = null;
            for (const s of sigs) { if (S.eventKeys.has(cust.custody + ":" + s.signature)) through = s; else break; }
            if (through) { cur.lastSig = through.signature; }
            if (!cur.oldestSig) { const o = sigs[0]; cur.oldestSig = o.signature; cur.oldestTime = o.blockTime; }
            if (through === sigs[sigs.length - 1] || S.eventKeys.has(cust.custody + ":" + sigs[sigs.length - 1].signature)) {
              if (!cur.ready) cur.backfillDone = true; // newSignatures already paged to the cutoff
            }
          }
        } catch (e) { S.cycleErrors.push(`${cust.pool}/${cust.symbol}: ${e.message}`); }
      }

      // -------- balances + conservation --------
      S.balances = await fetchVaultBalances(main, tracked());
      const t = now();
      for (const cust of tracked()) {
        const cur = S.cursors[cust.vault]; const bal = S.balances[cust.vault];
        if (!cur || bal == null) continue;
        if (cur.backfillDone && !cur.ready) { S.conservation[cust.vault] = { baseRaw: bal.toString(), baseTime: t, sumDeltas: "0", residual: "0", streak: 0, status: "exact", rebases: 0 }; cur.ready = true; continue; }
        const c = S.conservation[cust.vault]; if (!c) continue;
        const residual = bal - (BigInt(c.baseRaw) + BigInt(c.sumDeltas));
        c.residual = residual.toString();
        if (residual === 0n) { c.status = "exact"; c.streak = 0; }
        else { c.streak++; if (c.streak <= 2) c.status = "syncing"; else { c.status = "drift"; S.alertsLog.push({ time: t, rule: `conservation:${cust.pool}/${cust.symbol}`, from: "exact", to: "drift", detail: `residual ${residual} raw — rebasing` }); c.baseRaw = bal.toString(); c.baseTime = t; c.sumDeltas = "0"; c.streak = 0; c.rebases++; } }
      }

      if (Date.now() - S.pyth.lastAt > 15000) {
        let usedLazer = false;
        if (S.lazer.token) {
          try {
            if (!Object.keys(S.lazer.meta).length) S.lazer.meta = await fetchLazerMeta();
            const idBySym = {};
            for (const c of S.custodies) { const id = S.lazerIds[c.custody]; if (id && !(c.symbol in idBySym)) idBySym[c.symbol] = id; }
            const lp = await fetchLazerLatest([...new Set(Object.values(idBySym))], S.lazer.token, S.lazer.meta);
            const feeds = {}, prices = {};
            for (const [sym, id] of Object.entries(idBySym)) { const m = S.lazer.meta[id]; feeds[sym] = { id, pythSymbol: (m && m.symbol) || ("lazer#" + id), source: "lazer" }; if (lp[id]) prices[sym] = lp[id]; }
            if (Object.keys(prices).length) { S.pyth.feeds = feeds; S.pyth.prices = prices; S.pyth.source = "lazer"; S.lazer.ok = true; S.lazer.reason = null; usedLazer = true; }
          } catch (e) { S.lazer.ok = false; S.lazer.reason = e.message; }
        }
        if (!usedLazer) {
          try {
            const flash = await fetchFlashLazerPrices();
            const byMint = (S.flashLazerIds && S.flashLazerIds.byMint) || {};
            const feeds = {}, prices = {};
            for (const c of allDescriptors()) {
              if (c.symbol in feeds) continue;
              const reg = c.mint ? byMint[c.mint] : null;
              const apiSym = reg ? reg.symbol : (flash[c.symbol] ? c.symbol : null);
              if (!apiSym || !flash[apiSym]) continue;
              feeds[c.symbol] = { id: reg && reg.lazerId != null ? reg.lazerId : null, pythSymbol: "Lazer/" + apiSym, source: "flash-api" };
              prices[c.symbol] = flash[apiSym];
            }
            if (Object.keys(prices).length) { S.pyth.feeds = feeds; S.pyth.prices = prices; S.pyth.source = "flash-api"; }
          } catch (e) { S.cycleErrors.push("flashapi prices: " + e.message); }
        }
        S.pyth.lastAt = Date.now();
      }

      // governance & authority watch (throttled — rarely changes, 5 RPCs).
      // Cloud caveat: warm-instance only (no cross-recycle persistence) — the local daemon is the
      // authoritative alerter; here the card renders live and changes within a warm window alert.
      if (Date.now() - S.lastGovCheck > 120000) {
        try {
          const fresh = await fetchGovernance(main, er);
          if (fresh) {
            const prev = S.govBaseline;
            const gov = mergeGovernance(prev, fresh); // carry-forward failed sections (no false wolf)
            if (prev && prev.fingerprint !== gov.fingerprint) {
              const changes = diffGovernance(prev, gov);
              for (const ch of changes) {
                const a = { time: now(), rule: ch.key, from: "ok", to: "breach", severity: ch.severity, detail: ch.detail };
                S.govChanges.push(a); S.alertsLog.push(a); S.alertsActive[ch.key] = { status: "breach", detail: ch.detail, since: now() };
                deliverAlert(a, { webhookUrl: S.limits.webhookUrl });
              }
            }
            S.governance = gov; S.govBaseline = gov;
          }
        } catch (e) { S.cycleErrors.push("governance: " + e.message); }
        S.lastGovCheck = Date.now();
      }

      // retention + eval
      const keep = now() - WINDOW_H * 3600 - 3600;
      S.events = S.events.filter((e) => e.blockTime >= keep).sort((a, b) => a.blockTime - b.blockTime);
      S.eventKeys = new Set(S.events.map((e) => e.custody + ":" + e.sig));
      S.failures = S.failures.filter((f) => f.blockTime >= keep);
      const ev = evaluate(now(), S.events, S.failures, allDescriptors(), S.balances, S.marks, S.markTimes, S.lazerMarks || {}, S.pyth, S.limits, S.authority);
      processAlerts(ev);
      S.lastEval = ev; S.lastUpdate = now(); S.cycles++;
      heartbeat();
    } catch (e) { S.cycleErrors.push("update: " + (e.message || e)); }
  })();
  try { await inflight; } finally { inflight = null; }
}

function hourlyBuckets() {
  const t = now(), start = t - 24 * 3600, h0 = Math.floor(start / 3600) * 3600;
  const buckets = [];
  for (let h = h0; h <= t; h += 3600) buckets.push({ hourStart: h, inUsd: 0, outUsd: 0, inN: 0, outN: 0 });
  for (const e of S.events) {
    if (e.blockTime < start || e.blockTime > t) continue;
    if (S.authority && e.wallet === S.authority) continue; // internal reshuffles excluded
    const b = buckets[Math.floor((e.blockTime - h0) / 3600)]; if (!b) continue;
    if (e.direction === "out") { b.outUsd += e.usd || 0; b.outN++; } else { b.inUsd += e.usd || 0; b.inN++; }
  }
  return buckets.map((b) => ({ ...b, inUsd: Math.round(b.inUsd * 100) / 100, outUsd: Math.round(b.outUsd * 100) / 100 }));
}

function snapshot() {
  const rc = tracked();
  const ready = rc.filter((c) => S.cursors[c.vault] && S.cursors[c.vault].ready).length;
  const consRows = rc.map((c) => {
    const cv = S.conservation[c.vault]; const bal = S.balances[c.vault];
    return cv && { key: c.pool + "/" + c.symbol, vault: c.vault, baseRaw: cv.baseRaw, baseTime: cv.baseTime, sumDeltas: cv.sumDeltas, balanceRaw: bal == null ? null : bal.toString(), residual: cv.residual, status: cv.status, rebases: cv.rebases };
  }).filter(Boolean);
  return {
    meta: {
      name: "FLASH FLOW SENTINEL", program: PROG, cluster: "mainnet", erRpc: redact(ER_URL), mainRpc: redact(MAIN_URL),
      erSlot: S.erSlot, custodies: S.custodies.length, realVaults: realC().length, trackedVaults: rc.length, markets: S.markets.length, pools: S.pools,
      sweep: { authority: S.authority, watched: Object.keys(S.sweepBal).length, promoted: Object.keys(S.dynamic).length, namedVaults: S.named.map((n) => `${n.pool}/${n.symbol}`) },
      startedAt: S.startedAt, lastCycle: S.lastUpdate, cycleSeconds: null, pollMs: 10000, cycles: S.cycles, wsPush: false, cloud: true,
      backfillHours: WINDOW_H, retentionHours: WINDOW_H, eventsRetained: S.events.length,
      windowCoverage: { readyVaults: ready, of: rc.length, full: ready === rc.length && rc.length > 0 },
      cycleErrors: S.cycleErrors.slice(0, 8),
      oracleSource: S.pyth.source || "flash-api", lazer: { tokenPresent: !!S.lazer.token, ok: S.lazer.ok, reason: S.lazer.reason },
      channels: channelsConfigured(),
      squadsMofN: process.env.SQUADS_MOFN || "3-of-7", // Squads governance threshold (operator-set, verifiable on the Squads app)
      dataNote: "All values decoded from real on-chain state: base-chain SPL transfers (exact u64 vault deltas from pre/post token balances, confirmed commitment), ER custody/market/oracle accounts via the program's own on-chain IDL, Pyth Lazer cross-check. Tracked vaults = every custody vault + TradeVault + RebateVault + FAF TokenVault, plus a balance sweep of EVERY token account owned by the program's vault authority — any untracked account that moves is auto-promoted to full per-transaction tracking. Cloud mode: state advances on each request (10s CDN cache) and history builds progressively until the full window is covered. USD at the on-chain oracle mark observed at ingest. No synthetic data.",
      guardNote: "Guards bound the drain class seen across perp DEXes: a manipulated or stale price feed generating fake profits that exit the vaults within minutes.",
    },
    limits: S.limits,
    evaluation: S.lastEval || null,
    markets: S.markets,
    hourly: hourlyBuckets(),
    hourlySides: hourlyBucketsBySide(now(), S.events, S.authority),
    conservation: { rows: consRows, allExact: consRows.length > 0 && consRows.every((r) => r.status === "exact"), sinceOldestBase: consRows.length ? Math.min(...consRows.map((r) => r.baseTime)) : null },
    governance: S.governance ? { ...S.governance, changes: S.govChanges.slice(-40).reverse() } : null,
    alerts: { active: S.alertsActive, log: S.alertsLog.slice(-100).reverse() },
    events: S.events.slice(-250).reverse().map((e) => ({ ...e, kind: classify(e.ix || [], e.direction), internal: !!(S.authority && e.wallet === S.authority) })),
    failures1h: S.failures.filter((f) => f.blockTime >= now() - 3600).length,
    pythFeeds: Object.keys(S.pyth.feeds).length,
  };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  try {
    const url = new URL(req.url, "http://x");
    const route = url.searchParams.get("route") || "state";

    if (route === "limits" && req.method === "POST") {
      // Public deployment: limit writes require LIMITS_WRITE_TOKEN (header x-limits-token).
      // Without the env var configured, cloud limit writes are disabled entirely.
      const want = process.env.LIMITS_WRITE_TOKEN;
      if (!want || req.headers["x-limits-token"] !== want) {
        res.statusCode = want ? 403 : 405;
        res.setHeader("Cache-Control", "no-store");
        return res.end(JSON.stringify({ ok: false, error: want ? "invalid x-limits-token" : "limit writes are disabled on the public deployment — set LIMITS_WRITE_TOKEN env (and send it as x-limits-token) or use LIMITS_JSON for durable defaults" }));
      }
      let body = ""; for await (const c of req) { body += c; if (body.length > 65536) break; }
      const j = JSON.parse(body || "{}");
      const num = (v) => (v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0) ? v : undefined);
      const patch = {};
      for (const k of ["globalOutflowUsdPerHour", "defaultTokenOutflowUsdPerHour", "perWalletOutflowUsdPerHour", "vaultDrawdownPctPerHour", "oracleDeviationPct"]) if (num(j[k]) !== undefined) patch[k] = j[k];
      if (typeof j.warnFraction === "number" && j.warnFraction > 0 && j.warnFraction <= 1) patch.warnFraction = j.warnFraction;
      if (j.perTokenOutflowUsdPerHour && typeof j.perTokenOutflowUsdPerHour === "object") { patch.perTokenOutflowUsdPerHour = {}; for (const [k, v] of Object.entries(j.perTokenOutflowUsdPerHour)) if (num(v) !== undefined && v !== null) patch.perTokenOutflowUsdPerHour[k] = v; }
      if (j.webhookUrl === null || (typeof j.webhookUrl === "string" && /^https?:\/\//.test(j.webhookUrl))) patch.webhookUrl = j.webhookUrl;
      S.limits = { ...S.limits, ...patch };
      if (S.lastEval) { const ev = evaluate(now(), S.events, S.failures, allDescriptors(), S.balances, S.marks, S.markTimes, S.lazerMarks || {}, S.pyth, S.limits, S.authority); processAlerts(ev); S.lastEval = ev; }
      res.setHeader("Cache-Control", "no-store");
      return res.end(JSON.stringify({ ok: true, limits: S.limits, note: "cloud mode: limits persist per warm instance; set LIMITS_JSON env var for durable defaults" }));
    }
    if (route === "limits") { res.setHeader("Cache-Control", "no-store"); return res.end(JSON.stringify(S.limits)); }

    if (route === "ack" && req.method === "POST") {
      const want = process.env.LIMITS_WRITE_TOKEN;
      if (!want || req.headers["x-limits-token"] !== want) { res.statusCode = want ? 403 : 405; res.setHeader("Cache-Control", "no-store"); return res.end(JSON.stringify({ ok: false, error: want ? "invalid x-limits-token" : "ack disabled on public deployment (set LIMITS_WRITE_TOKEN)" })); }
      const rule = url.searchParams.get("rule");
      if (rule === "all") { for (const k of Object.keys(S.alertsActive)) if (k.startsWith("gov:")) delete S.alertsActive[k]; }
      else if (rule && S.alertsActive[rule]) delete S.alertsActive[rule];
      res.setHeader("Cache-Control", "no-store");
      return res.end(JSON.stringify({ ok: true, active: Object.keys(S.alertsActive) }));
    }

    // Separate BUILD from SERVE so a browser fetch never hangs on "CONNECTING":
    //   • keep-warm pings (?build=1, not browser-facing) do the heavy backfill (up to 45s < 60s cap)
    //   • browser requests use a SHORT budget so they always respond in a couple seconds, showing
    //     honest "building…" state until keep-warm has filled coverage (then instant full data).
    const isBuildPing = url.searchParams.has("build");
    if (isBuildPing) await update(45000, true);                 // keep-warm: do the heavy backfill
    else await update(S.inited ? 3000 : 6000, false);           // browser: never block behind a long build

    if (route === "events") {
      const hours = Math.min(Number(url.searchParams.get("hours") || 24), WINDOW_H);
      const cutoff = now() - hours * 3600;
      res.setHeader("Cache-Control", "s-maxage=10, stale-while-revalidate=30");
      return res.end(JSON.stringify(S.events.filter((e) => e.blockTime >= cutoff).slice(-5000).reverse()));
    }
    res.setHeader("Cache-Control", "s-maxage=10, stale-while-revalidate=30");
    return res.end(JSON.stringify(snapshot()));
  } catch (e) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: e.message || String(e) }));
  }
};
