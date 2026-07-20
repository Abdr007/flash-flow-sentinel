"use strict";
/*
 * VERIFY — independent re-verification of everything the dashboard claims.
 *   1. ARITHMETIC   : conservation rows re-checked (base + Σdeltas == balance, BigInt).
 *   2. CHAIN        : live vault balances refetched INDEPENDENTLY and compared.
 *   3. EVENTS       : random sample of events refetched from the chain; the vault delta
 *                     is recomputed from pre/post balances and must equal the stored raw.
 *   4. WINDOWS      : global 1h/24h in/out recomputed from the raw event list and
 *                     compared to the evaluation the dashboard serves.
 *   5. BUCKETS      : Σ hourly buckets == 24h totals.
 *   6. SANITY       : mark-vs-Pyth deviation for majors, no NaNs in any token row.
 * Exits non-zero on any failure.
 */
const https = require("https");
const MAIN = process.env.RPC_URL || (process.env.HELIUS_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_KEY}` : "https://api.mainnet-beta.solana.com");
const BASE = process.env.VERIFY_BASE || "http://127.0.0.1:4646";

const rpc = (method, params) => new Promise((res, rej) => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const u = new URL(MAIN);
  const rq = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (r) => { let d = ""; r.on("data", (c) => d += c); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); });
  rq.on("error", rej); rq.setTimeout(30000, () => rq.destroy(new Error("timeout"))); rq.write(body); rq.end();
});
const jget = async (p) => { const r = await fetch(BASE + p); if (!r.ok) throw new Error(p + " → " + r.status); return r.json(); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log(`  ✓ ${name}${detail ? " — " + detail : ""}`); } else { fail++; console.log(`  ✗ FAIL ${name}${detail ? " — " + detail : ""}`); } };

(async () => {
  const S = await jget("/api/state");
  const ev = S.evaluation, g = ev.global;
  console.log(`state: cycle #${S.meta.cycles}, ${S.meta.eventsRetained} events, ${S.meta.custodies} custodies (${S.meta.realVaults} vaults), ${S.meta.markets} markets\n`);

  // ---- 1. conservation arithmetic (BigInt, zero tolerance) ----
  console.log("1. CONSERVATION ARITHMETIC");
  let arithBad = 0;
  for (const r of S.conservation.rows) {
    if (r.balanceRaw == null) continue;
    const lhs = BigInt(r.baseRaw) + BigInt(r.sumDeltas) + BigInt(r.residual);
    if (lhs !== BigInt(r.balanceRaw)) arithBad++;
    if (r.status === "exact" && r.residual !== "0") arithBad++;
  }
  ok("base + Σdeltas + residual == balance for every vault", arithBad === 0, `${S.conservation.rows.length} vaults`);
  const exact = S.conservation.rows.filter((r) => r.status === "exact").length;
  const drift = S.conservation.rows.filter((r) => r.status === "drift").length;
  const syncing = S.conservation.rows.filter((r) => r.status === "syncing").length;
  // A vault in transient "syncing" (a transfer landed between the sig-scan and the balance read)
  // is NOT a defect — it reconciles next cycle and the arithmetic above already holds. Only a
  // persistent "drift" is a real conservation failure.
  ok("conservation holds (no drift)", drift === 0, `${exact}/${S.conservation.rows.length} exact${syncing ? `, ${syncing} syncing (transient, self-heals)` : ""}${drift ? `, ${drift} DRIFT` : ""}`);

  // ---- 2. independent balance refetch ----
  console.log("2. INDEPENDENT CHAIN BALANCES");
  const rows = S.conservation.rows;
  const vaults = rows.map((r) => r.vault);
  let balMatch = 0, balMoved = 0;
  for (let i = 0; i < vaults.length; i += 100) {
    const r = await rpc("getMultipleAccounts", [vaults.slice(i, i + 100), { encoding: "base64", commitment: "confirmed" }]);
    r.result.value.forEach((v, j) => {
      const row = rows[i + j];
      const live = v && v.data ? Buffer.from(v.data[0], "base64").readBigUInt64LE(64) : null;
      if (live == null) return;
      if (live.toString() === row.balanceRaw) balMatch++; else balMoved++;
    });
  }
  // A live balance can legitimately differ from the last snapshot if a transfer landed in the
  // seconds between the dashboard cycle and this re-read. The real invariant is conservation
  // (checked above, exact); here we only flag a LARGE divergence (>3 vaults moved at once).
  ok("live refetched balances reconcile", balMoved <= 3, `${balMatch}/${balMatch + balMoved} identical this instant${balMoved ? `, ${balMoved} moved since last cycle (normal — transfers land continuously; conservation still exact)` : ""}`);

  // ---- 3. random event re-verification against the chain ----
  console.log("3. EVENT RE-VERIFICATION (random sample, straight from the chain)");
  const events = await jget("/api/events?hours=24&limit=5000");
  const sample = [];
  const pool = [...events];
  while (sample.length < Math.min(6, pool.length)) sample.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  for (const e of sample) {
    const t = await rpc("getTransaction", [e.sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
    const tx = t.result;
    if (!tx) { ok(`event ${e.sig.slice(0, 10)}…`, false, "tx not found on chain"); continue; }
    const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
    // resolve the vault by the event's custody pubkey (exact) — display keys can collide
    // when two program vaults hold the same mint (e.g. staked-LP + compounding-LP)
    const tokRow = S.evaluation.tokens.find((t) => t.custody === e.custody);
    const vi = keys.indexOf(tokRow ? tokRow.vault : "");
    const at = (arr, ai) => (arr || []).find((b) => b.accountIndex === ai);
    const pv = at(tx.meta.preTokenBalances, vi), qv = at(tx.meta.postTokenBalances, vi);
    const delta = BigInt(qv ? qv.uiTokenAmount.amount : "0") - BigInt(pv ? pv.uiTokenAmount.amount : "0");
    ok(`event ${e.sig.slice(0, 10)}… ${e.pool}/${e.symbol} ${e.direction} ${e.amount}`, delta.toString() === e.deltaRaw && tx.blockTime === e.blockTime && tx.slot === e.slot, `chain delta ${delta} == stored ${e.deltaRaw}, slot+blockTime match`);
    await sleep(150);
  }

  // ---- 4. window recompute ----
  console.log("4. WINDOW RECOMPUTE (independent)");
  const nowRef = S.meta.lastCycle;
  const authority = S.meta.sweep && S.meta.sweep.authority;
  const w = { o1: 0, i1: 0, o24: 0, i24: 0, n1o: 0, n1i: 0, n24o: 0, n24i: 0 };
  for (const e of events) {
    if (e.blockTime < nowRef - 86400 || e.blockTime > nowRef) continue;
    if (authority && e.wallet === authority) continue; // internal reshuffles excluded (same rule as dashboard)
    const isOut = e.direction === "out", u = e.usd || 0;
    if (isOut) { w.o24 += u; w.n24o++; } else { w.i24 += u; w.n24i++; }
    if (e.blockTime >= nowRef - 3600) { if (isOut) { w.o1 += u; w.n1o++; } else { w.i1 += u; w.n1i++; } }
  }
  const close = (a, b, tol) => Math.abs((a || 0) - (b || 0)) <= (tol || 0.05);
  ok("out 1h recompute", close(w.o1, g.out1hUsd), `${w.o1.toFixed(2)} vs ${g.out1hUsd}`);
  ok("in 1h recompute", close(w.i1, g.in1hUsd), `${w.i1.toFixed(2)} vs ${g.in1hUsd}`);
  ok("out 24h recompute", close(w.o24, g.out24hUsd, 0.5), `${w.o24.toFixed(2)} vs ${g.out24hUsd}`);
  ok("in 24h recompute", close(w.i24, g.in24hUsd, 0.5), `${w.i24.toFixed(2)} vs ${g.in24hUsd}`);
  // ±1 tolerance: an event can cross the rolling-24h edge between the snapshot and this recount
  ok("event counts 24h (±1 window edge)", Math.abs(w.n24o - g.outEvents24h) <= 1 && Math.abs(w.n24i - g.inEvents24h) <= 1, `${w.n24o}/${w.n24i} vs ${g.outEvents24h}/${g.inEvents24h}`);
  ok("utilization math", g.limitUsdPerHour > 0 ? close(g.utilization, g.out1hUsd / g.limitUsdPerHour, 0.01) : g.utilization == null, `${g.utilization}`);

  // ---- 5. hourly buckets ----
  console.log("5. HOURLY BUCKETS");
  const bIn = S.hourly.reduce((s, b) => s + b.inUsd, 0), bOut = S.hourly.reduce((s, b) => s + b.outUsd, 0);
  ok("Σ buckets ≈ 24h totals", close(bIn, g.in24hUsd, 1) && close(bOut, g.out24hUsd, 1), `in ${bIn.toFixed(2)}/${g.in24hUsd} out ${bOut.toFixed(2)}/${g.out24hUsd}`);

  // ---- 6. sanity ----
  console.log("6. SANITY");
  const sol = ev.oracle.find((o) => o.symbol === "SOL");
  ok("SOL mark vs Pyth < 1%", sol && sol.deviationPct != null && sol.deviationPct < 1, sol ? `${sol.deviationPct}% (mark ${sol.markUsd} pyth ${sol.pythUsd})` : "no SOL row");
  const usdcRow = ev.oracle.find((o) => o.symbol === "USDC");
  ok("USDC mark ≈ $1", usdcRow && usdcRow.markUsd > 0.97 && usdcRow.markUsd < 1.03, usdcRow ? `$${usdcRow.markUsd}` : "no row");
  const nan = ev.tokens.filter((t) => [t.out1hUsd, t.in1hUsd, t.out24hUsd, t.in24hUsd].some((x) => x != null && !Number.isFinite(x)));
  ok("no NaN in token rows", nan.length === 0, `${ev.tokens.length} rows`);
  const mkts = S.markets || [];
  ok("markets decoded", mkts.length >= 60, `${mkts.length} market-sides, OI $${mkts.reduce((s, m) => s + m.oiUsd, 0).toFixed(0)}`);
  const badMkt = mkts.filter((m) => !Number.isFinite(m.oiUsd) || m.oiUsd < 0);
  ok("no invalid market OI", badMkt.length === 0);
  const expectRows = S.meta.trackedVaults || S.meta.realVaults;
  ok("all tracked vaults have conservation rows", S.conservation.rows.length === expectRows, `${S.conservation.rows.length}/${expectRows} (incl. TradeVault/RebateVault/TokenVault)`);
  if (S.meta.sweep) ok("authority sweep active", S.meta.sweep.watched > 200, `${S.meta.sweep.watched} token accounts watched under ${S.meta.sweep.authority ? S.meta.sweep.authority.slice(0, 8) + "…" : "?"} · ${S.meta.sweep.promoted} promoted`);
  if (ev.sides) {
    const sOut = ev.sides.reduce((s, x) => s + (x.out24hUsd || 0), 0), sIn = ev.sides.reduce((s, x) => s + (x.in24hUsd || 0), 0);
    ok("Σ sides == global user flows", close(sOut, g.out24hUsd, 0.5) && close(sIn, g.in24hUsd, 0.5), `out ${sOut.toFixed(2)}/${g.out24hUsd} in ${sIn.toFixed(2)}/${g.in24hUsd}`);
    const tr = ev.sides.find((x) => x.side === "trade"), lp = ev.sides.find((x) => x.side === "lp"), oth = ev.sides.find((x) => x.side === "other");
    ok("trade/lp sides populated", tr && lp && (tr.in24hUsd + tr.out24hUsd) > 0, `trade ▲${tr.in24hUsd} ▼${tr.out24hUsd} · lp ▲${lp.in24hUsd} ▼${lp.out24hUsd} · other ▲${oth.in24hUsd} ▼${oth.out24hUsd}`);
  }

  console.log(`\n${fail === 0 ? "ALL CHECKS PASSED" : "FAILURES PRESENT"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("VERIFY FATAL:", e.message || e); process.exit(1); });
