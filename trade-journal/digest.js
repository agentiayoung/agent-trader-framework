"use strict";
// ═══════════════════════════════════════════════════════════════════
// digest.js — état consolidé de l'agent (observabilité) + heartbeat.
//
// PUR : `buildDigest(state)` ne fait aucune I/O — il met en forme un état
// déjà assemblé en un message Telegram compact. `journal.js digest` assemble
// l'état (offline : trades.jsonl + equity.json + timeline + score-eval) et
// appelle buildDigest. `journal.js heartbeat` écrit routines/heartbeat.json et
// pingue un dead-man externe (HEALTHCHECK_PING_URL) -> détecte un agent muet.
//
// Raison d'être : le pire bug d'un agent autonome est le SILENCE (routine qui
// ne tourne plus). Le heartbeat + dead-man + digest le rendent observable.
// ═══════════════════════════════════════════════════════════════════

function _posLine(t) {
  const tl = Array.isArray(t.timeline) ? t.timeline : [];
  const last = tl.length ? tl[tl.length - 1] : null;
  const entry = t.entry_actual ?? t.entry_planned ?? t.entry ?? "?";
  let line = `• ${t.side} ${t.symbol} ${t.size ?? ""} @ ${entry}`;
  if (last && last.mark != null) line += ` (mark ${last.mark}${last.upnl != null ? `, uPnL ${last.upnl > 0 ? "+" : ""}${last.upnl}` : ""})`;
  if (last && last.decision) line += ` — ${last.decision}`;
  else line += " — non noté";
  return line;
}

// Construit le message digest (Telegram markdown compact). Pur.
// state = { ts, equity, day_pnl_pct, drawdown_pct, halt, open[], pending[],
//           today_trades, today_no_trades, stale_count, score_eval_n }
function buildDigest(state) {
  const s = state || {};
  const eq = s.equity != null ? `${Number(s.equity).toFixed(0)} USDT` : "—";
  const dp = s.day_pnl_pct != null ? `${s.day_pnl_pct > 0 ? "+" : ""}${Number(s.day_pnl_pct).toFixed(2)}%` : "—";
  const breaker = s.halt ? "🛑 HALT" : "✅ OK";
  const open = Array.isArray(s.open) ? s.open : [];
  const pending = Array.isArray(s.pending) ? s.pending : [];
  let md = `🤖 *Agent Trader* — ${s.ts || "?"}\n`;
  md += `💰 Equity ${eq} · jour ${dp} · breaker ${breaker}\n`;
  md += `📊 Positions ${open.length + pending.length}/4 (open ${open.length}, pending ${pending.length})\n`;
  for (const t of [...open, ...pending]) md += `  ${_posLine(t)}\n`;
  md += `🆕 Aujourd'hui : ${s.today_trades ?? 0} trade(s), ${s.today_no_trades ?? 0} no-trade(s)\n`;
  if (s.stale_count) md += `⚠️ ${s.stale_count} trade(s) open/pending NON noté(s) aujourd'hui (timeline trouée)\n`;
  md += `🎯 score-eval : n=${s.score_eval_n ?? 0}`;
  if (s.zones_fallback && s.zones_fallback.n) {
    const z = s.zones_fallback;
    md += `\n🗺️ zones : ${Math.round((z.rate || 0) * 100)}% screener_fallback (Desktop lu ${z.desktop}/${z.n}, ${z.days}j)`;
  }
  return md;
}

// Construit l'objet heartbeat (état machine compact, pour le dead-man). Pur.
function buildHeartbeat(state) {
  const s = state || {};
  return {
    ts: s.ts || null,
    equity: s.equity != null ? Number(s.equity) : null,
    open: Array.isArray(s.open) ? s.open.length : 0,
    pending: Array.isArray(s.pending) ? s.pending.length : 0,
    day_pnl_pct: s.day_pnl_pct != null ? Number(s.day_pnl_pct) : null,
    halt: !!s.halt,
    stale_count: s.stale_count || 0,
  };
}

// Le heartbeat est-il périmé ? (dead-man côté lecteur). Pur.
// lastTsMs = Date.parse du heartbeat ; nowMs = maintenant ; maxAgeMin = seuil.
function isStale(lastTsMs, nowMs, maxAgeMin) {
  if (!lastTsMs || isNaN(lastTsMs)) return true;
  return (nowMs - lastTsMs) > maxAgeMin * 60 * 1000;
}

module.exports = { buildDigest, buildHeartbeat, isStale };
