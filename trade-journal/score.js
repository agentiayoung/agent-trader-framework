"use strict";
// ═══════════════════════════════════════════════════════════════════
// score.js — barème /14 du scoring de confluence + gating dur + analyse.
//
// PUR : aucune I/O, aucun réseau, déterministe (testable offline).
// Le LLM de la routine PASSE les composantes brutes (lues sur TV Desktop +
// screener) ; le CODE dérive total/rr/tier/gate.passed. Le barème vit ICI
// (une seule source de vérité), pas dans le prompt -> reproductible + tunable.
//
// Référence barème : tradingview/DESKTOP_INDICATORS.md (table /14).
// IMPORTANT : `tier` est un LABEL calculé, PAS une barrière. La décision de
// trader reste celle de la routine (Philosophie v3). On MESURE, on n'impose pas.
// ═══════════════════════════════════════════════════════════════════

// Poids max de chaque composante (somme = 14). Cf. DESKTOP_INDICATORS.md.
const SCALE = {
  zeiierman: 2,  // prix à une zone Zeiierman alignée
  rsi: 2,        // RSI screener zone + direction
  macd: 2,       // MACD cross + histogramme
  regime: 1,     // régime Trend Channels aligné
  supertrend: 1, // prix du bon côté de l'AI Supertrend
  stochrsi: 1,   // StochRSI extrême cohérent
  ai_signal: 1,  // dernier label AI Signal aligné
  fib: 1,        // confluence Fib 0.5/0.618 × zone
  adx: 1,        // ADX/DI tendance alignée
  vwap: 1,       // VWAP retest aligné
  candle: 1,     // bougie / volume / OBV confirme
};

function clampComponents(raw) {
  const out = {};
  for (const k of Object.keys(SCALE)) {
    if (raw && raw[k] != null) {
      const v = Number(raw[k]) || 0;
      out[k] = Math.max(0, Math.min(SCALE[k], v));
    }
  }
  return out; // composantes inconnues ignorées, manquantes = absentes (0)
}

function computeRR(levels) {
  if (!levels) return null;
  const entry = Number(levels.entry), sl = Number(levels.sl), tp = Number(levels.tp);
  if (!isFinite(entry) || !isFinite(sl) || !isFinite(tp)) return null;
  const risk = Math.abs(entry - sl), reward = Math.abs(tp - entry);
  if (!risk) return null;
  return +(reward / risk).toFixed(2);
}

// Planchers de tier /14 (source unique, reutilises par la confluence pour parler la MEME langue).
const TIER_FLOORS = { aplus: 9, b: 6 };

// Tier = label de dimensionnement (A+ pleine / B demi / sub). EXIGE un R:R.
// A+ : total>=9 ET rr>=2.5 · B : total>=6 ET rr>=2 · sinon 'sub'.
function tierOf(total, rr) {
  if (rr != null && total >= TIER_FLOORS.aplus && rr >= 2.5) return "A+";
  if (rr != null && total >= TIER_FLOORS.b && rr >= 2) return "B";
  return "sub";
}

// tier14(score14) : tier d'un score DEJA sur l'echelle /14 SANS exiger de R:R (la confluence
// structurelle n'a pas de niveaux entree/SL/TP). Memes planchers que tierOf -> langage unifie.
function tier14(s14) {
  if (s14 >= TIER_FLOORS.aplus) return "A+";
  if (s14 >= TIER_FLOORS.b) return "B";
  return "sub";
}

// Enrichit un bloc score brut {components, gate, zones} avec total/rr/tier/gate.passed.
function enrichScore(score, levels) {
  const components = clampComponents(score && score.components);
  const total = Object.values(components).reduce((a, b) => a + b, 0);
  const rr = computeRR(levels);
  const tier = tierOf(total, rr);
  const g = (score && score.gate) || {};
  const gate = {
    regime_strong_opp: !!g.regime_strong_opp,
    supertrend_flip_opp: !!g.supertrend_flip_opp,
    passed: !g.regime_strong_opp && !g.supertrend_flip_opp,
  };
  return { components, total, rr, tier, gate, zones: (score && score.zones) || "screener_fallback" };
}

// ── Analyse offline : corrèle score/tier/composante/gate -> R réalisé ──
// Entrée : liste de trades (clôturés porteurs d'un bloc score). Pur, testable.
function _agg() { return { n: 0, wins: 0, rs: [] }; }
function _finalize(a) {
  const avg = a.rs.length ? a.rs.reduce((x, y) => x + y, 0) / a.rs.length : null;
  return { n: a.n, win_rate: a.n ? +((a.wins / a.n) * 100).toFixed(1) : null,
    avg_r: avg == null ? null : +avg.toFixed(2), expectancy: avg == null ? null : +avg.toFixed(2) };
}
function _bucketOf(total) {
  if (total >= 12) return "12+";
  if (total >= 9) return "9-11";
  if (total >= 6) return "6-8";
  return "<6";
}
// ── Scoring PERCEPTION /14 (F1, 18.06) : source DETERMINISTE de confluence ──
// La couche perception (structure x zones x bougies x orderflow) produit un /14 DISPONIBLE sur
// 14/14 opportunites (contrairement au /14 Desktop souvent en fallback zones). Ces helpers la
// rendent exploitable cote decision : aligner au sens du trade + cle de tri combinee.

// perceptionScore(confluence, side) -> bloc /14 ALIGNE au sens du trade depuis une confluence
// COMPACTE (cf. perception.compactPerception : {score14, side, opp14, ...}). On prend le score14 du
// sens DEMANDE ; si la perception penche dans l'autre sens, on lit opp14 (sens oppose). null si indispo.
function perceptionScore(confluence, side) {
  const cf = confluence;
  if (!cf || cf.score14 == null) return null;
  const aligned = side ? cf.side === side : true;
  const s14 = aligned ? cf.score14 : (cf.opp14 != null ? cf.opp14 : null);
  if (s14 == null) return null;
  const v = +Number(s14).toFixed(1);
  return { score14: v, tier: tier14(v), aligned, side: side || cf.side, source: "perception" };
}

// combinedScore(setupScore, confluence, side) -> cle de tri COMBINEE edge x confluence (livrable F1).
// Facteur de perception dans [0.5, 1.5] (neutre 1 si perception absente) : une confluence forte ALIGNEE
// remonte le candidat, une confluence faible / a l'oppose le redescend, SANS jamais l'annuler -> l'edge
// (deja pondere OOS) reste le socle, la perception ne fait qu'inflechir le tri. PUR.
function combinedScore(setupScore, confluence, side) {
  const base = Number(setupScore) || 0;
  const ps = perceptionScore(confluence, side);
  const factor = ps ? +(0.5 + ps.score14 / 14).toFixed(3) : 1;
  return +(base * factor).toFixed(2);
}

// evalPerception(trades) -> correle le /14 PERCEPTION (score_perception) au R realise. Parallele a
// evalScores (qui calibre le /14 Desktop) : source deterministe, dispo sur ~tous les trades. PUR.
function evalPerception(trades) {
  const scored = (trades || []).filter((t) => t.status === "closed" && t.score_perception
    && typeof t.score_perception.score14 === "number" && typeof t.r_multiple === "number"
    && !/^MANUAL_TEST/i.test(t.strategy || ""));
  const byBucket = {}, byTier = {}, byAligned = { aligned: _agg(), counter: _agg() };
  for (const t of scored) {
    const sp = t.score_perception, R = t.r_multiple, win = R > 0;
    const push = (a) => { a.n++; if (win) a.wins++; a.rs.push(R); };
    const bk = _bucketOf(sp.score14);
    (byBucket[bk] = byBucket[bk] || _agg()); push(byBucket[bk]);
    const tier = sp.tier || tier14(sp.score14);
    (byTier[tier] = byTier[tier] || _agg()); push(byTier[tier]);
    push(sp.aligned === false ? byAligned.counter : byAligned.aligned);
  }
  const fin = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, _finalize(v)]));
  return {
    n: scored.length, by_bucket: fin(byBucket), by_tier: fin(byTier),
    by_aligned: { aligned: _finalize(byAligned.aligned), counter: _finalize(byAligned.counter) },
    note: "Correlation perception /14 -> R (source DETERMINISTE, dispo ~14/14 opps). aligned=false : la confluence penchait a l'oppose du trade pris.",
  };
}

function evalScores(trades) {
  // Exclut UNIQUEMENT les tests pipeline (strategy MANUAL_TEST_*) — MÊME définition que journal.js
  // stats + obsidian-sync (cohérence : une seule notion de "perf", l'agent ne se brouille pas).
  // Les vrais trades manuels (early) comptent s'ils ont un score.
  const scored = (trades || []).filter((t) => t.status === "closed" && t.score && typeof t.r_multiple === "number" && !/^MANUAL_TEST/i.test(t.strategy || ""));
  const byBucket = {}, byTier = {}, byGate = { passed: _agg(), blocked: _agg() }, byComp = {};
  for (const t of scored) {
    // Un bloc score peut être BRUT (sans total/tier — ex. écrasé par `journal.js set` lors d'un
    // repositionnement) : ne jamais faire confiance au total stocké, le re-dériver du barème.
    const tp0 = Array.isArray(t.take_profits) && t.take_profits[0];
    const score = t.score.total != null ? t.score : enrichScore(t.score, {
      entry: t.entry_actual ?? t.entry_planned ?? t.entry,
      sl: t.stop_loss,
      tp: tp0 && (tp0.px ?? tp0),
    });
    const R = t.r_multiple, win = R > 0;
    const push = (a) => { a.n++; if (win) a.wins++; a.rs.push(R); };
    const bk = _bucketOf(score.total || 0);
    (byBucket[bk] = byBucket[bk] || _agg()); push(byBucket[bk]);
    const tier = score.tier || "sub";
    (byTier[tier] = byTier[tier] || _agg()); push(byTier[tier]);
    push(score.gate && score.gate.passed === false ? byGate.blocked : byGate.passed);
    const comps = (score.components) || {};
    for (const k of Object.keys(SCALE)) {
      byComp[k] = byComp[k] || { present: _agg(), absent: _agg() };
      push((comps[k] || 0) > 0 ? byComp[k].present : byComp[k].absent);
    }
  }
  const fin = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, _finalize(v)]));
  const finComp = Object.fromEntries(Object.entries(byComp).map(([k, v]) =>
    [k, { present: _finalize(v.present), absent: _finalize(v.absent) }]));
  return {
    n: scored.length,
    by_bucket: fin(byBucket), by_tier: fin(byTier),
    by_gate: { passed: _finalize(byGate.passed), blocked: _finalize(byGate.blocked) },
    by_component: finComp,
    note: "Correlation score->R (n faible au debut = forward-test). Gate->outcome counterfactuel sur no-trades : voir notrade-eval.js.",
  };
}

module.exports = { SCALE, enrichScore, computeRR, tierOf, tier14, TIER_FLOORS, evalScores, perceptionScore, combinedScore, evalPerception };
