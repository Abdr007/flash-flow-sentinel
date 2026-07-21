"use strict";
/*
 * Limit engine — rolling-window aggregation + rule evaluation over REAL flow events.
 * Windows are computed from event blockTimes (chain time), valued at the on-chain
 * oracle mark recorded when the event was observed. Events with no available mark
 * are surfaced as "unpriced" — they are never silently dropped from risk totals.
 */

const DEFAULT_LIMITS = {
  // Outflow velocity cap: hard USD cap on total outflow across ALL wallets, per rolling hour.
  globalOutflowUsdPerHour: 100000,
  warnFraction: 0.7,
  // per-token overrides keyed "Pool/SYMBOL"; default applies to every token when set
  defaultTokenOutflowUsdPerHour: null,
  perTokenOutflowUsdPerHour: {},
  // single wallet receiving too much, per rolling hour
  perWalletOutflowUsdPerHour: 50000,
  // Named wallet watchlist (operator-set): any wallet here is flagged on ANY outflow in the window,
  // even under the per-wallet cap. Empty by default — operators add addresses of interest via config.
  watchWallets: [],
  // % of a vault drained per rolling hour — calibrated to catch a real drain (Ostium lost ~⅓ of TVL
  // in minutes), NOT routine trading. At 5%/h it false-warns on any small vault's normal flow; 20%/h
  // (warn at 14%) clears normal ±4-8% swings while lighting up on a genuine "vault emptying" event.
  vaultDrawdownPctPerHour: 20,
  // Materiality floor for the drawdown guard: a % drawdown only alarms once the vault's actual
  // 1h outflow clears this USD floor. Without it, a dust/low-balance vault shows a huge % on a
  // trivial ($ hundreds) absolute move and false-breaches — noise, not a drain. A genuine vault
  // emptying moves far more than this, so the guard still lights up on the real thing.
  drawdownMinUsd: 5000,
  // FLASH6 mark vs independent Pyth price (oracle-manipulation guard)
  oracleDeviationPct: 1.5,
  webhookUrl: null,
};

const { classify, sideOf } = require("./flows.cjs");

const status = (util, warnFraction) => (util == null ? "ok" : util >= 1 ? "breach" : util >= warnFraction ? "warn" : "ok");
const r2 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);

const SIDE_KEYS = ["trade", "lp", "staking", "protocol", "other"];

function evaluate(nowUnix, events, failures, custodies, balances, marks, markTimes, lazerMarks, pyth, cfg, authority) {
  const h1 = nowUnix - 3600, h24 = nowUnix - 86400;
  const in1 = { usd: 0, n: 0 }, out1 = { usd: 0, n: 0, unpriced: 0 }, in24 = { usd: 0, n: 0 }, out24 = { usd: 0, n: 0, unpriced: 0 };
  const intl = { in1hUsd: 0, out1hUsd: 0, in24hUsd: 0, out24hUsd: 0, events24h: 0 };
  const sidesAgg = {};
  for (const k of SIDE_KEYS) sidesAgg[k] = { side: k, in1hUsd: 0, out1hUsd: 0, in24hUsd: 0, out24hUsd: 0, inEvents24h: 0, outEvents24h: 0, tokens: {} };
  const tok = {}, wal = {};
  const tkey = (e) => e.custody; // custody pubkey — globally unique, collision-proof

  for (const c of custodies) {
    if (c.isVirtual) continue; // virtual custodies have no vault → no flows to bound
    tok[c.custody] = {
      // swept accounts can share a mint (staked-LP vs compounding-LP) — suffix keeps keys unique
      key: c.pool + "/" + c.symbol + (c.kind === "swept" ? "·" + String(c.vault).slice(0, 4) : ""),
      custody: c.custody, pool: c.pool, symbol: c.symbol, mint: c.mint, decimals: c.decimals, vault: c.vault, isStable: c.isStable,
      in1hUsd: 0, out1hUsd: 0, in1hAmt: 0, out1hAmt: 0, in24hUsd: 0, out24hUsd: 0, in24hAmt: 0, out24hAmt: 0,
      out1hRaw: 0n, in1hRaw: 0n, unpriced1h: 0, events1h: 0, events24h: 0, failed1h: 0, internal24hUsd: 0,
    };
  }

  for (const e of events) {
    if (e.blockTime == null || e.blockTime < h24) continue;
    const kind = classify(e.ix || [], e.direction);   // re-derived live → improved patterns apply retroactively
    const internal = !!(authority && e.wallet === authority); // vault→vault reshuffle: both legs authority-owned
    const t = tok[tkey(e)];
    const usd = e.usd != null ? e.usd : null;
    const isOut = e.direction === "out";
    const in1h = e.blockTime >= h1;

    // gross raw deltas ALWAYS count (drawdown reconstructs the true balance 1h ago)
    if (t && in1h) { const raw = BigInt(e.deltaRaw); const araw = raw < 0n ? -raw : raw; if (isOut) t.out1hRaw += araw; else t.in1hRaw += araw; }

    if (internal) {
      // internal reshuffles are surfaced, but never counted as user inflow/outflow
      intl.events24h++;
      if (isOut) { intl.out24hUsd += usd || 0; if (in1h) intl.out1hUsd += usd || 0; }
      else { intl.in24hUsd += usd || 0; if (in1h) intl.in1hUsd += usd || 0; }
      if (t) { t.events24h++; t.internal24hUsd += usd || 0; if (in1h) t.events1h++; }
      continue;
    }

    if (isOut) { out24.usd += usd || 0; out24.n++; if (usd == null) out24.unpriced++; } else { in24.usd += usd || 0; in24.n++; }
    if (t) {
      t.events24h++;
      if (isOut) { t.out24hUsd += usd || 0; t.out24hAmt += e.amount; } else { t.in24hUsd += usd || 0; t.in24hAmt += e.amount; }
    }
    // trade vs LP vs staking/fees side split (per side + per token within side)
    const s = sidesAgg[sideOf(e, kind)] || sidesAgg.other;
    const skey = e.pool + "/" + e.symbol;
    const st = s.tokens[skey] || (s.tokens[skey] = { key: skey, symbol: e.symbol, pool: e.pool, in1hUsd: 0, out1hUsd: 0, in24hUsd: 0, out24hUsd: 0, events24h: 0 });
    st.events24h++;
    if (isOut) { s.out24hUsd += usd || 0; s.outEvents24h++; st.out24hUsd += usd || 0; } else { s.in24hUsd += usd || 0; s.inEvents24h++; st.in24hUsd += usd || 0; }
    if (in1h) {
      if (isOut) { out1.usd += usd || 0; out1.n++; if (usd == null) out1.unpriced++; s.out1hUsd += usd || 0; st.out1hUsd += usd || 0; }
      else { in1.usd += usd || 0; in1.n++; s.in1hUsd += usd || 0; st.in1hUsd += usd || 0; }
      if (t) {
        t.events1h++;
        if (isOut) { t.out1hUsd += usd || 0; t.out1hAmt += e.amount; if (usd == null) t.unpriced1h++; }
        else { t.in1hUsd += usd || 0; t.in1hAmt += e.amount; }
      }
    }
    if (isOut) {
      const w = wal[e.wallet] || (wal[e.wallet] = { wallet: e.wallet, out1hUsd: 0, out24hUsd: 0, events: 0, tokens: new Set(), firstSeen: e.blockTime });
      if (e.blockTime != null && (w.firstSeen == null || e.blockTime < w.firstSeen)) w.firstSeen = e.blockTime;
      w.out24hUsd += usd || 0;
      if (in1h) { w.out1hUsd += usd || 0; w.events++; w.tokens.add(tkey(e)); }
    }
  }

  const sides = SIDE_KEYS.map((k) => {
    const s = sidesAgg[k];
    return {
      side: k,
      in1hUsd: r2(s.in1hUsd), out1hUsd: r2(s.out1hUsd), in24hUsd: r2(s.in24hUsd), out24hUsd: r2(s.out24hUsd),
      net24hUsd: r2(s.in24hUsd - s.out24hUsd), inEvents24h: s.inEvents24h, outEvents24h: s.outEvents24h,
      tokens: Object.values(s.tokens).map((t) => ({ ...t, in1hUsd: r2(t.in1hUsd), out1hUsd: r2(t.out1hUsd), in24hUsd: r2(t.in24hUsd), out24hUsd: r2(t.out24hUsd), net24hUsd: r2(t.in24hUsd - t.out24hUsd) }))
        .sort((a, b) => (b.in24hUsd + b.out24hUsd) - (a.in24hUsd + a.out24hUsd)),
    };
  });
  const internalFlows = { in1hUsd: r2(intl.in1hUsd), out1hUsd: r2(intl.out1hUsd), in24hUsd: r2(intl.in24hUsd), out24hUsd: r2(intl.out24hUsd), events24h: intl.events24h, note: "vault→vault settlements inside the program (both legs authority-owned) — excluded from user inflow/outflow and wallet totals" };

  const tokByVault = {};
  for (const t of Object.values(tok)) tokByVault[t.vault] = t;
  for (const f of failures) {
    if (f.blockTime == null || f.blockTime < h1) continue;
    const t = tokByVault[f.vault];
    if (t) t.failed1h++;
  }

  // ---- rule: global hourly outflow cap (across all wallets) ----
  const gLimit = cfg.globalOutflowUsdPerHour;
  const gUtil = gLimit > 0 ? out1.usd / gLimit : null;
  const global = {
    out1hUsd: r2(out1.usd), in1hUsd: r2(in1.usd), net1hUsd: r2(in1.usd - out1.usd),
    out24hUsd: r2(out24.usd), in24hUsd: r2(in24.usd), net24hUsd: r2(in24.usd - out24.usd),
    outEvents1h: out1.n, inEvents1h: in1.n, outEvents24h: out24.n, inEvents24h: in24.n,
    unpricedOut1h: out1.unpriced, unpricedOut24h: out24.unpriced,
    limitUsdPerHour: gLimit, utilization: gUtil == null ? null : r2(gUtil * 100) / 100, status: status(gUtil, cfg.warnFraction),
  };

  // ---- rule: per-token hourly outflow + vault drawdown ----
  const tokens = Object.values(tok).map((t) => {
    const bal = balances[t.vault];
    const mark = marks[t.custody] != null ? marks[t.custody] : (t.isStable ? 1 : null);
    const balAmt = bal == null ? null : Number(bal) / Math.pow(10, t.decimals);
    const vaultUsd = balAmt != null && mark != null ? balAmt * mark : null;
    // balance one hour ago reconstructed EXACTLY from raw deltas
    const balRaw1hAgo = bal == null ? null : bal + t.out1hRaw - t.in1hRaw;
    const drawdownPct = balRaw1hAgo != null && balRaw1hAgo > 0n ? (Number(t.out1hRaw) / Number(balRaw1hAgo)) * 100 : (t.out1hRaw > 0n ? 100 : 0);
    const limit = cfg.perTokenOutflowUsdPerHour[t.key] != null ? cfg.perTokenOutflowUsdPerHour[t.key] : cfg.defaultTokenOutflowUsdPerHour;
    const util = limit > 0 ? t.out1hUsd / limit : null;
    // drawdown only counts once the absolute 1h outflow is material — a dust vault's big % on a tiny
    // move is noise, not a drain (see drawdownMinUsd). A real vault-emptying clears this floor easily.
    const drawdownMaterial = t.out1hUsd >= (cfg.drawdownMinUsd || 0);
    const dUtil = cfg.vaultDrawdownPctPerHour > 0 && drawdownMaterial ? drawdownPct / cfg.vaultDrawdownPctPerHour : null;
    const st = [status(util, cfg.warnFraction), status(dUtil, cfg.warnFraction)];
    return {
      key: t.key, custody: t.custody, pool: t.pool, symbol: t.symbol, mint: t.mint, vault: t.vault, decimals: t.decimals, isStable: t.isStable,
      markUsd: mark, vaultBalanceRaw: bal == null ? null : bal.toString(), vaultBalance: balAmt, vaultUsd: r2(vaultUsd),
      in1hUsd: r2(t.in1hUsd), out1hUsd: r2(t.out1hUsd), net1hUsd: r2(t.in1hUsd - t.out1hUsd), in1hAmt: t.in1hAmt, out1hAmt: t.out1hAmt,
      in24hUsd: r2(t.in24hUsd), out24hUsd: r2(t.out24hUsd), net24hUsd: r2(t.in24hUsd - t.out24hUsd), in24hAmt: t.in24hAmt, out24hAmt: t.out24hAmt,
      events1h: t.events1h, events24h: t.events24h, unpriced1h: t.unpriced1h, failed1h: t.failed1h, internal24hUsd: r2(t.internal24hUsd),
      drawdownPct1h: r2(drawdownPct), drawdownLimitPct: cfg.vaultDrawdownPctPerHour,
      limitUsdPerHour: limit != null ? limit : null, utilization: util == null ? null : r2(util * 100) / 100,
      status: st.includes("breach") ? "breach" : st.includes("warn") ? "warn" : "ok",
    };
  }).sort((a, b) => (b.out1hUsd || 0) - (a.out1hUsd || 0) || (b.out24hUsd || 0) - (a.out24hUsd || 0) || (b.vaultUsd || 0) - (a.vaultUsd || 0));

  // ---- rule: per-wallet hourly outflow ----
  const wLimit = cfg.perWalletOutflowUsdPerHour;
  const wallets = Object.values(wal).map((w) => {
    const util = wLimit > 0 ? w.out1hUsd / wLimit : null;
    return { wallet: w.wallet, watched: (cfg.watchWallets || []).includes(w.wallet), out1hUsd: r2(w.out1hUsd), out24hUsd: r2(w.out24hUsd), events: w.events, tokens: [...w.tokens], pctOfGlobal1h: out1.usd > 0 ? r2((w.out1hUsd / out1.usd) * 100) : null, firstSeenAgoSec: w.firstSeen != null ? Math.max(0, nowUnix - w.firstSeen) : null, limitUsdPerHour: wLimit, utilization: util == null ? null : r2(util * 100) / 100, status: status(util, cfg.warnFraction) };
  }).sort((a, b) => (b.out1hUsd || 0) - (a.out1hUsd || 0)).slice(0, 25);

  // ---- rule: oracle deviation vs an independent Pyth connection ----
  const seenSym = new Set();
  const oracle = [];
  for (const c of custodies) {
    if (seenSym.has(c.symbol)) continue; seenSym.add(c.symbol);
    const mark = marks[c.custody];
    const mTime = markTimes[c.custody] != null ? markTimes[c.custody] : null;
    const markAgeSec = mTime != null ? Math.max(0, nowUnix - mTime) : null;
    let lzOn = lazerMarks && lazerMarks[c.custody] != null ? lazerMarks[c.custody] : null;
    let lzScaleMismatch = false;
    // legacy/stale accounts can hold a lazer_price on a different exponent scale — flag, don't display nonsense
    if (lzOn != null && mark != null && mark > 0 && (lzOn / mark > 1000 || lzOn / mark < 0.001)) { lzOn = null; lzScaleMismatch = true; }
    const base = { symbol: c.symbol, markUsd: mark != null ? mark : null, markPublishTime: mTime, markAgeSec,
      lazerOnChainUsd: lzOn, lazerScaleMismatch: lzScaleMismatch,
      markVsLazerPct: lzOn != null && mark != null && lzOn > 0 ? r2(Math.abs(mark - lzOn) / lzOn * 100) : null };
    const p = pyth.prices[c.symbol];
    const feed = pyth.feeds[c.symbol];
    if (!feed) { oracle.push({ ...base, pythUsd: null, deviationPct: null, status: "unmapped", pythSymbol: null, source: null }); continue; }
    // No usable reference: missing mark, missing price, or a non-positive reference price (which would
    // make |mark - price|/price divide by zero → Infinity → a fabricated BREACH). Treat all as "stale".
    if (mark == null || !p || !(p.price > 0)) { oracle.push({ ...base, pythUsd: p && p.price > 0 ? p.price : null, deviationPct: null, status: "stale", pythSymbol: feed.pythSymbol, source: feed.source || null }); continue; }
    // A mark that is not updating (paused/closed market — provable via on-chain publish_time) is NOT
    // compared: a frozen mark drifting from a live feed is expected, not an attack. The deviation guard
    // fires only on FRESH marks vs a FRESH reference — a live manipulated feed trips instantly, and a
    // stale independent feed can never be compared against a fresh mark (that would mask/invent drift).
    if ((markAgeSec != null && markAgeSec > 600) || p.marketSession === "closed" || (p.publishTime != null && nowUnix - p.publishTime > 300)) {
      oracle.push({ ...base, pythUsd: p.price, deviationPct: null, status: "inactive", marketSession: p.marketSession || null, pythSymbol: feed.pythSymbol, source: feed.source || null });
      continue;
    }
    const dev = Math.abs(mark - p.price) / p.price * 100;
    const util = cfg.oracleDeviationPct > 0 ? dev / cfg.oracleDeviationPct : null;
    oracle.push({ ...base, pythUsd: p.price, deviationPct: r2(dev), pythPublishTime: p.publishTime, limitPct: cfg.oracleDeviationPct, status: status(util, cfg.warnFraction), pythSymbol: feed.pythSymbol, source: feed.source || null });
  }
  oracle.sort((a, b) => (b.deviationPct || 0) - (a.deviationPct || 0));

  return { global, sides, internalFlows, tokens, wallets, oracle };
}

/** Hourly diverging-chart buckets per side (trade / lp), same rules as the global chart:
 *  rolling 24h window, internal vault→vault settlements excluded, side re-derived live
 *  from each tx's own instruction names. */
function hourlyBucketsBySide(nowUnix, events, authority) {
  const start = nowUnix - 24 * 3600, h0 = Math.floor(start / 3600) * 3600;
  const mk = () => { const arr = []; for (let h = h0; h <= nowUnix; h += 3600) arr.push({ hourStart: h, inUsd: 0, outUsd: 0, inN: 0, outN: 0 }); return arr; };
  const out = { trade: mk(), lp: mk() };
  for (const e of events) {
    if (e.blockTime == null || e.blockTime < start || e.blockTime > nowUnix) continue;
    if (authority && e.wallet === authority) continue;
    const buckets = out[sideOf(e, classify(e.ix || [], e.direction))];
    if (!buckets) continue;
    const b = buckets[Math.floor((e.blockTime - h0) / 3600)];
    if (!b) continue;
    if (e.direction === "out") { b.outUsd += e.usd || 0; b.outN++; } else { b.inUsd += e.usd || 0; b.inN++; }
  }
  const round = (arr) => arr.map((b) => ({ ...b, inUsd: Math.round(b.inUsd * 100) / 100, outUsd: Math.round(b.outUsd * 100) / 100 }));
  return { trade: round(out.trade), lp: round(out.lp) };
}

/** Flatten evaluation into (ruleKey → {status, detail}) for alert-transition tracking. */
function ruleStates(ev) {
  const m = {};
  m["global"] = { status: ev.global.status, detail: `outflow 1h $${ev.global.out1hUsd} / limit $${ev.global.limitUsdPerHour}` };
  for (const t of ev.tokens) if (t.status !== "ok") m[`token:${t.key}`] = { status: t.status, detail: `out 1h $${t.out1hUsd}${t.limitUsdPerHour ? ` / $${t.limitUsdPerHour}` : ""}, drawdown ${t.drawdownPct1h}%/${t.drawdownLimitPct}%` };
  for (const w of ev.wallets) if (w.status !== "ok") m[`wallet:${w.wallet}`] = { status: w.status, detail: `out 1h $${w.out1hUsd} / $${w.limitUsdPerHour}` };
  // watchlist: flag any watched wallet that moves funds out, even under the per-wallet cap
  for (const w of ev.wallets) if (w.watched && w.out1hUsd > 0 && w.status === "ok") m[`watch:${w.wallet}`] = { status: "warn", detail: `WATCHED wallet active — out 1h $${w.out1hUsd} (${w.events} tx)` };
  // concentration: a single wallet taking an outsized share (≥75%) of ALL 1h outflow — catches one
  // address draining the protocol even when it stays under the per-wallet absolute cap.
  for (const w of ev.wallets) if (w.status === "ok" && (w.out1hUsd || 0) >= 5000 && w.pctOfGlobal1h != null && w.pctOfGlobal1h >= 75) m[`concentration:${w.wallet}`] = { status: "warn", detail: `single wallet = ${w.pctOfGlobal1h}% of all 1h outflow ($${w.out1hUsd})` };
  // fresh-recipient: a large outflow (≥$10k) to a wallet first seen only within the last hour of the
  // tracking window — large withdrawals to brand-new addresses are a classic exfil signature.
  for (const w of ev.wallets) if (w.status === "ok" && (w.out1hUsd || 0) >= 10000 && w.firstSeenAgoSec != null && w.firstSeenAgoSec <= 3600) m[`freshwallet:${w.wallet}`] = { status: "warn", detail: `$${w.out1hUsd} out to a wallet first seen ${Math.round(w.firstSeenAgoSec / 60)}m ago` };
  for (const o of ev.oracle) if (o.status === "warn" || o.status === "breach") m[`oracle:${o.symbol}`] = { status: o.status, detail: `mark $${o.markUsd} vs pyth $${o.pythUsd} (${o.deviationPct}% / ${o.limitPct}%)${o.markAgeSec != null && o.markAgeSec > 300 ? ` — mark is ${Math.floor(o.markAgeSec / 86400)}d stale (publish_time on-chain)` : ""}` };
  // acceleration: this hour's outflow is a large multiple (≥5×) of the trailing 24h hourly average —
  // catches a sudden velocity spike even before it hits the absolute cap. All from real flow totals.
  const g = ev.global; if (g && (g.out1hUsd || 0) >= 5000 && (g.out24hUsd || 0) > 0) { const hourlyAvg = g.out24hUsd / 24; if (hourlyAvg > 0 && g.out1hUsd > 5 * hourlyAvg) m["acceleration"] = { status: "warn", detail: `outflow this hour ($${g.out1hUsd}) is ${(g.out1hUsd / hourlyAvg).toFixed(1)}× the 24h hourly average` }; }
  // new-wallet burst: multiple wallets first seen within the last hour ALL receiving outflow at once —
  // a coordinated-exfil pattern. Counts real first-seen recipients from the evaluated flow.
  const freshRecipients = ev.wallets.filter((w) => w.firstSeenAgoSec != null && w.firstSeenAgoSec <= 3600 && (w.out1hUsd || 0) > 0);
  if (freshRecipients.length >= 3) m["newwallet-burst"] = { status: "warn", detail: `${freshRecipients.length} newly-seen wallets received outflow in the last hour (total $${Math.round(freshRecipients.reduce((s, w) => s + (w.out1hUsd || 0), 0))})` };
  return m;
}

module.exports = { DEFAULT_LIMITS, evaluate, ruleStates, hourlyBucketsBySide };
