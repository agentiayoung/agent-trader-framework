"use strict";
// ═══════════════════════════════════════════════════════════════════
// slippage.js — coût réel (slippage d'entrée + frais) en R vs modèle backtest.
//
// PUR : aucune I/O, aucun réseau, déterministe (testable offline). `journal.js
// slippage` charge trades.jsonl et appelle analyzeSlippage.
//
// POURQUOI : tout le NET-edge du projet (FEE 0.055%, décision B1 "limit/maker
// obligatoire", repondération EDGE) repose sur l'hypothèse "coût live ≈ coût
// modélisé". Ce module la VALIDE par-trade. Si la friction live d'un setup
// approche/dépasse son edge NET (MR4 +0.033R / S1 +0.045R), il n'est PAS
// tradable live. Mesure le drag d'entrée des entrées market two-phase (slip) vs
// les entrées LIMIT/maker (slip ~0) -> vérifie empiriquement la décision B1.
//
// Posture : OBSERVABILITÉ (flag review). Pas d'auto-action sur les poids EDGE
// tant que n<5 (lean-by-evidence). Jonction propre vers la piste 4 plus tard.
// ═══════════════════════════════════════════════════════════════════

// FEE aligné sur optimize.js/backtest.js (modèle taker, round-trip ~0.11%).
const FEE = parseFloat(process.env.OPT_FEE_PCT || "0.055") / 100;

// perTrade(t) -> métriques de friction d'UN trade clôturé, ou null si données insuffisantes.
//  entry_slip_R     : slip d'entrée signé en R (adverse>0 = pire que prévu ; favorable<0 = bonus)
//  realized_cost_R  : frais réels round-trip / risque initial
//  modeled_cost_R   : 2*FEE*entry/|entry-SL| (le feeR du backtest)
//  total_friction_R : realized_cost_R + max(0, entry_slip_R) — le drag live total (favorable ignoré)
function perTrade(t) {
  if (!t) return null;
  const entry = Number(t.entry_actual != null ? t.entry_actual : t.entry_planned);
  const sl = Number(t.stop_loss);
  const size = Number(t.size);
  const planned = t.entry_planned != null ? Number(t.entry_planned) : null;
  if (!isFinite(entry) || !isFinite(sl) || !isFinite(size) || entry === sl) return null;
  const riskUsd = Math.abs(entry - sl) * size;
  if (!(riskUsd > 0)) return null;

  let entrySlipR = null, entrySlipPct = null;
  if (planned != null && isFinite(planned)) {
    // long : payer PLUS cher (actual>planned) = adverse ; short : vendre MOINS cher (actual<planned) = adverse
    const adverse = t.side === "long" ? (entry - planned) : (planned - entry);
    entrySlipR = +((adverse * size) / riskUsd).toFixed(3);
    entrySlipPct = +((adverse / planned) * 100).toFixed(3);
  }
  const realizedCostR = t.fees != null && isFinite(Number(t.fees)) ? +(Number(t.fees) / riskUsd).toFixed(3) : null;
  const modeledCostR = +((2 * FEE * entry) / Math.abs(entry - sl)).toFixed(3);
  const totalFrictionR = realizedCostR != null ? +(realizedCostR + Math.max(0, entrySlipR || 0)).toFixed(3) : null;

  return {
    id: t.id, setup: t.strategy || "?", side: t.side,
    entry_planned: planned, entry_actual: entry,
    entry_slip_pct: entrySlipPct, entry_slip_R: entrySlipR,
    realized_cost_R: realizedCostR, modeled_cost_R: modeledCostR,
    total_friction_R: totalFrictionR,
  };
}

function avg(xs) { return xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3) : null; }

// analyzeSlippage(trades) -> agrégat global + par setup + détails.
// Exclut MANUAL_TEST* (tests pipeline) — MÊME convention que score-eval/stats.
function analyzeSlippage(trades) {
  const closed = (trades || []).filter((t) => t.status === "closed" && !/^MANUAL_TEST/i.test(t.strategy || ""));
  const rows = closed.map(perTrade).filter(Boolean);

  const slips = rows.map((r) => r.entry_slip_R).filter((x) => x != null);
  const realized = rows.map((r) => r.realized_cost_R).filter((x) => x != null);
  const modeled = rows.map((r) => r.modeled_cost_R).filter((x) => x != null);
  const friction = rows.map((r) => r.total_friction_R).filter((x) => x != null);
  const avgRealized = avg(realized), avgModeled = avg(modeled);

  const bySetup = {};
  for (const r of rows) {
    const k = r.setup || "?";
    (bySetup[k] = bySetup[k] || { frictions: [], slips: [] });
    if (r.total_friction_R != null) bySetup[k].frictions.push(r.total_friction_R);
    if (r.entry_slip_R != null) bySetup[k].slips.push(r.entry_slip_R);
    bySetup[k].n = (bySetup[k].n || 0) + 1;
  }
  const setups = Object.entries(bySetup).map(([setup, v]) => ({
    setup, n: v.n, avg_friction_R: avg(v.frictions), avg_slip_R: avg(v.slips),
  }));

  return {
    n: rows.length,
    avg_entry_slip_R: avg(slips),
    avg_realized_cost_R: avgRealized,
    avg_modeled_cost_R: avgModeled,
    avg_total_friction_R: avg(friction),
    // >1 = le live coûte PLUS que le modèle taker (slip/fills partiels) ; ~1 = modèle fidèle.
    cost_ratio: (avgRealized != null && avgModeled) ? +(avgRealized / avgModeled).toFixed(2) : null,
    by_setup: setups,
    note: "Friction live (slip entree + frais) en R vs modele backtest. Si avg_total_friction_R d'un setup approche/depasse son edge NET -> non tradable live. n faible au debut (forward-test). Slip ~0 attendu sur les entrees LIMIT/maker (B1).",
    details: rows,
  };
}

module.exports = { analyzeSlippage, perTrade };
