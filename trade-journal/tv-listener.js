"use strict";
// ─────────────────────────────────────────────────────────────────────────────
// LISTENER WEBHOOK TRADINGVIEW (couche alert-driven, design 2026-06-29)
//
// PRINCIPE : Pine = trigger de TIMING (alerte sur barstate.isconfirmed = anti-repaint).
// Le listener AUTHENTIFIE (secret partage) + MET EN FILE. Il n'execute JAMAIS d'ordre (demo-only).
// L'agent (entry-radar / monitor) consomme la file et RE-VALIDE l'edge avec les detecteurs node
// valides OOS avant toute action -> le piege look-ahead/repaint reste neutralise.
//
// handleAlert = PUR (testable offline). startListener = serveur http natif, gated TV_ALERTS=1.
// ─────────────────────────────────────────────────────────────────────────────
const http = require("http");
const fs = require("fs");

// handleAlert(body, { secret, seen }) -> { ok, code, record?, duplicate?, reason? }
// body : objet deja parse OU string JSON. Le listener ne fait confiance qu'au secret + au schema.
function handleAlert(body, opts) {
  opts = opts || {};
  const secret = opts.secret;
  const seen = opts.seen instanceof Set ? opts.seen : null;

  let obj = body;
  if (typeof body === "string") {
    try { obj = JSON.parse(body); } catch (e) { return { ok: false, code: 400, reason: "json invalide" }; }
  }
  if (!obj || typeof obj !== "object") return { ok: false, code: 400, reason: "body vide" };

  // AUTH : jamais ouvert si pas de secret configure. Comparaison simple (menace faible : URL+secret obscurs, demo).
  if (!secret || String(obj.secret || "") !== String(secret)) return { ok: false, code: 401, reason: "secret invalide" };

  // SCHEMA
  const symbol = String(obj.symbol || "").trim().toUpperCase();
  const edge = String(obj.edge || "").trim();
  const side = String(obj.side || "").trim().toLowerCase();
  const tf = String(obj.tf || "").trim();
  const kind = String(obj.kind || "entry").trim().toLowerCase();
  if (!symbol || !edge) return { ok: false, code: 400, reason: "symbol/edge requis" };
  if (side && side !== "long" && side !== "short") return { ok: false, code: 400, reason: "side invalide" };
  if (kind !== "entry" && kind !== "exit") return { ok: false, code: 400, reason: "kind invalide" };

  // IDEMPOTENCE : id fourni ou derive (symbol-edge-tf-ts).
  const id = String(obj.id || `${symbol}-${edge}-${tf}-${obj.ts || ""}`);
  if (seen && seen.has(id)) return { ok: true, code: 200, duplicate: true, record: { id } };
  if (seen) seen.add(id);

  // RECORD : le secret n'est JAMAIS propage dans la file.
  const record = {
    id, symbol, edge,
    side: side || null,
    tf: tf || null,
    price: obj.price != null ? Number(obj.price) : null,
    ts: obj.ts || null,
    kind,
    received_at: opts.now || null,
  };
  return { ok: true, code: 200, record };
}

// startListener({ port, secret, queueFile, seen? }) -> http.Server
// Append idempotent du record (une ligne JSON) dans queueFile. DEMO-only : aucune execution d'ordre.
function startListener(cfg) {
  cfg = cfg || {};
  const port = cfg.port || Number(process.env.TV_LISTENER_PORT || 8788);
  const secret = cfg.secret || process.env.TV_WEBHOOK_SECRET;
  const queueFile = cfg.queueFile || (__dirname + "/tv-alerts.jsonl");
  const seen = cfg.seen instanceof Set ? cfg.seen : new Set();

  const server = http.createServer((req, res) => {
    if (req.method !== "POST") { res.writeHead(405); return res.end("method"); }
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on("end", () => {
      const r = handleAlert(raw, { secret, seen, now: new Date().toISOString() });
      if (r.ok && r.record && !r.duplicate) {
        try { fs.appendFileSync(queueFile, JSON.stringify(r.record) + "\n"); }
        catch (e) { res.writeHead(500); return res.end("queue"); }
      }
      res.writeHead(r.code || (r.ok ? 200 : 400));
      res.end(JSON.stringify({ ok: r.ok, duplicate: !!r.duplicate, reason: r.reason || null }));
    });
  });
  server.listen(port, "0.0.0.0", () => console.log(`[tv-listener] ecoute :${port} -> ${queueFile}`));
  return server;
}

// readNewAlerts(queueFile, fromLine) -> { alerts, nextLine }
// Lecteur de file pour le CONSOMMATEUR (entry-radar / monitor) : retourne les records APRES fromLine
// (offset par nb de lignes, persiste cote appelant) + le nouvel offset. Le node re-valide ensuite
// l'edge AVANT toute action. Tolere les lignes corrompues (ignorees). Idempotent par offset.
function readNewAlerts(queueFile, fromLine) {
  const from = Number(fromLine) || 0;
  let lines = [];
  try { lines = fs.readFileSync(queueFile, "utf8").split("\n").filter((l) => l.trim().length); }
  catch (e) { return { alerts: [], nextLine: from }; }
  const alerts = [];
  for (let i = from; i < lines.length; i++) {
    try { alerts.push(JSON.parse(lines[i])); } catch (e) { /* ligne corrompue ignoree */ }
  }
  return { alerts, nextLine: lines.length };
}

module.exports = { handleAlert, startListener, readNewAlerts };

// CLI : node tv-listener.js  (gated TV_ALERTS=1)
if (require.main === module) {
  if (process.env.TV_ALERTS !== "1") { console.error("[tv-listener] TV_ALERTS!=1 -> desactive (gate)"); process.exit(0); }
  if (!process.env.TV_WEBHOOK_SECRET) { console.error("[tv-listener] TV_WEBHOOK_SECRET manquant -> refus de demarrer"); process.exit(1); }
  startListener({});
}
