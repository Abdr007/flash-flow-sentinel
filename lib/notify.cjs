"use strict";
/*
 * Alert delivery — fan out a WARN/BREACH/governance transition to every configured channel.
 * All optional, all env-configured (nothing is sent unless you set the channel):
 *   • TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID   → Telegram message
 *   • SLACK_WEBHOOK_URL                        → Slack incoming webhook
 *   • webhookUrl (from limits.json)            → generic JSON POST
 *   • HEARTBEAT_URL                            → pinged every healthy cycle (dead-man switch:
 *                                                 an external monitor like healthchecks.io alerts
 *                                                 if the sentinel goes silent — silence ≠ safety)
 */
// Returns the Response on a 2xx, or null on network error / non-2xx (e.g. a Telegram 400 that would
// otherwise look like success). Callers that care about delivery (critical alerts) check the result.
const post = (url, body, headers) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...(headers || {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) }).then((r) => (r && r.ok ? r : null)).catch(() => null);

// GLOBAL ALERT MUTE — when ALERTS_MUTED=1, NO external push goes out on ANY channel (Telegram main,
// operator DM, Slack, generic webhook, digests, photos). The dashboard still records everything; only the
// outbound notifications are held. Single kill-switch so nothing can push until it is explicitly lifted.
const MUTED = () => process.env.ALERTS_MUTED === "1";

const SEV_EMOJI = { critical: "🔴", high: "🟠", breach: "⛔", warn: "⚠️", ok: "✅" };

const GREEN = "rgba(63,204,120,.9)", RED = "rgba(233,84,96,.9)", BLUE = "rgba(90,150,240,.9)";

/*
 * Render a chart of REAL on-chain flow to a PNG via QuickChart and return its URL.
 *  - token alert (rule "token:Pool/SYMBOL")  → just that one token's own flow (1h/24h in·out + vault balance)
 *  - anything else (global/wallet/etc.)       → every active vault, diverging inflow ▲ / outflow ▼ (24h)
 * All values come straight from the evaluated on-chain token set — nothing synthetic.
 */
async function chartUrlForAlert(a, tokens) {
  if (!Array.isArray(tokens) || !tokens.length) return null;
  let config;
  const m = /^token:(.+)$/.exec(a.rule || "");
  if (m) {
    const t = tokens.find((x) => x.key === m[1]);
    if (!t) return null;
    config = {
      type: "bar",
      data: {
        labels: ["In 1h", "Out 1h", "In 24h", "Out 24h", "Vault bal"],
        datasets: [{
          data: [t.in1hUsd || 0, t.out1hUsd || 0, t.in24hUsd || 0, t.out24hUsd || 0, t.vaultUsd || 0],
          backgroundColor: [GREEN, RED, GREEN, RED, BLUE],
        }],
      },
      options: {
        legend: { display: false },
        title: { display: true, text: `${t.pool || "?"}/${t.symbol || "?"} — on-chain flow (USD)  ·  drawdown 1h ${t.drawdownPct1h != null ? t.drawdownPct1h : 0}%`, fontColor: "#e8f2ea" },
        scales: { yAxes: [{ ticks: { fontColor: "#9fb3a6" } }], xAxes: [{ ticks: { fontColor: "#9fb3a6" } }] },
      },
    };
  } else {
    const rows = tokens
      .filter((t) => (t.in24hUsd || 0) > 0 || (t.out24hUsd || 0) > 0)
      .sort((x, y) => ((y.in24hUsd || 0) + (y.out24hUsd || 0)) - ((x.in24hUsd || 0) + (x.out24hUsd || 0)))
      .slice(0, 18);
    if (!rows.length) return null;
    config = {
      type: "bar",
      data: {
        labels: rows.map((t) => `${t.pool || "?"}/${t.symbol || "?"}`),
        datasets: [
          { label: "Inflow ▲ 24h", data: rows.map((t) => Math.round(t.in24hUsd || 0)), backgroundColor: GREEN },
          { label: "Outflow ▼ 24h", data: rows.map((t) => -Math.round(t.out24hUsd || 0)), backgroundColor: RED },
        ],
      },
      options: {
        title: { display: true, text: "All vaults — on-chain inflow ▲ / outflow ▼ (24h USD)", fontColor: "#e8f2ea" },
        legend: { labels: { fontColor: "#cfe0d4" } },
        scales: {
          xAxes: [{ stacked: true, ticks: { fontColor: "#9fb3a6", maxRotation: 60, minRotation: 45 } }],
          yAxes: [{ stacked: true, ticks: { fontColor: "#9fb3a6" } }],
        },
      },
    };
  }
  try {
    const r = await fetch("https://quickchart.io/chart/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chart: config, width: 760, height: 420, backgroundColor: "#0b0f10", format: "png", version: "2" }),
      signal: AbortSignal.timeout(8000),
    });
    const j = await r.json();
    return j && j.success && j.url ? j.url : null;
  } catch (e) { return null; }
}

/** Send a photo (by URL) to Telegram with an optional caption. */
// Resolves to the Response on success, or null if the photo could not be delivered (so the caller
// can fall back to a plain-text message — a critical alert must never be silently dropped).
function sendPhoto(photoUrl, caption) {
  if (MUTED()) return Promise.resolve(null);
  const tok = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!tok || !chat || !photoUrl) return Promise.resolve(null);
  return post(`https://api.telegram.org/bot${tok}/sendPhoto`, { chat_id: chat, photo: photoUrl, caption: (caption || "").slice(0, 1024) });
}

/** Deliver one alert to all channels. `a` = { time, rule, from, to, detail, severity? }. */
function deliverAlert(a, cfg) {
  if (MUTED()) return; // global mute — hold all outbound alerts until explicitly lifted
  const sev = a.severity || (a.to === "breach" ? "breach" : a.to === "warn" ? "warn" : a.to === "ok" ? "ok" : "high");
  const emoji = SEV_EMOJI[sev] || "🔔";
  const line = `${emoji} FLASH FLOW SENTINEL — ${sev.toUpperCase()}\nrule: ${a.rule}\n${a.detail}`;

  // A raw threshold crossing is a TRIGGER, not an alarm — it is NEVER pushed to Telegram (neither the public
  // channel nor the operator DM). Per the operator: only VERIFIED/PROVEN events become Telegram alarms, and
  // those are sent from the verification layer (runContainment full-history over-withdrawal proof, census
  // solvency invariants, conservation, phantom position, fresh-program deploy, probe-cluster, governance) via
  // sendSecurityAlert. This function only fans a raw trigger to the OPT-IN generic webhook + Slack (for anyone
  // who wants the raw feed in their own system) — it can no longer turn a threshold cross into a DM alarm.
  if (cfg.webhookUrl) post(cfg.webhookUrl, { source: "flash-flow-sentinel", ...a });
  const slack = process.env.SLACK_WEBHOOK_URL;
  if (slack) post(slack, { text: line });
}

/** Ping the dead-man heartbeat (call once per healthy cycle). */
function heartbeat() {
  const url = process.env.HEARTBEAT_URL;
  if (url) fetch(url, { method: "GET", signal: AbortSignal.timeout(6000) }).catch(() => {});
}

/** Send a formatted message to the PUBLIC channel (digest, weekly, alerts). */
function sendTelegram(text) {
  if (MUTED()) return Promise.resolve();
  const tok = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!tok || !chat) return Promise.resolve();
  return post(`https://api.telegram.org/bot${tok}/sendMessage`, { chat_id: chat, text, disable_web_page_preview: true });
}

/** Withdrawal firehose — an explicitly-enabled feed (Flash team request during the ~24h resumption window).
 *  Bypasses the global ALERTS_MUTED on purpose: it is the ONE feed the operator turned on. Carries only
 *  outflow (withdrawal) content, never oracle. Batched one message per cycle by the caller to stay well
 *  under Telegram rate limits. Channel: WITHDRAWAL_CHAT_ID → OPERATOR_CHAT_ID → TELEGRAM_CHAT_ID. */
/** Security alert → operator DM (SECURITY_CHAT_ID → OPERATOR_CHAT_ID → TELEGRAM_CHAT_ID). Bypasses the global
 *  mute on purpose: it is the explicitly-enabled security channel. Used ONLY for rare, genuine danger signals
 *  (over-withdrawal, conservation drift, governance change, phantom position) — never for routine flow, so it
 *  cannot spam. Carries an identical-content backstop like the withdrawal feed. */
// Deliver `text` to ONE Telegram bot/chat with retry+backoff. Returns true on confirmed delivery, false otherwise.
async function tgSend(tok, chat, text, tries = 4) {
  if (!tok || !chat) return false;
  const url = `https://api.telegram.org/bot${tok}/sendMessage`, body = { chat_id: chat, text, disable_web_page_preview: true };
  for (let a = 0; a < tries; a++) { if (await post(url, body)) return true; await new Promise((r) => setTimeout(r, 1500 * (a + 1))); }
  return false;
}
// Deliver to a generic alert webhook (works for Discord `content`, Slack `text`, or any custom endpoint / SMS-email
// relay). Independent of Telegram — this is the channel that reaches you if Telegram is down or the token is pulled.
async function webhookSend(url, text, sev, tries = 3) {
  if (!url) return false;
  const body = { content: text, text, source: "flash-flow-sentinel", severity: sev || "critical", ts: Date.now() };
  for (let a = 0; a < tries; a++) { if (await post(url, body)) return true; await new Promise((r) => setTimeout(r, 1200 * (a + 1))); }
  return false;
}

const _recentSecText = new Map();
async function sendSecurityAlert(text) {
  // EVERY alarm routes here → the operator's PRIVATE channels ONLY. It NEVER falls back to the public/main channel.
  // REDUNDANCY (#3): the same alarm fans out to every configured INDEPENDENT channel in parallel —
  //   • primary Telegram bot → OPERATOR_CHAT_ID / SECURITY_CHAT_ID   (as before)
  //   • ALERT_WEBHOOK_URL     → Discord/custom/SMS-relay              (survives a full Telegram outage)
  //   • ALERT_TG_BACKUP_TOKEN → a SECOND Telegram bot                 (survives the primary token being revoked)
  // Delivery is confirmed if ANY ONE channel lands — so the un-missable latch releases only when you're actually
  // reachable, and a single dead channel can neither block delivery nor suppress the retry. Zero regression: with
  // no backup configured it behaves exactly as before (primary Telegram only).
  const tok = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.OPERATOR_CHAT_ID || process.env.SECURITY_CHAT_ID;
  const webhook = process.env.ALERT_WEBHOOK_URL;
  const bkTok = process.env.ALERT_TG_BACKUP_TOKEN, bkChat = process.env.ALERT_TG_BACKUP_CHAT || chat;
  if ((!tok || !chat) && !webhook && !bkTok) { if (tok) console.error("[sentinel] ALARM NOT SENT — no private channel set (OPERATOR_CHAT_ID / ALERT_WEBHOOK_URL):", text.split("\n").slice(0, 2).join(" / ")); return null; }
  const nowMs = Date.now();
  for (const [k, ts] of _recentSecText) if (nowMs - ts > 300000) _recentSecText.delete(k);
  if (_recentSecText.has(text)) return null; // don't repeat the SAME already-DELIVERED alert within 5 min
  // fan out to every independent channel at once — each fully isolated so one channel's failure can't affect another
  const [tg, wh, bk] = await Promise.all([
    tgSend(tok, chat, text).catch(() => false),
    webhookSend(webhook, text, "critical").catch(() => false),
    (bkTok ? tgSend(bkTok, bkChat, text) : Promise.resolve(false)).catch(() => false),
  ]);
  const landed = [tg && "telegram", wh && "webhook", bk && "telegram-backup"].filter(Boolean);
  if (landed.length) { _recentSecText.set(text, Date.now()); return { ok: true, channels: landed }; } // delivered on ≥1 channel → latch
  console.error("[sentinel] CRITICAL: security alert delivery FAILED on ALL channels —", text.split("\n").slice(0, 2).join(" / "));
  return null; // nothing landed → do NOT latch → caller re-fires next cycle (un-missable)
}

const _recentWText = new Map(); // exact message text → timestamp, for the idempotency backstop
function sendWithdrawalNotice(text) {
  // MAIN channel by default (the Flash Flow Sentinel public channel) — this feed is meant for the team/public,
  // not the private operator DM. Override with WITHDRAWAL_CHAT_ID if a different destination is ever wanted.
  const tok = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.WITHDRAWAL_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
  if (!tok || !chat) return Promise.resolve(null);
  // IDEMPOTENCY BACKSTOP: never post byte-identical content twice within 2 minutes. Each withdrawal message
  // carries its unique solscan link(s), so identical text can only mean an accidental re-send — drop it. This
  // is a belt-and-suspenders layer on top of the persisted sig:custody dedup; it costs nothing and can only
  // ever suppress a true duplicate.
  const nowMs = Date.now();
  for (const [k, ts] of _recentWText) if (nowMs - ts > 120000) _recentWText.delete(k);
  if (_recentWText.has(text)) return Promise.resolve(null);
  _recentWText.set(text, nowMs);
  return post(`https://api.telegram.org/bot${tok}/sendMessage`, { chat_id: chat, text, disable_web_page_preview: true });
}

/** Send an OPS message to the operator's PRIVATE DM only (infra health: downtime, degraded cycles). Never the
 *  public channel — if no private chat is set it is simply not sent. */
function sendOperator(text) {
  if (MUTED()) return Promise.resolve();
  const tok = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.OPERATOR_CHAT_ID || process.env.SECURITY_CHAT_ID;
  if (!tok || !chat) return Promise.resolve();
  return post(`https://api.telegram.org/bot${tok}/sendMessage`, { chat_id: chat, text, disable_web_page_preview: true });
}

// LIVE STATUS — ONE message in the operator's PRIVATE DM, EDITED in place every interval. Telegram does NOT
// re-notify on an edit, so the operator sees a single always-current status line, never a flood. Returns the
// message_id to reuse. If the edit fails (message deleted / too old), it posts a fresh one and returns its id.
// Private-only (OPERATOR_CHAT_ID / SECURITY_CHAT_ID) — never the public channel. Bypasses mute (explicit channel).
async function sendOrEditLiveStatus(text, msgId) {
  const tok = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.OPERATOR_CHAT_ID || process.env.SECURITY_CHAT_ID;
  if (!tok || !chat) return null;
  if (msgId) {
    const r = await post(`https://api.telegram.org/bot${tok}/editMessageText`, { chat_id: chat, message_id: msgId, text, disable_web_page_preview: true });
    if (r) return msgId; // edited in place — no new notification
    // edit failed (deleted / too old / identical) → fall through to a fresh post
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }), signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    return j && j.ok && j.result ? j.result.message_id : null;
  } catch (e) { return null; }
}

function channelsConfigured() {
  const operator = !!(process.env.TELEGRAM_BOT_TOKEN && (process.env.OPERATOR_CHAT_ID || process.env.SECURITY_CHAT_ID));
  const alertWebhook = !!process.env.ALERT_WEBHOOK_URL;
  const backupTelegram = !!process.env.ALERT_TG_BACKUP_TOKEN;
  return {
    telegram: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
    // The PRIVATE alarm channel — required for any proven alarm to be delivered (alarms never fall back to main).
    operator,
    // REDUNDANCY (#3): independent second/third alarm paths that survive a Telegram outage or token revocation.
    alertWebhook, backupTelegram,
    // count of INDEPENDENT private alarm channels — 1 = single point of failure; ≥2 = redundant delivery.
    alarmChannels: (operator ? 1 : 0) + (alertWebhook ? 1 : 0) + (backupTelegram ? 1 : 0),
    slack: !!process.env.SLACK_WEBHOOK_URL,
    heartbeat: !!process.env.HEARTBEAT_URL,
  };
}

module.exports = { deliverAlert, heartbeat, sendTelegram, sendOperator, sendSecurityAlert, sendWithdrawalNotice, sendOrEditLiveStatus, sendPhoto, chartUrlForAlert, channelsConfigured };
