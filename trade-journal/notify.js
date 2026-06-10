"use strict";

// Notifier Telegram pour l'agent trader — appelé par les routines sur
// trade / cancel / circuit-breaker. No-op gracieux si non configuré.
//
// Config (config/.env) : TELEGRAM_BOT_TOKEN_ROUTINE (ou _HYPERLIQUID) + TELEGRAM_CHAT_ID
// Usage : node trade-journal/notify.js "message markdown"

const https = require("https");
const path = require("path");
require(path.join(__dirname, "..", "skills", "bybit", "index.js")); // déclenche le chargement .env

const TOKEN = process.env.TELEGRAM_BOT_TOKEN_ROUTINE || process.env.TELEGRAM_BOT_TOKEN_HYPERLIQUID || "";
const CHAT = process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID || "";

// Une tentative d'envoi (timeout 8s -> jamais bloquant). Resout true/false.
function sendOnce(text) {
  return new Promise((resolve) => {
    const data = JSON.stringify({ chat_id: CHAT, text, parse_mode: "Markdown", disable_web_page_preview: true });
    const req = https.request({
      hostname: "api.telegram.org", path: `/bot${TOKEN}/sendMessage`, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
    }, (res) => { let b = ""; res.on("data", (c) => (b += c)).on("end", () => resolve(res.statusCode === 200)); });
    req.on("error", () => resolve(false));
    req.setTimeout(8000, () => { req.destroy(); resolve(false); }); // pas de hang
    req.write(data); req.end();
  });
}

// Envoi avec RETRY (3 tentatives, backoff) — un blip réseau transitoire ne doit PAS
// perdre une notification (le dead-man/digest en dépendent). Constaté : routine 02:07
// a eu un echec notify transitoire (token OK, reseau). Robustesse ajoutee 09.06.
async function send(text, retries = 2) {
  if (!TOKEN || !CHAT) { console.log("(telegram non configuré — skip)"); return false; }
  for (let i = 0; i <= retries; i++) {
    if (await sendOnce(text)) return true;
    if (i < retries) await new Promise((r) => setTimeout(r, 800 * (i + 1))); // 0.8s, 1.6s
  }
  return false;
}

if (require.main === module) {
  const msg = process.argv.slice(2).join(" ") || "🤖 test agent-trader";
  send(msg).then((ok) => { console.log(ok ? "envoyé" : "non envoyé"); process.exit(ok ? 0 : 1); });
}
module.exports = send;
