// Builder PUR d'une entree datee du journal de strategie (auto-doc de l'orchestrateur).
// Trace de RAISONNEMENT (distincte de JOURNAL.md=trades et LESSONS.md=lecons).
function buildEntry({ date, time, sentiment, bull_case, bear_case, decision, why, adjustments }) {
  return [
    `\n## ${date} ${time || ''}`.trimEnd(),
    `- **Sentiment marche :** ${sentiment || '-'}`,
    `- **Bull case :** ${bull_case || '-'}`,
    `- **Bear case :** ${bear_case || '-'}`,
    `- **Decision :** ${decision || 'no_trade'}`,
    `- **Pourquoi :** ${why || '-'}`,
    `- **Ajustements :** ${adjustments || '-'}`,
    '',
  ].join('\n');
}
module.exports = { buildEntry };
