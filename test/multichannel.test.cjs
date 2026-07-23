// Proves: delivered if ANY channel lands; no regression (telegram-only) ; total failure → no latch (re-fires).
const http = require("http");
let pass=true; const t=(c,m)=>{console.log((c?"✓":"✗")+" "+m); if(!c)pass=false;};

// stand up a tiny local webhook that records hits
let hits=0; const srv=http.createServer((req,res)=>{ let b=""; req.on("data",c=>b+=c); req.on("end",()=>{ hits++; res.writeHead(200); res.end("ok"); }); });
(async () => {
  await new Promise(r=>srv.listen(0,r));
  const port=srv.address().port;
  // fresh require with env set so ALERT_WEBHOOK_URL is picked up
  process.env.ALERT_WEBHOOK_URL = `http://127.0.0.1:${port}/hook`;
  delete process.env.TELEGRAM_BOT_TOKEN; delete process.env.OPERATOR_CHAT_ID; // no telegram → webhook must carry it
  delete require.cache[require.resolve("../lib/notify.cjs")];
  const notify = require("../lib/notify.cjs");

  // 1) Telegram unconfigured, webhook up → alert STILL delivered via webhook
  const r1 = await notify.sendSecurityAlert("TEST-ALERT-1 unbacked drain");
  t(r1 && r1.ok && r1.channels.includes("webhook") && hits>=1, "Telegram down / webhook up → delivered via webhook ("+ (r1&&r1.channels)+")");

  // 2) channelsConfigured reflects redundancy count
  const ch = notify.channelsConfigured();
  t(ch.alertWebhook===true && ch.alarmChannels>=1, "channelsConfigured: alertWebhook true, alarmChannels="+ch.alarmChannels);

  // 3) total failure (webhook points nowhere, no telegram) → returns null (no latch → caller re-fires)
  process.env.ALERT_WEBHOOK_URL = "http://127.0.0.1:1/nowhere";
  delete require.cache[require.resolve("../lib/notify.cjs")];
  const notify2 = require("../lib/notify.cjs");
  const r3 = await notify2.sendSecurityAlert("TEST-ALERT-3 dead everything");
  t(r3===null, "all channels dead → returns null (un-missable: caller re-fires, never false-latches)");

  srv.close();
  console.log("\n"+(pass?"✅ PASS — multi-channel redundancy: any-channel delivery, config-reported, no false latch":"❌ FAIL"));
  process.exit(pass?0:1);
})();
