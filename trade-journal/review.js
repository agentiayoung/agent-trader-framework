"use strict";
// ═══════════════════════════════════════════════════════════════════
// review.js — synthèse hebdo (méta-apprentissage). PUR (testable offline).
//
// Agrège perf déclenchée (stats) + expectancy par setup (scorecard) + /14→R
// (score-eval) + non-déclenchés, et produit des FLAGS ACTIONNABLES (que faire).
// `journal.js review` gathère les données et appelle ces fonctions. Le but :
// transformer les boucles (score-eval/scorecard/notrade-eval) en décisions.
// ═══════════════════════════════════════════════════════════════════

// Flags actionnables (pur). stats = cmd_stats(), scorecard = cmd_scorecard(),
// scoreEval = evalScores(), slippage = analyzeSlippage() (optionnel). Retourne ✅/⚠️/ℹ️.
function reviewFlags(stats, scorecard, scoreEval, slippage) {
  const flags = [];
  // 1. Perf déclenchée
  if ((stats.trades || 0) >= 5) {
    if (stats.win_rate < 40) flags.push(`⚠️ WR déclenché ${stats.win_rate}% < 40% (n${stats.trades}) — resserrer la sélection`);
    if (stats.net_pnl < 0) flags.push(`⚠️ PnL net déclenché négatif (${stats.net_pnl} USDT)`);
    if (stats.win_rate >= 50 && stats.net_pnl > 0) flags.push(`✅ perf déclenchée saine (WR ${stats.win_rate}%, PnL +${stats.net_pnl})`);
  } else {
    flags.push(`ℹ️ ${stats.trades || 0} trades déclenchés clôturés — échantillon faible, laisser tourner`);
  }
  // 2. Par setup (auto-dé-prioriser les perdants, privilégier les gagnants)
  for (const s of (scorecard.setups || [])) {
    if (s.n >= 5 && s.expectancy < 0) flags.push(`⚠️ setup ${s.setup}: expectancy ${s.expectancy} (n${s.n}) → ÉVITER / baisser l'EDGE`);
    else if (s.n >= 5 && s.expectancy > 0.1) flags.push(`✅ setup ${s.setup}: expectancy ${s.expectancy} (n${s.n}) → privilégier`);
  }
  // 3. Le /14 prédit-il le R ? (validation du scoring)
  if (scoreEval && scoreEval.n >= 5) {
    const bb = scoreEval.by_bucket || {};
    const hi = (bb["12+"] && bb["12+"].avg_r != null) ? bb["12+"].avg_r : (bb["9-11"] && bb["9-11"].avg_r);
    const lo = bb["<6"] && bb["<6"].avg_r;
    if (hi != null && lo != null) {
      flags.push(hi > lo
        ? `✅ /14 prédit le R (bucket haut ${hi} > bas ${lo}) → sizer par le score a du sens`
        : `⚠️ /14 ne prédit PAS le R (haut ${hi} ≤ bas ${lo}) → revoir le barème SCALE / les composantes`);
    }
  } else {
    flags.push(`ℹ️ score-eval n=${scoreEval ? scoreEval.n : 0} (clôturés scorés) — pas assez pour valider le /14`);
  }
  // 4. Funnel no-trade : trop d'annulés "rebond raté" = entrées limit mal placées
  const cr = (stats.not_triggered && stats.not_triggered.by_reason) || {};
  if ((cr.rebond_rate || 0) >= 3) flags.push(`⚠️ ${cr.rebond_rate} annulés "rebond raté" → entrées limit trop loin / passer en continuation plus tôt`);
  // 5. Friction live (slippage piste 1) : le coût réel valide-t-il le modèle backtest ?
  if (slippage && slippage.n >= 3) {
    if (slippage.cost_ratio != null && slippage.cost_ratio > 1.5)
      flags.push(`⚠️ coût live ${slippage.cost_ratio}× le modèle (frais ${slippage.avg_realized_cost_R}R vs ${slippage.avg_modeled_cost_R}R) → entrées market dégradent l'edge, forcer LIMIT/maker (B1)`);
    if ((slippage.avg_entry_slip_R || 0) > 0.05)
      flags.push(`⚠️ slip d'entrée moyen ${slippage.avg_entry_slip_R}R (adverse) → friction totale ${slippage.avg_total_friction_R}R menace les edges marginaux (MR4/S1 NET <0.05R)`);
    else if (slippage.avg_entry_slip_R != null && slippage.avg_entry_slip_R <= 0.02)
      flags.push(`✅ slip d'entrée ≈ 0 (${slippage.avg_entry_slip_R}R) → B1 maker tient, coût live ≈ frais modélisés`);
  } else if (slippage) {
    flags.push(`ℹ️ slippage n=${slippage.n} clôturés — friction live pas encore mesurable, laisser tourner`);
  }
  return flags;
}

// Markdown de la review (pur). state = { date, stats, scorecard, scoreEval, flags }
function renderReview(s) {
  const st = s.stats || {}, sc = s.scorecard || {}, se = s.scoreEval || {}, sl = s.slippage || {};
  const nt = st.not_triggered || { cancelled: 0, by_reason: {} };
  const crTxt = Object.keys(nt.by_reason || {}).length ? Object.entries(nt.by_reason).map(([k, v]) => `${k} ${v}`).join(", ") : "—";
  let md = `📋 *Review agent-trader* — ${s.date}\n`;
  md += `\n*Perf DÉCLENCHÉE* (tests exclus) : ${st.trades || 0} trades · WR ${st.win_rate ?? "—"}% · R moy ${st.avg_r ?? "—"} · PnL ${st.net_pnl ?? "—"} USDT\n`;
  md += `*Non déclenchés* : ${nt.cancelled || 0} annulés (${crTxt})\n`;
  md += `*Score /14* : n=${se.n || 0} clôturés scorés\n`;
  if (sl.n) md += `*Friction live* : n=${sl.n} · slip ${sl.avg_entry_slip_R ?? "—"}R · frais ${sl.avg_realized_cost_R ?? "—"}R vs modèle ${sl.avg_modeled_cost_R ?? "—"}R (×${sl.cost_ratio ?? "—"})\n`;
  if ((sc.setups || []).length) {
    md += `\n*Par setup (expectancy)* :\n`;
    for (const x of sc.setups) md += `• ${x.setup} : ${x.n}t · WR ${x.win_rate}% · exp ${x.expectancy} — ${x.verdict}\n`;
  }
  md += `\n*🎯 Flags / actions* :\n` + (s.flags || []).map((f) => "• " + f).join("\n");
  return md;
}

module.exports = { reviewFlags, renderReview };
