"use strict";
// ═══════════════════════════════════════════════════════════════════
// timeline.js — historique d'analyse multi-routine d'un trade.
//
// PUR : aucune I/O, aucun réseau, déterministe (testable offline).
// Capture l'évolution d'un trade entre son ouverture et sa clôture : chaque
// routine qui GÈRE un trade ouvert appende un snapshot {ts, décision, mark,
// note, score}. La donnée vit dans `trades.jsonl` (champ `timeline`) ; la page
// `trades/<id>.md` est une VUE générée. Résout le gap : avant, la ré-analyse
// d'un trade ouvert partait dans les logs texte, non rattachée au trade.
// ═══════════════════════════════════════════════════════════════════

const DECISIONS = ["open", "keep", "trail", "scale_in", "take_partial", "reposition", "cancel", "exit", "close", "note"];

// Appende un snapshot au timeline d'un trade (init []). Retourne le nb de snapshots.
function addSnapshot(trade, snap) {
  if (!Array.isArray(trade.timeline)) trade.timeline = [];
  trade.timeline.push(snap);
  return trade.timeline.length;
}

function _badge(status, netPnl) {
  if (status === "closed") return (netPnl ?? 0) > 0 ? "✅ WIN" : "❌ LOSS";
  if (status === "pending") return "⏳ PENDING";
  if (status === "cancelled") return "🚫 CANCELLED";
  if (status === "no_trade") return "⚪ NO-TRADE";
  if (status === "planned") return "🎯 PLANNED";
  return "🟢 OPEN";
}

// Rend la page markdown d'un trade (la "story" lisible). Pur.
function renderTradePage(trade) {
  const t = trade;
  const entry = t.entry_actual ?? t.entry_planned ?? t.entry ?? "—";
  let md = `# Trade ${t.id} — ${_badge(t.status, t.net_pnl)}\n\n`;
  md += `- ${t.exchange || "?"}/${t.mode || "?"} · **${t.side} ${t.symbol}** ${t.size ?? ""} · entrée ${entry} · SL ${t.stop_loss ?? "—"} · setup ${t.strategy || "?"}${t.tier ? ` · tier ${t.tier}` : ""}\n`;
  md += `- 🕒 ouvert ${t.ts_open || "—"}${t.ts_close ? ` → clôturé ${t.ts_close}` : ""}\n`;
  if (t.score && typeof t.score.total === "number") md += `- 🎯 score initial **${t.score.total}/14** (tier ${t.score.tier}, gate ${t.score.gate && t.score.gate.passed ? "OK" : "BLOQUÉ"})\n`;
  md += `\n## Rationale initiale\n\n${t.rationale || "_(aucune)_"}\n`;

  const tl = Array.isArray(t.timeline) ? t.timeline : [];
  md += `\n## Timeline (${tl.length} snapshot${tl.length > 1 ? "s" : ""})\n\n`;
  if (!tl.length) {
    md += "_Aucun snapshot de gestion. Ajouter via `journal.js note`._\n";
  } else {
    md += "| # | quand | décision | mark | uPnL | /14 | note |\n|---|---|---|---|---|---|---|\n";
    tl.forEach((s, i) => {
      const sc = s.score && typeof s.score.total === "number" ? s.score.total : "—";
      md += `| ${i + 1} | ${s.ts || "—"} | ${s.decision || "—"} | ${s.mark ?? "—"} | ${s.upnl ?? "—"} | ${sc} | ${(s.note || "").replace(/\n/g, " ")} |\n`;
    });
  }

  if (t.review) md += `\n## Review\n\n${t.review}\n`;
  if (t.status === "closed") {
    md += `\n## Résultat\n\n- sortie moy ${t.avg_exit ?? "—"} · PnL net **${t.net_pnl ?? "—"} USDT** · R **${t.r_multiple ?? "—"}** · ${t.exit_reason || t.outcome || ""}\n`;
  }
  return md;
}

// buildBrief(trade) -> brief CONCIS lu par la routine AVANT de gérer un trade (Imp 1, suivi
// qualitatif). Fait FLUER l'analyse passée du trade (thèse + invalidation + R courant + dernière
// action + décroissance du /14) vers la décision de gestion -> continuité au lieu de re-dériver.
// PUR. `journal.js trade <id>` l'imprime.
function buildBrief(trade) {
  const t = trade;
  if (!t) return "(trade introuvable)";
  const entry = t.entry_actual ?? t.entry_planned ?? t.entry ?? "—";
  const tps = Array.isArray(t.take_profits) ? t.take_profits.map((x) => (x && x.px != null ? x.px : x)).join("/") : "—";
  const e = Number(entry), sl = Number(t.stop_loss), sz = Number(t.size);
  const riskUsd = Math.abs(e - sl) * sz > 0 ? +(Math.abs(e - sl) * sz).toFixed(2) : null;
  const rOf = (upnl) => (riskUsd && typeof upnl === "number" ? +(upnl / riskUsd).toFixed(2) : null);

  let s = `📋 BRIEF ${t.id} — ${t.strategy || "?"} ${t.side || "?"} [${_badge(t.status, t.net_pnl)}]\n`;
  s += `• entrée ${entry} · SL ${t.stop_loss ?? "—"} · TP ${tps} · taille ${t.size ?? "—"}${riskUsd != null ? ` · risque ${riskUsd} USDT` : ""}\n`;
  s += `• thèse: ${(t.rationale || "—").replace(/\n/g, " ").slice(0, 180)}\n`;
  s += `• invalidation: ${t.invalidation || "—  (À LOGGER à l'entrée : la condition qui casse la thèse)"}\n`;

  const tl = Array.isArray(t.timeline) ? t.timeline : [];
  if (t.status === "closed") {
    s += `• résultat: sortie ${t.avg_exit ?? "—"} · PnL net ${t.net_pnl ?? "—"} USDT · R ${t.r_multiple ?? "—"} · ${t.exit_reason || t.outcome || ""}`;
  } else if (tl.length) {
    const last = tl[tl.length - 1];
    const R = rOf(typeof last.upnl === "number" ? last.upnl : undefined);
    s += `• état: mark ${last.mark ?? "—"} · uPnL ${last.upnl ?? "—"} USDT${R != null ? ` (${R}R)` : ""} · dernière action: ${last.decision || "—"}\n`;
    s += `• dernière note (${last.ts || "—"}): ${(last.note || "—").replace(/\n/g, " ")}`;
    const totals = tl.map((x) => (x.score && typeof x.score.total === "number" ? x.score.total : null)).filter((v) => v != null);
    if (totals.length) {
      const f = totals[0], l = totals[totals.length - 1];
      s += `\n• /14: ${f}→${l} sur ${tl.length} snapshot(s)${l < f ? " ⚠️ score en DÉCROISSANCE (thèse qui s'affaiblit → resserrer SL / sortir)" : ""}`;
    }
  } else {
    s += `• état: aucun snapshot de gestion (noter via 'journal.js note' à CHAQUE routine)`;
  }
  return s;
}

// Trades open/pending dont le dernier snapshot n'est PAS daté `today` (ou absent). Pur.
function staleOpen(trades, today) {
  return (trades || [])
    .filter((t) => ["open", "pending"].includes(t.status))
    .map((t) => {
      const tl = Array.isArray(t.timeline) ? t.timeline : [];
      const last = tl.length ? tl[tl.length - 1].ts : null;
      const lastDate = last ? String(last).slice(0, 10) : null;
      return { id: t.id, last_snapshot: lastDate, stale: lastDate !== today };
    })
    .filter((x) => x.stale);
}

module.exports = { DECISIONS, addSnapshot, renderTradePage, staleOpen, buildBrief };
