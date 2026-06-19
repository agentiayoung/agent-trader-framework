"use strict";
// risk-verify.js (16.06 — data-quality) — RISQUE GEOMETRIQUE REEL d'un trade arme.
// Probleme (bug DOGE 16.06) : risk_usd logge = le BUDGET (equity x size_pct), mais la geometrie
// reelle de la position (size x |entry - SL|) pouvait diverger (3.6x) -> R-multiple = pnl/risk_usd
// FAUSSE (DOGE -4.35R au lieu de -1.12R). En DEMO on trade activement pour optimiser l'infra : la
// DATA doit etre propre. Ce module derive le risque REEL et signale toute divergence.
// 100% PUR (teste offline).

// Risque geometrique d'une position simple = taille x distance au SL (en USD, perp lineaire).
function geomRisk(trade) {
  const entry = Number(
    trade.entry_actual != null ? trade.entry_actual
      : trade.avg_entry != null ? trade.avg_entry
        : trade.entry_planned != null ? trade.entry_planned
          : trade.entry
  );
  const sl = Number(trade.stop_loss);
  const size = Number(trade.size);
  if (!(entry > 0) || !(sl > 0) || !(size > 0)) return null;
  const dist = Math.abs(entry - sl);
  if (!(dist > 0)) return null;
  return +(size * dist).toFixed(4);
}

// verifyTradeRisk : compare le risque geometrique reel au risk_usd logge (budget).
// tol = divergence relative toleree (defaut 0.25 = 25%).
// Retourne { geom_risk, budget, factor, diverged, authoritative, reason }.
// - laddered : on NE recalcule PAS (risk_usd = somme des rungs, size = position totale -> geomRisk
//   d'un seul entry/SL n'est pas representatif). On reporte sans override.
function verifyTradeRisk(trade, tol) {
  const t = tol != null ? Number(tol) : 0.25;
  const g = geomRisk(trade);
  const budget = Number(trade.risk_usd);
  const laddered = trade.entry_mode === "laddered";
  if (g == null) {
    return { geom_risk: null, budget: isFinite(budget) ? budget : null, factor: null, diverged: false, authoritative: isFinite(budget) ? budget : null, reason: "geometrie incalculable (entry/SL/size manquant)" };
  }
  if (!(budget > 0)) {
    // pas de budget logge -> la geometrie EST la verite.
    return { geom_risk: g, budget: null, factor: null, diverged: false, authoritative: g, reason: "risk_usd absent -> risque geometrique fait foi" };
  }
  const factor = +(g / budget).toFixed(3);
  const diverged = !laddered && Math.abs(factor - 1) > t;
  return {
    geom_risk: g,
    budget,
    factor,
    diverged,
    // authoritative = la valeur a utiliser pour le R-multiple. Pour un trade simple divergent,
    // la GEOMETRIE reelle fait foi (c'est le vrai risque pris). Laddered -> on garde le budget.
    authoritative: laddered ? budget : (diverged ? g : budget),
    reason: laddered
      ? "laddered -> budget conserve (risk_usd = somme rungs)"
      : diverged
        ? `divergence sizing x${factor} (geom ${g} vs budget ${budget}) -> geometrie fait foi`
        : "sizing coherent",
  };
}

module.exports = { geomRisk, verifyTradeRisk };
