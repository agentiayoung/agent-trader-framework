"use strict";
// ═══════════════════════════════════════════════════════════════════
// review.js — synthèse hebdo (méta-apprentissage). PUR (testable offline).
//
// Agrège perf déclenchée (stats) + expectancy par setup (scorecard) + /14→R
// (score-eval) + non-déclenchés, et produit des FLAGS ACTIONNABLES (que faire).
// `journal.js review` gathère les données et appelle ces fonctions. Le but :
// transformer les boucles (score-eval/scorecard/notrade-eval) en décisions.
// ═══════════════════════════════════════════════════════════════════

// trendWinnerStats : mesure forward-test du chantier B (trail trend-adaptatif). Les setups de
// TENDANCE (S1/S2/S3/S12) plafonnaient leurs gagnants au TP (~+1.46R moy, max +1.87R) ; le
// trail-adaptatif vise +3R/+5R. Cette stat surveille le PLAFOND de R des trend-winners clos
// dans le temps -> si le trail-adaptatif marche, max_r/avg_r doivent MONTER. PUR, testable.
const TREND_SETUP_RE = /^(S1|S2|S3|S12)(?![A-Za-z0-9])/i;
function trendWinnerStats(trades) {
  const rs = (trades || [])
    .filter((t) => t && t.status === "closed" && t.outcome === "win" && typeof t.r_multiple === "number" && TREND_SETUP_RE.test(String(t.strategy || "")))
    .map((t) => t.r_multiple);
  if (!rs.length) return { n: 0, avg_r: null, max_r: null };
  return { n: rs.length, avg_r: +(rs.reduce((a, b) => a + b, 0) / rs.length).toFixed(2), max_r: +Math.max(...rs).toFixed(2) };
}

// Flags actionnables (pur). stats = cmd_stats(), scorecard = cmd_scorecard(),
// scoreEval = evalScores(), slippage = analyzeSlippage() (optionnel), trades = load() (optionnel,
// pour la mesure forward-test du trail trend-adaptatif). Retourne ✅/⚠️/ℹ️.
function reviewFlags(stats, scorecard, scoreEval, slippage, trades) {
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
  // 6. Forward-test trail trend-adaptatif (chantier B) : plafond de R des trend-winners
  if (trades) {
    const tw = trendWinnerStats(trades);
    if (tw.n >= 5) {
      if (tw.max_r >= 3) flags.push(`✅ trend-winner a couru à ${tw.max_r}R (avg ${tw.avg_r}R, n${tw.n}) → le trail-adaptatif B capture les grandes tendances`);
      else flags.push(`ℹ️ trend-winners plafonnent (max ${tw.max_r}R, avg ${tw.avg_r}R, n${tw.n}) → le trail-adaptatif B vise +3R/+5R, surveiller si le plafond monte en régime trending`);
    } else {
      flags.push(`ℹ️ trend-winners n=${tw.n} clôturés → trail-adaptatif B pas encore mesurable (besoin de tendances + de trades), laisser tourner`);
    }
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

module.exports = { reviewFlags, renderReview, trendWinnerStats };
