"use strict";
// ═══════════════════════════════════════════════════════════════════
// dashboard/server.js — Dashboard web LOCAL, LECTURE SEULE, des 2 agents.
//
// Serveur http natif (zéro dépendance). Sert `index.html` + un endpoint
// `/api/portfolio` (= portfolio.dashboardData() : agrégat + métriques + positions
// + courbes equity). AUCUNE capacité d'exécution d'ordre, aucune écriture, aucun
// secret exposé. 127.0.0.1 uniquement. Demo-only.
//
//   node dashboard/server.js   (ou: npm run dashboard)   puis http://127.0.0.1:8787
// ═══════════════════════════════════════════════════════════════════

const http = require("http");
const fs = require("fs");
const path = require("path");
const portfolio = require("../trade-journal/portfolio.js");
const market = require("./api/market.js");
const options = require("./api/options.js");
const freshness = require("./api/freshness.js");
const grid = require("./api/grid.js");
const routines = require("./api/routines.js");
const edges = require("./api/edges.js");
const positions = require("./api/positions.js");
const history = require("./api/history.js");
const reconcile = require("./api/reconcile.js");

const HOST = "127.0.0.1";
const PORT = parseInt(process.env.DASHBOARD_PORT || "8787", 10);
const HTML = path.join(__dirname, "index.html");

// Cache mémoire TTL court : le poll client (15-60s) peut taper plusieurs fois
// la même route ; on évite de re-digérer les fichiers à chaque requête.
const CACHE_TTL = parseInt(process.env.DASHBOARD_CACHE_MS || "5000", 10);
const cache = {};
function cached(key, fn) {
  const now = Date.now();
  const c = cache[key];
  if (c && now - c.t < CACHE_TTL) return c.v;
  const v = fn();
  cache[key] = { t: now, v };
  return v;
}

// Endpoints JSON read-only : name -> producteur. Chacun renvoie un objet
// sérialisable ; une source manquante donne { stale:true } sans planter.
const API = {
  "/api/portfolio": () => portfolio.dashboardData(),
  "/api/market": () => market.readMarket(),
  "/api/options": () => options.readOptions(),
  "/api/grid": () => grid.readGrid(),
  "/api/routines": () => routines.readRoutines(),
  "/api/edges": () => edges.readEdges(),
  "/api/positions": () => positions.readPositions(),
  "/api/history": () => history.readHistory(),
  "/api/reconcile": () => reconcile.readReconcile(),
  "/api/health": () => freshness.readFreshness(),
};

const server = http.createServer((req, res) => {
  // Lecture seule stricte : seules les requêtes GET sont honorées.
  if (req.method !== "GET") { res.writeHead(405).end("read-only"); return; }
  const url = (req.url || "/").split("?")[0];

  if (API[url]) {
    let body;
    try { body = JSON.stringify(cached(url, API[url])); }
    catch (e) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); return; }
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(body);
    return;
  }
  if (url === "/" || url === "/index.html") {
    fs.readFile(HTML, (err, buf) => {
      if (err) { res.writeHead(500).end("index.html introuvable"); return; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(buf);
    });
    return;
  }
  res.writeHead(404).end("not found");
});

// EADDRINUSE : un autre serveur tient deja le port (daemon + bat lances ensemble).
// On sort PROPREMENT (message clair, pas de stack trace) pour ne pas spammer un
// keep-alive en boucle ; exit 0 = "deja servi, rien a faire".
server.on("error", (e) => {
  if (e && e.code === "EADDRINUSE") {
    console.log(`Dashboard deja en cours sur http://${HOST}:${PORT} -- rien a faire.`);
    process.exit(0);
  }
  console.error("Dashboard server error:", e && e.message ? e.message : e);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`Portfolio dashboard (read-only, demo) -> http://${HOST}:${PORT}`);
});
