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

// Tier = label de dimensionnement (A+ pleine / B demi / sub). EXIGE un R:R.
// A+ : total>=9 ET rr>=2.5 · B : total>=6 ET rr>=2 · sinon 'sub'.
function tierOf(total, rr) {
  if (rr != null && total >= 9 && rr >= 2.5) return "A+";
  if (rr != null && total >= 6 && rr >= 2) return "B";
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

module.exports = { SCALE, enrichScore, computeRR, tierOf, evalScores };
