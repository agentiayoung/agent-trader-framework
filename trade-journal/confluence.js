"use strict";
// confluence.js — moteur de CONFLUENCE 0-100 + decision PUR (Phase 6, master plan 2026-06-18).
// Fusionne la perception deterministe (structure x zones x bougies x orderflow x options) en UN
// score 0-100 par sens, et propose une decision schematisee (long|short|wait|no_trade).
// Produit le bloc `confluence` du contrat docs/SCHEMA-market-state.md.
//
// PHILOSOPHIE (D-C, lean-by-evidence) : le score est de l'OBSERVABILITE. `would_gate` indique si un
// plancher (defaut 75) serait franchi, mais la decision reste une PROPOSITION ; le LLM arbitre, et le
// plancher dur ne sera active qu'apres validation OOS (/edge-sprint). Aucune execution ici.
//
// Ponderation (=100) : structure 20 | zone 20 | bougie 25 | orderflow 20 | liquidite/confluence 15.

// Barème /14 partagé (source unique = score.js) -> la confluence parle la MEME langue que le /14
// deja en place (tiers A+/B/sub). Le "plancher 75/100" est REMPLACE par le plancher /14 (B=6) qui
// pilote deja le sizing du systeme. Coherence totale du scoring (L7+L2, directive the maintainer 18.06).
const { tier14, TIER_FLOORS } = require("./score.js");

const W = { structure: 20, zone: 20, candle: 25, orderflow: 20, liquidity: 15 };

const BULL_ZONES = new Set(["support", "flip", "order_block", "fvg", "eql", "pdl", "pwl", "hvn", "vwap"]);
const BEAR_ZONES = new Set(["resistance", "flip", "order_block", "fvg", "eqh", "pdh", "pwh", "hvn", "vwap"]);

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

// score d'UN sens (dir = long|short) sur la perception fournie.
function scoreSide(dir, st, opts) {
  const s = st || {};
  const structure = s.structure || {};
  const zones = Array.isArray(s.zones) ? s.zones : [];
  const candles = s.candles || {};
  const of = s.orderflow || {};
  const px = s.px; const atr = s.atr > 0 ? s.atr : null;
  const wantUp = dir === "long";
  const reasons = [];

  // 1) STRUCTURE (20) : tendance alignee + CHoCH/MSS dans le sens.
  let structPts = 0;
  const trend = structure.trend;
  if ((wantUp && trend === "up") || (!wantUp && trend === "down")) { structPts += 14; reasons.push(`structure ${trend} alignee`); }
  else if (trend === "range") { structPts += 6; }
  const mss = structure.last_mss, choch = structure.last_choch;
  if (mss && ((wantUp && mss.dir === "up") || (!wantUp && mss.dir === "down"))) { structPts += 6; reasons.push("MSS dans le sens"); }
  else if (choch && ((wantUp && choch.dir === "up") || (!wantUp && choch.dir === "down"))) { structPts += 3; reasons.push("CHoCH dans le sens"); }
  structPts = clamp(structPts, 0, W.structure);

  // 2) ZONE (20) : zone pertinente FRAICHE proche du prix, alignee au sens.
  const set = wantUp ? BULL_ZONES : BEAR_ZONES;
  let zonePts = 0, bestZone = null;
  for (const z of zones) {
    const sideOk = z.side ? (wantUp ? z.side === "bull" : z.side === "bear") : true;
    if (!set.has(z.type) || !sideOk) continue;
    if (z.dist_atr == null || z.dist_atr > 1.5) continue;
    const prox = clamp(1 - z.dist_atr / 1.5, 0, 1);
    const fresh = z.status === "fresh" ? 1 : z.status === "mitigated" ? 0.6 : 0.2;
    const pts = (8 * prox + 6 * fresh + 6 * clamp(z.strength || 0, 0, 1));
    if (pts > zonePts) { zonePts = pts; bestZone = z; }
  }
  zonePts = clamp(zonePts, 0, W.zone);
  if (bestZone) reasons.push(`zone ${bestZone.type} @${bestZone.dist_atr}ATR (${bestZone.status})`);

  // 3) BOUGIE (25) : confirmation contextuelle valide dans le sens.
  let candlePts = 0;
  if (candles.confirmation_valid && candles.side === dir) {
    candlePts = W.candle * clamp((candles.strength || 0.5) * (candles.location_quality || 0), 0, 1);
    reasons.push(`bougie ${candles.pattern} confirmee (lq ${candles.location_quality})`);
  } else if (candles.side === dir && candles.location_quality >= 0.3) {
    candlePts = 6; // pattern present mais non pleinement confirme
  }
  candlePts = clamp(candlePts, 0, W.candle);

  // 4) ORDERFLOW (20) : sweep + divergence CVD + signal OI + absorption.
  let ofPts = 0;
  if (of.sweep && of.sweep.detected && of.sweep.bias === dir) { ofPts += 8; reasons.push(`sweep ${of.sweep.side} -> ${dir}`); }
  if (of.cvd_divergence && ((wantUp && of.cvd_divergence === "bull") || (!wantUp && of.cvd_divergence === "bear"))) { ofPts += 5; reasons.push("divergence CVD alignee"); }
  const oiFav = wantUp ? ["new_longs", "short_covering"] : ["new_shorts", "long_covering"];
  if (of.oi_signal && oiFav.includes(of.oi_signal)) { ofPts += 4; }
  if (of.absorption && of.absorption.detected && of.absorption.against === (wantUp ? "short" : "long")) { ofPts += 3; reasons.push("absorption favorable"); }
  ofPts = clamp(ofPts, 0, W.orderflow);

  // 5) LIQUIDITE / CONFLUENCE (15) : multi-facteurs au meme niveau + cible de liquidite opposee.
  let liqPts = 0;
  if (bestZone && bestZone.confluence) liqPts += clamp(bestZone.confluence.length * 3, 0, 9);
  const targetType = wantUp ? "eqh" : "eql"; // liquidite a aller chercher dans le sens
  if (zones.some((z) => z.type === targetType)) { liqPts += 3; }
  if (zones.some((z) => z.type === (wantUp ? "pdh" : "pdl"))) liqPts += 3;
  liqPts = clamp(liqPts, 0, W.liquidity);

  const breakdown = {
    structure: +structPts.toFixed(1), zone: +zonePts.toFixed(1), candle: +candlePts.toFixed(1),
    orderflow: +ofPts.toFixed(1), liquidity: +liqPts.toFixed(1),
  };
  const score = +(structPts + zonePts + candlePts + ofPts + liqPts).toFixed(1);
  return { dir, score, breakdown, reasons, best_zone: bestZone ? { type: bestZone.type, lo: bestZone.lo, hi: bestZone.hi, dist_atr: bestZone.dist_atr } : null };
}

// to14(score100) : convertit le score 0-100 sur l'echelle /14 (langage unifie avec score.js).
function to14(score100) { return +(score100 * 14 / 100).toFixed(1); }

// confluence(state, opts) -> bloc confluence complet + decision PROPOSEE, exprime en /14.
// opts.floor14 = plancher de tradeabilite sur /14 (defaut B=6, comme le sizing). opts.threshold
// (0-100) toujours accepte en retro-compat -> converti en /14.
function confluence(state, opts) {
  const o = opts || {};
  const floor14 = o.floor14 != null ? o.floor14 : (o.threshold != null ? to14(o.threshold) : TIER_FLOORS.b);
  const s = state || {};
  const long = scoreSide("long", s, o);
  const short = scoreSide("short", s, o);
  const best = long.score >= short.score ? long : short;
  const other = best === long ? short : long;

  const score14 = to14(best.score);
  const tier = tier14(score14);           // A+ (>=9) / B (>=6) / sub — MEME barème que le /14 en place

  // Decision PROPOSEE (le LLM arbitre ; observabilite-first).
  const candles = s.candles || {};
  const zones = Array.isArray(s.zones) ? s.zones : [];
  const nearZone = zones.some((z) => z.dist_atr != null && z.dist_atr <= 0.5);
  const valid = candles.confirmation_valid && candles.side === best.dir;
  let decision;
  if (valid && score14 >= floor14) decision = best.dir;       // confluence tradeable (>=B) + bougie confirmee
  else if (valid) decision = best.dir;                        // confirmee mais confluence faible (tier sub) = proposition basse conviction
  else if (nearZone) decision = "wait";                       // prix dans une zone, pas (encore) de reaction confirmee
  else decision = "no_trade";
  const conviction = valid ? tier : "none";

  return {
    score: best.score,             // 0-100 (granularite)
    score14,                       // /14 (echelle unifiee avec score.js)
    tier,                          // A+ / B / sub (langage de sizing partage)
    side: best.dir,
    decision,
    conviction,
    would_gate: valid && score14 >= floor14, // atteint le plancher /14 tradeable (B) — informatif, non bloquant
    floor14,
    breakdown: best.breakdown,
    reasons: best.reasons,
    best_zone: best.best_zone,
    opposite: { side: other.dir, score: other.score, score14: to14(other.score) },
    note: "OBSERVABILITE : decision = PROPOSITION ; le LLM arbitre. Confluence exprimee en /14 (tiers A+/B/sub = memes planchers que le score /14 en place). Plancher dur non applique (D-C).",
  };
}

module.exports = { confluence, scoreSide, W };
