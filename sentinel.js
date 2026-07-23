"use strict";
/*
 * FLASH FLOW SENTINEL
 * ------------------------------------------------------------------------------------------------
 * Real-time inflow/outflow monitor + outflow rate limits for every token traded on Flash V2
 * (program FLASH6…, Solana mainnet). Defenses: an hourly outflow cap across all wallets,
 * per-token caps, per-wallet concentration, vault drawdown velocity, failure spikes,
 * and an independent Pyth cross-check of the protocol oracle.
 *
 * DATA HONESTY: every number is derived from real chain state —
 *   • custodies + oracle marks: MagicBlock mainnet ER, program's own on-chain IDL
 *   • flow events: real base-chain transactions (exact u64 vault deltas from pre/post balances)
 *   • vault balances: base-chain SPL token accounts, raw u64
 *   • cross-check prices: Pyth Lazer (direct with token, else the Flash V2 API Lazer feed)
 * A live flow-conservation proof (baseline + Σ deltas == current balance, raw u64) is computed
 * per vault every cycle, so the dashboard can PROVE it hasn't missed a transfer.
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { makeRpc } = require("./lib/rpc.cjs");
const { PROG, mergeSymbols, symbolForMint, scanCustodies, scanMarkets, scanNamedVaults, describeVault, sweepAuthority, fetchMarks, fetchVaultBalances } = require("./lib/custodies.cjs");
const { fetchPoolConfigSymbols } = require("./lib/poolconfig.cjs");
const { newSignatures, decodeFlow, classify } = require("./lib/flows.cjs");
const { fetchLazerMeta, fetchLazerLatest } = require("./lib/lazer.cjs");
const { fetchFlashLazerPrices, fetchFlashLazerIds } = require("./lib/flashprices.cjs");
const { DEFAULT_LIMITS, evaluate, ruleStates, hourlyBucketsBySide } = require("./lib/limits.cjs");
const { fetchGovernance, diffGovernance, mergeGovernance } = require("./lib/authority.cjs");
const { deliverAlert, heartbeat, sendTelegram, sendOperator, sendSecurityAlert, sendWithdrawalNotice, sendOrEditLiveStatus, channelsConfigured } = require("./lib/notify.cjs");
const containment = require("./lib/containment.cjs"); // Layer 3 — proof-gated auto-containment
const reconwatch = require("./lib/reconwatch.cjs");

// ---------------- config ----------------
const ER_URL = process.env.ER_URL || "https://flashtrade.magicblock.app";
const MAIN_URL = process.env.RPC_URL || (process.env.HELIUS_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_KEY}` : "https://api.mainnet-beta.solana.com");
const POLL_MS = Number(process.env.POLL_MS || 12000);
const DIGEST_INTERVAL_S = Number(process.env.DIGEST_INTERVAL_S || 86400); // daily status digest to the channel
const WEEKLY_INTERVAL_S = Number(process.env.WEEKLY_INTERVAL_S || 604800); // weekly deep-dive post
const CUSTODY_REFRESH_MS = Number(process.env.CUSTODY_REFRESH_MS || 600000);
const BACKFILL_HOURS = Number(process.env.BACKFILL_HOURS || 24);
const RETENTION_HOURS = Number(process.env.RETENTION_HOURS || 48);
const PORT = Number(process.env.PORT || 4646);
// On a hosting platform ($PORT is injected) bind all interfaces; locally stay on loopback.
const HOST = process.env.HOST || (process.env.PORT ? "0.0.0.0" : "127.0.0.1");

const DATA = path.join(__dirname, "data");
const F_EVENTS = path.join(DATA, "events.jsonl");
const F_STATE = path.join(DATA, "state.json");
const F_LIMITS = path.join(DATA, "limits.json");
const F_ALERTS = path.join(DATA, "alerts.jsonl");

const er = makeRpc(ER_URL, { minGapMs: 150 });
const main = makeRpc(MAIN_URL, { minGapMs: 130 });
const now = () => Math.floor(Date.now() / 1000);
const redact = (u) => { try { const x = new URL(u); return x.hostname; } catch (e) { return "?"; } };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------------- state ----------------
const S = {
  startedAt: now(),
  custodies: [], pools: 0, erSlot: null,
  markets: [],               // every Market account on the ER (full traded universe)
  named: [],                 // TradeVault / RebateVault / TokenVault descriptors (custody-shaped)
  dynamic: {},               // ta → descriptor: authority-swept accounts promoted on first movement
  sweepBal: {},              // ta → last seen raw balance for ALL authority-owned token accounts
  authority: null,           // the program's vault authority PDA (read from chain)
  marks: {},                 // custody → mark USD (on-chain CustomOracle)
  markTimes: {},             // custody → CustomOracle publish_time (unix) — proves staleness
  balances: {},              // vault → BigInt | null
  vaultState: {},            // vault → { lastSig }
  events: [],                // ascending blockTime, retained window
  eventKeys: new Set(),      // `${vault}:${sig}` dedupe
  failures: [],              // { vault, sig, blockTime }
  conservation: {},          // vault → { baseRaw, baseTime, sumDeltas, residual, streak, status, rebases }
  reconKnown: {},            // marketAccount → known basket-vs-market mismatch (persisted; only NEW ones alert)
  reconSeeded: false,        // once true, a phantom present at first boot has been silently baselined
  reconStatus: null,         // last census reconciliation summary { mismatched, marketSides, allExact, checkedAt }
  governance: null,          // live governance snapshot (upgrade auth, multisig, permissions)
  govBaseline: null,         // last-good full governance snapshot for change detection (persisted)
  govChanges: [],            // recorded governance changes (also alerts) — drives the red governance verdict
  authorizedUpgrades: [],    // program upgrades AUTO-VERIFIED as authorized (multisig, authority unchanged) — informational review-log, NOT red
  wAlertFrom: 0,             // watermark: only notify withdrawals at/after this ts (set when the feed is enabled — never dump the backlog)
  wAlertSent: [],            // capped list of already-notified withdrawal keys (sig:custody) so none is sent twice
  wSummaryLast: 0,           // last hourly-summary send (persisted) — one summary per WSUMMARY_INTERVAL, no spam
  wFreshToken: null,         // last WITHDRAWAL_FRESH_START value applied
  knownPrograms: {},         // programId → firstSeen — every program ever seen touching Flash vaults (new-program detector)
  progSeeded: false,         // once true, the existing program set is baselined; only NEW programs alert
  knownSettlers: {},         // signer → firstSeen — authorized ER→base settlement crank(s) (ProcessUndelegation). ANY new settler = the AFX compromised-signer fingerprint (auth-model-aware; conservation/census are auth-agnostic and can't raise this).
  settlerSeeded: false,      // once true, the authorized settler set is baselined; only a NEW settler alarms
  probeFunders: {},          // probe wallet → funding source (in-memory cache; re-traced on restart, only runs when a cluster exists)
  probeClusterKey: null,     // latch: last-alerted coordinated-cluster signature (funder:count) so a proven cluster alarms once
  containment: { trips: {}, lastTrip: null, checked: {} }, // Layer 3: proven-drain trips (persisted) + in-memory verify cache
  liveStatusMsgId: null,     // Telegram message_id of the live-status message (edited in place every minute; persisted so restarts reuse it, no dupes)
  liveStatusLast: 0,         // last live-status edit time (in-memory)
  lastHourlySummary: 0,      // last hourly transaction-report send (persisted so a restart doesn't re-send within the hour)
  lastDigestUnix: 0,         // last daily-digest broadcast (persisted; survives restarts)
  lastWeeklyUnix: 0,         // last weekly deep-dive broadcast (persisted)
  pyth: { feeds: {}, prices: {}, source: "flash-api" },
  flashLazerIds: {},         // symbol → official Lazer feed id (from flashapi /tokens)
  lazerIds: {},              // custody → on-chain lazer_feed_id
  lazer: { token: process.env.LAZER_ACCESS_TOKEN || null, meta: {}, ok: false, reason: null },
  limits: { ...DEFAULT_LIMITS },
  alertsActive: {},          // ruleKey → { status, detail, since }
  alertsLog: [],             // recent transitions (also appended to alerts.jsonl)
  lastCycle: null, cycleSeconds: null, cycleErrors: [], cycles: 0,
  ready: false,            // false until the initial backfill completes → suppresses a premature green verdict
  coverageDegraded: null,  // set if a custody scan returned materially fewer vaults than the high-water mark
  custodyHighWater: 0,     // most vaults ever seen in one scan (persisted → a flaky boot can't lower the bar; coverage-shrink guard)
  driftAccum: {},          // wallet → cumulative net outflow USD, persisted ACROSS event pruning — slow-drip nominator for the proof
  driftAccumAt: 0,         // watermark blockTime up to which drift has been accumulated
  solvencyBuffer: { accum: 0, lastSurplus: null, lastAt: 0, alertAt: 0 }, // cross-domain unbacked-outflow watch: census surplus erosion PAIRED with base outflow (AFX buffer-drain, caught before insolvency)
  sse: new Set(),
};

// ---------------- persistence ----------------
function loadLimits() {
  try { S.limits = { ...DEFAULT_LIMITS, ...JSON.parse(fs.readFileSync(F_LIMITS, "utf8")) }; }
  catch (e) { fs.writeFileSync(F_LIMITS, JSON.stringify(DEFAULT_LIMITS, null, 2)); }
}
function saveLimits() { fs.writeFileSync(F_LIMITS, JSON.stringify(S.limits, null, 2)); }
function loadState() {
  try {
    const j = JSON.parse(fs.readFileSync(F_STATE, "utf8"));
    S.vaultState = j.vaultState || {};
    S.alertsActive = j.alertsActive || {};   // don't re-fire alerts that were already active
    S.alertsLog = j.alertsLog || [];
    S.sweepBal = j.sweepBal || {};           // so movements during downtime are still caught
    S.dynamic = j.dynamic || {};             // promoted accounts stay fully tracked
    S.govBaseline = j.govBaseline || null;   // detect governance changes across restarts too
    S.govChanges = j.govChanges || [];
    S.conservation = j.conservation || {};   // persist the conservation baseline so a restart can't re-baseline away a pre-existing missed-transfer drift (false "exact")
    S.reconKnown = j.reconKnown || {};        // persist known phantom mismatches so a restart doesn't re-alert them
    S.reconSeeded = !!j.reconSeeded;
    S.authorizedUpgrades = j.authorizedUpgrades || [];
    S.wAlertFrom = j.wAlertFrom || 0;
    S.wAlertSent = j.wAlertSent || [];
    S.wFreshToken = j.wFreshToken || null;
    S.wSummaryLast = j.wSummaryLast || 0;
    S.knownPrograms = j.knownPrograms || {};
    S.progSeeded = !!j.progSeeded;
    S.knownSettlers = j.knownSettlers || {};
    S.settlerSeeded = !!j.settlerSeeded;
    S.probeClusterKey = j.probeClusterKey || null;
    S.containment = { trips: (j.containment && j.containment.trips) || {}, lastTrip: (j.containment && j.containment.lastTrip) || null, checked: {} };
    S.liveStatusMsgId = j.liveStatusMsgId || null;
    S.lastHourlySummary = j.lastHourlySummary || 0;
    S.custodyHighWater = j.custodyHighWater || 0;
    S.driftAccum = j.driftAccum || {};
    S.driftAccumAt = j.driftAccumAt || 0;
    S.solvencyBuffer = j.solvencyBuffer || { accum: 0, lastSurplus: null, lastAt: 0, alertAt: 0 };
    S.lastDigestUnix = j.lastDigestUnix || 0; // don't re-send the digest on every restart
    S.lastWeeklyUnix = j.lastWeeklyUnix || 0;
    S.lastSavedAt = j.savedAt || 0;           // to detect how long the daemon was down across a restart
  } catch (e) {}
}
function saveState() {
  const data = JSON.stringify({ vaultState: S.vaultState, alertsActive: S.alertsActive, alertsLog: S.alertsLog.slice(-200), sweepBal: S.sweepBal, dynamic: S.dynamic, govBaseline: S.govBaseline, govChanges: S.govChanges.slice(-100), conservation: S.conservation, reconKnown: S.reconKnown, reconSeeded: S.reconSeeded, authorizedUpgrades: S.authorizedUpgrades.slice(-50), wAlertFrom: S.wAlertFrom, wAlertSent: S.wAlertSent.slice(-20000), wFreshToken: S.wFreshToken, wSummaryLast: S.wSummaryLast, knownPrograms: S.knownPrograms, progSeeded: S.progSeeded, knownSettlers: S.knownSettlers, settlerSeeded: S.settlerSeeded, probeClusterKey: S.probeClusterKey, containment: { trips: S.containment.trips, lastTrip: S.containment.lastTrip }, liveStatusMsgId: S.liveStatusMsgId, lastHourlySummary: S.lastHourlySummary, custodyHighWater: S.custodyHighWater, driftAccum: S.driftAccum, driftAccumAt: S.driftAccumAt, solvencyBuffer: S.solvencyBuffer, lastDigestUnix: S.lastDigestUnix, lastWeeklyUnix: S.lastWeeklyUnix, savedAt: now() }, null, 2);
  // ATOMIC write: a crash mid-write must never leave a half-written state file (which would wipe the sent-
  // history on reboot and re-send withdrawals). Write to a temp file, then rename — rename is atomic on the
  // volume's filesystem, so readers only ever see a complete file.
  try { fs.writeFileSync(F_STATE + ".tmp", data); fs.renameSync(F_STATE + ".tmp", F_STATE); }
  catch (e) { try { fs.writeFileSync(F_STATE, data); } catch (e2) {} } // fall back to direct write on any rename issue
}
function loadEvents() {
  const cutoff = now() - RETENTION_HOURS * 3600;
  let lines = [];
  try { lines = fs.readFileSync(F_EVENTS, "utf8").split("\n").filter(Boolean); } catch (e) { return; }
  for (const ln of lines) {
    try {
      const e = JSON.parse(ln);
      if (e.blockTime == null || e.blockTime < cutoff) continue;
      const k = e.custody + ":" + e.sig;
      if (S.eventKeys.has(k)) continue;
      S.eventKeys.add(k); S.events.push(e);
    } catch (err) {}
  }
  S.events.sort((a, b) => a.blockTime - b.blockTime);
  // rotate the file down to the retained window if it has grown
  if (lines.length > S.events.length * 2 || (fs.existsSync(F_EVENTS) && fs.statSync(F_EVENTS).size > 25e6)) {
    fs.writeFileSync(F_EVENTS, S.events.map((e) => JSON.stringify(e)).join("\n") + (S.events.length ? "\n" : ""));
  }
  log(`loaded ${S.events.length} retained events from disk`);
}
function appendEvent(e) { fs.appendFileSync(F_EVENTS, JSON.stringify(e) + "\n"); }
function appendAlert(a) { fs.appendFileSync(F_ALERTS, JSON.stringify(a) + "\n"); }
function pruneMemory() {
  const cutoff = now() - RETENTION_HOURS * 3600;
  while (S.events.length && S.events[0].blockTime < cutoff) { const e = S.events.shift(); S.eventKeys.delete(e.custody + ":" + e.sig); }
  S.failures = S.failures.filter((f) => f.blockTime >= cutoff);
  if (S.alertsLog.length > 500) S.alertsLog = S.alertsLog.slice(-500);
}

// ---------------- alerts ----------------
function fireWebhook(a, tokens) {
  // fan out to every configured channel (generic webhook + Telegram + Slack). `tokens` = the current
  // evaluated on-chain token set, so Telegram can attach the matching chart image (defaults to the last
  // evaluation for call sites — governance/conservation — that don't have it directly in scope).
  deliverAlert(a, { webhookUrl: S.limits.webhookUrl, tokens: tokens || (S.lastEval && S.lastEval.tokens) || null });
}
function processAlertTransitions(ev) {
  const next = ruleStates(ev);
  const t = now();
  // Oracle mark-vs-Lazer deviation is informational (not a vault-drain signal) and frequent — per the Flash
  // team it must NOT be pushed to the main channel. We still record it on the dashboard + alert log; we just
  // suppress the external notification for oracle:* rules.
  const pushAlert = (a, tokens) => { if (!String(a.rule || "").startsWith("oracle:")) fireWebhook(a, tokens); };
  // PROVEN-ONLY POLICY: the windowed entitlement/threat rules are HEURISTICS (a threshold on a 1h/24h window).
  // A heuristic is NOT proof, so it NEVER DMs on its own — it only marks the wallet on the dashboard and sets
  // cand.entitlement, which makes runContainment() re-verify that wallet on its NEXT pass. The actual Telegram
  // alarm — the wallet's ENTIRE on-chain history checked to prove it withdrew more than it ever deposited — is
  // sent by runContainment(). Likewise every other Telegram alarm (census solvency, conservation, phantom,
  // fresh-program, probe-cluster, governance) is verified on-chain before it fires. No raw "breach" ever DMs.
  const secSend = () => {};
  for (const [key, st] of Object.entries(next)) {
    const prev = S.alertsActive[key];
    if (!prev) {
      S.alertsActive[key] = { ...st, since: t };
      if (st.status !== "ok") { // never log/webhook a rule that starts green
        const a = { time: t, rule: key, from: "ok", to: st.status, detail: st.detail, severity: st.severity };
        S.alertsLog.push(a); appendAlert(a); pushAlert({ source: "flash-flow-sentinel", ...a }, ev.tokens); secSend(key, st);
        log(`ALERT ${(st.severity || st.status).toUpperCase()} ${key} — ${st.detail}`);
      }
    } else if (prev.status !== st.status) {
      const a = { time: t, rule: key, from: prev.status, to: st.status, detail: st.detail, severity: st.severity };
      S.alertsActive[key] = { ...st, since: prev.since };
      S.alertsLog.push(a); appendAlert(a); pushAlert({ source: "flash-flow-sentinel", ...a }, ev.tokens); secSend(key, st);
      log(`ALERT ${prev.status}→${st.status} ${key} — ${st.detail}`);
    } else {
      S.alertsActive[key].detail = st.detail; S.alertsActive[key].severity = st.severity; // keep severity fresh even when status is unchanged (e.g. a threat escalating within "breach")
    }
  }
  for (const key of Object.keys(S.alertsActive)) {
    if (key.startsWith("gov:")) continue; // governance changes are latched — cleared only by human ack
    if (!next[key]) {
      const a = { time: t, rule: key, from: S.alertsActive[key].status, to: "ok", detail: "resolved" };
      delete S.alertsActive[key];
      S.alertsLog.push(a); appendAlert(a); pushAlert(a);
      log(`ALERT resolved ${key}`);
    }
  }
}

// ---------------- daily status digest (broadcast to the channel) ----------------
const money = (n) => { const a = Math.abs(n || 0); const s = (n || 0) < 0 ? "-" : ""; return a >= 1e6 ? s + "$" + (a / 1e6).toFixed(2) + "M" : a >= 1e3 ? s + "$" + (a / 1e3).toFixed(1) + "k" : s + "$" + a.toFixed(0); };
function composeDigest() {
  const ev = S.lastEval, g = ev && ev.global, gv = S.governance;
  const consEx = Object.values(S.conservation).filter((c) => c.status === "exact").length, consN = Object.keys(S.conservation).length;
  const tokBad = ev ? ev.tokens.filter((t) => t.status !== "ok").length : 0;
  const walBad = ev ? ev.wallets.filter((w) => w.status !== "ok").length : 0;
  const oraBad = ev ? ev.oracle.filter((o) => o.status === "breach").length : 0;
  const govChg = gv && gv.changes ? gv.changes.length : 0;
  const allGreen = g && g.status === "ok" && !tokBad && !walBad && !oraBad && !govChg;
  const tr = ev && ev.sides.find((s) => s.side === "trade"), lp = ev && ev.sides.find((s) => s.side === "lp");
  const oraLive = ev ? ev.oracle.filter((o) => o.deviationPct != null) : [];
  const worst = oraLive.length ? oraLive.reduce((a, b) => (b.deviationPct > a.deviationPct ? b : a)) : null;
  const tvl = ev ? ev.tokens.reduce((s, t) => s + (t.vaultUsd || 0), 0) : 0;
  const L = [];
  L.push(`📊 FLASH FLOW SENTINEL — Daily Status`);
  L.push(``);
  L.push(allGreen ? `✅ All flow guards GREEN` : `⚠️ ${[g && g.status !== "ok" ? "global cap" : null, tokBad ? tokBad + " token" : null, walBad ? walBad + " wallet" : null, oraBad ? oraBad + " oracle" : null, govChg ? govChg + " governance" : null].filter(Boolean).join(", ")} tripped`);
  L.push(`🏦 ${S.custodies ? tracked().length : 0} vaults · TVL ${money(tvl)} · conservation ${consEx}/${consN} exact`);
  if (g) L.push(`💵 24h flow: ▲ ${money(g.in24hUsd)} in · ▼ ${money(g.out24hUsd)} out (net ${money(g.in24hUsd - g.out24hUsd)})`);
  if (tr && lp) L.push(`📈 Trade ▲${money(tr.in24hUsd)}/▼${money(tr.out24hUsd)} · LP ▲${money(lp.in24hUsd)}/▼${money(lp.out24hUsd)}`);
  L.push(`🔮 Oracle: ${oraLive.length} feeds checked${worst ? ` · worst ${worst.symbol} ${worst.deviationPct}% vs Lazer` : ""}`);
  L.push(`🛡️ Governance: ${govChg ? "⚠️ " + govChg + " change(s)" : "stable"} · Squads ${process.env.SQUADS_MOFN || "3-of-7"} multisig-gated upgrades`);
  L.push(``);
  L.push(`🔗 flash-flow-sentinel.vercel.app`);
  return L.join("\n");
}
// ---------------- live status — ONE private-DM message, edited in place every minute (no spam) ----------------
const LIVE_STATUS = () => process.env.LIVE_STATUS === "1";
const LIVE_STATUS_SEC = Number(process.env.LIVE_STATUS_SEC || 60);
let liveStatusBusy = false;
function buildLiveStatus() {
  const ev = S.lastEval; if (!ev || !ev.global) return null;
  const g = ev.global;
  const rows = conservationRows(); const cn = rows.length, cx = rows.filter((r) => r.status === "exact").length;
  const consOk = cn > 0 && cx === cn;
  const sv = S.reconStatus && S.reconStatus.solvency;
  const svOk = !!(sv && sv.present && sv.allHold && !sv.stale);
  const phantom = (S.reconStatus && S.reconStatus.mismatched) || 0;
  const govN = (S.govChanges || []).length;
  const contTrips = Object.keys(S.containment.trips || {}).length;
  const tvl = (ev.tokens || []).reduce((s, t) => s + (t.vaultUsd || 0), 0);
  const oi = (S.markets || []).reduce((s, m) => s + (m.oiUsd || 0), 0);
  const out24 = (ev.tokens || []).reduce((s, t) => s + (t.out24hUsd || 0), 0);
  const wallets1h = (ev.wallets || []).filter((w) => (w.out1hUsd || 0) > 0).length;
  const stale = S.lastCycle ? now() - S.lastCycle : null;
  const allGreen = consOk && svOk && g.status === "ok" && !phantom && !govN && !contTrips;
  const L = (ok, label, val) => `${ok ? "✅" : "🔴"} ${label}: ${val}`;
  const usd = (n) => "$" + Math.round(n || 0).toLocaleString("en-US");
  const hhmmss = new Date(now() * 1000).toISOString().slice(11, 19);
  return [
    `${allGreen ? "🟢" : "🔴"} FLASH V2 · FLOW SENTINEL — LIVE`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `updated ${hhmmss} UTC · cycle #${S.cycles} · ${stale != null ? stale + "s ago" : "—"}`,
    ``,
    `PROVEN GUARDS (verified on-chain)`,
    L(consOk, "Conservation (u64)", `${cx}/${cn} exact`),
    L(svOk, "Solvency (census)", sv ? (sv.stale ? "stale" : (sv.allHold ? `all hold · deficit ${sv.deficit || 0}` : `${(sv.fails || []).length} FAILED`)) : "syncing"),
    L(!phantom, "Phantom positions", `${phantom} open`),
    L(!govN, "Governance / authority", govN ? `${govN} change` : "stable"),
    L(!contTrips, "Over-withdrawal", contTrips ? `${contTrips} PROVEN` : "none proven"),
    ``,
    `FLOW (real on-chain)`,
    `Out 1h ${usd(g.out1hUsd)} · In 1h ${usd(g.in1hUsd)} · Net ${usd((g.in1hUsd || 0) - (g.out1hUsd || 0))}`,
    `Out 24h ${usd(out24)} · TVL $${(tvl / 1e6).toFixed(2)}M · OI $${(oi / 1e6).toFixed(2)}M`,
    `Withdrawing wallets (1h): ${wallets1h}`,
    ``,
    `cycle ${S.cycleSeconds}s · ${wsUp ? "WS push ⚡" : "poll"} · wedges ${cycleWedges} · alarms → this DM (proven-only)`,
    `🔗 flash-flow-sentinel.vercel.app`,
  ].join("\n");
}
async function maybeSendLiveStatus() {
  if (!LIVE_STATUS() || liveStatusBusy) return;
  if (S.liveStatusLast && now() - S.liveStatusLast < LIVE_STATUS_SEC) return;
  liveStatusBusy = true;
  try {
    const text = buildLiveStatus(); if (!text) return;
    const id = await sendOrEditLiveStatus(text, S.liveStatusMsgId);
    if (id && id !== S.liveStatusMsgId) { S.liveStatusMsgId = id; saveState(); } // persist only on a NEW message (first post / repost)
    S.liveStatusLast = now();
  } catch (e) { S.cycleErrors.push("livestatus: " + (e.message || e)); }
  finally { liveStatusBusy = false; }
}
// ---------------- hourly transaction report → operator's private DM ----------------
const HOURLY_SUMMARY = () => process.env.HOURLY_SUMMARY === "1";
const HOURLY_SUMMARY_SEC = Number(process.env.HOURLY_SUMMARY_SEC || 3600);
function composeHourlySummary() {
  const cut = now() - HOURLY_SUMMARY_SEC;
  const evs = (S.events || []).filter((e) => e.blockTime >= cut && !(S.authority && e.wallet === S.authority)).sort((a, b) => a.blockTime - b.blockTime); // chronological, internal vault→vault excluded
  const outEv = evs.filter((e) => e.direction === "out"), inEv = evs.filter((e) => e.direction === "in");
  const sum = (a) => a.reduce((s, e) => s + (e.usd || 0), 0);
  const usd = (n) => "$" + Math.round(n || 0).toLocaleString("en-US");
  const ev = S.lastEval || {}; const rows = conservationRows(); const consOk = rows.length && rows.every((r) => r.status === "exact");
  const sv = S.reconStatus && S.reconStatus.solvency; const tokBad = ((ev.tokens) || []).filter((t) => t.status === "breach").length;
  const contTrips = Object.keys(S.containment.trips || {}).length;
  const hh = new Date(now() * 1000).toISOString().slice(11, 16);
  const header = [
    `📊 HOURLY REPORT · FLASH V2 · ${hh} UTC`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `${evs.length} transactions in the last 60m`,
    `Outflow ${usd(sum(outEv))} (${outEv.length}) · Inflow ${usd(sum(inEv))} (${inEv.length}) · Net ${usd(sum(inEv) - sum(outEv))}`,
    `Guards: ${tokBad || contTrips ? "⚠️ " + tokBad + " token / " + contTrips + " drain" : "all green ✅"} · conservation ${consOk ? "exact ✅" : "syncing"} · solvency ${sv && sv.allHold ? "hold ✅" : "—"}`,
  ].join("\n");
  if (!evs.length) return [header + "\n\nNo transactions this hour.\n🔗 flash-flow-sentinel.vercel.app"];
  // FULL list — EVERY transaction with its FULL wallet address + FULL solscan link (auto-links in Telegram)
  const lines = evs.map((e) => {
    const t = new Date(e.blockTime * 1000).toISOString().slice(11, 16);
    const kind = classify(e.ix || [], e.direction) || (e.direction === "out" ? "OUT" : "IN");
    const arrow = e.direction === "out" ? "🔴 OUT" : "🟢 IN ";
    return `${t} ${arrow} ${usd(e.usd)} ${e.symbol || "?"} · ${kind}\n${e.wallet || "unknown"}\nhttps://solscan.io/tx/${e.sig}`;
  });
  // pack into ≤3900-char Telegram messages; header leads the first chunk
  const chunks = []; let buf = header + "\n\n— all transactions —";
  for (const ln of lines) {
    if ((buf + "\n\n" + ln).length > 3900) { chunks.push(buf); buf = ln; }
    else buf += "\n\n" + ln;
  }
  if (buf) chunks.push(buf);
  const n = chunks.length;
  return chunks.map((c, i) => c + (n > 1 ? `\n\n— part ${i + 1}/${n} —` : "") + (i === n - 1 ? "\n🔗 flash-flow-sentinel.vercel.app" : ""));
}
let hourlyBusy = false;
async function maybeSendHourlySummary() {
  if (!HOURLY_SUMMARY() || hourlyBusy || !S.ready) return;
  if (S.lastHourlySummary && now() - S.lastHourlySummary < HOURLY_SUMMARY_SEC) return;
  hourlyBusy = true;
  try {
    const chunks = composeHourlySummary(); // array of ≤4k-char messages (every tx, full addr + full link)
    let allOk = true;
    for (const ch of chunks) { const r = await sendSecurityAlert(ch); if (!r) allOk = false; await new Promise((res) => setTimeout(res, 1200)); } // pace to stay under Telegram limits
    if (allOk) { S.lastHourlySummary = now(); saveState(); } // advance only if EVERY part delivered, else retry next cycle
  } catch (e) { S.cycleErrors.push("hourly: " + (e.message || e)); }
  finally { hourlyBusy = false; }
}
function maybeSendDigest() {
  if (!S.lastEval) return; // wait until we have a real evaluation
  const t = now();
  if (t - (S.lastDigestUnix || 0) < DIGEST_INTERVAL_S) return;
  S.lastDigestUnix = t;
  sendTelegram(composeDigest());
  log(`digest broadcast to channel`);
}

// ---------------- weekly deep-dive (richer analytics broadcast) ----------------
const shortAddr = (a) => (a ? a.slice(0, 4) + "…" + a.slice(-4) : "—");
function composeWeekly() {
  const ev = S.lastEval, gv = S.governance;
  const wk = now() - 7 * 86400;
  // the week's guard record from the persisted alert log
  const wkLog = (S.alertsLog || []).filter((a) => a.time >= wk);
  const breaches = wkLog.filter((a) => a.to === "breach" && !a.rule.startsWith("gov:")).length;
  const warns = wkLog.filter((a) => a.to === "warn").length;
  const govEvents = (S.govChanges || []).filter((a) => a.time >= wk);
  const deploys = govEvents.filter((a) => a.rule === "gov:program-deploy").length;
  const activeNow = Object.values(S.alertsActive || {}).filter((a) => a.status === "warn" || a.status === "breach").length;

  const tokens = (ev && ev.tokens) || [];
  const topOut = [...tokens].filter((t) => t.out24hUsd > 0).sort((a, b) => b.out24hUsd - a.out24hUsd).slice(0, 3);
  const topBal = [...tokens].sort((a, b) => (b.vaultUsd || 0) - (a.vaultUsd || 0))[0];
  const wallets = ((ev && ev.wallets) || []).filter((w) => w.out24hUsd > 0).slice(0, 3);
  const tr = ev && ev.sides.find((s) => s.side === "trade"), lp = ev && ev.sides.find((s) => s.side === "lp"), stk = ev && ev.sides.find((s) => s.side === "staking");
  const oraLive = ev ? ev.oracle.filter((o) => o.deviationPct != null) : [];
  const worst = oraLive.length ? oraLive.reduce((a, b) => (b.deviationPct > a.deviationPct ? b : a)) : null;
  const idle = ev ? ev.oracle.filter((o) => o.status === "inactive").length : 0;
  const consRows = Object.values(S.conservation);
  const consEx = consRows.filter((c) => c.status === "exact").length, drift = consRows.filter((c) => c.status === "drift").length;
  const tvl = tokens.reduce((s, t) => s + (t.vaultUsd || 0), 0);

  const L = [];
  L.push(`📈 FLASH FLOW SENTINEL — Weekly Deep Dive`);
  L.push(``);
  L.push(`🛡️ 7-day guard record`);
  L.push(breaches || warns ? `   ${breaches} breach · ${warns} warn fired${activeNow ? ` · ${activeNow} active now` : " · all resolved"}` : `   clean week — every guard held green`);
  L.push(`   Governance: ${govEvents.length ? govEvents.length + " change(s)" : "no changes"}${deploys ? ` · ${deploys} redeploy(s) tracked` : ""} · Squads ${process.env.SQUADS_MOFN || "3-of-7"} multisig`);
  L.push(``);
  L.push(`💰 Flow leaders (24h)`);
  if (topOut.length) L.push(`   Vaults ▼out: ${topOut.map((t, i) => `${i + 1}. ${t.pool}/${t.symbol} ${money(t.out24hUsd)}`).join(" · ")}`);
  if (wallets.length) L.push(`   Wallets ▼out: ${wallets.map((w, i) => `${i + 1}. ${shortAddr(w.wallet)} ${money(w.out24hUsd)}`).join(" · ")}`);
  L.push(``);
  if (tr && lp) L.push(`📊 Sides (24h): Trade ▲${money(tr.in24hUsd)}/▼${money(tr.out24hUsd)} · LP ▲${money(lp.in24hUsd)}/▼${money(lp.out24hUsd)}${stk && (stk.in24hUsd || stk.out24hUsd) ? ` · Staking ▲${money(stk.in24hUsd)}/▼${money(stk.out24hUsd)}` : ""}`);
  L.push(`🏦 ${tracked().length} vaults · TVL ${money(tvl)}${topBal ? ` · biggest ${topBal.symbol} ${money(topBal.vaultUsd)}` : ""}`);
  L.push(`🔮 Oracle: ${oraLive.length} live feeds${worst ? ` · worst ${worst.symbol} ${worst.deviationPct}%` : ""}${idle ? ` · ${idle} idle (paused/closed)` : ""}`);
  L.push(`✅ Conservation: ${consEx}/${consRows.length} exact · ${drift} unresolved drift`);
  L.push(``);
  L.push(`🔗 flash-flow-sentinel.vercel.app`);
  return L.join("\n");
}
function maybeSendWeekly() {
  if (!S.lastEval) return;
  const t = now();
  if (t - (S.lastWeeklyUnix || 0) < WEEKLY_INTERVAL_S) return;
  S.lastWeeklyUnix = t;
  sendTelegram(composeWeekly());
  log(`weekly deep-dive broadcast to channel`);
}

// ---------------- core cycle ----------------
let coverageMissStreak = 0, coverageAlertAt = 0;
async function refreshCustodies() {
  const { custodies, pools, erSlot } = await scanCustodies(er);
  if (!custodies.length) return; // fully-empty scan = transient RPC failure — keep the last-good set
  // Coverage-shrink guard: a partial/truncated scan must NOT silently replace the full set with a smaller one
  // (that drops a vault from conservation while still reporting "N/N exact" — perfect cover for a drain). If the
  // count falls materially below the PERSISTED high-water OR a previously-tracked vault DISAPPEARS, keep the
  // last-good set and ALARM the operator privately (rate-limited). Only after the reduced set persists ~5min do
  // we accept it as a real change (a legit vault removal) and rebaseline — jitter/attack never drops a vault.
  const hw = S.custodyHighWater || 0;
  const newSet = new Set(custodies.map((c) => c.custody));
  const missing = (S.custodies || []).map((c) => c.custody).filter((k) => !newSet.has(k));
  const degraded = (hw && custodies.length < hw * 0.8) || missing.length > 0;
  if (degraded && ++coverageMissStreak < 30) {
    S.coverageDegraded = `scan returned ${custodies.length}/${hw} vaults${missing.length ? `, ${missing.length} tracked vault(s) missing` : ""} — keeping last-good coverage`;
    S.cycleErrors.push(S.coverageDegraded);
    if (erSlot) S.erSlot = erSlot;
    const t0 = now();
    if (SECURITY_ALERTS() && t0 - coverageAlertAt > 1800) {
      coverageAlertAt = t0;
      sendSecurityAlert(`🟠  SECURITY · FLASH V2\n━━━━━━━━━━━━━━━━━━━━\nVAULT COVERAGE SHRANK\n\nLatest scan: ${custodies.length} vaults (high-water ${hw}).${missing.length ? `\n${missing.length} previously-tracked vault(s) DISAPPEARED: ${missing.slice(0, 5).map((k) => String(k).slice(0, 6) + "…").join(", ")}` : ""}\n\n⚠️ Keeping last-good coverage so no vault is silently dropped — a vanishing vault can hide a drain. Check the RPC/scan now.\n\n🔗 flash-flow-sentinel.vercel.app`);
    }
    return;
  }
  if (degraded) log(`coverage: reduced set persisted ${coverageMissStreak} scans → accepting as new baseline (${custodies.length} vaults)`);
  S.custodies = custodies; S.pools = pools; S.erSlot = erSlot;
  S.custodyHighWater = degraded ? custodies.length : Math.max(hw, custodies.length);
  coverageMissStreak = 0; S.coverageDegraded = null;
}
const realC = () => S.custodies.filter((c) => !c.isVirtual); // custodies that own SPL vaults
const tracked = () => [...realC(), ...S.named, ...Object.values(S.dynamic)]; // every fully-tracked vault
const allDescriptors = () => [...S.custodies, ...S.named, ...Object.values(S.dynamic)];

/** Re-price every in-window event at the CURRENT on-chain mark (stablecoins at $1) right before each
 *  evaluation. An event that was unpriced at ingest (its mark not yet resolved) would otherwise
 *  contribute $0 to the global/per-token/per-wallet USD caps forever — a drain routed through such a
 *  token could stay under the dollar caps. This closes that gap and mirrors how vaultUsd/TVL are
 *  valued (current mark). Raw deltas (deltaRaw/amount) are never touched — conservation stays exact. */
function repriceEvents() {
  const d = {}; for (const c of allDescriptors()) d[c.custody] = c;
  const cutoff = now() - RETENTION_HOURS * 3600;
  for (const e of S.events) {
    if (e.blockTime == null || e.blockTime < cutoff) continue;
    if (e.usd != null) continue; // keep the value observed at capture — only fill flows that were unpriced
    const mark = S.marks[e.custody];
    const px = mark != null && Number.isFinite(mark) ? mark : (d[e.custody] && d[e.custody].isStable ? 1 : null);
    if (px != null) { const v = e.amount * px; if (Number.isFinite(v)) { e.usd = v; e.markUsed = px; } } // now priceable → counts toward the USD caps (never let a NaN/Infinity into the totals — that would read as green)
  }
}

/** Authority sweep: watch the balance of EVERY token account owned by the program's vault
 *  authority (2 RPC calls). Any untracked account that moves is promoted to full per-tx
 *  tracking and its window is immediately decoded — nothing under the authority can flow
 *  unobserved. */
async function runSweep(cutoff) {
  if (!S.authority) return 0;
  const sw = await sweepAuthority(main, S.authority);
  if (!Object.keys(sw).length) return 0;
  const trackedVaults = new Set(tracked().map((c) => c.vault));
  let promoted = 0;
  for (const [ta, info] of Object.entries(sw)) {
    const prev = S.sweepBal[ta];
    if (!trackedVaults.has(ta) && prev != null && prev !== info.amountRaw) {
      const desc = describeVault({ pda: ta, pool: "Authority", ta, mint: info.mint, kind: "swept" }, S.custodies, info);
      S.dynamic[ta] = desc; promoted++;
      log(`SWEEP: promoted ${desc.symbol} ${ta.slice(0, 8)}… to full tracking (balance ${prev} → ${info.amountRaw})`);
      try { await pollVault(desc, cutoff); } catch (e) { S.cycleErrors.push(`sweep ${desc.symbol}: ${e.message}`); }
    }
    S.sweepBal[ta] = info.amountRaw;
  }
  return promoted;
}

async function pollVault(cust, cutoff) {
  const vs = S.vaultState[cust.vault] || (S.vaultState[cust.vault] = { lastSig: null });
  const { sigs, failed } = await newSignatures(main, cust.vault, vs.lastSig, cutoff);
  for (const f of failed) if (!S.failures.some((x) => x.sig === f.sig)) S.failures.push({ vault: cust.vault, sig: f.sig, blockTime: f.blockTime });
  const fresh = [];
  for (const s of sigs) {
    const k = cust.custody + ":" + s.signature;
    if (S.eventKeys.has(k)) continue;
    try {
      const e = await decodeFlow(main, s, cust, S.marks[cust.custody]);
      if (e) {
        S.eventKeys.add(k); S.events.push(e); appendEvent(e); fresh.push(e);
        const c = S.conservation[cust.vault];
        if (c) c.sumDeltas = (BigInt(c.sumDeltas) + BigInt(e.deltaRaw)).toString();
      } else {
        S.eventKeys.add(k); // confirmed tx that didn't move the vault — remember, don't refetch
      }
      if (S.decodeRetries && S.decodeRetries[k]) delete S.decodeRetries[k]; // decoded fine — clear any retry count
    } catch (err) {
      const retries = (S.decodeRetries || (S.decodeRetries = {}));
      const rc = (retries[k] = (retries[k] || 0) + 1);
      if (rc < 6) { S.cycleErrors.push(`decode ${s.signature.slice(0, 12)}…: ${err.message} (retry ${rc}/6)`); break; } // transient — retry next cycle, don't advance past it
      // persistently undecodable after 6 cycles: SKIP so this vault's stream isn't wedged forever. Mark
      // processed (lastSig advances) and flag loudly. Any real vault delta it carried is still caught by
      // the conservation proof (baseline + Σdeltas ≠ balance → drift alert), so nothing is silently lost.
      S.eventKeys.add(k); delete retries[k];
      const skip = (S.skippedSigs || (S.skippedSigs = []));
      skip.push({ vault: cust.vault, pool: cust.pool, symbol: cust.symbol, sig: s.signature, blockTime: s.blockTime, error: err.message, at: now() });
      if (skip.length > 100) S.skippedSigs = skip.slice(-100);
      log(`⚠️ SKIPPED undecodable tx after 6 retries: ${s.signature} (${cust.pool}/${cust.symbol}) — ${err.message}. Conservation drift will catch any missed delta.`);
      // fall through (no break) — keep processing the rest of the vault's signatures
    }
  }
  // advance lastSig only through the fully processed prefix (an undecoded tx is retried next cycle)
  let processedThrough = null;
  for (const s of sigs) { if (S.eventKeys.has(cust.custody + ":" + s.signature)) processedThrough = s.signature; else break; }
  if (processedThrough) vs.lastSig = processedThrough;
  return fresh.length;
}

function checkConservation() {
  const t = now();
  for (const cust of tracked()) {
    const bal = S.balances[cust.vault];
    if (bal == null) continue;
    let c = S.conservation[cust.vault];
    if (!c) { S.conservation[cust.vault] = { baseRaw: bal.toString(), baseTime: t, firstSeen: t, sumDeltas: "0", residual: "0", streak: 0, status: "exact", rebases: 0 }; continue; }
    const expect = BigInt(c.baseRaw) + BigInt(c.sumDeltas);
    const residual = bal - expect;
    c.residual = residual.toString();
    if (residual === 0n) { c.status = "exact"; c.streak = 0; }
    else {
      c.streak++;
      if (c.streak <= 2) c.status = "syncing"; // a transfer can land between the sig scan and the balance read
      else {
        c.status = "drift";
        if (c.firstSeen == null) c.firstSeen = c.baseTime || t;
        // Suppress transient residuals: a transfer landing between the sig scan and the balance read, or a slow
        // 0.1-CPU backfill cycle, produces a residual that is NOT a missed transfer. Only proceed once the vault
        // has settled (180s), the monitor is READY, and it's running a NORMAL-speed cycle (not the slow backfill).
        const settled = t - c.firstSeen > 180 && S.ready && (S.cycleSeconds || 0) < 60;
        if (settled) {
          const a = { time: t, rule: `conservation:${cust.pool}/${cust.symbol}`, from: "exact", to: "drift", detail: `residual ${residual} raw — rebasing baseline` };
          S.alertsLog.push(a); appendAlert(a); fireWebhook({ source: "flash-flow-sentinel", ...a });
          if (SECURITY_ALERTS()) {
            const tokAmt = Number(residual) / Math.pow(10, cust.decimals || 0), mk = S.marks[cust.custody];
            const usd = mk != null && Number.isFinite(tokAmt) ? ` (~$${Math.abs(tokAmt * mk).toLocaleString("en-US", { maximumFractionDigits: 0 })})` : "";
            // DUAL-WITNESS SEVERITY: a residual means the sentinel's OWN books don't tie out — but that's a DRAIN
            // only if the INDEPENDENT census ALSO shows a deficit. If the census confirms full solvency, this is a
            // monitor decode-gap (a tx the decoder couldn't parse), NOT a drain → send an informational note, never
            // the "missed or forged — investigate now" critical. Only a census deficit (or no census) escalates.
            const sv = S.reconStatus && S.reconStatus.solvency;
            const censusSolvent = !!(sv && sv.present && sv.allHold && !sv.stale);
            const skipped = (S.skippedSigs || []).length;
            const amt = `${tokAmt >= 0 ? "+" : "−"}${Math.abs(tokAmt).toFixed(4)} ${cust.symbol}${usd}`;
            if (censusSolvent) {
              sendSecurityAlert(`🟡  MONITOR · FLASH V2\n━━━━━━━━━━━━━━━━━━━━\nCONSERVATION DECODE-GAP (NOT a drain)\n\nThe monitor's books drifted on ${cust.pool}/${cust.symbol} by ${amt}${skipped ? ` — ${skipped} tx the decoder couldn't parse` : ""}.\n\n✅ The INDEPENDENT census confirms FULL solvency (deficit 0) — no funds are missing. This is a monitor decode-gap; auto-rebasing. No action needed.`);
            } else {
              sendSecurityAlert(`🔴  SECURITY · FLASH V2\n━━━━━━━━━━━━━━━━━━━━\nCONSERVATION DRIFT\n\nVault ${cust.pool}/${cust.symbol} no longer reconciles:\nbaseline + Σ transfers ≠ live balance\nresidual ${amt}\n\n⚠️ The independent census does NOT confirm solvency (${sv && sv.present ? "deficit/failed" : "census unavailable"}) — a transfer may have been missed or forged. INVESTIGATE NOW.\n\n🔗 flash-flow-sentinel.vercel.app`);
            }
          }
          log(`CONSERVATION DRIFT ${cust.pool}/${cust.symbol} residual=${residual} censusSolvent=${!!(S.reconStatus && S.reconStatus.solvency && S.reconStatus.solvency.allHold)}`);
        }
        c.baseRaw = bal.toString(); c.baseTime = t; c.sumDeltas = "0"; c.streak = 0; c.rebases++;
      }
    }
  }
}

// ---------------- governance & authority watch ----------------
// Reads the full authority surface (upgrade authority, program deploys, admin multisig,
// global permission flags) and alerts the instant any of it changes — the precursor step
// of the drain kill-chain, ahead of any money movement.
async function checkGovernance() {
  let fresh;
  try { fresh = await fetchGovernance(main, er); }
  catch (e) { S.cycleErrors.push("governance: " + e.message); return; }
  if (!fresh) return;
  const t = now();
  const prev = S.govBaseline; // full prior snapshot (persisted across restarts)
  // carry-forward: any section that failed to read keeps its last-good value → a transient RPC
  // gap can neither raise a false change nor blind a later real change on that section.
  const gov = mergeGovernance(prev, fresh);
  S.governance = gov;
  if (!prev) { S.govBaseline = gov; return; }             // first observation → baseline, no alert
  if (prev.fingerprint === gov.fingerprint) { S.govBaseline = gov; return; }

  const changes = diffGovernance(prev, gov);
  if (!changes.length) { S.govBaseline = gov; return; }   // fingerprint moved only on a skipped section → no wolf
  for (const ch of changes) {
    // An upgrade AUTO-VERIFIED as authorized (through the unchanged multisig authority) is not a red event:
    // record it in the informational review-log so the human still sees it and reviews the new bytecode, but
    // do NOT latch a critical or flip the governance verdict red — that would be crying wolf on a routine,
    // authorized upgrade. Only genuinely unexpected changes (authority swap, control drop, unverified deploy)
    // take the critical path below.
    if (ch.authorized) {
      const u = { time: t, rule: ch.key, severity: "notice", authorized: true, detail: ch.detail };
      S.authorizedUpgrades.push(u); S.alertsLog.push({ ...u, from: "ok", to: "notice" }); appendAlert({ ...u, from: "ok", to: "notice" });
      log(`GOVERNANCE authorized upgrade (verified) — ${ch.detail}`);
      continue;
    }
    const a = { time: t, rule: ch.key, from: "ok", to: "breach", severity: ch.severity, detail: ch.detail };
    S.govChanges.push(a); S.alertsActive[ch.key] = { status: "breach", severity: ch.severity, detail: ch.detail, since: t };
    S.alertsLog.push(a); appendAlert(a); fireWebhook(a);
    if (SECURITY_ALERTS()) sendSecurityAlert(`🔴  SECURITY · FLASH V2\n━━━━━━━━━━━━━━━━━━━━\nGOVERNANCE CHANGE\n\n${ch.detail}\n\n⚠️ Verify this change was authorized.`);
    log(`GOVERNANCE ${ch.severity.toUpperCase()} ${ch.key} — ${ch.detail}`);
  }
  S.govBaseline = gov;
}

// ---------------- solvency-buffer watch (cross-domain unbacked-outflow catcher — the AFX buffer-drain) ----------------
// Neither proof alone sees this: conservation proves base-chain movement is internally consistent (it's
// auth-AGNOSTIC — a valid-signature drain still "conserves"), and the census proves the vault currently holds
// AT LEAST its obligations (`vault >= owned`) — which stays TRUE while a $190k surplus buffer is eaten dollar by
// dollar. So a drain that leaves the vault still ≥ obligations (by shrinking the margin) is invisible to both
// until the last dollar. This closes the gap by tying the census surplus (backing − obligations) to the REAL
// base-chain outflow: money that leaves WITHOUT obligations falling to match is unbacked. Proven inputs only.
const SOLV_BUFFER_FLOOR = Number(process.env.SOLVENCY_BUFFER_FLOOR_USD || 50000); // accumulator floor before alarming
const SOLV_BUFFER_CAP = Number(process.env.SOLVENCY_BUFFER_CAP_USD || 2000000);   // accumulator ceiling (sanity bound)
// Net priced base outflow across ALL vaults since `sinceUnix`, excluding internal authority↔authority reshuffles
// (both legs authority-owned → no real backing left the protocol). Real tokens only; marks move none of this.
function netVaultOutflowSince(sinceUnix) {
  const auth = S.authority; let out = 0, inn = 0;
  for (const e of S.events) {
    if (e.blockTime == null || e.blockTime < sinceUnix) continue;
    if (auth && e.wallet === auth) continue;            // vault↔vault internal move — not a real outflow
    const usd = e.usd; if (usd == null || !Number.isFinite(usd)) continue;
    if (e.direction === "out") out += usd; else if (e.direction === "in") inn += usd;
  }
  return Math.max(0, out - inn);
}
async function checkSolvencyBuffer(inv, t) {
  const s = inv.surplusUsd;
  if (s == null || !Number.isFinite(s)) return;         // surplus not readable this scan → skip (never guess)
  const B = S.solvencyBuffer;
  const netOut = B.lastAt ? netVaultOutflowSince(B.lastAt) : 0; // real money out since the previous census poll
  const step = reconwatch.solvencyStep({ accum: B.accum, lastSurplus: B.lastSurplus }, s, netOut, SOLV_BUFFER_CAP);
  B.accum = step.accum; B.lastSurplus = step.lastSurplus; B.lastAt = t;
  if (step.contribution > 0) log(`SOLVENCY-BUFFER: surplus $${Math.round(s).toLocaleString()} netOut $${Math.round(netOut).toLocaleString()} → +$${Math.round(step.contribution).toLocaleString()} unbacked (accum $${Math.round(B.accum).toLocaleString()}/${SOLV_BUFFER_FLOOR})`);
  if (B.accum >= SOLV_BUFFER_FLOOR && (!B.alertAt || t - B.alertAt > 1800)) {
    B.alertAt = t;
    const deficitNow = inv.deficit != null && Number(inv.deficit) > 0;
    const delivered = !SECURITY_ALERTS() || await sendSecurityAlert(
      `${deficitNow ? "🔴🔴" : "🟠"}  SECURITY · FLASH V2 ${deficitNow ? "🔴🔴" : ""}\n━━━━━━━━━━━━━━━━━━━━\nSOLVENCY BUFFER ERODING — UNBACKED OUTFLOW\n\n` +
      `≈ $${Math.round(B.accum).toLocaleString()} has left the vaults WITHOUT the protocol's obligations falling to match — the solvency margin is being eaten.\n\n` +
      `Current backing surplus: $${Math.round(s).toLocaleString()} (backing $${Math.round(inv.vaultUsd || 0).toLocaleString()} − obligations $${Math.round(inv.ownedUsd || 0).toLocaleString()}).\n\n` +
      `A legit withdrawal drops backing AND obligations together (buffer stays flat); a market move changes the buffer but moves no tokens. This is neither — real tokens left while obligations held, the fingerprint of an over-withdrawal / unbacked drain eating the margin BEFORE it shows as insolvency.\n\n` +
      `${deficitNow ? "🔴 The census now ALSO shows a deficit — the buffer is gone and it's a live drain. ACT NOW." : "Census still shows solvency (buffer not yet exhausted) — VERIFY these withdrawals are entitled NOW, before the margin is spent."}\n\n🔗 flashtrade-v2-onchain-census.vercel.app`);
    if (delivered) { log(`SOLVENCY-BUFFER ALARM sent — accum $${Math.round(B.accum)} deficitNow=${deficitNow}`); }
    else { B.alertAt = 0; } // un-missable: undelivered → re-fire next poll
  }
  // full recovery → clear the accumulator so a later, unrelated erosion starts clean
  if (B.accum < SOLV_BUFFER_FLOOR * 0.2 && B.alertAt) B.alertAt = 0;
  saveState();
}

// ---------------- reconciliation-anomaly watch (the 7-day-rehearsal catcher) ----------------
// Poll the census basket-vs-market reconciliation and alert on the FIRST appearance of a phantom position
// (a Market whose open-interest no longer matches the sum of the baskets behind it). A phantom is the
// on-chain signature of a broken-entitlement / over-withdrawal path being EXERCISED — the exact fingerprint
// the 2026-07-20 rehearsal left on-chain a full day before the live drain, which nothing alerted on.
// Alerts route to the OPERATOR DM ONLY (private) — never the public channel — until explicitly promoted.
async function checkReconciliation() {
  let full;
  try {
    // Hard ceiling independent of fetch's own AbortSignal, so a stalled census body-read can never hold the
    // cycle. If it loses the race the reject is caught below and the cycle proceeds untouched.
    full = await Promise.race([
      reconwatch.fetchCensusFull(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("recon timeout (30s)")), 30000)),
    ]);
  } catch (e) {
    // The census is a SECOND independent witness of solvency — losing it must NOT be silent. Alarm the operator
    // (rate-limited to once / 30m) that the solvency cross-check has gone blind, then proceed; the sentinel's own
    // flow/entitlement/conservation guards are unaffected.
    S.cycleErrors.push("recon: " + e.message);
    const t0 = now();
    if (SECURITY_ALERTS() && (!S.censusBlindSince || t0 - S.censusBlindSince > 1800)) {
      S.censusBlindSince = t0;
      sendSecurityAlert(`🟠  SECURITY · FLASH V2\n━━━━━━━━━━━━━━━━━━━━\nSOLVENCY CROSS-CHECK BLIND\n\nThe on-chain census (independent solvency witness) is unreachable: ${e.message}.\nProtocol-solvency + phantom-position checks are paused until it returns — the sentinel's own guards are unaffected.\n\n🔗 flashtrade-v2-onchain-census.vercel.app`);
    }
    return;
  }
  if (S.censusBlindSince) { S.censusBlindSince = null; log("RECON: census reachable again"); }
  const recon = full.recon, inv = full.inv;
  const t = now();
  const stale = inv.asOfUnix != null && (t - inv.asOfUnix) > 1800; // census scan older than 30m → not a live witness
  S.reconStatus = { mismatched: recon.mismatchedCount, marketSides: recon.marketSides, allExact: recon.allExact, checkedAt: t,
    solvency: { present: inv.present, allHold: inv.allHold, fails: inv.fails, asOfUnix: inv.asOfUnix, stale, coveragePct: inv.coveragePct, deficit: inv.deficit,
      surplusUsd: inv.surplusUsd, vaultUsd: inv.vaultUsd, ownedUsd: inv.ownedUsd, unbackedAccum: S.solvencyBuffer.accum } };

  // ---- PROTOCOL SOLVENCY INVARIANTS (the single strongest signal) ----
  // If the census's own on-chain invariants FAIL, the protocol is provably insolvent / being drained. CRITICAL,
  // raw-u64, computed on an INDEPENDENT scan. Latched so it alarms once on break and once on recovery; only ever
  // trusted when the invariant suite is present AND the census scan is fresh.
  if (inv.present && !stale) {
    if (!inv.allHold && !S.censusInvariantBad) {
      log(`RECON CRITICAL — census solvency invariant FAILED: ${inv.fails.join("; ")}`);
      // UN-MISSABLE: latch ONLY after CONFIRMED delivery to the private DM. If Telegram is down, do NOT latch →
      // this re-fires every recon cycle until it lands. (If alerts are off there's nothing to deliver → latch.)
      const delivered = !SECURITY_ALERTS() || await sendSecurityAlert(`🔴🔴 SECURITY · FLASH V2 🔴🔴\n━━━━━━━━━━━━━━━━━━━━\nPROTOCOL SOLVENCY INVARIANT FAILED\n\nThe on-chain census proves ${inv.fails.length} invariant(s) NO LONGER HOLD:\n• ${inv.fails.join("\n• ")}${inv.deficit ? `\n\nVault deficit: ${inv.deficit}` : ""}\n\n⚠️ PROVEN on-chain (raw u64, independent scan): the protocol is under-collateralised or being drained. Strongest signal the monitor has — ACT NOW.\n\n🔗 flashtrade-v2-onchain-census.vercel.app`);
      if (delivered) { S.censusInvariantBad = true; saveState(); }
    } else if (inv.allHold && S.censusInvariantBad) {
      S.censusInvariantBad = false; saveState();
      log("RECON — census solvency invariants hold again");
      if (SECURITY_ALERTS()) sendSecurityAlert(`🟢  SECURITY · FLASH V2\n━━━━━━━━━━━━━━━━━━━━\nSOLVENCY RESTORED\n\nAll on-chain census invariants hold again (${inv.coveragePct || "?"} coverage).`);
    }
    // cross-domain unbacked-outflow watch: pair the surplus buffer against real base outflow (catches an AFX-style
    // drain eating the solvency margin while `vault >= owned` still holds — before it registers as insolvency).
    try { await checkSolvencyBuffer(inv, t); } catch (e) { S.cycleErrors.push("solvbuffer: " + (e.message || e)); }
  }

  // Cold start: silently baseline whatever phantom mismatch already exists so a pre-existing one is never fired
  // as if it were brand-new — BUT surface the count so a restart-after-attack can't hide a planted phantom.
  if (!S.reconSeeded) {
    const n = reconwatch.seed(S.reconKnown, recon.mismatched, t);
    S.reconSeeded = true;
    log(`RECON seeded: ${n} pre-existing mismatch(es) baselined (${recon.marketSides} sides, ${recon.mismatchedCount} mismatched)`);
    if (n > 0 && SECURITY_ALERTS()) sendSecurityAlert(`🟠  SECURITY · FLASH V2\n━━━━━━━━━━━━━━━━━━━━\nPHANTOM POSITION(S) PRESENT AT STARTUP\n\n${n} basket-vs-market mismatch(es) already existed when the monitor started — baselined so they don't re-fire, but REVIEW them (a planted phantom could predate a restart):\n${recon.mismatched.slice(0, 4).map((m) => "• " + reconwatch.describe(m)).join("\n")}\n\n🔗 flashtrade-v2-onchain-census.vercel.app`);
    saveState();
    return;
  }

  const { fresh, resolved } = reconwatch.diffMismatches(S.reconKnown, recon.mismatched, t);
  for (const m of fresh) {
    const detail = reconwatch.describe(m);
    log(`RECON CRITICAL — new phantom position: ${detail}`);
    // SECURITY → operator DM (bypasses the global mute when SECURITY_ALERTS=1). A NEW phantom is rare and real.
    if (SECURITY_ALERTS()) sendSecurityAlert(`🔴  SECURITY · FLASH V2\n━━━━━━━━━━━━━━━━━━━━\nNEW PHANTOM POSITION\n\n${detail}\n\nA market no longer matches the baskets behind it — the on-chain fingerprint of an over-withdrawal path being exercised.\n\n🔗 flashtrade-v2-onchain-census.vercel.app`);
  }
  for (const m of resolved) log(`RECON resolved — ${m.pool}/${m.market} ${m.side} reconciles again`);
  if (fresh.length || resolved.length) saveState();
}

// ---------------- withdrawal firehose (Flash team request — notify on every withdrawal, ~24h resumption) ----------------
// When WITHDRAWAL_ALERTS=1, push a Telegram notice for EVERY new withdrawal (non-internal vault outflow),
// BATCHED one message per cycle to stay well under Telegram rate limits. A watermark (wAlertFrom) is stamped
// the first time it runs so the existing backlog is NEVER dumped; dedup by sig:custody so none is sent twice.
// Bypasses the global mute on purpose (this is the one feed explicitly turned on) and carries no oracle content.
const WITHDRAWAL_ALERTS = () => process.env.WITHDRAWAL_ALERTS === "1";
const SECURITY_ALERTS = () => process.env.SECURITY_ALERTS === "1";
const WMODE = () => (process.env.WITHDRAWAL_MODE === "pertx" ? "pertx" : "summary"); // default: low-noise hourly summary
const WSUMMARY_INTERVAL = Number(process.env.WSUMMARY_INTERVAL_S || 3600);
const wKey = (e) => `${e.sig}:${e.custody}`;
let wSending = false; // one send-batch at a time so a burst is never double-sent across overlapping cycles

// HOURLY SUMMARY (default, no-spam): one message/hour with the last hour's real decoded totals — withdrawals,
// deposits, net, TVL. Never posted until a real evaluation exists (never synthetic/empty). Inherently dedup-safe
// (one per interval, tracked by wSummaryLast). All numbers come straight from the live on-chain evaluation.
function notifyWithdrawalSummary() {
  const t = now();
  if (!S.wSummaryLast) { S.wSummaryLast = t; saveState(); log("withdrawal HOURLY SUMMARY enabled — first roundup in ~1h (real on-chain totals)"); return; }
  if (t - S.wSummaryLast < WSUMMARY_INTERVAL) return;
  const ev = S.lastEval;
  if (!ev || !ev.global) return; // wait for a real evaluation — never post empty/synthetic
  S.wSummaryLast = t; saveState();
  const g = ev.global;
  const tvl = (ev.tokens || []).reduce((s, tk) => s + (tk.vaultUsd || 0), 0);
  const fmt = (n) => { const a = Math.abs(n || 0); return a >= 1e6 ? "$" + (a / 1e6).toFixed(2) + "M" : a >= 1e3 ? "$" + (a / 1e3).toFixed(1) + "k" : "$" + Math.round(a).toLocaleString("en-US"); };
  const net = (g.in1hUsd || 0) - (g.out1hUsd || 0);
  const bar = "━━━━━━━━━━━━━━━━━━━━";
  sendWithdrawalNotice(`📊  FLASH V2  ·  HOURLY REPORT\n${bar}\n💸  Withdrawals   ${g.outEvents1h || 0}  ·  ${fmt(g.out1hUsd)}\n💰  Deposits      ${g.inEvents1h || 0}  ·  ${fmt(g.in1hUsd)}\n⚖️  Net flow      ${net >= 0 ? "+" : "−"}${fmt(net)}\n🏦  Vault TVL     ${fmt(tvl)}\n${bar}\n✅  Live on-chain · verified`);
}

// Dispatcher — default mode posts the hourly summary above (no spam); WITHDRAWAL_MODE=pertx uses the
// dedup-hardened per-transaction feed below. Every value is decoded live on-chain; nothing is ever synthetic.
// Human-readable labels for the public feed (any kind not listed shows its raw kind unchanged).
const KIND_LABEL = { REVENUE: "Collect Revenue" };
const kindLabel = (k) => KIND_LABEL[k] || k;
function notifyWithdrawals() {
  if (!WITHDRAWAL_ALERTS()) return;
  if (WMODE() === "summary") return notifyWithdrawalSummary();
  if (wSending) return;
  // One-time FRESH START: whenever WITHDRAWAL_FRESH_START changes value, reset the feed to *now* — clear the
  // watermark to this instant and wipe the sent-history — so (re)enabling posts only brand-new transactions
  // with zero backlog and zero chance of repeating anything sent before. Runs once per new token value.
  const ft = process.env.WITHDRAWAL_FRESH_START;
  if (ft && ft !== S.wFreshToken) { S.wFreshToken = ft; S.wAlertFrom = now(); S.wAlertSent = []; S._wSent = new Set(); saveState(); log(`withdrawal feed FRESH START (${ft}) — watermark reset to now, sent-history cleared: fresh txs only, no repeats`); return; }
  if (!S.wAlertFrom) { S.wAlertFrom = now(); saveState(); log("withdrawal feed ENABLED — watermark set; notifying on all withdrawals from now (backlog not dumped)"); return; }
  const sent = S._wSent || (S._wSent = new Set(S.wAlertSent || []));
  const fresh = S.events.filter((e) => e.direction === "out" && e.sig && !(S.authority && e.wallet === S.authority) && e.blockTime >= S.wAlertFrom && !sent.has(wKey(e)));
  if (!fresh.length) return;
  fresh.sort((a, b) => a.blockTime - b.blockTime);
  // ── DEDUP FIX (the duplicate flood): mark every fresh withdrawal as sent and PERSIST TO DISK *before* the
  // Telegram send. Previously a tx was marked sent only AFTER delivery and persisted a cycle later, so any
  // restart in that gap re-announced it — and I restarted many times. With the marker on disk first, a
  // restart / redeploy can NEVER re-send a transaction. A delivery that then fails is logged loudly with its
  // signature (failures are extremely rare on an admin channel + rate-limited spacing) — never silently re-sent.
  for (const e of fresh) sent.add(wKey(e));
  S.wAlertSent = [...sent].slice(-20000); // cap ≫ any 48h volume, so a key is never evicted then re-sent
  saveState(); // persist the sent-markers NOW, before any Telegram call — this is what stops restart duplicates
  const short = (w) => (w ? w.slice(0, 6) + "…" + w.slice(-4) : "?");
  // Priced flows show USD; an unpriced one (LP-receipt token whose mark isn't resolved) shows the real token
  // amount instead of a bare "—", so no notice ever looks broken. All values are real on-chain.
  const amtStr = (e) => (e.usd != null
    ? "$" + Number(e.usd).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " " + e.symbol
    : Number(e.amount || 0).toLocaleString("en-US", { maximumFractionDigits: 4 }) + " " + e.symbol);
  // Report EVERY withdrawal — NOTHING truncated. Chunk into messages of 10 lines (safely under Telegram's
  // 4096-char limit) and send them ALL, spaced to respect rate limits; wSending serializes batches.
  const CHUNK = 10, total = fresh.length, chunks = [];
  for (let i = 0; i < total; i += CHUNK) chunks.push(fresh.slice(i, i + CHUNK));
  wSending = true;
  (async () => {
    try {
      for (let c = 0; c < chunks.length; c++) {
        const part = chunks[c];
        const hdr = total === 1 ? "💸 WITHDRAWAL · Flash V2"
          : chunks.length === 1 ? `💸 ${total} WITHDRAWALS · Flash V2`
          : `💸 Flash V2 withdrawals (${c * CHUNK + 1}–${c * CHUNK + part.length} of ${total})`;
        const body = part.map((e) => `• ${amtStr(e)} (${e.pool}) → ${short(e.wallet)} · ${kindLabel(e.kind)}\n  https://solscan.io/tx/${e.sig}`).join("\n");
        const ok = await sendWithdrawalNotice(`${hdr}\n\n${body}`);
        if (!ok) log(`WITHDRAWAL notice FAILED to deliver (${part.length}): ${part.map((e) => e.sig.slice(0, 10)).join(", ")} — already marked sent, will NOT re-send (resend manually if needed)`);
        if (c < chunks.length - 1) await new Promise((r) => setTimeout(r, 1100));
      }
    } finally { wSending = false; }
  })();
}

// ---------------- new-program detector (PROVEN-ONLY: fresh-deploy footprint) ----------------
// The attacker's earliest move was DEPLOYING a custom program and pointing it at Flash. A program merely
// "not seen before" is NOT proof of anything — core infra (ATA, session-keys) appears sporadically and is
// years/months old. So before ever alarming, this VERIFIES the program's on-chain deploy age: it alarms only
// on an UPGRADEABLE program DEPLOYED WITHIN THE LAST ~30 DAYS (the real attacker signature — they deploy days
// before a drain). Anything established, core/native, or unverifiable is baselined SILENTLY. Proof or silence.
const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const NEWPROG_RECENCY_DAYS = Number(process.env.NEWPROG_RECENCY_DAYS || 30);
let newProgBusy = false;
async function checkNewPrograms() {
  if (!SECURITY_ALERTS() || newProgBusy) return;
  const t = now();
  const seen = new Set();
  for (const e of S.events) if (Array.isArray(e.programs)) for (const p of e.programs) seen.add(p);
  if (!seen.size) return;
  if (!S.progSeeded) {
    for (const p of seen) if (!S.knownPrograms[p]) S.knownPrograms[p] = t;
    S.progSeeded = true; saveState();
    log(`NEW-PROGRAM detector seeded: ${Object.keys(S.knownPrograms).length} programs baselined`);
    return;
  }
  const fresh = [...seen].filter((p) => !S.knownPrograms[p]);
  if (!fresh.length) return;
  newProgBusy = true;
  try {
    let curSlot = null;
    try { const s = await main("getSlot", []); curSlot = s && s.result; } catch (e) {}
    const bs58 = require("bs58");
    for (const p of fresh) {
      if (p === PROG) { S.knownPrograms[p] = t; continue; } // never alarm on Flash's own program (it upgraded during remediation → looks "fresh")
      let verdict = "established", ageDays = null;
      try {
        const inf = await main("getAccountInfo", [p, { encoding: "base64" }]);
        const val = inf && inf.result && inf.result.value;
        const owner = val && val.owner;
        // Only an UPGRADEABLE program can be freshly deployed+controlled by an attacker. Core/native programs
        // (ATA=BPFLoader2, System/ComputeBudget=NativeLoader) can never be — baseline them silently.
        if (owner === UPGRADEABLE_LOADER && val.data && val.data[0] && curSlot) {
          const buf = Buffer.from(val.data[0], "base64");
          if (buf.length >= 36) {
            const pd = bs58.encode(buf.slice(4, 36)); // ProgramData address
            const pdInf = await main("getAccountInfo", [pd, { encoding: "base64" }]);
            const pdVal = pdInf && pdInf.result && pdInf.result.value;
            if (pdVal && pdVal.data && pdVal.data[0]) {
              const deploySlot = Number(Buffer.from(pdVal.data[0], "base64").readBigUInt64LE(4));
              ageDays = (curSlot - deploySlot) * 0.4 / 86400; // ~0.4s/slot
              if (ageDays <= NEWPROG_RECENCY_DAYS) verdict = "fresh";
            } else verdict = "unverified";
          }
        } // owner !== upgradeable loader → established core/native
      } catch (e) { verdict = "unverified"; }
      // A transient RPC failure must NOT permanently baseline (and thus silence) a fresh program. Retry it on
      // later cycles; only give up (baseline) after 3 unverifiable attempts so a permanently-odd account can't loop.
      if (verdict === "unverified") {
        S._progUnverified = S._progUnverified || {};
        if ((S._progUnverified[p] = (S._progUnverified[p] || 0) + 1) >= 3) { S.knownPrograms[p] = t; log(`new program ${p} — unverifiable 3× → baselined (giving up)`); }
        else log(`new program ${p} — unverified (transient RPC?), retrying next cycle`);
        continue;
      }
      S.knownPrograms[p] = t; // conclusive verdict (established / fresh) → baseline, never re-verify
      // PROVEN-ONLY: alarm ONLY when we can prove it's a freshly-deployed program. Established/core → baseline silently.
      if (verdict !== "fresh") { log(`new program ${p} — ${verdict}${ageDays != null ? ` (~${ageDays.toFixed(0)}d old)` : ""} — baselined silently, not an attack footprint`); continue; }
      const evs = S.events.filter((e) => Array.isArray(e.programs) && e.programs.includes(p));
      const sample = evs[evs.length - 1];
      const outN = evs.filter((e) => e.direction === "out").length, inN = evs.filter((e) => e.direction === "in").length;
      // DUAL-WITNESS: a fresh program touching vaults is worth verifying, but it's a DRAIN only if the independent
      // census also shows a deficit. If the census confirms solvency, frame it as "verify this integration", not
      // "attacker — investigate now" (a legit new deposit/withdrawal router looks exactly like this).
      const sv = S.reconStatus && S.reconStatus.solvency;
      const censusSolvent = !!(sv && sv.present && sv.allHold && !sv.stale);
      log(`🔴 FRESHLY-DEPLOYED program touching Flash: ${p} (~${ageDays.toFixed(0)}d) out=${outN} in=${inN} censusSolvent=${censusSolvent}`);
      const ctx = censusSolvent
        ? "✅ The independent census confirms FULL solvency (deficit 0) — NO drain is in progress. Verify this is a legitimate integration when convenient."
        : (sv && sv.present ? "🔴 The census does NOT confirm solvency — a fresh program + a deficit is the real attacker pattern. INVESTIGATE NOW." : "The census cross-check is currently unavailable — verify soon.");
      sendSecurityAlert(`${censusSolvent ? "🟠" : "🔴"}  SECURITY · FLASH V2\n━━━━━━━━━━━━━━━━━━━━\nNEW PROGRAM TOUCHING FLASH\n\nA program deployed ~${ageDays.toFixed(0)} day(s) ago is interacting with Flash vaults:\n${p}\n(activity: ${inN} deposit-side · ${outN} withdraw-side)\n${sample ? `e.g. ${sample.pool}/${sample.symbol} · https://solscan.io/tx/${sample.sig}\n` : ""}\n${ctx}`);
    }
    saveState();
  } finally { newProgBusy = false; }
}

// ---------------- settlement-signer watch (the AFX compromised-signer catcher) ----------------
// AFX ($24M, 2026-07-22) was drained by a COMPROMISED SIGNER on the settlement/bridge path: the withdrawals
// carried GENUINE, valid signatures satisfying the quorum — the bridge released funds because the auth checked
// out, even though the controller was the attacker. Signature-checks, audits and Pyth verification are all
// blind to this: the auth is real. Conservation + census catch the RESULTING drop (they're auth-agnostic), but
// they cannot tell you WHO signed it. This watch closes that exact gap.
//
// Flash's ER→base settlement (`ProcessUndelegation`, the MagicBlock delegation-program commit that releases a
// delegated vault back to base chain) is — verified on-chain — executed by a single fixed crank signer
// (FLAshCJG…). A user can NEVER self-sign it (the vault is a program-owned PDA committed through the delegation
// program), so the authorized settler set is small, fixed, and pinnable. ANY settlement signed by a key outside
// that set is the on-chain fingerprint of a stolen/forged settler — a CRITICAL, auth-model-aware signal.
// Proven-only, delivery-confirmed, private DM. Optionally pin the set with EXPECTED_SETTLEMENT_SIGNERS=key1,key2.
const SETTLE_IX = /ProcessUndelegation/i; // structurally crank-only (verified: 1 distinct signer across sampled vaults)
const EXPECTED_SETTLERS = (process.env.EXPECTED_SETTLEMENT_SIGNERS || "").split(",").map((s) => s.trim()).filter(Boolean);
let settleBusy = false;
async function checkSettlementSigners() {
  if (!SECURITY_ALERTS() || settleBusy) return;
  // every distinct signer of a settlement instruction in the retained buffer → a representative sample event
  const settlers = {};
  for (const e of S.events) {
    if (!Array.isArray(e.ix) || !e.ix.some((n) => SETTLE_IX.test(n))) continue;
    const signer = e.feePayer || e.wallet; // keys[0] = the settlement signer (verified)
    if (!signer) continue;
    if (!settlers[signer]) settlers[signer] = e;
  }
  const seen = Object.keys(settlers);
  if (!seen.length) return;
  // SEED: pin to EXPECTED_SETTLEMENT_SIGNERS if the operator supplied them (then even a first-pass rogue signer
  // alarms); otherwise baseline whatever legit crank(s) the buffer currently shows. Rigorous either way.
  if (!S.settlerSeeded) {
    const base = EXPECTED_SETTLERS.length ? EXPECTED_SETTLERS : seen;
    for (const s of base) if (!S.knownSettlers[s]) S.knownSettlers[s] = now();
    S.settlerSeeded = true; saveState();
    log(`SETTLEMENT-SIGNER watch seeded: ${Object.keys(S.knownSettlers).length} authorized settler(s)${EXPECTED_SETTLERS.length ? " (pinned via env)" : " (observed)"} [${Object.keys(S.knownSettlers).map((x) => x.slice(0, 4) + "…").join(", ")}]`);
    if (!EXPECTED_SETTLERS.length) return; // observed-seed trusts the buffer; skip alarms this pass
    // pinned-seed: fall through so any observed signer NOT in the pinned set alarms immediately
  }
  const fresh = seen.filter((s) => !S.knownSettlers[s]);
  if (!fresh.length) return;
  settleBusy = true;
  try {
    for (const s of fresh) {
      const ev = settlers[s];
      const sv = S.reconStatus && S.reconStatus.solvency;
      const censusSolvent = !!(sv && sv.present && sv.allHold && !sv.stale);
      // total value this key has settled out inside the retained window — the blast size if it's compromised
      const vol = S.events.filter((e) => (e.feePayer === s || e.wallet === s) && Array.isArray(e.ix) && e.ix.some((n) => SETTLE_IX.test(n)) && e.direction === "out").reduce((a, e) => a + (e.usd || 0), 0);
      const known = Object.keys(S.knownSettlers).map((x) => x.slice(0, 4) + "…" + x.slice(-4)).join(", ") || "—";
      const txt = `🔴🔴 SECURITY · FLASH V2 🔴🔴\n━━━━━━━━━━━━━━━━━━━━\nUNRECOGNISED SETTLEMENT SIGNER\n\nA key NEVER seen before just executed an ER→base settlement (ProcessUndelegation) on a Flash vault:\n${s}\nout-settled this window: $${Math.round(vol).toLocaleString()}\ne.g. ${ev.pool}/${ev.symbol} · https://solscan.io/tx/${ev.sig}\n\nAuthorized settler(s): ${known}\n\n${censusSolvent
        ? "The independent census still shows solvency (deficit 0) — this could be an authorized crank rotation, but a NEW settlement authority is the EXACT fingerprint of the AFX compromised-signer drain ($24M, valid signatures). VERIFY this key is authorized NOW; if not, freeze the settlement authority."
        : "🔴 The census does NOT confirm solvency — an unrecognised settler + a deficit is a LIVE compromised-signer drain. ACT NOW."}\n\n🔗 flash-flow-sentinel.vercel.app`;
      const delivered = await sendSecurityAlert(txt);
      // un-missable: baseline ONLY after confirmed delivery, so an undelivered alarm re-fires next cycle.
      if (delivered) { S.knownSettlers[s] = now(); saveState(); }
      log(`🔴 SETTLEMENT-SIGNER: unrecognised settler ${s.slice(0, 6)}… vol=$${Math.round(vol)} censusSolvent=${censusSolvent} delivered=${delivered}`);
    }
  } finally { settleBusy = false; }
}

let probeBusy = false;
const PROBE_FRESH_TX_MAX = Number(process.env.PROBE_FRESH_TX_MAX || 50); // a disposable rehearsal wallet has few lifetime txs
// Trace a wallet's on-chain ORIGIN: its lifetime tx count (freshness) + FUNDER (the account that sent it the most
// SOL in its earliest transaction). Cached in-memory (re-traced on restart; only runs when a cluster exists → rare).
async function getOrigin(wallet) {
  if (S.probeFunders[wallet] !== undefined) return S.probeFunders[wallet];
  let funder = null, txCount = null;
  try {
    const sig = await main("getSignaturesForAddress", [wallet, { limit: 1000 }]);
    const list = (sig && sig.result) || [];
    txCount = list.length >= 1000 ? 1000 : list.length; // 1000 = capped (established); exact otherwise
    if (list.length) {
      const oldest = list[list.length - 1].signature; // last = earliest
      const tx = await main("getTransaction", [oldest, { maxSupportedTransactionVersion: 0 }]);
      const t = tx && tx.result;
      if (t && t.meta && t.transaction) {
        const keys = t.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
        const pre = t.meta.preBalances || [], post = t.meta.postBalances || [];
        let maxDrop = 0;
        for (let i = 0; i < keys.length; i++) {
          const drop = (pre[i] || 0) - (post[i] || 0); // lamports this account paid out
          if (keys[i] !== wallet && drop > maxDrop) { maxDrop = drop; funder = keys[i]; }
        }
      }
    }
  } catch (e) {}
  const o = { funder, txCount };
  S.probeFunders[wallet] = o; // cache (null funder too) so we don't retrace
  return o;
}

// PROVEN-ONLY probe-cluster. Tiny deposit→withdraw round-trips look IDENTICAL to legit resumption testing, so the
// pattern alone NEVER alarms. Two independent on-chain proofs must BOTH hold before we alarm:
//   (1) the wallets are genuinely FRESH/disposable on-chain (≤PROBE_FRESH_TX_MAX lifetime txs) — not real traders/MMs, and
//   (2) ≥3 of those fresh wallets share a single common FUNDER — the coordination fingerprint (one entity spun them up).
// Established wallets (hundreds of txs) that merely share an exchange/MM funder are excluded by (1); independently
// funded fresh testers are excluded by (2). Only a genuinely coordinated disposable-wallet cluster survives.
async function checkProbeCluster(ev) {
  if (!SECURITY_ALERTS() || probeBusy) return;
  const probes = (ev && ev.probes) || [];
  if (probes.length < 3) { if (S.probeClusterKey) { S.probeClusterKey = null; saveState(); } return; } // cluster gone → reset latch
  probeBusy = true;
  try {
    const byFunder = {};
    let freshCount = 0;
    for (const p of probes) {
      const { funder, txCount } = await getOrigin(p.wallet);
      if (txCount == null || txCount > PROBE_FRESH_TX_MAX) continue; // PROOF 1: established wallet → not a disposable rehearsal wallet
      freshCount++;
      if (funder) (byFunder[funder] = byFunder[funder] || []).push(p.wallet);
    }
    let topFunder = null, group = [];
    for (const [f, ws] of Object.entries(byFunder)) if (ws.length > group.length) { group = ws; topFunder = f; }
    if (group.length < 3) { // PROOF 2 fails → no coordinated fresh cluster → SILENT (correct for legit testers / MM-funded traders)
      if (S.probeClusterKey) { S.probeClusterKey = null; saveState(); }
      if (freshCount) log(`probe-check: ${freshCount} fresh probe wallet(s) but no common funder ≥3 → silent (not coordinated)`);
      return;
    }
    const key = topFunder + ":" + group.length;
    if (S.probeClusterKey === key) return; // already alerted this exact cluster
    S.probeClusterKey = key; saveState();
    let funderN = "?"; // funder size, for the operator's judgement
    try { const s = await main("getSignaturesForAddress", [topFunder, { limit: 1000 }]); const n = ((s && s.result) || []).length; funderN = n >= 1000 ? "1000+" : String(n); } catch (e) {}
    log(`🔴 COORDINATED PROBE CLUSTER: ${group.length} FRESH wallets (≤${PROBE_FRESH_TX_MAX} txs) share funder ${topFunder}`);
    sendSecurityAlert(
      `🔴  SECURITY · FLASH V2\n━━━━━━━━━━━━━━━━━━━━\nCOORDINATED PROBE CLUSTER\n\n` +
      `${group.length} freshly-created wallets (each <${PROBE_FRESH_TX_MAX} lifetime txs) running tiny deposit→withdraw round-trips are ALL funded by ONE source:\n${topFunder}\n(funder ≈ ${funderN} txs)\n\n` +
      `Wallets: ${group.slice(0, 5).map((w) => w.slice(0, 6) + "…").join(", ")}${group.length > 5 ? " …" : ""}\n\n` +
      `⚠️ PROVEN on-chain (two independent signals): disposable wallets + single common funder + dust round-trips = the exact exploit-rehearsal fingerprint. This is NOT resumption testing. Investigate now.`
    );
  } finally { probeBusy = false; }
}

// ─── LAYER 3: AUTO-CONTAINMENT ───────────────────────────────────────────────
// Nominates candidates from the live eval, proves over-withdrawal on-chain (full-history),
// and on PROOF fires the automated response: max-priority alert + signed-intent webhook to
// Flash's authorized responder. Latched (contains once per wallet). Gated by CONTAINMENT=1.
// Slow-drip accumulator: track each wallet's CUMULATIVE net outflow (out − in) in USD, persisted across event
// pruning. A drip that stays under every 1h/24h velocity threshold still creeps this total up — and any wallet
// past the floor is nominated for the full-history proof. Reset when a wallet is proven entitled.
function updateDriftAccum() {
  S.driftAccum = S.driftAccum || {}; const since = S.driftAccumAt || 0; let maxT = since;
  for (const e of S.events) {
    if (!e.wallet || e.blockTime <= since || (S.authority && e.wallet === S.authority)) continue;
    const u = e.usd || 0;
    S.driftAccum[e.wallet] = (S.driftAccum[e.wallet] || 0) + (e.direction === "out" ? u : -u);
    if (e.blockTime > maxT) maxT = e.blockTime;
  }
  S.driftAccumAt = maxT;
  for (const w of Object.keys(S.driftAccum)) if (!(S.driftAccum[w] > 500)) delete S.driftAccum[w]; // drop noise + net-inflow wallets
  const ks = Object.keys(S.driftAccum);
  if (ks.length > 2000) { const keep = {}; for (const w of ks.sort((a, b) => S.driftAccum[b] - S.driftAccum[a]).slice(0, 2000)) keep[w] = S.driftAccum[w]; S.driftAccum = keep; }
}
let containBusy = false;
async function runContainment(ev) {
  // The airtight lifetime-proof runs whenever the operator wants security alerts OR has armed auto-containment.
  // Detection (the proven alarm) is decoupled from the auto-response so the strongest signal is never off by default.
  if ((!SECURITY_ALERTS() && !containment.CONTAINMENT()) || containBusy) return;
  const c = containment.cfg();
  const cands = containment.selectCandidates(ev, c);
  // slow-drip: also nominate any wallet whose CUMULATIVE net outflow has crept past the floor (survives pruning)
  const nominated = new Set(cands.map((x) => x.wallet));
  for (const [w, cum] of Object.entries(S.driftAccum || {})) if (cum >= c.minUsd && !nominated.has(w)) cands.push({ wallet: w, out1hUsd: 0, out24hUsd: cum, in24hUsd: 0, entitlement: false });
  if (!cands.length) return;
  cands.sort((a, b) => (b.out1hUsd || 0) - (a.out1hUsd || 0) || (b.out24hUsd || 0) - (a.out24hUsd || 0)); // prove the biggest/most-live withdrawals first
  containBusy = true;
  try {
    const flashVaults = new Set(Object.keys(S.balances || {})); // vault token accounts — counterparty check for the proof
    let traced = 0;
    for (const cand of cands) {
      const w = cand.wallet;
      if (S.containment.trips[w]) continue;                                  // already contained — latched
      const seen = S.containment.checked[w];
      if (seen && (now() - seen.ts) < 1800 && !cand.entitlement && cand.out1hUsd <= (seen.out || 0) * 1.5) continue; // re-trace within 30m only if entitlement-flagged or the outflow grew >50%
      if (traced >= 3) break;                                                // bound on-chain proof work per cycle (rest re-checked next cycle)
      traced++;
      // Trace the collateral the candidate ACTUALLY withdrew — Layer 3 was USDC-only, so a SOL/BTC/ETH drain
      // must be proven in its own mint and valued at its mark, or it would pass invisibly.
      let mint = c.collateralMint, mintUsd = 0;
      for (const e of S.events) { if (e.wallet !== w || e.direction !== "out" || !e.mint || (now() - e.blockTime) > 3600) continue; const u = e.usd || 0; if (u > mintUsd) { mintUsd = u; mint = e.mint; } }
      let markUsd = 1;
      if (mint !== c.collateralMint) { const tk = (ev.tokens || []).find((t) => t.mint === mint); markUsd = tk && tk.markUsd > 0 ? tk.markUsd : 0; }
      // If the collateral can't be valued, we cannot PROVE over-withdrawal → escalate to a human, never stay silent.
      if (markUsd === 0) {
        // Unpriced collateral — can't value to PROVE over-withdrawal. NOT alarmed (not a proven threat, and it
        // would spam on legit exotic-token withdrawals). A real drain here still surfaces as a raw-unit deficit
        // in the census vaultSolvency invariant → that PROVEN alarm is the backstop. Log only.
        if (cand.out1hUsd >= c.minUsd) log(`containment: ${w.slice(0, 8)} unpriced-collateral $${Math.round(cand.out1hUsd)}/1h — unprovable here, census solvency backstops`);
        S.containment.checked[w] = { ts: now(), out: cand.out1hUsd, capped: true, proven: false };
        continue;
      }
      const proof = await containment.verifyDrain(w, main, { ...c, collateralMint: mint }, flashVaults, markUsd);
      S.containment.checked[w] = { ts: now(), out: cand.out1hUsd, capped: proof.capped, proven: proof.proven };
      if (!proof.proven) {
        // Not proven over-withdrawal (a real whale whose full history we can't trace, or genuinely entitled).
        // NOT alarmed — that would spam on legit large withdrawals and is not a proven threat. A genuine
        // over-withdrawal from such a wallet still surfaces as a census solvency deficit → PROVEN alarm.
        if (S.driftAccum) delete S.driftAccum[w]; // cleared → reset its drip accumulator so it doesn't re-nominate
        if (proof.capped && cand.out1hUsd >= c.minUsd) log(`containment: ${w.slice(0, 8)} $${Math.round(cand.out1hUsd)}/1h history-capped, unprovable — census solvency backstops`);
        continue;
      }
      // PROVEN OVER-WITHDRAWAL (airtight, full lifetime history) → ALWAYS alarm the operator. If auto-containment
      // is armed (CONTAINMENT=1), ALSO fire the signed pause-request to Flash's responder.
      const contained = containment.CONTAINMENT();
      log(`🚨🚨 PROVEN OVER-WITHDRAWAL: ${w} — $${Math.round(proof.lifetimeOut)} out vs $${Math.round(proof.lifetimeIn)} in (${proof.txCount}-tx full history)${contained ? " — CONTAINING" : ""}`);
      // CRITICAL: latch (and fire the auto-response) ONLY after the alarm is CONFIRMED delivered. If Telegram is
      // down, we do NOT latch — the wallet is re-verified + the alarm re-sent every cycle until it lands. Un-missable.
      const delivered = await sendSecurityAlert(containment.buildAlarmText(proof, c, contained));
      if (!delivered) { log(`containment alarm for ${w.slice(0, 8)} NOT delivered — re-attempting next cycle (not latched)`); delete S.containment.checked[w]; continue; }
      S.containment.trips[w] = { wallet: w, lifetimeOut: proof.lifetimeOut, lifetimeIn: proof.lifetimeIn, ratio: proof.ratio === Infinity ? null : proof.ratio, txCount: proof.txCount, sigs: proof.sigs, mint, markUsd, contained, at: now() };
      S.containment.lastTrip = now();
      saveState();
      if (contained && c.webhook && isPublicHttpUrl(c.webhook)) {
        fetch(c.webhook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(containment.buildPayload(proof, c)), signal: AbortSignal.timeout(8000) })
          .then((r) => log(`containment signal POSTed to responder → ${r && r.ok ? "accepted" : "non-200"}`))
          .catch((e) => log(`containment webhook failed: ${e.message}`));
      }
    }
  } finally { containBusy = false; }
}

// ---------------- realtime push: WebSocket accountSubscribe on every vault ----------------
// Any balance change on any custody vault triggers an immediate decode cycle (~1s after the
// block) instead of waiting for the next poll. Baseline polling remains the safety net.
let ws = null, wsVaults = "", wsUp = false, fastTimer = null;
function triggerFastCycle() {
  if (fastTimer) return;
  fastTimer = setTimeout(() => { fastTimer = null; cycle("ws"); }, 1200);
}
function connectWs() {
  if (typeof WebSocket === "undefined") { log("WS: no WebSocket in this Node — push trigger disabled"); return; }
  const rc = tracked();
  const vaults = rc.map((c) => c.vault).sort().join(",");
  wsVaults = vaults;
  try { if (ws) { ws.onclose = null; ws.close(); } } catch (e) {}
  try {
    ws = new WebSocket(MAIN_URL.replace(/^https/, "wss").replace(/^http/, "ws"));
    ws.onopen = () => {
      wsUp = true;
      rc.forEach((c, i) => ws.send(JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: "accountSubscribe", params: [c.vault, { encoding: "base64", commitment: "confirmed" }] })));
      log(`WS: subscribed to ${rc.length} vault accounts (push-triggered capture)`);
    };
    ws.onmessage = (m) => { try { const j = JSON.parse(m.data); if (j.method === "accountNotification") triggerFastCycle(); } catch (e) {} };
    ws.onclose = () => { wsUp = false; setTimeout(connectWs, 5000); };
    ws.onerror = () => { try { ws.close(); } catch (e) {} };
  } catch (e) { wsUp = false; log("WS: " + e.message); }
}


// ---------------- independent price source: Pyth Lazer (Flash's own feed service, mapped by
// each oracle's on-chain lazer_feed_id) when LAZER_ACCESS_TOKEN is set; else the Flash V2 API Lazer feed. ----
async function refreshIndependentPrices() {
  // 1) direct Pyth Lazer (third-party independent) when LAZER_ACCESS_TOKEN is configured
  if (S.lazer.token) {
    try {
      if (!Object.keys(S.lazer.meta).length) S.lazer.meta = await fetchLazerMeta();
      const idBySym = {};
      for (const c of S.custodies) { const id = S.lazerIds[c.custody]; if (id && !(c.symbol in idBySym)) idBySym[c.symbol] = id; }
      const ids = [...new Set(Object.values(idBySym))];
      const lp = await fetchLazerLatest(ids, S.lazer.token, S.lazer.meta);
      const feeds = {}, prices = {};
      for (const [sym, id] of Object.entries(idBySym)) {
        const m = S.lazer.meta[id];
        feeds[sym] = { id, pythSymbol: (m && m.symbol) || ("lazer#" + id), source: "lazer" };
        if (lp[id]) prices[sym] = lp[id];
      }
      if (Object.keys(prices).length) {
        S.pyth = { feeds, prices, source: "lazer" };
        if (!S.lazer.ok) log(`oracle guard source → PYTH LAZER direct (${Object.keys(prices).length} feeds, on-chain feed ids)`);
        S.lazer.ok = true; S.lazer.reason = null;
        return;
      }
      throw new Error("lazer returned no usable prices");
    } catch (e) {
      if (S.lazer.ok || !S.lazer.reason) log(`lazer direct unavailable (${e.message}) — using Flash API Lazer feed`);
      S.lazer.ok = false; S.lazer.reason = e.message;
    }
  }
  // 2) Flash V2 API /prices — Flash's Lazer-fed price service (flashapi.trade, documented).
  //    A different system from the on-chain oracle writer: a forged mark diverges instantly.
  try {
    const flash = await fetchFlashLazerPrices();
    const byMint = (S.flashLazerIds && S.flashLazerIds.byMint) || {};
    const feeds = {}, prices = {};
    for (const c of allDescriptors()) {
      if (c.symbol in feeds) continue;
      const reg = c.mint ? byMint[c.mint] : null;          // exact mint match first
      const apiSym = reg ? reg.symbol : (flash[c.symbol] ? c.symbol : null);
      if (!apiSym || !flash[apiSym]) continue;
      feeds[c.symbol] = { id: reg && reg.lazerId != null ? reg.lazerId : null, pythSymbol: "Lazer/" + apiSym, source: "flash-api" };
      prices[c.symbol] = flash[apiSym];
    }
    if (Object.keys(prices).length) { S.pyth = { feeds, prices, source: "flash-api" }; return; }
    throw new Error("no overlapping symbols");
  } catch (e) { S.cycleErrors.push("flashapi prices: " + e.message); }
}

let lastCustodyRefresh = 0, busy = false, lastGovCheck = 0, lastReconCheck = 0;
let cycleStartedAt = 0, cycleGen = 0, cycleWedges = 0; // watchdog: detect + force-recover a hung cycle
const GOV_CHECK_MS = Number(process.env.GOV_CHECK_MS || 120000); // governance rarely changes; 5 RPCs
const RECON_CHECK_MS = Number(process.env.RECON_CHECK_MS || 180000); // basket-vs-market reconciliation (1 census fetch)
// A cycle normally takes ~15s; even a 429-storm with RPC retries stays well under this. If `busy` is still
// held past this ceiling, the cycle is wedged on an await that will never return (a monitor must NEVER be
// able to stall permanently) — the watchdog force-releases the lock so the next poll tick runs a fresh cycle.
const CYCLE_MAX_MS = Number(process.env.CYCLE_MAX_MS || 300000);
const WATCHDOG_TICK_MS = Number(process.env.WATCHDOG_TICK_MS || 15000);
async function cycle(reason) {
  if (busy) return;
  busy = true;
  const myGen = ++cycleGen;   // if the watchdog force-restarts, a newer cycle supersedes this one
  cycleStartedAt = Date.now();
  const t0 = Date.now();
  S.cycleErrors = [];
  try {
    if (Date.now() - lastCustodyRefresh > CUSTODY_REFRESH_MS) {
      await refreshCustodies(); lastCustodyRefresh = Date.now();
      const nowVaults = tracked().map((c) => c.vault).sort().join(",");
      if (nowVaults !== wsVaults) connectWs(); // new listing → resubscribe
    }
    const mk = await fetchMarks(er, main, allDescriptors());
    S.marks = mk.marks; S.markTimes = mk.markTimes; S.lazerIds = mk.lazerIds || {}; S.lazerMarks = mk.lazerMarks || {};
    try { S.markets = await scanMarkets(er, S.custodies, S.marks); } catch (e) { S.cycleErrors.push("markets: " + e.message); }
    const cutoff = now() - BACKFILL_HOURS * 3600;
    let freshCount = 0;
    for (const cust of tracked()) {
      try { freshCount += await pollVault(cust, cutoff); }
      catch (e) { S.cycleErrors.push(`${cust.pool}/${cust.symbol}: ${e.message}`); }
    }
    try { const p = await runSweep(cutoff); if (p) connectWs(); } catch (e) { S.cycleErrors.push("sweep: " + e.message); }
    S.balances = await fetchVaultBalances(main, tracked());
    checkConservation();
    await refreshIndependentPrices();
    if (Date.now() - lastGovCheck > GOV_CHECK_MS) { await checkGovernance(); lastGovCheck = Date.now(); }
    if (Date.now() - lastReconCheck > RECON_CHECK_MS) { await checkReconciliation(); lastReconCheck = Date.now(); }
    S.events.sort((a, b) => a.blockTime - b.blockTime);
    pruneMemory();
    repriceEvents(); // value unpriced-at-ingest flows at the current mark so they count toward the caps
    try { notifyWithdrawals(); } catch (e) { S.cycleErrors.push("wnotify: " + e.message); } // never let the firehose break the cycle
    try { checkNewPrograms(); } catch (e) { S.cycleErrors.push("newprog: " + e.message); } // new-program detector (rehearsal footprint)
    checkSettlementSigners().catch((e) => S.cycleErrors.push("settler: " + (e.message || e))); // AFX compromised-signer watch on the ER→base settlement path
    const ev = evaluate(now(), S.events, S.failures, allDescriptors(), S.balances, S.marks, S.markTimes, S.lazerMarks || {}, S.pyth, S.limits, S.authority);
    processAlertTransitions(ev);
    checkProbeCluster(ev).catch((e) => S.cycleErrors.push("probe: " + (e.message || e))); // proven-only coordinated-cluster (common-funder) verify → DM
    updateDriftAccum(); // accumulate per-wallet cumulative net outflow (slow-drip nominator), before containment
    runContainment(ev).catch((e) => S.cycleErrors.push("contain: " + (e.message || e)));  // Layer 3: proven-drain full-history verify → auto-response
    S.lastEval = ev;
    saveState();
    S.lastCycle = now(); S.cycleSeconds = +((Date.now() - t0) / 1000).toFixed(1); S.cycles++;
    heartbeat(); // dead-man ping — external monitor alerts if the sentinel goes silent
    maybeSendDigest(); // daily status broadcast to the channel
    maybeSendWeekly(); // weekly deep-dive broadcast
    maybeSendLiveStatus(); // live status → operator DM, edited in place every minute (no spam)
    maybeSendHourlySummary(); // hourly transaction report → operator DM (new message each hour)
    if (freshCount) log(`cycle #${S.cycles}${reason ? ` (${reason})` : ""}: +${freshCount} events, ${S.cycleSeconds}s, global out1h $${ev.global.out1hUsd} [${ev.global.status}]`);
    broadcast();
  } catch (e) {
    S.cycleErrors.push("cycle: " + (e.message || e));
    log("CYCLE ERROR:", e.message || e);
  } finally {
    // Only release the lock if we're still the current generation. If the watchdog already force-restarted
    // (this cycle was wedged and a newer cycle now owns `busy`), a late-resolving zombie must NOT clear the
    // newer cycle's lock — otherwise two cycles could run concurrently.
    if (cycleGen === myGen) busy = false;
  }
}

// ---------------- snapshot / api ----------------
function hourlyBuckets() {
  // Buckets are hour-aligned for readable axis labels, but ONLY events inside the same
  // rolling 24h window the KPIs use are counted — so Σ buckets always equals the 24h totals.
  const t = now(), start = t - 24 * 3600;
  const buckets = [];
  const h0 = Math.floor(start / 3600) * 3600;
  for (let h = h0; h <= t; h += 3600) buckets.push({ hourStart: h, inUsd: 0, outUsd: 0, inN: 0, outN: 0 });
  for (const e of S.events) {
    if (e.blockTime < start || e.blockTime > t) continue;
    if (S.authority && e.wallet === S.authority) continue; // internal vault→vault reshuffles excluded
    const idx = Math.floor((e.blockTime - h0) / 3600);
    const b = buckets[idx]; if (!b) continue;
    if (e.direction === "out") { b.outUsd += e.usd || 0; b.outN++; } else { b.inUsd += e.usd || 0; b.inN++; }
  }
  return buckets.map((b) => ({ ...b, inUsd: Math.round(b.inUsd * 100) / 100, outUsd: Math.round(b.outUsd * 100) / 100 }));
}
function conservationRows() {
  return tracked().map((c) => {
    const cv = S.conservation[c.vault] || null;
    const bal = S.balances[c.vault];
    return cv && {
      key: c.pool + "/" + c.symbol, vault: c.vault,
      baseRaw: cv.baseRaw, baseTime: cv.baseTime, sumDeltas: cv.sumDeltas,
      balanceRaw: bal == null ? null : bal.toString(), residual: cv.residual, status: cv.status, rebases: cv.rebases,
    };
  }).filter(Boolean);
}
// ---- security helpers ----
// never expose a configured alert-webhook secret (Discord/Slack/relay URLs embed tokens) to public reads
// public view: never expose the alert-webhook secret, and never expose the operator watchlist
// (a monitored-address list is operator-internal — leaking it tips off watched parties).
const publicLimits = (l) => { const { watchWallets, ...rest } = l || {}; return { ...rest, webhookUrl: l && l.webhookUrl ? "(configured)" : null }; };
// constant-time write-token comparison over fixed-length digests (no length leak, no early-exit timing)
const safeEq = (a, b) => { try { const h = (x) => crypto.createHash("sha256").update(String(x)).digest(); return crypto.timingSafeEqual(h(a), h(b)); } catch (e) { return false; } };
// block SSRF: a webhook URL must be public http(s), never loopback/private/link-local
const isPublicHttpUrl = (s) => { try { const u = new URL(s); if (u.protocol !== "http:" && u.protocol !== "https:") return false; let h = u.hostname.toLowerCase(); if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1); // unwrap IPv6 literal so the checks below see the raw address
  if (h === "localhost" || h.endsWith(".localhost") || h === "0.0.0.0" || h === "::1" || h === "::") return false;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
  // IPv6 private/loopback/link-local + IPv4-mapped loopback (::ffff:127.x). fc00::/7, fe80::/10, ::1.
  if (/^fc/.test(h) || /^fd/.test(h) || /^fe[89ab]/.test(h) || /^::ffff:(127|10|0)\./.test(h) || /^::1$/.test(h)) return false;
  return true; } catch (e) { return false; } };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'";
const SEC_HEADERS = { "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer" };

// The operator watchlist is internal — /api/state is public, so scrub any signal of WHICH wallets are
// watched: drop the `watched` flag, drop pure `watch:` alerts, and remove "on watchlist" from details.
// (Never mutates the shared S.lastEval / S.alertsActive — builds shallow copies.)
function redactWatchedEval(ev) {
  if (!ev || !Array.isArray(ev.wallets)) return ev;
  return { ...ev, wallets: ev.wallets.map((w) => (w && w.watched ? { ...w, watched: undefined } : w)) };
}
function redactWatchedAlerts(active, log) {
  const scrub = (d) => (typeof d === "string" ? d.replace(/on watchlist; ?/gi, "").replace(/WATCHED wallet active/gi, "wallet active") : d);
  const a = {};
  for (const [k, v] of Object.entries(active || {})) { if (k.startsWith("watch:")) continue; a[k] = v && v.detail ? { ...v, detail: scrub(v.detail) } : v; }
  const l = (log || []).filter((x) => !String(x && x.rule || "").startsWith("watch:")).map((x) => (x && x.detail ? { ...x, detail: scrub(x.detail) } : x));
  return { active: a, log: l };
}
function snapshot() {
  const consRows = conservationRows();
  return {
    meta: {
      name: "FLASH FLOW SENTINEL", program: PROG, cluster: "mainnet", erRpc: redact(ER_URL), mainRpc: redact(MAIN_URL),
      erSlot: S.erSlot, custodies: S.custodies.length, realVaults: realC().length, trackedVaults: tracked().length, markets: S.markets.length, pools: S.pools,
      sweep: { authority: S.authority, watched: Object.keys(S.sweepBal).length, promoted: Object.keys(S.dynamic).length, namedVaults: S.named.map((n) => `${n.pool}/${n.symbol}`) },
      startedAt: S.startedAt, lastCycle: S.lastCycle, cycleSeconds: S.cycleSeconds, pollMs: POLL_MS, cycles: S.cycles, wsPush: wsUp, cycleWedges,
      wFeed: WITHDRAWAL_ALERTS() ? { on: true, sinceUnix: S.wAlertFrom, sentCount: (S.wAlertSent || []).length, sending: wSending } : { on: false },
      // freshness/coverage the client uses to gate the verdict: serverNow−lastCycle = true staleness even
      // if the cycle loop wedges (the HTTP server keeps serving), backfilling until first full scan done.
      // Stale cutoff adapts to how long a cycle actually takes on the current RPC (a full poll of 52 vaults
      // on a slow/public RPC legitimately runs ~100s) so a healthy-but-slow cycle isn't falsely flagged
      // stale; bounded 180–600s. A genuine hang is caught separately by the watchdog (CYCLE_MAX_MS).
      serverNow: now(), ready: S.ready, backfilling: !S.ready, staleCutoffSec: Math.min(600, Math.max(180, Math.round((S.cycleSeconds || 0) * 2))),
      oracleFeedCount: Object.keys(S.pyth.prices || {}).length, // 0 ⇒ independent cross-check is down (not "aligned")
      coverageDegraded: S.coverageDegraded || null,
      backfillHours: BACKFILL_HOURS, retentionHours: RETENTION_HOURS, eventsRetained: S.events.length,
      cycleErrors: S.cycleErrors.slice(0, 8),
      skippedTxs: (S.skippedSigs || []).slice(-10).reverse(), // txs skipped after 6 undecodable retries (conservation drift still backstops any missed delta)
      oracleSource: S.pyth.source || "flash-api", lazer: { tokenPresent: !!S.lazer.token, ok: S.lazer.ok, reason: S.lazer.reason },
      channels: channelsConfigured(),
      // Alerting posture — surfaced so a silenced monitor can NEVER look normal. muted = ALERTS_MUTED kills the
      // primary flow-guard pushes; security/withdrawals/containment reflect the opt-in detector channels.
      alerting: { muted: process.env.ALERTS_MUTED === "1", security: SECURITY_ALERTS(), withdrawals: WITHDRAWAL_ALERTS(), containment: containment.CONTAINMENT(), liveStatus: LIVE_STATUS(), liveStatusPosted: !!S.liveStatusMsgId },
      squadsMofN: process.env.SQUADS_MOFN || "3-of-7", // Squads governance threshold (operator-set, verifiable on the Squads app)
      limitsWritable: HOST === "127.0.0.1" && !process.env.LIMITS_WRITE_TOKEN, // public view is read-only
      dataNote: "All values decoded from real on-chain state: base-chain SPL transfers (exact u64 vault deltas from pre/post token balances, confirmed commitment), ER custody/oracle accounts via the program's own on-chain IDL, Pyth Lazer cross-check. Tracked vaults = every custody vault + TradeVault + RebateVault + FAF TokenVault, plus a balance sweep of EVERY token account owned by the program's vault authority — any untracked account that moves is auto-promoted to full per-transaction tracking. Capture is push-triggered by WebSocket accountSubscribe plus a baseline poll. Each flow is valued in USD at the on-chain oracle mark observed at capture (stablecoins at $1); a flow whose mark was not yet resolved at capture is valued once its mark is available, and shown as unpriced until then — never dropped. No synthetic data.",
      guardNote: "Guards bound the drain class seen across perp DEXes: a manipulated or stale price feed generating fake profits that exit the vaults within minutes.",
    },
    limits: publicLimits(S.limits),
    evaluation: redactWatchedEval(S.lastEval) || null,
    markets: S.markets,
    hourly: hourlyBuckets(),
    hourlySides: hourlyBucketsBySide(now(), S.events, S.authority),
    conservation: { rows: consRows, allExact: consRows.length > 0 && consRows.every((r) => r.status === "exact"), sinceOldestBase: consRows.length ? Math.min(...consRows.map((r) => r.baseTime)) : null },
    // reconciliation-anomaly watch: live basket-vs-market phantom-position count + the set currently open.
    // A NEW phantom is the 7-day-rehearsal fingerprint (over-withdrawal path being exercised) — alerted privately.
    reconciliation: S.reconStatus ? { ...S.reconStatus, openPhantoms: Object.values(S.reconKnown).map((m) => ({ market: m.market, side: m.side, pool: m.pool, posDiff: m.posDiff, firstSeen: m.firstSeen })) } : null,
    // Layer 3 auto-containment posture + any proven-drain trips (proof-gated; sentinel holds no pause key by design).
    containment: { ...containment.posture(containment.cfg(), SECURITY_ALERTS()), lastTrip: S.containment.lastTrip, trips: Object.values(S.containment.trips).slice(-10).reverse() },
    governance: S.governance ? { ...S.governance, changes: S.govChanges.slice(-40).reverse(), authorizedUpgrades: S.authorizedUpgrades.slice(-20).reverse() } : null,
    // settlement-signer watch: the authorized ER→base crank set (AFX compromised-signer tripwire). Any settlement
    // signed by a key outside this set fires a CRITICAL private alarm — auth-model-aware, unlike conservation/census.
    settlementWatch: { seeded: S.settlerSeeded, authorizedSettlers: Object.keys(S.knownSettlers), pinned: EXPECTED_SETTLERS.length > 0, watches: "ProcessUndelegation (ER→base commit)" },
    alerts: redactWatchedAlerts(S.alertsActive, S.alertsLog.slice(-100).reverse()),
    events: S.events.slice(-250).reverse().map((e) => ({ ...e, kind: classify(e.ix || [], e.direction), internal: !!(S.authority && e.wallet === S.authority) })),
    failures1h: S.failures.filter((f) => f.blockTime >= now() - 3600).length,
    pythFeeds: Object.keys(S.pyth.feeds).length,
  };
}
function broadcast() {
  const msg = `event: cycle\ndata: ${JSON.stringify({ at: now(), cycles: S.cycles })}\n\n`;
  for (const res of S.sse) { try { res.write(msg); } catch (e) { S.sse.delete(res); } }
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const send = (code, body, type = "application/json") => { res.writeHead(code, { "Content-Type": type, "Access-Control-Allow-Origin": "*", ...SEC_HEADERS }); res.end(body); };
  try {
    if (u.pathname === "/api/state") return send(200, JSON.stringify(snapshot()));
    if (u.pathname === "/api/events") {
      const hours = Math.min(Number(u.searchParams.get("hours") || 24), RETENTION_HOURS);
      const limit = Math.min(Number(u.searchParams.get("limit") || 2000), 10000);
      const cutoff = now() - hours * 3600;
      // re-label each event's symbol from its mint against the CURRENT (merged) symbol map, so the feed
      // never shows a stale mint prefix baked in when the event was first captured (pre-symbol-merge).
      const relabel = (e) => { const s = symbolForMint(e.mint); return s && s !== e.symbol ? { ...e, symbol: s } : e; };
      return send(200, JSON.stringify(S.events.filter((e) => e.blockTime >= cutoff).slice(-limit).reverse().map(relabel)));
    }
    // DRY-RUN containment proof for ANY wallet (demo the Layer-3 verifier on the historical attacker, etc.).
    // Read-only: no alarm, no webhook, no state change — but heavy RPC, so operator-gated (write token / loopback).
    if (u.pathname === "/api/containment/verify" && req.method === "GET") {
      const tok = process.env.LIMITS_WRITE_TOKEN;
      if (tok ? !safeEq(req.headers["x-limits-token"], tok) : HOST !== "127.0.0.1")
        return send(403, JSON.stringify({ ok: false, error: "operator-gated (heavy RPC): send x-limits-token or run on the local daemon" }));
      const wallet = u.searchParams.get("wallet");
      if (!wallet || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) return send(400, JSON.stringify({ ok: false, error: "valid ?wallet= required" }));
      const c = containment.cfg();
      containment.verifyDrain(wallet, main, c, new Set(Object.keys(S.balances || {})))
        .then((v) => send(200, JSON.stringify({ ok: true, dryRun: true, wouldContain: v.proven, verdict: v })))
        .catch((e) => send(500, JSON.stringify({ ok: false, error: e.message })));
      return;
    }
    // write-gate: mutations (limits, ack). Local loopback daemon = trusted (operator's machine).
    // Hosted (0.0.0.0): require LIMITS_WRITE_TOKEN via header; without it, writes are disabled so
    // a public visitor can never change your caps. Reads always stay open.
    const WRITE_TOKEN = process.env.LIMITS_WRITE_TOKEN;
    const isWrite = (u.pathname === "/api/ack" || u.pathname === "/api/limits") && req.method === "POST";
    if (isWrite) {
      // CSRF guard: /api/ack is a bodyless "simple" POST, so a malicious page could fire it cross-site
      // at the loopback daemon with no preflight. Reject any browser request whose Sec-Fetch-Site says
      // it's cross-site. Non-browser clients (curl/operator scripts) don't send the header → allowed.
      if (String(req.headers["sec-fetch-site"] || "").toLowerCase() === "cross-site") return send(403, JSON.stringify({ ok: false, error: "cross-site write blocked" }));
      if (WRITE_TOKEN) {
        if (!safeEq(req.headers["x-limits-token"], WRITE_TOKEN)) return send(403, JSON.stringify({ ok: false, error: "invalid x-limits-token" }));
      } else if (HOST !== "127.0.0.1") {
        return send(405, JSON.stringify({ ok: false, error: "writes disabled on the public deployment — set LIMITS_WRITE_TOKEN (and send it as x-limits-token) or edit limits from the local daemon" }));
      }
    }
    // acknowledge (clear) a latched governance alert after a human has reviewed it
    if (u.pathname === "/api/ack" && req.method === "POST") {
      const rule = u.searchParams.get("rule");
      // rule=all: clear the latched governance alerts AND the change log that drives the red verdict.
      // The baseline is already advanced to current on each detection, so clearing the log won't re-fire
      // the same (already-reviewed) changes; only a NEW change re-latches.
      if (rule === "wreset") { S.wAlertFrom = now(); S.wAlertSent = []; S._wSent = new Set(); saveState(); return send(200, JSON.stringify({ ok: true, withdrawalFeed: "reset to now — every withdrawal from this instant posts to the main channel, no gaps, no dupes" })); }
      if (rule === "containment") { const n = Object.keys(S.containment.trips).length; S.containment.trips = {}; S.containment.checked = {}; S.containment.lastTrip = null; saveState(); return send(200, JSON.stringify({ ok: true, containment: `re-armed — cleared ${n} trip(s); wallets will be re-verified on next activity` })); }
      if (rule === "all") { for (const k of Object.keys(S.alertsActive)) if (k.startsWith("gov:")) delete S.alertsActive[k]; S.govChanges = []; }
      else if (rule && S.alertsActive[rule]) delete S.alertsActive[rule];
      else return send(404, JSON.stringify({ ok: false, error: "no such active alert" }));
      saveState();
      return send(200, JSON.stringify({ ok: true, active: Object.keys(S.alertsActive) }));
    }
    if (u.pathname === "/api/limits" && req.method === "GET") return send(200, JSON.stringify(publicLimits(S.limits)));
    if (u.pathname === "/api/limits" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 65536) req.destroy(); });
      req.on("end", () => {
        try {
          const j = JSON.parse(body);
          // caps/thresholds must be POSITIVE or null(=disabled). Reject 0 — every rule gates on `limit>0`,
          // so a 0 cap silently DISABLES the guard (false green) instead of tightening it. null is the
          // only intended "disabled" value; use a real positive number to actually cap.
          const num = (v) => (v === null || (typeof v === "number" && Number.isFinite(v) && v > 0) ? v : undefined);
          const patch = {};
          if (num(j.globalOutflowUsdPerHour) !== undefined) patch.globalOutflowUsdPerHour = j.globalOutflowUsdPerHour;
          if (typeof j.warnFraction === "number" && j.warnFraction > 0 && j.warnFraction <= 1) patch.warnFraction = j.warnFraction;
          if (num(j.defaultTokenOutflowUsdPerHour) !== undefined) patch.defaultTokenOutflowUsdPerHour = j.defaultTokenOutflowUsdPerHour;
          if (j.perTokenOutflowUsdPerHour && typeof j.perTokenOutflowUsdPerHour === "object") { patch.perTokenOutflowUsdPerHour = {}; for (const [k, v] of Object.entries(j.perTokenOutflowUsdPerHour)) if (num(v) !== undefined) patch.perTokenOutflowUsdPerHour[k] = v; }
          if (num(j.perWalletOutflowUsdPerHour) !== undefined) patch.perWalletOutflowUsdPerHour = j.perWalletOutflowUsdPerHour;
          if (num(j.vaultDrawdownPctPerHour) !== undefined) patch.vaultDrawdownPctPerHour = j.vaultDrawdownPctPerHour;
          if (num(j.drawdownMinUsd) !== undefined) patch.drawdownMinUsd = j.drawdownMinUsd;
          if (num(j.oracleDeviationPct) !== undefined) patch.oracleDeviationPct = j.oracleDeviationPct;
          if (j.webhookUrl === null || (typeof j.webhookUrl === "string" && isPublicHttpUrl(j.webhookUrl))) patch.webhookUrl = j.webhookUrl;
          S.limits = { ...S.limits, ...patch };
          saveLimits();
          if (S.lastEval) { const ev = evaluate(now(), S.events, S.failures, allDescriptors(), S.balances, S.marks, S.markTimes, S.lazerMarks || {}, S.pyth, S.limits, S.authority); processAlertTransitions(ev); S.lastEval = ev; }
          send(200, JSON.stringify({ ok: true, limits: publicLimits(S.limits) }));
        } catch (e) { send(400, JSON.stringify({ ok: false, error: e.message })); }
      });
      return;
    }
    if (u.pathname === "/events") {
      if (S.sse.size >= 512) { res.writeHead(503, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" }); res.end("too many streams"); return; } // cap concurrent SSE clients (FD/memory exhaustion guard)
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "Access-Control-Allow-Origin": "*", ...SEC_HEADERS });
      res.write("retry: 3000\n\n");
      S.sse.add(res);
      req.on("close", () => S.sse.delete(res));
      return;
    }
    // static (root files, allowlisted — same files Vercel serves)
    const STATIC = new Set(["index.html", "app.js", "styles.css", "flash-trade-v2.png", "favicon.png"]);
    const name = u.pathname === "/" ? "index.html" : u.pathname.slice(1);
    if (STATIC.has(name)) {
      // HTML must always revalidate (so new ?v= asset tags are picked up); assets are versioned → cacheable
      const cache = name === "index.html" ? "no-cache, must-revalidate" : "public, max-age=300";
      const hdrs = { "Content-Type": MIME[path.extname(name)] || "application/octet-stream", "Access-Control-Allow-Origin": "*", "Cache-Control": cache, ...SEC_HEADERS };
      if (name === "index.html") hdrs["Content-Security-Policy"] = CSP; // XSS/clickjacking backstop on the document
      res.writeHead(200, hdrs);
      return res.end(fs.readFileSync(path.join(__dirname, name)));
    }
    send(404, JSON.stringify({ error: "not found" }));
  } catch (e) { log("HTTP 500:", e.message); send(500, JSON.stringify({ error: "internal error" })); } // don't leak internals/paths
});

// ---------------- startup ----------------
(async () => {
  if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
  loadLimits(); loadState(); loadEvents();
  // one-time migration: the drawdown alarm default was raised 5→20/h (5%/h false-warned on normal
  // small-vault trading, well under the $100k/h cap). Bump any persisted value still at the old 5.
  if (S.limits.vaultDrawdownPctPerHour === 5 && DEFAULT_LIMITS.vaultDrawdownPctPerHour !== 5) {
    S.limits.vaultDrawdownPctPerHour = DEFAULT_LIMITS.vaultDrawdownPctPerHour; saveLimits();
    log(`migrated vaultDrawdownPctPerHour 5 → ${S.limits.vaultDrawdownPctPerHour}/h`);
  }
  log(`FLASH FLOW SENTINEL — program ${PROG}`);
  log(`ER: ${redact(ER_URL)} | base: ${redact(MAIN_URL)} | poll ${POLL_MS / 1000}s | backfill ${BACKFILL_HOURS}h`);

  // Listen IMMEDIATELY so a hosting platform's health check passes and the page loads (showing
  // "ARMING GUARDS…") during the initial backfill, instead of the container looking dead for ~60s.
  server.listen(PORT, HOST, () => log(`dashboard → http://${HOST}:${PORT}`));

  // Resolve real symbols from Flash's LIVE pool-config manifest (source of truth, no stale SDK snapshot)
  // BEFORE the first custody scan, so alerts/charts/labels show "GRAM"/"BP"/"ORE" instead of a mint prefix.
  try { const added = mergeSymbols(await fetchPoolConfigSymbols("mainnet-beta")); log(`pool-config symbols merged: +${added} mints from live manifest`); }
  catch (e) { log("pool-config symbols: " + (e.message || e)); }

  await refreshCustodies(); lastCustodyRefresh = Date.now();
  log(`custodies: ${S.custodies.length} total (${realC().length} real vaults) across ${S.pools} pools (ER slot ${S.erSlot})`);

  // vault authority (from the first custody vault's token-account owner) + named vaults + sweep baseline
  try {
    const rc0 = realC()[0];
    const r = await main("getMultipleAccounts", [[rc0.vault], { encoding: "jsonParsed" }]);
    S.authority = r.result.value[0].data.parsed.info.owner;
  } catch (e) { log("authority discovery failed: " + (e.message || e)); }
  const namedRaw = await scanNamedVaults(er, S.custodies);
  const sweep0 = S.authority ? await sweepAuthority(main, S.authority) : {};
  S.named = namedRaw.map((v) => describeVault(v, S.custodies, sweep0[v.ta] || null));
  // re-describe persisted dynamic promotions against the fresh custody list
  for (const [ta, d] of Object.entries(S.dynamic)) S.dynamic[ta] = describeVault({ pda: d.custody, pool: d.pool, ta, mint: d.mint, kind: d.kind }, S.custodies, sweep0[ta] || null);
  for (const [ta, info] of Object.entries(sweep0)) if (S.sweepBal[ta] == null) S.sweepBal[ta] = info.amountRaw;
  log(`vault authority ${S.authority ? S.authority.slice(0, 8) + "…" : "?"} — named vaults: ${S.named.map((n) => `${n.pool}/${n.symbol}`).join(", ") || "none"} · sweep watching ${Object.keys(S.sweepBal).length} token accounts (${Object.keys(S.dynamic).length} promoted)`);

  // official Lazer feed ids from Flash API /tokens (symbol → lazerId)
  try { S.flashLazerIds = await fetchFlashLazerIds(); mergeSymbols((S.flashLazerIds && S.flashLazerIds.byMint) || null); } catch (e) { log("flashapi /tokens: " + (e.message || e)); }
  log(`price source: ${S.lazer.token ? "PYTH LAZER direct (token present)" : "Flash API Lazer feed (flashapi.trade/prices)"} · ${Object.keys((S.flashLazerIds && S.flashLazerIds.byMint) || {}).length} tokens in registry`);

  { const mk = await fetchMarks(er, main, allDescriptors()); S.marks = mk.marks; S.markTimes = mk.markTimes; S.lazerIds = mk.lazerIds || {}; S.lazerMarks = mk.lazerMarks || {}; }
  log(`oracle marks: ${Object.keys(S.marks).length}/${allDescriptors().length}`);
  try { S.markets = await scanMarkets(er, S.custodies, S.marks); log(`markets: ${S.markets.length} market-sides live`); } catch (e) { log("markets: " + e.message); }

  // EARLY PAINT: evaluate the events loaded from disk (persistent volume) + live balances BEFORE the
  // heavy per-vault backfill, so a restart serves last-good real data within seconds instead of empties.
  try {
    S.balances = await fetchVaultBalances(main, tracked());
    S.events.sort((a, b) => a.blockTime - b.blockTime);
    await refreshIndependentPrices();
    repriceEvents();
    S.lastEval = evaluate(now(), S.events, S.failures, allDescriptors(), S.balances, S.marks, S.markTimes, S.lazerMarks || {}, S.pyth, S.limits, S.authority);
    S.lastCycle = now(); S.cycles = 1;
    log(`early paint from ${S.events.length} persisted events: 24h out $${S.lastEval.global.out24hUsd} in $${S.lastEval.global.in24hUsd}`);
  } catch (e) { log("early paint skipped: " + e.message); }

  // initial backfill (custody vaults + TradeVault/RebateVault/TokenVault + promoted accounts)
  const cutoff = now() - BACKFILL_HOURS * 3600;
  log(`backfilling ${BACKFILL_HOURS}h of real transfers for ${tracked().length} vaults…`);
  let n = 0;
  for (const cust of tracked()) {
    try { const f = await pollVault(cust, cutoff); n += f; if (f) log(`  ${cust.pool}/${cust.symbol}: +${f} events`); }
    catch (e) { log(`  ${cust.pool}/${cust.symbol}: ${e.message}`); }
  }
  log(`backfill complete: ${n} new events (${S.events.length} total retained)`);

  S.balances = await fetchVaultBalances(main, tracked());
  checkConservation(); // establishes per-vault baselines → conservation proof runs from here
  await refreshIndependentPrices();
  await checkGovernance(); lastGovCheck = Date.now(); // baseline the authority surface at startup
  { const g = S.governance, ch = channelsConfigured();
    log(`governance: upgrade authority ${g && g.upgradeAuthority ? g.upgradeAuthority.slice(0, 6) + "…" : "?"}${g && g.upgradeControl ? " (control: " + g.upgradeControl.model + ")" : ""} · Squads ${process.env.SQUADS_MOFN || "3-of-7"} · alert channels: ${Object.entries(ch).filter(([, v]) => v).map(([k]) => k).join(", ") || "none (set TELEGRAM_*/SLACK_WEBHOOK_URL/HEARTBEAT_URL)"}`); }
  S.events.sort((a, b) => a.blockTime - b.blockTime);
  repriceEvents();
  const ev = evaluate(now(), S.events, S.failures, allDescriptors(), S.balances, S.marks, S.markTimes, S.lazerMarks || {}, S.pyth, S.limits, S.authority);
  processAlertTransitions(ev);
  S.lastEval = ev;
  S.ready = true; // initial backfill complete → guards are now authoritative (verdict may go green)
  S.lastCycle = now(); S.cycles = 1;
  saveState();
  log(`global outflow 1h: $${ev.global.out1hUsd} / $${ev.global.limitUsdPerHour} [${ev.global.status}] | 24h out $${ev.global.out24hUsd} in $${ev.global.in24hUsd}`);

  // self-contained dead-man: if the daemon was down longer than a normal restart, tell the operator
  // (privately) how long it was silent — so an outage never passes unnoticed even without an external monitor.
  const downGap = S.lastSavedAt ? now() - S.lastSavedAt : 0;
  if (downGap > 240) { // >4 min gap = a real outage, not a routine redeploy
    const mins = Math.floor(downGap / 60);
    sendOperator(`⚠️ FLASH FLOW SENTINEL restarted after ${mins >= 60 ? Math.floor(mins / 60) + "h " + (mins % 60) + "m" : mins + "m"} of downtime — now back online and monitoring.\nGuards: ${ev.global.status === "ok" ? "green" : ev.global.status}. Dashboard: flash-flow-sentinel.vercel.app`);
    log(`recovery notice sent to operator (was down ${mins}m)`);
  }

  connectWs();
  setInterval(() => cycle("poll"), POLL_MS);
  // WATCHDOG — the guarantee that the monitor can never stall permanently. Runs on its own timer (the event
  // loop stays alive even while a cycle's await is hung — the HTTP server keeps serving), so it can always
  // fire. If a cycle has held `busy` past the ceiling, it's wedged on an await that will never return: log
  // loudly, notify the operator, and force-release the lock (bumping the generation so the zombie can't
  // clobber the fresh cycle). The next poll tick then runs a clean cycle within POLL_MS.
  setInterval(() => {
    if (!busy || !cycleStartedAt) return;
    const stuckMs = Date.now() - cycleStartedAt;
    if (stuckMs <= CYCLE_MAX_MS) return;
    cycleWedges++;
    const stuckS = Math.round(stuckMs / 1000);
    cycleGen++;      // supersede the wedged cycle → its finally won't release the next cycle's lock
    busy = false;    // release so the next poll tick starts fresh
    cycleStartedAt = 0;
    log(`WATCHDOG: cycle wedged ${stuckS}s on a hung await — force-released the lock; monitoring resuming (wedge #${cycleWedges})`);
    try { S.cycleErrors.unshift(`watchdog: force-reset a cycle wedged ${stuckS}s`); } catch (e) {}
    sendOperator(`⚠️ FLASH FLOW SENTINEL — watchdog recovered a wedged monitor cycle (hung ${stuckS}s on a network call, likely RPC). Lock force-released; monitoring is resuming automatically. Wedge #${cycleWedges}. Dashboard: flash-flow-sentinel.vercel.app`);
  }, WATCHDOG_TICK_MS);
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });

process.on("SIGINT", () => { try { saveState(); } catch (e) {} process.exit(0); });
process.on("SIGTERM", () => { try { saveState(); } catch (e) {} process.exit(0); });
