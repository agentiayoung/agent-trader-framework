"use strict";
// ═══════════════════════════════════════════════════════════════════
// edge-watch.js — détection de décroissance d'edge entre 2 snapshots optimize.js
// + helper de bucket de régime (partagé avec optimize.js).
//
// PUR : aucune I/O, aucun réseau, déterministe (testable offline). Le wrapper
// edge-revalidate.js lance optimize.js (réseau), snapshot le résultat, et appelle
// compareEdges pour produire des flags Telegram.
//
// POURQUOI (piste 5) : c'est la SEULE boucle self-learning non bloquée par notre
// compteur de trades — elle tourne sur la donnée MARCHÉ (échantillon massif, dispo
// maintenant). Re-valider périodiquement les edges détecte leur décroissance
// (régime qui change) AVANT qu'ils ne nous coûtent en live.
// ═══════════════════════════════════════════════════════════════════

// Edges suivis = ceux validés OOS NET (alignés Daily). Source : STRATEGY_MATRIX.md.
const TRACKED = ["S5_MTF", "MR8_MTF", "S1_MTF", "MR4_MTF", "S5_fade_range", "MR8_stochrsi_naked"];

// Bucket de régime à partir d'un ADX (mêmes seuils que scan.js : 22 / 35).
// strong (>35) = tendance forte = mean-reversion RISQUÉE (tous nos edges fadent).
function regimeBucket(adx) {
  if (adx == null || !isFinite(adx)) return "?";
  if (adx > 35) return "strong";
  if (adx > 22) return "trending";
  return "range";
}

// ── macroAlign : position d'un signal vs le régime MACRO (BTC daily) ─────────
// "strong_opposed"  = macro strong ET le side va CONTRE la direction macro (ex. long en strong bear)
// "strong_aligned"  = macro strong ET le side va AVEC (ex. short en strong bear)
// "calm"            = macro range/trending (pas de tendance forte à contrarier)
// "?"               = pas de mesure macro fiable.
// Sert au split H2 d'optimize.js : le gating macro sur les fades est-il backtest-backed ?
function macroAlign(side, macroBucket, macroBull) {
  if (!macroBucket || macroBucket === "?" ) return "?";
  if (macroBucket !== "strong") return "calm";
  if (macroBull == null) return "?";
  const sideBull = side === "long";
  return sideBull === !!macroBull ? "strong_aligned" : "strong_opposed";
}

// ── regimeFit : routage setup<->régime (TOP2, encode le finding 5a) ──────────
// Edge NET OOS par (famille de setup × régime), source : optimize.js test_by_regime (split 5a).
// S1 = edge de TENDANCE (perd en range, gagne en trend/strong) ; MR8 = mean-reversion
// (gagne en range/trending, BLEED en strong) ; S5 = edge de range. MR4/S3 = marginaux (pas
// de mesure régime fiable). Permet à la routine d'utiliser le BON setup selon le régime live
// (`regime_d` du scan) -> + d'entrées VALIDES sans diluer (cf. seuils élargis rejetés).
const REGIME_EDGE = {
  S1:  { range: -0.082, trending: 0.354, strong: 0.311 },
  // S2 validé 10.06 (sprint régime fort) : edge de TENDANCE caché, pattern identique à S1.
  // trending +0.30R test (n53, WR 66%) ET +0.212R train (n68) = cohérent ; range négatif 2 côtés.
  // strong : positif mais n test=13 -> pas dans la table (neutral). Source : optimize-history/2026-06-10.json.
  S2:  { range: -0.08, trending: 0.30 },
  // S12 validé 10.06 (sprint #4 /edge-sprint, cross-TF) : squeeze->expansion aligné daily.
  // 4H trending +0.19R test (n35) / +0.272R train ; corroboré 1H trending/strong (+0.118/+0.286R,
  // n158/53). Range 4H incohérent -> pas dans la table (la SOP restreint S12 à trending).
  S12: { trending: 0.19 },
  MR8: { range: 0.13, trending: 0.191, strong: -0.05 },
  S5:  { range: 0.31 }, // trend/strong : n trop faible (S5 ne déclenche qu'en range)
  MR4: {},              // marginal/négatif OOS (MR4_MTF ≤0 sur 2 fenêtres -> EDGE réduit 0.6 le 10.06)
  S3:  {},              // négatif OOS
};
function family(setup) { return String(setup || "").split("_")[0].toUpperCase(); }
// regimeFit(setup, regime) -> { fit:'good'|'avoid'|'neutral'|'unknown', edge_R, note }
// Seuils : edge NET >=0.10R = good (privilégier) ; <=0 = avoid (bucket perdant) ; entre = neutral.
function regimeFit(setup, regime) {
  const fam = family(setup);
  const tbl = REGIME_EDGE[fam];
  if (!tbl) return { fit: "unknown", edge_R: null, note: `${fam || "?"}: setup hors table régime` };
  if (!(regime in tbl)) return { fit: "neutral", edge_R: null, note: `${fam} en ${regime}: pas de mesure OOS fiable (n faible)` };
  const e = tbl[regime];
  if (e <= 0) return { fit: "avoid", edge_R: e, note: `${fam} en ${regime} = bucket PERDANT (${e}R OOS NET) -> éviter/dé-prioriser` };
  if (e >= 0.10) return { fit: "good", edge_R: e, note: `${fam} en ${regime} = edge solide (${e}R OOS NET) -> privilégier` };
  return { fit: "neutral", edge_R: e, note: `${fam} en ${regime} = edge faible (${e}R OOS NET)` };
}

// edgeOf(setups, name) -> { exp, wr, n, robust } depuis une sortie optimize.js, ou null.
function edgeOf(setups, name) {
  const s = (setups || []).find((x) => x.setup === name);
  if (!s || !s.test_OOS || s.test_OOS.exp == null) return null;
  return { exp: s.test_OOS.exp, wr: s.test_OOS.wr, n: s.test_OOS.n, robust: /ROBUSTE/.test(s.verdict || "") };
}

// compareEdges(prevSetups, currSetups, opts) -> { flags:[], table:[] }
//   opts.tracked  : liste de setups à suivre (déf. TRACKED)
//   opts.dropPct  : chute relative qui alerte (déf. 0.5 = -50%)
function compareEdges(prevSetups, currSetups, opts = {}) {
  const tracked = opts.tracked || TRACKED;
  const dropPct = opts.dropPct != null ? opts.dropPct : 0.5;
  const flags = [], table = [];
  let warned = 0;
  for (const name of tracked) {
    const cur = edgeOf(currSetups, name);
    if (!cur) continue; // non reporté ce run (n insuffisant) -> on ne flag pas
    const prev = prevSetups ? edgeOf(prevSetups, name) : null;
    table.push({ setup: name, prev_exp: prev ? prev.exp : null, curr_exp: cur.exp, wr: cur.wr, n: cur.n, robust: cur.robust });
    if (cur.exp <= 0) { flags.push(`⚠️ ${name} OOS NET passé à ${cur.exp}R (≤0) → edge perdu, ré-évaluer / baisser l'EDGE`); warned++; }
    else if (!cur.robust) { flags.push(`⚠️ ${name} a perdu le verdict ROBUSTE (OOS ${cur.exp}R, WR ${cur.wr}%) → surveiller`); warned++; }
    if (prev && prev.exp > 0 && cur.exp < prev.exp * (1 - dropPct)) {
      flags.push(`⚠️ ${name} OOS NET chute ${prev.exp}→${cur.exp}R (>${Math.round(dropPct * 100)}%) → décroissance d'edge`);
      warned++;
    }
  }
  if (!warned) {
    const pos = table.filter((r) => r.curr_exp > 0).length;
    flags.push(`✅ edges suivis stables (${pos}/${table.length} positifs OOS NET)`);
  }
  return { flags, table };
}

module.exports = { compareEdges, edgeOf, regimeBucket, regimeFit, macroAlign, REGIME_EDGE, TRACKED };
