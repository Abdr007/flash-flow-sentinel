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
  const tok = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!tok || !chat || !photoUrl) return Promise.resolve(null);
  return post(`https://api.telegram.org/bot${tok}/sendPhoto`, { chat_id: chat, photo: photoUrl, caption: (caption || "").slice(0, 1024) });
}

/** Deliver one alert to all channels. `a` = { time, rule, from, to, detail, severity? }. */
function deliverAlert(a, cfg) {
  const sev = a.severity || (a.to === "breach" ? "breach" : a.to === "warn" ? "warn" : a.to === "ok" ? "ok" : "high");
  const emoji = SEV_EMOJI[sev] || "🔔";
  const line = `${emoji} FLASH FLOW SENTINEL — ${sev.toUpperCase()}\nrule: ${a.rule}\n${a.detail}`;

  if (cfg.webhookUrl) post(cfg.webhookUrl, { source: "flash-flow-sentinel", ...a });

  const tgTok = process.env.TELEGRAM_BOT_TOKEN, tgChat = process.env.TELEGRAM_CHAT_ID;
  if (tgTok && tgChat) {
    // On a WARN/BREACH transition, lead with the token chart image (caption carries the alert text);
    // a token:<Pool/SYMBOL> alert shows that token's own flow, anything else shows all vaults. On a
    // resolve (→ok) or when no chart could be built, just send the text so we never double-post images.
    const wantsChart = (a.to === "warn" || a.to === "breach") && Array.isArray(cfg.tokens) && cfg.tokens.length;
    const sendText = () => post(`https://api.telegram.org/bot${tgTok}/sendMessage`, { chat_id: tgChat, text: line, disable_web_page_preview: true });
    if (wantsChart) {
      chartUrlForAlert(a, cfg.tokens)
        .then((url) => (url ? sendPhoto(url, line) : null))
        // if no chart, or the photo send failed (Telegram rejected the URL/image), fall back to text —
        // the alert must never be silently lost. Retry text once if it also fails.
        .then((ok) => (ok ? null : sendText()))
        .then((ok) => (ok ? null : sendText()))
        .catch(() => sendText());
    } else {
      post(`https://api.telegram.org/bot${tgTok}/sendMessage`, { chat_id: tgChat, text: line, disable_web_page_preview: true });
    }
  }

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
  const tok = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!tok || !chat) return Promise.resolve();
  return post(`https://api.telegram.org/bot${tok}/sendMessage`, { chat_id: chat, text, disable_web_page_preview: true });
}

/** Send an OPS message to the operator's private DM (infra health: downtime, degraded cycles).
 *  Falls back to the public chat only if no operator chat is configured. */
function sendOperator(text) {
  const tok = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.OPERATOR_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
  if (!tok || !chat) return Promise.resolve();
  return post(`https://api.telegram.org/bot${tok}/sendMessage`, { chat_id: chat, text, disable_web_page_preview: true });
}

function channelsConfigured() {
  return {
    telegram: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
    slack: !!process.env.SLACK_WEBHOOK_URL,
    heartbeat: !!process.env.HEARTBEAT_URL,
  };
}

module.exports = { deliverAlert, heartbeat, sendTelegram, sendOperator, sendPhoto, chartUrlForAlert, channelsConfigured };
