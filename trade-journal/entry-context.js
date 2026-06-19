"use strict";
// entry-context.js — capture DETERMINISTE du contexte d'analyse au moment d'un trade.
// Comble le trou de tracabilite G8 (audit 18.06) : un trade doit etre reconstructible
// (quel scan, quelle posture marche, quels candidats concurrents, quelles options) SANS
// dependre de la memoire du LLM ni des logs texte qui pourrissent. Lu depuis scan-latest.json
// (deja sur disque, ecrit par scan.js) -> aucun cout, aucun appel reseau.
// ADDITIF/PUR : ne change RIEN au trade ; ajoute un champ `entry_context` optionnel.

const fs = require("fs");
const path = require("path");

function baseSym(s) {
  return String(s || "").replace(/\/.*$/, "").replace(/USDT.*$/, "").toUpperCase();
}

// buildEntryContext(trade, scanData) -> snapshot compact. PUR (aucune IO).
function buildEntryContext(trade, scanData) {
  if (!scanData || !scanData.market) {
    return { scan_ts: null, note: "scan-latest absent ou invalide -> contexte non capture" };
  }
  const m = scanData.market;
  const bw = m.bottom_watch || {};
  const sym = baseSym(trade && trade.symbol);
  const opps = Array.isArray(scanData.opportunities) ? scanData.opportunities : [];
  const all = Array.isArray(scanData.all) ? scanData.all : [];
  const thisPair = opps.find((o) => baseSym(o.pair) === sym) || all.find((r) => baseSym(r.pair) === sym) || null;

  const compactPair = (o) => o ? {
    pair: o.pair, setup: o.setup, side: o.side, score: o.score,
    regime_fit: o.regime_fit && (o.regime_fit.fit != null ? o.regime_fit.fit : o.regime_fit),
    divergence: o.divergence != null ? o.divergence : null,
    cycle: o.cycle ? { range_pos: o.cycle.range_pos, at_cycle_low: o.cycle.at_cycle_low } : null,
    beta: o.beta ? o.beta.vs_btc : null,
  } : null;

  const top3 = opps.slice()
    .sort((a, b) => Math.abs(b.score || 0) - Math.abs(a.score || 0))
    .slice(0, 3)
    .map((o) => ({ pair: o.pair, setup: o.setup, side: o.side, score: o.score }));

  const opt = m.options || {};
  const compactOpt = (x) => x ? { max_pain: x.max_pain, call_wall: x.call_wall, put_wall: x.put_wall, gamma_regime: x.gamma_regime } : null;

  return {
    scan_ts: scanData.ts || null,
    captured_ts: new Date().toISOString(),
    market: {
      regime: m.regime,
      btc_daily_adx: m.btc_daily_adx,
      posture: m.posture && (m.posture.stance != null ? m.posture.stance : m.posture),
      dispersion: m.dispersion && (m.dispersion.regime != null ? m.dispersion.regime : m.dispersion),
      fear_greed: m.fear_greed ? { value: m.fear_greed.value, label: m.fear_greed.label } : null,
      relief_rally: !!(bw.relief_rally && bw.relief_rally.active),
      alt_capitulation: !!bw.alt_capitulation,
      bottom_confirmed: !!bw.bottom_confirmed,
    },
    this_pair: compactPair(thisPair),
    top3,
    options: { btc: compactOpt(opt.btc), eth: compactOpt(opt.eth) },
    zones_source: (trade && trade.zones) || null,
  };
}

// loadEntryContext(trade, dir) -> lit scan-latest.json best-effort + build. NE THROW JAMAIS.
function loadEntryContext(trade, dir) {
  try {
    const p = path.join(dir || __dirname, "scan-latest.json");
    if (!fs.existsSync(p)) return { scan_ts: null, note: "scan-latest.json absent" };
    const scanData = JSON.parse(fs.readFileSync(p, "utf8"));
    return buildEntryContext(trade, scanData);
  } catch (e) {
    return { scan_ts: null, note: "entry-context erreur: " + (e && e.message) };
  }
}

// zonesFallbackRate(trades, days) -> mesure le taux reel de zones=screener_fallback (G2 audit
// 18.06 : TV Desktop debranche en prod -> on quantifie). PUR. Ne compte que les trades RECENTS
// (open/pending/closed) portant un champ `zones`. rate = part qui n'a PAS lu Desktop.
function zonesFallbackRate(trades, days) {
  const d = days || 7;
  const cutoff = Date.now() - d * 86400000;
  const rel = (Array.isArray(trades) ? trades : []).filter((t) => {
    if (!t || typeof t.zones !== "string") return false;
    const ts = Date.parse(t.ts_open || "");
    return !isNaN(ts) && ts >= cutoff;
  });
  const fallback = rel.filter((t) => /screener_fallback/i.test(t.zones)).length;
  const n = rel.length;
  return { n, fallback, desktop: n - fallback, rate: n ? +(fallback / n).toFixed(2) : null, days: d };
}

module.exports = { buildEntryContext, loadEntryContext, baseSym, zonesFallbackRate };
