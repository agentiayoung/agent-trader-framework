"use strict";

// ============================================================================
// tv-preflight.js — Sonde l'etat de TradingView Desktop AVANT une routine.
// ----------------------------------------------------------------------------
// Interroge le Chrome DevTools Protocol (CDP) sur 127.0.0.1:9222 SANS passer par
// le MCP. Renvoie un JSON exploitable par l'agent pour decider :
//   - ready=true  -> CDP up : l'agent peut lire les indicateurs/zones Desktop.
//   - charts=[]   -> CDP up mais AUCUN chart ouvert (page "Nouvel onglet") ->
//                    l'agent doit ouvrir un onglet chart (tab_new) avant de lire.
//   - ready=false -> CDP down : lancer le watchdog (cote session user) ou
//                    basculer en fallback screener.
//
// Usage : node scripts/tv-preflight.js
// Codes sortie : 0 = CDP up, 2 = CDP up mais pas de chart, 1 = CDP down.
// ============================================================================

const http = require("http");

const PORT = process.env.TV_CDP_PORT || 9222;
const HOST = "127.0.0.1";

function getJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: HOST, port: PORT, path, timeout: 3000 }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => {
        try { resolve(JSON.parse(b)); } catch (e) { reject(new Error("parse: " + e.message)); }
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", (e) => reject(e));
  });
}

(async () => {
  const out = { ready: false, cdp_port: Number(PORT), charts: [], targets: 0, version: null, hint: "" };
  try {
    const ver = await getJson("/json/version");
    out.ready = true;
    out.version = (ver && (ver.Browser || ver.product)) || "unknown";
  } catch (e) {
    out.hint = "CDP injoignable (TV pas lance en debug). Lancer scripts/tv-cdp-watchdog.ps1 cote session user, ou fallback screener.";
    console.log(JSON.stringify(out, null, 2));
    process.exit(1);
  }

  // CDP up -> lister les cibles pour reperer les charts ouverts
  try {
    const list = await getJson("/json/list");
    const pages = Array.isArray(list) ? list.filter((t) => t.type === "page") : [];
    out.targets = pages.length;
    // Detection chart best-effort. Les fenetres-shell de l'app TradingView
    // (tabbed-window, main-menu, new-tab, bare index.html) ne sont PAS des charts.
    // /!\ Source AUTORITAIRE pour "chart ouvert" = MCP tab_list (tab_count) cote
    // agent ; cette heuristique sert juste de signal indicatif.
    const SHELL = ["tabbed-window", "main-menu", "new-tab", "nouvel onglet", "titlebaroptions"];
    out.charts = pages
      .filter((t) => {
        const blob = ((t.url || "") + " " + (t.title || "")).toLowerCase();
        if (SHELL.some((s) => blob.includes(s))) return false;
        // bare launcher "index.html" sans symbole = shell
        if (/\/index\.html$/.test((t.url || "")) && !blob.includes("symbol")) return false;
        return blob.includes("chart") || blob.includes("symbol");
      })
      .map((t) => ({ title: (t.title || "").slice(0, 60), url: (t.url || "").slice(0, 80) }));
  } catch (e) {
    out.hint = "CDP up mais /json/list illisible: " + e.message;
  }

  if (out.charts.length === 0) {
    out.hint = "CDP up mais aucun chart exploitable (page launcher). L'agent doit ouvrir un onglet chart (tab_new) puis chart_set_symbol avant de lire les indicateurs.";
    console.log(JSON.stringify(out, null, 2));
    process.exit(2);
  }

  out.hint = "OK: CDP up + chart(s) ouvert(s). Lecture indicateurs/zones Desktop possible.";
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
})();
