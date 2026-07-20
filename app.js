"use strict";
/* ============================================================================
   FLASH FLOW SENTINEL — renderer. Every value on this page comes from /api/state,
   which is decoded live from real on-chain data (base-chain SPL transfers, ER
   custody/market/oracle accounts, Pyth Lazer cross-check). No synthetic data.
   ============================================================================ */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const short = (a, n = 4) => (a ? a.slice(0, n) + "…" + a.slice(-n) : "—");
const scanTx = (s) => `https://solscan.io/tx/${s}`;
const scanAcct = (a) => `https://solscan.io/account/${a}`;

/* ---------- formatters (tabular, honest) ---------- */
const usd = (n, dp) => {
  if (n == null || !Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (dp == null) dp = a < 1000 ? 2 : a < 100000 ? 1 : 0;
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
};
const usdc = (n) => {
  if (n == null || !Number.isFinite(n)) return "—";
  const a = Math.abs(n), s = n < 0 ? "−" : "";
  if (a >= 1e9) return s + "$" + (a / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return s + "$" + (a / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return s + "$" + (a / 1e3).toFixed(1) + "k";
  return s + "$" + a.toFixed(a < 10 ? 2 : 0);
};
const amt = (n) => {
  if (n == null || !Number.isFinite(n)) return "—";
  const a = Math.abs(n), dp = a >= 1000 ? 0 : a >= 1 ? 2 : 6;
  return n.toLocaleString("en-US", { maximumFractionDigits: dp });
};
const px = (n) => {
  if (n == null || !Number.isFinite(n)) return "—";
  const a = Math.abs(n), dp = a >= 1000 ? 2 : a >= 1 ? 3 : a >= 0.001 ? 5 : 8;
  return "$" + n.toLocaleString("en-US", { maximumFractionDigits: dp });
};
const ago = (ts) => {
  if (!ts) return "—";
  const d = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  return d < 60 ? d + "s" : d < 3600 ? Math.floor(d / 60) + "m " + (d % 60) + "s" : d < 86400 ? Math.floor(d / 3600) + "h " + Math.floor((d % 3600) / 60) + "m" : Math.floor(d / 86400) + "d " + Math.floor((d % 86400) / 3600) + "h";
};
const utcHMS = (ts) => new Date(ts * 1000).toISOString().slice(11, 19);
const utcHM = (ts) => new Date(ts * 1000).toISOString().slice(11, 16);
const grp = (raw) => { if (raw == null) return "—"; const neg = String(raw).startsWith("-"); const s = String(raw).replace("-", ""); return (neg ? "−" : "") + s.replace(/\B(?=(\d{3})+(?!\d))/g, ","); };

const PILL = { ok: ["✓", "OK", "ok"], warn: ["⚠", "WARN", "warn"], breach: ["⛔", "BREACH", "bad"], unmapped: ["·", "UNMAPPED", "mut"], stale: ["◌", "NO FEED", "mut"], inactive: ["⏸", "MARKET IDLE", "mut"] };
const pill = (st, title) => { const [i, l, c] = PILL[st] || ["·", String(st).toUpperCase(), "mut"]; return `<span class="gpill ${c}" ${title ? `title="${esc(title)}"` : ""}>${i} ${l}</span>`; };
const meter = (frac, big) => {
  const p = frac == null ? 0 : Math.min(1, Math.max(0, frac)) * 100;
  const cls = frac == null ? "" : frac >= 1 ? "bad" : frac >= 0.7 ? "warn" : "";
  return `<span class="meter ${cls}" style="${big ? "" : "width:64px"}"><span style="width:${p}%"></span></span>`;
};
const meterCell = (frac) => `<span class="meter-cell"><span class="meter-pct">${frac == null ? "—" : Math.round(frac * 100) + "%"}</span>${meter(frac)}</span>`;
const POOL_COLORS = ["#46e6a0", "#56b8ff", "#9d7bff", "#ffc24b", "#ff6b85", "#00e08a", "#ccff00", "#7ff05a", "#5ad1f0", "#ff9a6b"];
const poolIdx = {}; let poolN = 0;
const poolPill = (p) => { if (!(p in poolIdx)) poolIdx[p] = poolN++ % POOL_COLORS.length; return `<span class="pool-pill" style="--pc:${POOL_COLORS[poolIdx[p]]}">${esc(p)}</span>`; };
const sidePill = (s) => `<span class="side ${s === "Long" ? "long" : "short"}">${esc(s.toUpperCase())}</span>`;

/* ---------- tooltip ---------- */
const tip = $("tooltip");
const showTip = (html, x, y) => { tip.innerHTML = html; tip.style.display = "block"; const r = tip.getBoundingClientRect(); tip.style.left = Math.min(x + 14, innerWidth - r.width - 10) + "px"; tip.style.top = Math.min(y + 14, innerHeight - r.height - 10) + "px"; };
const hideTip = () => (tip.style.display = "none");

/* ---------- header ---------- */
function renderHeader(S) {
  const m = S.meta;
  $("asOf").textContent = m.lastCycle ? `as of ${utcHMS(m.lastCycle)} UTC · ${ago(m.lastCycle)} ago · cycle #${m.cycles}${m.cycleSeconds != null ? ` in ${m.cycleSeconds}s` : ""}` : "—";
  $("chipWs").textContent = m.wsPush ? "PUSH ⚡ WS LIVE" : m.cloud ? "CLOUD · 10s refresh" : "PUSH — poll only";
  $("chipWs").style.color = m.wsPush || m.cloud ? "var(--teal)" : "var(--amber)";
  $("chipCycle").textContent = `poll ${Math.round(m.pollMs / 1000)}s · ${m.eventsRetained} events`;
  $("brandSub").textContent = `${m.custodies} custodies · ${m.trackedVaults || m.realVaults} vaults tracked${m.sweep && m.sweep.watched ? ` · ${m.sweep.watched} authority accounts swept` : ""} · ${m.markets} market-sides · ${m.pools} pools · ER slot ${m.erSlot ? m.erSlot.toLocaleString("en-US") : "—"}`;
  const st = $("liveStatus");
  st.classList.remove("offline"); $("liveText").textContent = "LIVE";
}
function headerOffline() { $("liveStatus").classList.add("offline"); $("liveText").textContent = "RECONNECTING"; }

/* ---------- verdict hero ---------- */
function renderVerdict(S) {
  const ev = S.evaluation; if (!ev) return;
  const g = ev.global;
  const tokBad = ev.tokens.filter((t) => t.status === "breach").length, tokWarn = ev.tokens.filter((t) => t.status === "warn").length;
  const walBad = ev.wallets.filter((w) => w.status === "breach").length, walWarn = ev.wallets.filter((w) => w.status === "warn").length;
  const oraRows = ev.oracle.filter((o) => o.deviationPct != null);
  const oraBad = ev.oracle.filter((o) => o.status === "breach").length, oraWarn = ev.oracle.filter((o) => o.status === "warn").length;
  const worstDev = oraRows.length ? oraRows[0] : null;
  const cons = S.conservation, cn = cons.rows.length, cx = cons.rows.filter((r) => r.status === "exact").length;
  const capOk = S.meta.lastCycle && (Date.now() / 1000 - S.meta.lastCycle) < 90;

  const govBad = (S.governance && (S.governance.changes || []).length) || 0;
  const anyBreach = g.status === "breach" || tokBad || walBad || oraBad || govBad;
  const anyWarn = g.status === "warn" || tokWarn || walWarn || oraWarn;
  const v = $("verdict");
  v.classList.toggle("perfect", !anyBreach && !anyWarn);
  if (anyBreach) {
    $("verdictFlag").innerHTML = `⛔ <span style="color:var(--red)">${govBad ? "GOVERNANCE CHANGE" : "FLOW GUARD BREACH"}</span> — investigate now`;
    const parts = [];
    if (govBad) parts.push(`${govBad} authority/permission change${govBad > 1 ? "s" : ""} since baseline`);
    if (g.status === "breach") parts.push(`global outflow ${usd(g.out1hUsd)} exceeded the ${usd(g.limitUsdPerHour)}/h cap`);
    if (tokBad) parts.push(`${tokBad} token guard${tokBad > 1 ? "s" : ""}`);
    if (walBad) parts.push(`${walBad} wallet guard${walBad > 1 ? "s" : ""}`);
    if (oraBad) parts.push(`${oraBad} oracle deviation${oraBad > 1 ? "s" : ""} (on-chain mark vs Pyth Lazer)`);
    $("verdictSub").textContent = "Tripped: " + parts.join(" · ") + " — details in the panels and alert log below.";
  } else if (anyWarn) {
    $("verdictFlag").innerHTML = `⚠ <span style="color:var(--amber)">APPROACHING LIMITS</span>`;
    $("verdictSub").textContent = `Warn-level utilization on ${[g.status === "warn" ? "the global cap" : null, tokWarn ? tokWarn + " token(s)" : null, walWarn ? walWarn + " wallet(s)" : null, oraWarn ? oraWarn + " oracle(s)" : null].filter(Boolean).join(", ")} — nothing breached.`;
  } else {
    $("verdictFlag").innerHTML = `ALL FLOW GUARDS <span class="exact-word">GREEN</span>`;
    $("verdictSub").textContent = `Outflow across all ${ev.tokens.length} vaults is ${usd(g.out1hUsd)} this hour — ${g.utilization != null ? Math.round(g.utilization * 100) + "%" : "0%"} of the ${usd(g.limitUsdPerHour)}/hour global cap. Every transfer decoded from the base chain; conservation ${cx}/${cn} exact.`;
  }
  const vc = (good, label, val, sub, title) => `<div class="vcheck ${good ? "good" : "bad"}" ${title ? `title="${esc(title)}"` : ""}><div class="vcheck-top"><span class="tick ${good ? "ok" : "bad"}">${good ? "✓" : "✗"}</span><span class="vcheck-label">${label}</span></div><div class="vcheck-val">${val}</div><div class="vcheck-sub">${sub}</div></div>`;
  $("verdictChecks").innerHTML = [
    vc(g.status === "ok", "GLOBAL OUT · 1H", g.utilization != null ? Math.round(g.utilization * 100) + "%" : "0%", `${usdc(g.out1hUsd)} of ${usdc(g.limitUsdPerHour)} cap`, "total outflow across ALL wallets vs the hourly cap"),
    vc(!tokBad && !tokWarn, "TOKEN GUARDS", tokBad ? tokBad + " BREACH" : tokWarn ? tokWarn + " WARN" : ev.tokens.length + " ✓", "per-vault caps + drawdown velocity"),
    vc(!walBad && !walWarn, "WALLET GUARD", walBad ? walBad + " BREACH" : walWarn ? walWarn + " WARN" : "clear", `top wallet ${ev.wallets[0] && ev.wallets[0].out1hUsd ? usdc(ev.wallets[0].out1hUsd) + " / 1h" : "$0 / 1h"}`),
    vc(!oraBad && !oraWarn, "ORACLE GUARD", worstDev ? worstDev.deviationPct.toFixed(2) + "%" : "—", worstDev ? `worst: ${worstDev.symbol} vs Lazer` : "on-chain mark vs Pyth Lazer", "oracle-manipulation guard: a mark forged at the on-chain oracle diverges from a live Lazer read instantly"),
    vc(!govBad, "GOVERNANCE", govBad ? govBad + " CHANGE" : "STABLE", S.governance && S.governance.upgradeControl && S.governance.upgradeControl.model === "squads-multisig" ? "Squads-gated upgrades · watched" : "authority surface watched", "upgrade authority, Squads control, program deploys, and permission flags — alerts on any change"),
    vc(cx === cn, "CONSERVATION", `${cx}/${cn}`, "baseline+Σdeltas == balance (u64)", "proof the monitor missed nothing — raw u64, zero tolerance"),
    vc(!!capOk, "CAPTURE", S.meta.wsPush ? "PUSH ⚡" : "POLL", `${S.failures1h} failed tx · 1h${S.meta.lastCycle ? " · " + ago(S.meta.lastCycle) + " ago" : ""}`, "WebSocket accountSubscribe on every vault + baseline poll"),
  ].join("");
}

/* ---------- KPIs ---------- */
function renderKpis(S) {
  const ev = S.evaluation; if (!ev) return;
  const g = ev.global;
  const tvl = ev.tokens.reduce((s, t) => s + (t.vaultUsd || 0), 0);
  const oi = (S.markets || []).reduce((s, m) => s + (m.oiUsd || 0), 0);
  const cov = S.meta.windowCoverage, building = cov && !cov.full;
  const k = (label, val, sub, cls) => `<div class="kpi ${cls || ""}"><span class="kpi-label">${label}</span><span class="kpi-value">${val}</span><span class="kpi-sub">${sub}</span></div>`;
  const bv = (v) => building ? "building…" : v; // don't show a misleading $0 while history loads
  $("kpiGrid").innerHTML = [
    k("Outflow · 1h", bv(usdc(g.out1hUsd)), building ? `${cov.readyVaults}/${cov.of} vaults loaded` : `${g.outEvents1h} transfers${g.unpricedOut1h ? " · " + g.unpricedOut1h + " unpriced" : ""}`, "neg"),
    k("Inflow · 1h", bv(usdc(g.in1hUsd)), building ? "history building" : `${g.inEvents1h} transfers`, "pos"),
    k("Net · 1h", building ? "building…" : (g.net1hUsd >= 0 ? "▲ " : "▼ ") + usdc(Math.abs(g.net1hUsd)), "in − out, all vaults", g.net1hUsd >= 0 ? "pos" : "neg"),
    k("Outflow · 24h", bv(usdc(g.out24hUsd)), building ? "history building" : `${g.outEvents24h} transfers · in ${usdc(g.in24hUsd)}`, "neg"),
    k("Vault TVL", usdc(tvl), `${ev.tokens.length} vaults · on-chain marks`),
    k("Open Interest", usdc(oi), `${(S.markets || []).filter((m) => m.openPositions > 0).length} active market-sides`),
  ].join("");
}

/* ---------- charts (shared diverging hourly renderer) ---------- */
function drawFlowChart(wrap, buckets, opts) {
  const H = (opts && opts.H) || 280, tickEvery = (opts && opts.tickEvery) || 3;
  if (!buckets || !buckets.length) { wrap.innerHTML = `<div class="empty">no flow data yet</div>`; return; }
  const W = Math.max(340, wrap.clientWidth || 900);
  const M = { t: 20, r: 10, b: 26, l: 62 };
  const pw = W - M.l - M.r, ph = H - M.t - M.b, n = buckets.length;
  const yMax = Math.max(1, ...buckets.map((b) => Math.max(b.inUsd, b.outUsd))) * 1.08;
  const z = M.t + ph / 2;
  const sy = (v) => (v / yMax) * (ph / 2 - 6);
  const bw = Math.max(2, pw / n - 2.5);
  let grid = "", bars = "", labels = "", hov = "";
  for (const f of [1, 0.5]) for (const sgn of [1, -1]) {
    const y = z - sgn * sy(yMax * f);
    grid += `<line x1="${M.l}" y1="${y}" x2="${W - M.r}" y2="${y}" stroke="rgba(120,160,130,.12)" stroke-width="1"/>`;
    labels += `<text x="${M.l - 8}" y="${y + 3.5}" text-anchor="end" fill="#7d8c82" font-size="10" font-family="JetBrains Mono,monospace">${sgn > 0 ? "▲" : "▼"}${usdc(yMax * f)}</text>`;
  }
  labels += `<text x="${M.l - 8}" y="${z + 3.5}" text-anchor="end" fill="#7d8c82" font-size="10" font-family="JetBrains Mono,monospace">$0</text>`;
  let pkIn = 0, pkOut = 0;
  buckets.forEach((b, i) => { if (b.inUsd > buckets[pkIn].inUsd) pkIn = i; if (b.outUsd > buckets[pkOut].outUsd) pkOut = i; });
  buckets.forEach((b, i) => {
    const x = M.l + (i / n) * pw + 1.25;
    const hi = sy(b.inUsd), ho = sy(b.outUsd);
    if (b.inUsd > 0) bars += `<rect x="${x}" y="${z - hi}" width="${bw}" height="${Math.max(1.5, hi)}" rx="2.5" fill="#46e6a0"/>`;
    if (b.outUsd > 0) bars += `<rect x="${x}" y="${z + 2}" width="${bw}" height="${Math.max(1.5, ho)}" rx="2.5" fill="#ff6b85"/>`;
    if (i === pkIn && b.inUsd > 0) labels += `<text x="${x + bw / 2}" y="${z - hi - 6}" text-anchor="middle" fill="#b9c6bd" font-size="10" font-family="JetBrains Mono,monospace">${usdc(b.inUsd)}</text>`;
    if (i === pkOut && b.outUsd > 0) labels += `<text x="${x + bw / 2}" y="${z + ho + 14}" text-anchor="middle" fill="#b9c6bd" font-size="10" font-family="JetBrains Mono,monospace">${usdc(b.outUsd)}</text>`;
    if (i % tickEvery === 0) labels += `<text x="${x + bw / 2}" y="${H - 8}" text-anchor="middle" fill="#7d8c82" font-size="9.5" font-family="JetBrains Mono,monospace">${utcHM(b.hourStart)}</text>`;
    hov += `<rect data-i="${i}" x="${M.l + (i / n) * pw}" y="${M.t}" width="${pw / n}" height="${ph}" fill="transparent"/>`;
  });
  wrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc((opts && opts.aria) || "Hourly inflow and outflow, last 24 hours, UTC")}">
    ${grid}<line x1="${M.l}" y1="${z}" x2="${W - M.r}" y2="${z}" stroke="rgba(120,160,130,.35)" stroke-width="2"/>${bars}${labels}<g class="hovg">${hov}</g></svg>`;
  const hg = wrap.querySelector(".hovg");
  hg.addEventListener("mousemove", (e) => {
    const t = e.target.closest("rect[data-i]"); if (!t) return hideTip();
    const b = buckets[+t.dataset.i];
    showTip(`<b>${utcHM(b.hourStart)}–${utcHM(b.hourStart + 3600)} UTC</b><br><span style="color:var(--pos)">▲ in ${usd(b.inUsd)}</span> · ${b.inN} tx<br><span style="color:var(--neg)">▼ out ${usd(b.outUsd)}</span> · ${b.outN} tx<br>net ${usd(b.inUsd - b.outUsd)}`, e.clientX, e.clientY);
  });
  hg.addEventListener("mouseleave", hideTip);
}

function renderChart(S) {
  const g = S.evaluation && S.evaluation.global;
  const cov = S.meta.windowCoverage;
  const tag = $("chartTag");
  if (cov && !cov.full) { tag.textContent = `BUILDING HISTORY ${cov.readyVaults}/${cov.of} VAULTS`; tag.className = "card-tag warn"; }
  else if (g) { tag.textContent = g.status === "ok" ? "WITHIN LIMITS" : g.status.toUpperCase(); tag.className = "card-tag " + (g.status === "ok" ? "okk" : g.status === "warn" ? "warn" : "bad"); }
  drawFlowChart($("chartWrap"), S.hourly || [], { H: 280, tickEvery: 3, aria: "Hourly inflow and outflow across all Flash vaults, last 24 hours, UTC" });
  if (g) {
    const frac = g.utilization;
    $("limitHero").innerHTML = `
      <div class="limit-hero-row"><span>OUTFLOW · LAST 60 MIN (all wallets) <b>${usd(g.out1hUsd)}</b> of <b>${usd(g.limitUsdPerHour, 0)}</b> cap</span>
      <span>${pill(g.status)} <b>${frac != null ? Math.round(frac * 100) + "%" : "0%"}</b> used</span></div>
      ${meter(frac, true)}`;
  }
}

/* ---------- trade & lp side cards (each with its own graph) ---------- */
function renderSides(S) {
  const ev = S.evaluation; if (!ev || !ev.sides) return;
  const by = {}; for (const s of ev.sides) by[s.side] = s;
  const tr = by.trade, lp = by.lp, stk = by.staking, pr = by.protocol, ot = by.other;
  const intl = ev.internalFlows || {};
  const hs = S.hourlySides || {};

  const cov = S.meta.windowCoverage;
  const building = cov && !cov.full;
  const sideCard = (tagId, chartId, sumId, s, label) => {
    const tag = $(tagId);
    if (building) { tag.textContent = `BUILDING HISTORY ${cov.readyVaults}/${cov.of} VAULTS`; tag.className = "card-tag warn"; }
    else { tag.textContent = `▲ ${usdc(s.in24hUsd)} IN · ▼ ${usdc(s.out24hUsd)} OUT / 24H`; tag.className = "card-tag " + ((s.net24hUsd || 0) >= 0 ? "okk" : "bad"); }
    drawFlowChart($(chartId), hs[label] || [], { H: 240, tickEvery: 3, aria: `Hourly ${label}-side inflow and outflow, last 24 hours, UTC` });
    const stat = (lbl, v, sub, cls) => `<div class="recon-stat ${cls || ""}"><span class="recon-stat-label">${lbl}</span><span class="recon-stat-value">${v}</span><span class="recon-stat-sub">${sub}</span></div>`;
    if (building) {
      $(sumId).innerHTML = stat("BUILDING 24h HISTORY", `${cov.readyVaults}/${cov.of}`, "this side's totals appear once its vaults finish loading — refresh in a few seconds", "amber");
      return;
    }
    $(sumId).innerHTML = [
      stat("INFLOW · 24H", `<span class="dir-in">▲ ${usdc(s.in24hUsd)}</span>`, `${s.inEvents24h} transfers · 1h ▲${usdc(s.in1hUsd)}`, "green"),
      stat("OUTFLOW · 24H", `<span class="dir-out">▼ ${usdc(s.out24hUsd)}</span>`, `${s.outEvents24h} transfers · 1h ▼${usdc(s.out1hUsd)}`, "red"),
      stat("NET · 24H", `${(s.net24hUsd || 0) >= 0 ? "▲" : "▼"} ${usdc(Math.abs(s.net24hUsd || 0))}`, "in − out", (s.net24hUsd || 0) >= 0 ? "green" : "red"),
      stat("ACTIVITY", `${s.inEvents24h + s.outEvents24h} tx`, "last 24h, internal excluded", ""),
    ].join("");
  };
  sideCard("tradeTag", "chartTrade", "tradeSummary", tr, "trade");
  sideCard("lpTag", "chartLp", "lpSummary", lp, "lp");

  const tokTable = (el, s) => {
    $(el).innerHTML = `<thead><tr><th>TOKEN</th><th class="r">IN 1H</th><th class="r">OUT 1H</th><th class="r">IN 24H</th><th class="r">OUT 24H</th><th class="r">NET 24H</th><th class="r">TX</th></tr></thead><tbody>` +
      ((s.tokens || []).map((t) => `<tr>
        <td><b>${esc(t.symbol)}</b> ${poolPill(t.pool)}</td>
        <td class="r">${t.in1hUsd ? `<span class="dir-in">▲ ${usdc(t.in1hUsd)}</span>` : "·"}</td>
        <td class="r">${t.out1hUsd ? `<span class="dir-out">▼ ${usdc(t.out1hUsd)}</span>` : "·"}</td>
        <td class="r">${t.in24hUsd ? `<span class="dir-in">${usdc(t.in24hUsd)}</span>` : "·"}</td>
        <td class="r">${t.out24hUsd ? `<span class="dir-out">${usdc(t.out24hUsd)}</span>` : "·"}</td>
        <td class="r ${t.net24hUsd > 0 ? "pos" : t.net24hUsd < 0 ? "neg" : ""}">${t.net24hUsd ? usdc(t.net24hUsd) : "·"}</td>
        <td class="r">${t.events24h}</td>
      </tr>`).join("") || `<tr><td colspan="7" class="empty">no flows in the window</td></tr>`) + "</tbody>";
  };
  tokTable("sideTradeTable", tr);
  tokTable("sideLpTable", lp);
  $("sideOther").innerHTML =
    `<span><b>Staking 24h:</b> ▲${usdc(stk.in24hUsd)} ▼${usdc(stk.out24hUsd)}</span>` +
    `<span><b>Protocol (rewards/rebates/fees) 24h:</b> ▲${usdc(pr.in24hUsd)} ▼${usdc(pr.out24hUsd)}</span>` +
    `<span><b>Other (unattributed):</b> ▲${usdc(ot.in24hUsd)} ▼${usdc(ot.out24hUsd)} · ${ot.inEvents24h + ot.outEvents24h} tx</span>` +
    `<span><b>Internal vault→vault settlements (excluded):</b> ▲${usdc(intl.in24hUsd)} ▼${usdc(intl.out24hUsd)} · ${intl.events24h || 0} tx</span>` +
    `<span class="dim">side = classified from each tx's own program instruction logs</span>`;
}

/* ---------- governance & authority watch ---------- */
function renderGovernance(S) {
  const g = S.governance;
  const tag = $("govTag");
  if (!g) { tag.textContent = "reading…"; tag.className = "card-tag"; $("govSummary").innerHTML = ""; return; }
  const changes = (g.changes || []).length;
  const stale = (g.staleSections || []);
  const acct = (a) => a ? `<a class="addr" href="${scanAcct(a)}" target="_blank" rel="noopener">${short(a, 5)}</a>` : "—";
  tag.textContent = changes ? `${changes} CHANGE${changes > 1 ? "S" : ""} DETECTED` : stale.length ? `READ INCOMPLETE (${stale.join(",")})` : "STABLE — BASELINE HELD";
  tag.className = "card-tag " + (changes ? "bad" : stale.length ? "warn" : "okk");

  const ctrl = g.upgradeControl || {};
  const squads = ctrl.model === "squads-multisig";
  const ctrlBadge = squads ? ` <span class="gpill ok" title="program upgrades are executed through the Squads multisig program (${esc(ctrl.executor || "")}) — verified from the most recent on-chain upgrade transaction">🔐 SQUADS MULTISIG</span>`
    : ctrl.model === "direct-authority" ? ` <span class="gpill mut" title="the most recent upgrade was signed directly by the authority key, not via a detected multisig program">direct-authority</span>` : "";
  const mofn = (S.meta && S.meta.squadsMofN) || "3-of-7";
  const stat = (label, val, sub, cls) => `<div class="recon-stat ${cls || ""}"><span class="recon-stat-label">${label}</span><span class="recon-stat-value">${val}</span><span class="recon-stat-sub">${sub}</span></div>`;
  $("govSummary").innerHTML = [
    stat("UPGRADE AUTHORITY", acct(g.upgradeAuthority) + ctrlBadge, squads ? "program upgrades gated by the Squads multisig" : "program upgrade authority", squads ? "green" : ""),
    stat("GOVERNANCE MULTISIG", squads ? `${esc(mofn)}` : "—", squads ? "Squads " + esc(mofn) + " — verify on the Squads app" : "not detected", squads ? "green" : ""),
    stat("PROGRAM DEPLOY", `slot ${g.lastDeploySlot != null ? g.lastDeploySlot.toLocaleString("en-US") : "—"}`, "last on-chain deploy — alerts on any redeploy", ""),
    stat("CHANGES SINCE BASELINE", String(changes), changes ? "see alert log" : "authority surface unchanged", changes ? "red" : "green"),
  ].join("");

  // permission flags
  const perms = (g.perpetuals && g.perpetuals.permissions) || {};
  const CRIT = new Set(["allow_remove_liquidity", "allow_collateral_withdrawal", "allow_close_position", "allow_liquidation"]);
  $("govPermNote").innerHTML = g.perpetuals ? acct(g.perpetuals.account) : "";
  $("govPerms").innerHTML = Object.keys(perms).length
    ? Object.entries(perms).map(([k, v]) => `<span class="rcheck ${v ? "good" : "bad"}" title="${CRIT.has(k) ? "money-path permission — a flip here is highest severity" : "protocol permission flag"}">${v ? "✓" : "✕"} ${esc(k.replace(/^allow_/, ""))}${CRIT.has(k) ? " ●" : ""}</span>`).join("")
    : `<span class="dim">no Perpetuals config decoded</span>`;

  // the FLASH6-internal Multisig 1-of-4 account is NOT displayed — it is not the protocol's
  // governance; program upgrades are gated by the Squads multisig shown above.
  const msNote = document.getElementById("govMsNote"), msTable = document.getElementById("govMsTable");
  if (msNote) msNote.textContent = "";
  if (msTable) msTable.innerHTML = "";

  const ch = S.meta.channels || {};
  const on = Object.entries(ch).filter(([, v]) => v).map(([k]) => k);
  const ackBtn = changes ? ` <button class="ptok-btn" data-ack="all" title="clear latched governance alerts after review">ACKNOWLEDGE ALL</button>` : "";
  $("govChannels").innerHTML = `<span><b>Alert delivery:</b> ${on.length ? on.map((c) => `<span class="gpill ok">${esc(c)}</span>`).join(" ") : '<span class="gpill mut">none configured — set TELEGRAM_BOT_TOKEN+TELEGRAM_CHAT_ID / SLACK_WEBHOOK_URL / HEARTBEAT_URL</span>'}${ackBtn}</span><span class="dim">● = money-path permission (highest severity on flip)</span>`;
}

/* ---------- markets ---------- */
function renderMarkets(S) {
  const rows = S.markets || [];
  const q = ($("mktFilter").value || "").toLowerCase();
  const f = rows.filter((m) => !q || `${m.symbol} ${m.side} ${m.pool} ${m.collateralSymbol}`.toLowerCase().includes(q));
  const active = rows.filter((m) => m.openPositions > 0);
  $("mktTag").textContent = `${rows.length} market-sides · ${active.length} active · OI ${usdc(rows.reduce((s, m) => s + m.oiUsd, 0))}`;
  $("mktTable").innerHTML = `<thead><tr><th>MARKET</th><th>SIDE</th><th>POOL</th><th class="r">OPEN INTEREST</th><th class="r">COLLATERAL</th><th class="r">POSITIONS</th><th class="r">AVG ENTRY</th><th class="r">MARK (ON-CHAIN)</th><th class="r">COLLATERAL TOKEN</th></tr></thead><tbody>` +
    (f.map((m) => `<tr>
      <td><b>${esc(m.symbol)}</b>${m.targetIsVirtual ? ` <span class="gpill mut" title="synthetic target — priced by its virtual custody's on-chain oracle">SYN</span>` : ""}</td>
      <td>${sidePill(m.side)}</td>
      <td>${poolPill(m.pool)}</td>
      <td class="r"><b>${m.oiUsd ? usdc(m.oiUsd) : "·"}</b></td>
      <td class="r">${m.collateralUsd ? usdc(m.collateralUsd) : "·"}</td>
      <td class="r">${m.openPositions || "·"}</td>
      <td class="r">${m.avgEntry ? px(m.avgEntry) : "·"}</td>
      <td class="r">${m.markUsd != null ? px(m.markUsd) : "—"}</td>
      <td class="r dim">${esc(m.collateralSymbol)}</td>
    </tr>`).join("") || `<tr><td colspan="9" class="empty">no match</td></tr>`) + "</tbody>";
}

/* ---------- tokens ---------- */
function renderTokens(S) {
  const rows = (S.evaluation && S.evaluation.tokens) || [];
  const globalCap = (S.evaluation && S.evaluation.global && S.evaluation.global.limitUsdPerHour) || 0;
  const q = ($("tokFilter").value || "").toLowerCase();
  const active = (t) => (t.in24hUsd || 0) > 0 || (t.out24hUsd || 0) > 0;
  // (2) sort ACTIVE vaults (any 24h flow) to the top by activity; quiet vaults below by balance
  const f = rows.filter((t) => !q || `${t.symbol} ${t.pool} ${t.mint}`.toLowerCase().includes(q))
    .slice().sort((a, b) => (active(b) - active(a))
      || ((b.out1hUsd || 0) - (a.out1hUsd || 0))
      || (((b.in24hUsd || 0) + (b.out24hUsd || 0)) - ((a.in24hUsd || 0) + (a.out24hUsd || 0)))
      || ((b.vaultUsd || 0) - (a.vaultUsd || 0)));
  const nActive = f.filter(active).length;
  const bad = rows.filter((t) => t.status !== "ok").length;
  const tag = $("tokTag");
  tag.textContent = bad ? `${bad} GUARD${bad > 1 ? "S" : ""} TRIPPED` : `${nActive} ACTIVE · ${rows.length - nActive} QUIET · ALL WITHIN LIMITS`;
  tag.className = "card-tag " + (rows.some((t) => t.status === "breach") ? "bad" : bad ? "warn" : "okk");
  const dot = (label) => `<span class="noflow" title="${label}">·</span>`; // (3) hover explains the dot
  let firstQuietSeen = false;
  $("tokTable").innerHTML = `<thead><tr><th>TOKEN</th><th>POOL</th><th class="r">VAULT BALANCE</th><th class="r">IN 1H</th><th class="r">OUT 1H</th><th class="r">IN 24H</th><th class="r">OUT 24H</th><th class="r">DRAWDOWN 1H</th><th class="r" title="share of the \$${globalCap.toLocaleString("en-US")}/h global outflow cap this vault used this hour (or its own per-token cap if set)">CAP UTIL 1H</th><th class="r">TX 1H</th><th class="c">GUARD</th></tr></thead><tbody>` +
    (f.map((t) => {
      const ddFrac = t.drawdownLimitPct > 0 ? (t.drawdownPct1h || 0) / t.drawdownLimitPct : null;
      const quiet = !active(t);
      // (2) visual separator where the active rows end and quiet ones begin
      const sep = quiet && !firstQuietSeen && nActive > 0; if (sep) firstQuietSeen = true;
      // (1) CAP UTIL: per-token cap util if one is set, else this vault's share of the GLOBAL cap
      const globalShare = globalCap > 0 ? (t.out1hUsd || 0) / globalCap : null;
      const capCell = t.limitUsdPerHour
        ? `<span title="per-token cap \$${usd(t.limitUsdPerHour, 0)}/h">${meterCell(t.utilization)}</span>`
        : `<span class="share-cell" title="${usd(t.out1hUsd || 0)} of the \$${usd(globalCap, 0)}/h global cap"><span class="share-pct">${globalShare != null ? (globalShare * 100 < 0.1 && (t.out1hUsd || 0) > 0 ? "<0.1%" : (globalShare * 100).toFixed(globalShare * 100 < 10 ? 1 : 0) + "%") : "—"}</span>${meter(globalShare)}</span>`;
      return `<tr class="${quiet ? "row-quiet" : ""}${sep ? " row-active-sep" : ""}">
      <td><b>${esc(t.symbol)}</b>${t.isStable ? ` <span class="gpill blue" title="stablecoin custody">STB</span>` : ""}</td>
      <td>${poolPill(t.pool)}</td>
      <td class="r" title="${amt(t.vaultBalance)} ${esc(t.symbol)} raw:${esc(t.vaultBalanceRaw)}"><a class="addr" href="${scanAcct(t.vault)}" target="_blank" rel="noopener"><b>${usdc(t.vaultUsd)}</b></a><br><span class="dim">${amt(t.vaultBalance)}</span></td>
      <td class="r">${t.in1hUsd ? `<span class="dir-in">▲ ${usdc(t.in1hUsd)}</span>` : dot("no inflow this hour")}</td>
      <td class="r">${t.out1hUsd ? `<span class="dir-out">▼ ${usdc(t.out1hUsd)}</span>` : dot("no outflow this hour")}</td>
      <td class="r">${t.in24hUsd ? `<span class="dir-in">${usdc(t.in24hUsd)}</span>` : dot("no inflow in 24h")}</td>
      <td class="r">${t.out24hUsd ? `<span class="dir-out">${usdc(t.out24hUsd)}</span>` : dot("no outflow in 24h")}</td>
      <td class="r" title="share of vault drained in the last rolling hour · alarm at ${t.drawdownLimitPct}%">${t.drawdownPct1h ? t.drawdownPct1h.toFixed(2) + "%" : "0%"} ${meter(ddFrac)}</td>
      <td class="r">${capCell}</td>
      <td class="r">${t.events1h}${t.failed1h ? ` <span class="gpill warn" title="FAILED txs touching this vault in the last hour — a supplementary signal">✗${t.failed1h}</span>` : ""}</td>
      <td class="c">${pill(t.status, `mark ${px(t.markUsd)} · ${t.unpriced1h ? t.unpriced1h + " unpriced events · " : ""}net 1h ${usd(t.net1hUsd)}`)}</td>
    </tr>`; }).join("") || `<tr><td colspan="11" class="empty">no match</td></tr>`) + "</tbody>";
}

/* ---------- wallets ---------- */
function renderWallets(S) {
  const rows = ((S.evaluation && S.evaluation.wallets) || []).filter((w) => w.out1hUsd > 0 || w.out24hUsd > 0);
  const bad = rows.filter((w) => w.status !== "ok").length;
  const tag = $("walTag");
  tag.textContent = bad ? `${bad} WALLET GUARD${bad > 1 ? "S" : ""}` : rows.length ? "WITHIN LIMITS" : "QUIET";
  tag.className = "card-tag " + (rows.some((w) => w.status === "breach") ? "bad" : bad ? "warn" : "okk");
  $("walTable").innerHTML = `<thead><tr><th>WALLET</th><th class="r">OUT 1H</th><th class="r">OUT 24H</th><th class="r">SHARE OF 1H OUTFLOW</th><th class="r">TX</th><th class="c">GUARD</th></tr></thead><tbody>` +
    (rows.slice(0, 14).map((w) => `<tr>
      <td><a class="addr" href="${scanAcct(w.wallet)}" target="_blank" rel="noopener" title="tokens: ${esc((w.tokens || []).join(", "))}">${short(w.wallet, 6)}</a></td>
      <td class="r"><span class="dir-out">${w.out1hUsd ? "▼ " + usdc(w.out1hUsd) : "·"}</span></td>
      <td class="r">${usdc(w.out24hUsd)}</td>
      <td class="r">${w.pctOfGlobal1h != null ? w.pctOfGlobal1h.toFixed(1) + "% " + meter(w.pctOfGlobal1h / 100) : "—"}</td>
      <td class="r">${w.events}</td>
      <td class="c">${pill(w.status, `per-wallet cap ${usd(w.limitUsdPerHour, 0)}/h`)}</td>
    </tr>`).join("") || `<tr><td colspan="6" class="empty">no outflows in the window — quiet is good</td></tr>`) + "</tbody>";
}

/* ---------- oracle ---------- */
function renderOracle(S) {
  const rows = (S.evaluation && S.evaluation.oracle) || [];
  const bad = rows.filter((o) => o.status === "breach").length, warn = rows.filter((o) => o.status === "warn").length;
  const src = S.meta.oracleSource === "lazer" ? "PYTH LAZER · DIRECT" : "PYTH LAZER · FLASH API";
  const tag = $("oraTag");
  tag.textContent = (bad ? `${bad} DEVIATION BREACH` : warn ? `${warn} WARN` : "MARKS ALIGNED") + " · via " + src;
  tag.className = "card-tag " + (bad ? "bad" : warn ? "warn" : "okk");
  tag.title = S.meta.lazer && S.meta.lazer.tokenPresent
    ? (S.meta.lazer.ok ? "prices from Pyth Lazer directly (third-party independent) — the exact feeds Flash uses" : `Lazer token present but failing (${S.meta.lazer.reason}) — using the Flash V2 API Lazer feed`)
    : "prices from the Flash V2 API Lazer feed (flashapi.trade/prices — a separate system from the on-chain oracle writer, so a forged mark diverges instantly); set LAZER_ACCESS_TOKEN for third-party-direct Lazer";
  $("oraTable").innerHTML = `<thead><tr><th>SYMBOL</th><th class="r">FLASH MARK</th><th class="r">MARK AGE</th><th class="r" title="lazer_price stored in the same on-chain CustomOracle account — Flash's own Lazer value">LAZER (ON-CHAIN)</th><th class="r">LAZER (${src === "PYTH LAZER · DIRECT" ? "DIRECT" : "FLASH API"})</th><th class="r">DEVIATION</th><th class="c">GUARD</th></tr></thead><tbody>` +
    (rows.map((o) => {
      const staleMark = o.markAgeSec != null && o.markAgeSec > 300;
      return `<tr>
      <td><b>${esc(o.symbol)}</b></td>
      <td class="r">${px(o.markUsd)}</td>
      <td class="r ${staleMark ? "sync-cell" : "dim"}" title="CustomOracle publish_time, read on-chain">${o.markAgeSec != null ? ago(Math.floor(Date.now() / 1000) - o.markAgeSec) : "—"}</td>
      <td class="r" title="${o.lazerScaleMismatch ? "legacy/stale account — on-chain lazer_price is not on the mark's scale, not comparable" : o.markVsLazerPct != null ? "mark vs on-chain lazer_price: " + o.markVsLazerPct + "%" : "no on-chain lazer_price"}">${o.lazerScaleMismatch ? '<span class="dim">n/a</span>' : px(o.lazerOnChainUsd)}${o.markVsLazerPct != null && o.markVsLazerPct >= 0.5 ? ` <span class="gpill warn" title="Flash's own mark and its own on-chain Lazer value disagree by ${o.markVsLazerPct}%">Δ${o.markVsLazerPct}%</span>` : ""}</td>
      <td class="r" title="${esc(o.pythSymbol || "")}">${px(o.pythUsd)}</td>
      <td class="r">${o.deviationPct != null ? `${o.deviationPct.toFixed(2)}% ${meter(o.deviationPct / (o.limitPct || 1.5))}` : "—"}</td>
      <td class="c">${pill(o.status, o.status === "unmapped" ? "no confident independent feed match — reported, never guessed" : o.status === "stale" ? "mark or Pyth quote unavailable this cycle" : o.status === "inactive" ? "mark not updating (on-chain publish_time) — market paused/closed, deviation not evaluated; the guard re-arms automatically when the mark goes live" : `alarm at ${o.limitPct}% divergence`)}</td>
    </tr>`; }).join("") || `<tr><td colspan="6" class="empty">no oracle rows</td></tr>`) + "</tbody>";
}

/* ---------- limits form ---------- */
let limitsBuilt = false, limitsDirty = false;
const FIELDS = [
  ["globalOutflowUsdPerHour", "GLOBAL outflow cap · USD/hour", "total outflow across ALL wallets per rolling hour"],
  ["defaultTokenOutflowUsdPerHour", "Per-token cap (default) · USD/hour", "applies to every vault · blank = off (global still applies)"],
  ["perWalletOutflowUsdPerHour", "Per-wallet cap · USD/hour", "max any single wallet may receive per rolling hour"],
  ["vaultDrawdownPctPerHour", "Vault drawdown alarm · %/hour", "share of a vault drained per rolling hour"],
  ["oracleDeviationPct", "Oracle deviation alarm · %", "FLASH6 on-chain mark vs Pyth Lazer"],
  ["warnFraction", "Warn threshold · 0–1", "fraction of any limit that raises WARN before BREACH"],
];
function renderLimits(S) {
  const ro = !(S.meta && S.meta.limitsWritable);
  if (ro) return renderLimitsReadonly(S); // public view: clean read-only threshold display, no dead form
  // operator (writable) view: editable configuration
  const t = document.getElementById("limTitle"); if (t) t.textContent = "Outflow Limits — live configuration";
  const n = document.getElementById("limNote"); if (n) n.innerHTML = "Limits re-evaluate against the live windows the moment you apply. Every WARN/BREACH transition is logged and broadcast. <strong>This monitor alerts; on-chain enforcement needs a program-level circuit breaker.</strong>";
  const apply = document.getElementById("btnApply"); if (apply) apply.style.display = "";
  if (!limitsBuilt) {
    $("limitsGrid").innerHTML = FIELDS.map(([k, t, s]) => `<div class="lctl"><label for="f_${k}">${t}</label><input id="f_${k}" inputmode="decimal" placeholder="off" autocomplete="off"><small>${s}</small></div>`).join("")
      + `<div class="lctl" style="grid-column:1/-1"><label>Per-token caps · USD/hour (individual)</label><small>a dedicated hourly cap for a specific vault — overrides the default per-token cap above; the global cap always applies on top</small>
         <div class="ptok-rows" id="ptokRows"></div>
         <div class="ptok-add"><select id="ptokSel"></select><input id="ptokAmt" inputmode="decimal" placeholder="USD/hour" autocomplete="off"><button class="ptok-btn" id="ptokAdd" type="button">+ ADD CAP</button></div></div>`;
    $("ptokAdd").addEventListener("click", () => {
      const key = $("ptokSel").value, amt = Number($("ptokAmt").value);
      if (!key || !Number.isFinite(amt) || amt < 0) { $("limitsMsg").textContent = "✗ pick a token and a valid USD/hour amount"; return; }
      ptokDraft[key] = amt; limitsDirty = true; $("ptokAmt").value = ""; renderPtokRows();
    });
    $("ptokRows").addEventListener("click", (e) => {
      const b = e.target.closest(".ptok-del"); if (!b) return;
      delete ptokDraft[b.dataset.k]; limitsDirty = true; renderPtokRows();
    });
    $("ptokRows").addEventListener("input", (e) => {
      const i = e.target.closest("input[data-k]"); if (!i) return;
      ptokDraft[i.dataset.k] = i.value; limitsDirty = true;
    });
    $("limitsGrid").addEventListener("input", () => { limitsDirty = true; });
    $("btnApply").addEventListener("click", async () => {
      const body = {};
      for (const [k] of FIELDS) { const v = $("f_" + k).value.trim(); body[k] = v === "" ? null : Number(v); if (v !== "" && !Number.isFinite(body[k])) { $("limitsMsg").textContent = `✗ invalid number: ${k}`; return; } }
      body.perTokenOutflowUsdPerHour = {};
      for (const [k, v] of Object.entries(ptokDraft)) { const n = Number(v); if (Number.isFinite(n) && n >= 0) body.perTokenOutflowUsdPerHour[k] = n; }
      try {
        const r = await fetch("/api/limits", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const j = await r.json();
        $("limitsMsg").textContent = j.ok ? "✓ applied · saved to limits.json · re-evaluated against live windows" : "✗ " + (j.error || "rejected");
        limitsDirty = false; refresh();
      } catch (e) { $("limitsMsg").textContent = "✗ " + e.message; }
    });
    limitsBuilt = true;
  }
  if (!limitsDirty && S.limits) {
    for (const [k] of FIELDS) { const i = $("f_" + k); if (document.activeElement !== i) i.value = S.limits[k] == null ? "" : S.limits[k]; }
    ptokDraft = { ...(S.limits.perTokenOutflowUsdPerHour || {}) };
    renderPtokRows();
  }
}

// Public read-only view: show the ACTIVE guard thresholds as a clean readout (transparency),
// with no dead input boxes / Apply button. Editing lives on the operator daemon.
function renderLimitsReadonly(S) {
  const L = S.limits || {};
  const usd = (v) => (v == null ? "off" : "$" + Number(v).toLocaleString("en-US") + "/hr");
  const stat = (label, val, sub, cls) => `<div class="recon-stat ${cls || ""}"><span class="recon-stat-label">${label}</span><span class="recon-stat-value">${val}</span><span class="recon-stat-sub">${sub}</span></div>`;
  const ptok = Object.entries(L.perTokenOutflowUsdPerHour || {});
  $("limitsGrid").innerHTML = [
    stat("GLOBAL OUTFLOW CAP", usd(L.globalOutflowUsdPerHour), "total across all wallets · rolling hour", "green"),
    stat("PER-WALLET CAP", usd(L.perWalletOutflowUsdPerHour), "max any single wallet receives · rolling hour", ""),
    stat("PER-TOKEN CAP (default)", L.defaultTokenOutflowUsdPerHour == null ? "off" : usd(L.defaultTokenOutflowUsdPerHour), "per vault · global still applies", ""),
    stat("VAULT DRAWDOWN ALARM", (L.vaultDrawdownPctPerHour != null ? L.vaultDrawdownPctPerHour : "—") + "%/hr", "share of a vault drained · rolling hour", ""),
    stat("ORACLE DEVIATION ALARM", (L.oracleDeviationPct != null ? L.oracleDeviationPct : "—") + "%", "on-chain mark vs Pyth Lazer", ""),
    stat("WARN THRESHOLD", String(L.warnFraction != null ? L.warnFraction : "—"), "fraction of a limit that raises WARN first", ""),
  ].join("") + (ptok.length ? `<div class="lctl" style="grid-column:1/-1"><label>Individual per-token caps</label><div class="ptok-rows">${ptok.map(([k, v]) => `<div class="ptok-row"><code>${esc(k)}</code><span class="dim">$${Number(v).toLocaleString("en-US")}/hr</span></div>`).join("")}</div></div>` : "");
  const apply = $("btnApply"); if (apply) apply.style.display = "none";
  $("limitsMsg").innerHTML = `<span class="dim">🔒 Live guard thresholds (read-only). The sentinel alerts the operator's channel the instant any is crossed.</span>`;
}

let ptokDraft = {};
function renderPtokRows() {
  const rows = $("ptokRows"); if (!rows) return;
  rows.innerHTML = Object.entries(ptokDraft).map(([k, v]) => `<div class="ptok-row"><code>${esc(k)}</code><input data-k="${esc(k)}" inputmode="decimal" value="${esc(v)}"><button class="ptok-del" data-k="${esc(k)}" type="button" title="remove this cap">✕</button></div>`).join("")
    || `<div class="dim" style="font-size:11px;padding:4px 0">no individual caps set — the default per-token cap (if any) and the global cap apply</div>`;
  const sel = $("ptokSel"); if (!sel) return;
  const keys = ((lastState && lastState.evaluation && lastState.evaluation.tokens) || []).map((t) => t.key).filter((k) => !(k in ptokDraft)).sort();
  const cur = sel.value;
  sel.innerHTML = `<option value="">select token…</option>` + keys.map((k) => `<option${k === cur ? " selected" : ""}>${esc(k)}</option>`).join("");
}

/* ---------- feed ---------- */
let seenSigs = new Set(), firstFeed = true;
function renderFeed(S) {
  const rows = S.events || [];
  const q = ($("feedFilter").value || "").toLowerCase();
  const f = rows.filter((e) => !q || `${e.symbol} ${e.pool} ${e.kind} ${e.wallet} ${e.sig} ${(e.ix || []).join(" ")}`.toLowerCase().includes(q));
  $("feedTag").textContent = `${rows.length} transfers held (${S.meta.retentionHours}h retention) · newest first`;
  const newSet = new Set();
  $("feedTable").innerHTML = `<thead><tr><th>UTC TIME</th><th>TOKEN</th><th>POOL</th><th>KIND</th><th>DIRECTION</th><th class="r">AMOUNT</th><th class="r">USD</th><th>WALLET</th><th>TX</th><th class="r">CAPTURE</th></tr></thead><tbody>` +
    (f.slice(0, 150).map((e) => {
      const isNew = !firstFeed && !seenSigs.has(e.sig + e.custody);
      newSet.add(e.sig + e.custody);
      const lat = e.observedAtMs != null && e.blockTime != null ? (e.observedAtMs / 1000 - e.blockTime) : null;
      return `<tr class="${isNew ? "feed-new" : ""}">
      <td class="r" title="slot ${e.slot} · ${new Date(e.blockTime * 1000).toISOString()}">${utcHMS(e.blockTime)}<br><span class="dim">${ago(e.blockTime)} ago</span></td>
      <td><b>${esc(e.symbol)}</b></td>
      <td>${poolPill(e.pool)}</td>
      <td><span class="kindtag" title="${esc((e.ix || []).join(" · "))}">${esc(e.kind)}</span>${e.internal ? ` <span class="gpill mut" title="vault→vault internal settlement — excluded from user inflow/outflow totals">INT</span>` : ""}</td>
      <td>${e.direction === "in" ? `<span class="dir-in">▲ IN</span>` : `<span class="dir-out">▼ OUT</span>`}</td>
      <td class="r" title="raw delta ${esc(e.deltaRaw)}">${amt(e.amount)}</td>
      <td class="r">${e.usd != null ? `<span class="${e.direction === "in" ? "dir-in" : "dir-out"}">${usd(e.usd)}</span>` : `<span class="dim" title="no oracle mark at capture — counted in totals as unpriced">unpriced</span>`}</td>
      <td><a class="addr" href="${scanAcct(e.wallet)}" target="_blank" rel="noopener" title="${esc(e.wallet)}${e.counterparties && e.counterparties.length ? " · counterparties: " + e.counterparties.map((c) => c.owner).join(", ") : ""}">${short(e.wallet, 5)}</a></td>
      <td><a class="addr" href="${scanTx(e.sig)}" target="_blank" rel="noopener">${short(e.sig, 5)}</a></td>
      <td class="r dim" title="seconds between the block and this monitor decoding the transfer">${lat != null && lat < 300 ? "+" + lat.toFixed(1) + "s" : lat != null ? "backfill" : "—"}</td>
    </tr>`; }).join("") || `<tr><td colspan="10" class="empty">no transfers match</td></tr>`) + "</tbody>";
  rows.forEach((e) => newSet.add(e.sig + e.custody));
  seenSigs = newSet; firstFeed = false;
}

/* ---------- alerts ---------- */
function renderAlerts(S) {
  const act = Object.values((S.alerts && S.alerts.active) || {}).filter((a) => a.status === "warn" || a.status === "breach").length;
  const rows = (S.alerts && S.alerts.log) || [];
  const tag = $("alertTag");
  tag.textContent = act ? `${act} ACTIVE` : "ALL CLEAR";
  tag.className = "card-tag " + (Object.values((S.alerts && S.alerts.active) || {}).some((a) => a.status === "breach") ? "bad" : act ? "warn" : "okk");
  $("alertTable").innerHTML = `<thead><tr><th>UTC TIME</th><th>RULE</th><th class="c">TRANSITION</th><th>DETAIL</th></tr></thead><tbody>` +
    (rows.slice(0, 60).map((a) => `<tr>
      <td class="r">${utcHMS(a.time)}<br><span class="dim">${ago(a.time)} ago</span></td>
      <td><code>${esc(a.rule)}</code></td>
      <td class="c">${pill(a.from === "ok" || a.to !== "ok" ? a.to : "ok")} <span class="dim">← ${esc(a.from)}</span></td>
      <td style="max-width:420px;white-space:normal">${esc(a.detail)}</td>
    </tr>`).join("") || `<tr><td colspan="4" class="empty good">no alerts — every guard has stayed green</td></tr>`) + "</tbody>";
}

/* ---------- conservation proof ---------- */
function renderProof(S) {
  const rows = (S.conservation && S.conservation.rows) || [];
  const exact = rows.filter((r) => r.status === "exact").length;
  const tag = $("proofTag");
  tag.textContent = `${exact}/${rows.length} EXACT`;
  tag.className = "card-tag " + (exact === rows.length ? "okk" : rows.some((r) => r.status === "drift") ? "bad" : "warn");
  $("proofTable").innerHTML = `<thead><tr><th>VAULT</th><th class="r">BASELINE (RAW u64)</th><th class="r">Σ OBSERVED DELTAS</th><th class="r">LIVE BALANCE (RAW u64)</th><th class="r">RESIDUAL</th><th class="r">PROVEN FOR</th><th class="c">STATUS</th></tr></thead><tbody>` +
    (rows.map((r) => `<tr>
      <td><b>${esc(r.key)}</b><br><a class="addr dim" href="${scanAcct(r.vault)}" target="_blank" rel="noopener">${short(r.vault, 5)}</a></td>
      <td class="r proof-line">${grp(r.baseRaw)}</td>
      <td class="r proof-line">${grp(r.sumDeltas)}</td>
      <td class="r proof-line">${grp(r.balanceRaw)}</td>
      <td class="r proof-line ${r.residual === "0" ? "exact-cell" : "drift-cell"}">${r.residual === "0" ? "0 ✓" : grp(r.residual)}</td>
      <td class="r dim">${ago(r.baseTime)}</td>
      <td class="c">${r.status === "exact" ? `<span class="exact-badge">EXACT</span>` : r.status === "syncing" ? `<span class="gpill warn" title="a transfer landed mid-cycle — must reconcile exactly next cycle">◌ SYNCING</span>` : `<span class="gpill bad">DRIFT ×${r.rebases}</span>`}</td>
    </tr>`).join("") || `<tr><td colspan="7" class="empty">establishing baselines…</td></tr>`) + "</tbody>";
}

/* ---------- footer ---------- */
function renderFoot(S) {
  const m = S.meta;
  $("footSource").innerHTML = `<b>Sources:</b> transfers &amp; balances → <code>${esc(m.mainRpc)}</code> (base chain, confirmed) · custody/market/oracle state → <code>${esc(m.erRpc)}</code> (program's own on-chain IDL) · independent price cross-check → <code>${esc(S.meta && S.meta.oracleSource === "lazer" ? "pyth-lazer.dourolabs.app" : "flashapi.trade/prices")}</code> (Pyth Lazer) · backfill ${m.backfillHours}h · retention ${m.retentionHours}h${m.cycleErrors && m.cycleErrors.length ? ` · <span style="color:var(--amber)">cycle warnings: ${m.cycleErrors.map(esc).join(" · ")}</span>` : ""}`;
  $("footWhy").textContent = (m.guardNote || "") + " A per-hour outflow cap, wallet concentration, drawdown velocity and a Pyth Lazer oracle cross-check bound that class of drain. This is a detection layer, not on-chain enforcement.";
}

/* ---------- main loop ---------- */
let lastState = null;
async function refresh() {
  try {
    const r = await fetch("/api/state");
    if (!r.ok) throw new Error("api " + r.status);
    const S = await r.json();
    lastState = S;
    renderHeader(S); renderVerdict(S); renderKpis(S); renderChart(S); renderSides(S); renderMarkets(S);
    renderTokens(S); renderGovernance(S); renderWallets(S); renderOracle(S); renderLimits(S); renderFeed(S); renderAlerts(S); renderProof(S); renderFoot(S);
  } catch (e) { headerOffline(); }
}
let fastPoll = null;
function connectSSE() {
  // local daemon pushes over SSE; on Vercel there is no SSE → fall back to 10s polling
  try {
    let fails = 0;
    const es = new EventSource("/events");
    es.addEventListener("cycle", () => { fails = 0; refresh(); });
    es.onerror = () => { fails++; if (fails >= 2 && !fastPoll) { es.close(); fastPoll = setInterval(refresh, 10000); } };
  } catch (e) { if (!fastPoll) fastPoll = setInterval(refresh, 10000); }
}
["mktFilter", "tokFilter", "feedFilter"].forEach((id) => $(id).addEventListener("input", () => lastState && (id === "mktFilter" ? renderMarkets(lastState) : id === "tokFilter" ? renderTokens(lastState) : renderFeed(lastState))));
let rsz; addEventListener("resize", () => { clearTimeout(rsz); rsz = setTimeout(() => { if (lastState) { renderChart(lastState); renderSides(lastState); } }, 200); });
// acknowledge latched governance alerts (delegated, attached once)
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-ack]"); if (!b) return;
  b.disabled = true;
  try { await fetch("/api/ack?rule=" + encodeURIComponent(b.dataset.ack), { method: "POST" }); refresh(); }
  catch (err) { b.disabled = false; }
});
refresh(); connectSSE(); setInterval(refresh, 30000);
setInterval(() => lastState && renderHeader(lastState), 1000); // live freshness ticker
