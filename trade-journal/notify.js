"use strict";

// Notifier Telegram pour l'agent trader — appelé par les routines sur
// trade / cancel / circuit-breaker. No-op gracieux si non configuré.
//
// Config (config/.env) : TELEGRAM_BOT_TOKEN_ROUTINE (ou _HYPERLIQUID) + TELEGRAM_CHAT_ID_HUGO
// Usage : node trade-journal/notify.js "message markdown"

const https = require("https");
const path = require("path");
require(path.join(__dirname, "..", "skills", "bybit", "index.js")); // déclenche le chargement .env

const TOKEN = process.env.TELEGRAM_BOT_TOKEN_ROUTINE || process.env.TELEGRAM_BOT_TOKEN_HYPERLIQUID || "";
const CHAT = process.env.TELEGRAM_CHAT_ID_HUGO || process.env.TELEGRAM_CHAT_ID || "";

// Une tentative d'envoi (timeout 8s -> jamais bloquant). Resout true/false.
// markdown=false -> texte BRUT (pas de parse_mode) : un message technique (paths avec _,
// identifiants comme last_complete, exit(1)...) casse le parser Markdown de Telegram -> HTTP 400
// -> "non envoye". Le texte brut passe TOUJOURS. (Bug racine des alertes perdues 06:07/14:07 du 11.06.)
function sendOnce(text, markdown = true) {
  return new Promise((resolve) => {
    const body = { chat_id: CHAT, text, disable_web_page_preview: true };
    if (markdown) body.parse_mode = "Markdown";
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: "api.telegram.org", path: `/bot${TOKEN}/sendMessage`, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
    }, (res) => { let b = ""; res.on("data", (c) => (b += c)).on("end", () => resolve(res.statusCode === 200)); });
    req.on("error", () => resolve(false));
    req.setTimeout(8000, () => { req.destroy(); resolve(false); }); // pas de hang
    req.write(data); req.end();
  });
}

// Envoi avec RETRY (backoff) PUIS FALLBACK TEXTE BRUT — une notification ne doit JAMAIS se perdre
// (le dead-man/digest/alertes d'incompletude en dependent). Deux modes d'echec couverts :
//  (1) blip reseau transitoire -> retry (constate routine 02:07, token OK) ;
//  (2) Markdown invalide (texte technique : _, *, [, backtick, paths) -> HTTP 400 systematique
//      que le retry ne resout PAS -> on RE-TENTE en texte BRUT (sans parse_mode). Bug 11.06.
async function send(text, retries = 2) {
  if (!TOKEN || !CHAT) { console.log("(telegram non configuré — skip)"); return false; }
  for (const markdown of [true, false]) {            // d'abord Markdown (joli), sinon brut (garanti)
    for (let i = 0; i <= retries; i++) {
      if (await sendOnce(text, markdown)) return true;
      if (i < retries) await new Promise((r) => setTimeout(r, 800 * (i + 1))); // 0.8s, 1.6s
    }
  }
  return false;
}

if (require.main === module) {
  const msg = process.argv.slice(2).join(" ") || "🤖 test agent-trader";
  send(msg).then((ok) => { console.log(ok ? "envoyé" : "non envoyé"); process.exit(ok ? 0 : 1); });
}
module.exports = send;
