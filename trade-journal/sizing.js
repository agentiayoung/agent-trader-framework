"use strict";
// ═══════════════════════════════════════════════════════════════════
// sizing.js — taille par risque AVEC clamp de levier/notional.
//
// PUR : aucune I/O, déterministe (testable offline). `journal.js size` assemble
// l'equity (Bybit) et appelle computeSize.
//
// Principe : le RISQUE par trade reste la cible (5% A / 2.5% B) — la formule
// `size = (equity*risk%)/|entry-SL|` est inchangée sur les SL normaux. MAIS un SL
// TRÈS serré fait exploser le notional -> levier 10-20x silencieux (risque de
// liquidation AVANT le SL sur un vrai compte). Le clamp plafonne le levier
// (RM_MAX_LEVERAGE) : sur ce cas dégénéré, la taille est réduite (le trade risque
// alors MOINS que la cible, jamais plus). Active le garde-fou RM_MAX_LEVERAGE
// (qui était du config mort, lu nulle part). Ne change RIEN aux SL raisonnables.
// ═══════════════════════════════════════════════════════════════════

// computeSize({ equity, entry, sl, riskPct, maxLeverage, maxNotionalUsd })
//  -> { size, notional, leverage, risk_usd, risk_pct_target, risk_pct_effective,
//       sl_distance, clamped, reasons }
function computeSize(p) {
  const equity = Number(p.equity) || 0;
  const entry = Number(p.entry);
  const sl = Number(p.sl);
  const riskPct = Number(p.riskPct) || 0;
  const maxLeverage = p.maxLeverage != null ? Number(p.maxLeverage) : 0;   // 0 = pas de cap
  const maxNotionalUsd = p.maxNotionalUsd != null ? Number(p.maxNotionalUsd) : 0; // 0 = pas de cap

  const dist = Math.abs(entry - sl);
  const riskUsd = (equity * riskPct) / 100;
  let size = dist > 0 && isFinite(entry) ? riskUsd / dist : 0;
  let notional = size * entry;
  const reasons = [];
  let clamped = false;

  // Cap de LEVIER : notional <= maxLeverage * equity. Garde le risque% sur SL normaux.
  if (maxLeverage > 0 && entry > 0 && notional > maxLeverage * equity) {
    size = (maxLeverage * equity) / entry;
    notional = size * entry;
    clamped = true;
    reasons.push(`levier plafonné à ${maxLeverage}x (SL serré -> taille réduite, risque < cible)`);
  }
  // Cap NOTIONAL absolu (optionnel).
  if (maxNotionalUsd > 0 && entry > 0 && notional > maxNotionalUsd) {
    size = maxNotionalUsd / entry;
    notional = size * entry;
    clamped = true;
    reasons.push(`notional plafonné à ${maxNotionalUsd} USDT`);
  }

  const riskUsdEff = size * dist;
  const leverage = equity > 0 ? notional / equity : 0;
  const riskPctEff = equity > 0 ? (riskUsdEff / equity) * 100 : 0;

  return {
    size: +size.toFixed(6),
    notional: +notional.toFixed(2),
    leverage: +leverage.toFixed(2),
    risk_usd: +riskUsdEff.toFixed(2),
    risk_pct_target: riskPct,
    risk_pct_effective: +riskPctEff.toFixed(2),
    sl_distance: +dist.toFixed(6),
    clamped,
    reasons,
  };
}

// ── Sizing par EDGE (Kelly-lite) ─────────────────────────────────────
// Facteur d'échelle du risque% selon l'edge NET du setup (multiplicateur scan.js).
// ref = edge "pleine taille" (1.2 = MR8) ; au-dessus -> capé à 1 (garde le 5% max) ;
// en-dessous (marginaux MR4 0.8 / S1 1.0 / S3 0.6) -> RÉDUIT. floor = plancher.
// Principe : risquer PLEIN sur les edges forts (S5/MR8), MOINS sur les minces. Strictement
// plus conservateur (ne dépasse jamais le risque de base) -> meilleur rendement ajusté au risque.
function edgeScale(edge, ref = 1.2, floor = 0.4) {
  if (edge == null || !isFinite(edge)) return 1;
  return +Math.max(floor, Math.min(1, edge / ref)).toFixed(3);
}

// ── Drawdown-scaled sizing (piste 3, anti-martingale) ────────────────
// Réduit le risque à mesure que le drawdown approche le circuit breaker : on trade
// PLUS PETIT quand on perd (atterrissage en douceur AVANT le halt dur, lisse la courbe
// d'équité). Multiplicateur [floor, 1], linéaire entre `start` et `breaker`.
//   start   = dd (%) où la réduction commence (déf. RM_DD_TAPER_START ou 4)
//   breaker = dd (%) du circuit breaker (déf. RM_MAX_DRAWDOWN_PCT ou 10) — halt de toute façon
//   floor   = plancher du multiplicateur (déf. RM_DD_FLOOR ou 0.4)
// Strictement <= 1 (ne MONTE jamais le risque) -> garde-fou purement conservateur.
function drawdownScale(ddPct, opts = {}) {
  const start = opts.start != null ? opts.start : parseFloat(process.env.RM_DD_TAPER_START || "4");
  const breaker = opts.breaker != null ? opts.breaker : parseFloat(process.env.RM_MAX_DRAWDOWN_PCT || "10");
  const floor = opts.floor != null ? opts.floor : parseFloat(process.env.RM_DD_FLOOR || "0.4");
  const dd = (ddPct == null || !isFinite(Number(ddPct))) ? 0 : Number(ddPct);
  if (dd <= start || breaker <= start) return 1;       // sous le seuil de taper -> plein
  if (dd >= breaker) return floor;                     // au breaker (ou au-dela) -> plancher
  const t = (dd - start) / (breaker - start);          // interpolation lineaire 1 -> floor
  return +(1 - t * (1 - floor)).toFixed(3);
}

module.exports = { computeSize, edgeScale, drawdownScale };
