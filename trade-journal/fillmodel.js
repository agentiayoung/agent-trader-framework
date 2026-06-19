"use strict";
// ═══════════════════════════════════════════════════════════════════
// fillmodel.js — modele de remplissage d'ordres LIMIT maker (#2 fondation, approved 16.06).
//
// PUR, deterministe, testable offline. Supprime le biais "prix touche = ordre rempli" du backtest
// (critique par la microstructure : queue position + adverse selection). Reponse a B4/B6/O1.
//
// Usage (a l'integration opt-in dans optimize.js, etape suivante) : pour une entree LIMIT a distance
// dATR du prix de placement, P(fill)=exp(-k*dATR) -> tirage Bernoulli seede ; non-fill = trade MANQUE
// (pas compte). Fill maker -> frais maker (~1/3 du taker, avantage B1) - haircut d'adverse selection.
// ═══════════════════════════════════════════════════════════════════

// fillProbability : proba de remplissage d'un limit maker en fonction de la distance en ATR au prix
// de placement. Decroissance exponentielle (microstructure : la proba de fill chute vite avec la
// profondeur). k calibrable par paire ; defaut generique conservateur (P~0.30 a 1xATR).
function fillProbability(dATR, k = 1.2) {
  const d = Math.abs(Number(dATR) || 0);
  const p = Math.exp(-k * d);
  return p > 1 ? 1 : (p < 0 ? 0 : p);
}

// Frais round-trip en R (= 2*fee*entry/risk). Maker << taker (l'avantage de l'entree LIMIT, B1).
function takerFeeR(entry, risk, fee = 0.00055) { return risk ? (2 * fee * entry) / risk : 0; }
function makerFeeR(entry, risk, fee = 0.0002) { return risk ? (2 * fee * entry) / risk : 0; }

// Tirage Bernoulli seede (rng = mulberry32 reproductible) : true = ordre rempli.
function bernoulli(p, rng) { return rng() < p; }

// Haircut d'adverse selection (en R) : placeholder calibrable (rapport : via difference MAE/MFE
// limit-vs-market). Defaut 0 tant que non calibre sur donnees Bybit reelles.
function adverseHaircutR(h = 0) { return h; }

module.exports = { fillProbability, takerFeeR, makerFeeR, bernoulli, adverseHaircutR };
