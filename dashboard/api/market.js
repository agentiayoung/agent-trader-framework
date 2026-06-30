"use strict";
// ═══════════════════════════════════════════════════════════════════
// dashboard/api/market.js — Agrégateur PUR du contexte marché live.
//
// Digère `scan-latest.json` (.market) en un objet plat prêt à afficher :
// régime/ADX, posture, dispersion/corrélation, Fear&Greed, bottom-watch.
// LECTURE SEULE. Aucune logique de trading dupliquée. Dégradation gracieuse
// (source manquante -> { stale:true }, jamais d'exception).
// ═══════════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");

// Fonction PURE : prend l'objet scan-latest (ou null), renvoie le résumé marché.
function buildMarket(scan) {
  const m = scan && scan.market;
  if (!m) return { stale: true, reason: "scan-latest.market absent" };

  const fg = m.fear_greed || null;
  const bw = m.bottom_watch || null;

  return {
    stale: false,
    ts: scan.ts || null,
    scanned: scan.scanned != null ? scan.scanned : null,
    regime: m.regime || null,
    // l'agent 4h expose btc_daily_adx ; le scalp expose btc_htf_adx -> accepter les deux.
    btc_daily_adx: m.btc_daily_adx != null ? m.btc_daily_adx : (m.btc_htf_adx != null ? m.btc_htf_adx : null),
    posture: m.posture
      ? { stance: m.posture.stance || null, reasons: m.posture.reasons || [], note: m.posture.note || null }
      : null,
    dispersion: m.dispersion
      ? {
          mean_corr: m.dispersion.mean_corr != null ? m.dispersion.mean_corr : null,
          n_decoupled: m.dispersion.n_decoupled != null ? m.dispersion.n_decoupled : null,
          n_pairs: m.dispersion.n_pairs != null ? m.dispersion.n_pairs : null,
          regime: m.dispersion.regime || null,
          hedge_enabled: !!m.dispersion.hedge_enabled,
          note: m.dispersion.note || null,
        }
      : null,
    fear_greed: fg
      ? {
          value: fg.value != null ? fg.value : null,
          label: fg.label || null,
          yesterday: fg.yesterday != null ? fg.yesterday : null,
          delta: fg.value != null && fg.yesterday != null ? fg.value - fg.yesterday : null,
        }
      : null,
    bottom_watch: bw
      ? {
          pairs_at_cycle_low: bw.pairs_at_cycle_low != null ? bw.pairs_at_cycle_low : null,
          at_cycle_low_pairs: bw.at_cycle_low_pairs || [],
          bull_div_at_low: bw.bull_div_at_low || [],
          bull_div_any: bw.bull_div_any || [],
          reclaim_ema50d: bw.reclaim_ema50d != null ? bw.reclaim_ema50d : null,
          reclaim_pairs: bw.reclaim_pairs || [],
          reclaim_ema200d: bw.reclaim_ema200d != null ? bw.reclaim_ema200d : null,
          decoupled_from_btc: bw.decoupled_from_btc || [],
          btc_range_pos: bw.btc_range_pos != null ? bw.btc_range_pos : null,
          fear_extreme: !!bw.fear_extreme,
          alt_capitulation: !!bw.alt_capitulation,
          bottom_confirmed: !!bw.bottom_confirmed,
          relief_rally_active: !!(bw.relief_rally && bw.relief_rally.active),
        }
      : null,
  };
}

// Lecture réelle (serveur) : prend le scan le plus FRAIS des 2 agents et
// annote la source retenue (transparence : quel agent a fourni la donnée).
function readMarket() {
  const { readFreshestScan } = require("./sources.js");
  const { scan, source } = readFreshestScan();
  const built = buildMarket(scan);
  // La POSTURE n'est calculée QUE par l'agent 4h (le scalp n'a pas ce champ). Si le scan le plus
  // frais (souvent le scalp) ne la porte pas, on la complète depuis le scan AGENT -> sinon la
  // section "Posture & dispersion" du dashboard reste vide (fix 26.06).
  if (!built.posture) {
    try {
      const { resolveDirs } = require("../../trade-journal/portfolio.js");
      const ag = JSON.parse(fs.readFileSync(path.join(resolveDirs().agentDir, "scan-latest.json"), "utf-8"));
      const ap = buildMarket(ag).posture;
      if (ap) { built.posture = ap; built.posture_source = "agent-trader"; }
    } catch (_) { /* best-effort */ }
  }
  return Object.assign(built, { scan_source: source });
}

module.exports = { buildMarket, readMarket };
