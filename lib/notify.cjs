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
const post = (url, body, headers) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...(headers || {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) }).catch(() => {});

const SEV_EMOJI = { critical: "🔴", high: "🟠", breach: "⛔", warn: "⚠️", ok: "✅" };

/** Deliver one alert to all channels. `a` = { time, rule, from, to, detail, severity? }. */
function deliverAlert(a, cfg) {
  const sev = a.severity || (a.to === "breach" ? "breach" : a.to === "warn" ? "warn" : a.to === "ok" ? "ok" : "high");
  const emoji = SEV_EMOJI[sev] || "🔔";
  const line = `${emoji} FLASH FLOW SENTINEL — ${sev.toUpperCase()}\nrule: ${a.rule}\n${a.detail}`;

  if (cfg.webhookUrl) post(cfg.webhookUrl, { source: "flash-flow-sentinel", ...a });

  const tgTok = process.env.TELEGRAM_BOT_TOKEN, tgChat = process.env.TELEGRAM_CHAT_ID;
  if (tgTok && tgChat) post(`https://api.telegram.org/bot${tgTok}/sendMessage`, { chat_id: tgChat, text: line, disable_web_page_preview: true });

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

module.exports = { deliverAlert, heartbeat, sendTelegram, sendOperator, channelsConfigured };
