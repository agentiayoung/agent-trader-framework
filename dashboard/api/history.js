"use strict";
// ═══════════════════════════════════════════════════════════════════
// dashboard/api/history.js — Historique COMPLET des trades clos des 2 agents (PUR).
//
// Lit les `trades.jsonl` (agent-trader 4H + scalp-trader), filtre les trades CLOS
// (exclut la plomberie MANUAL_TEST), normalise en lignes plates, trie par date de
// clôture, et calcule les analytics (totaux par agent + combiné, courbe de PnL net
// cumulé, distribution des R-multiples, perf par stratégie/côté via edges.js).
// LECTURE SEULE. Aucune écriture, aucun secret, aucune exécution.
// ═══════════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");
const { aggEdges, statOf, netOf } = require("./edges.js");

// Plomberie de test (cf. portfolio.js isTest) — exclue de l'historique.
const isTest = (t) => /^MANUAL_TEST/i.test((t && t.strategy) || "");

// Lecture tolérante (1 ligne corrompue ne tue pas le calcul).
function readTrades(file) {
  try {
    return fs.readFileSync(file, "utf-8").trim().split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } })
      .filter(Boolean);
  } catch (_) { return []; }
}

const num = (x) => (typeof x === "number" && !Number.isNaN(x) ? x : null);

// Durée de détention en minutes (null si timestamps absents/invalides).
// DEPUIS LE FILL (30.06, Hugo) : la durée se compte A PARTIR DU MOMENT OU LE LIMIT EST TOUCHE
// (ts_fill, stampe a la transition pending->open), PAS depuis la pose/arm (ts_open).
// GARDE-FOU ts_fill<ts_open (30.06) : le reconcile pouvait deriver ts_fill du createdTime d'une VIEILLE
// position Bybit (one-way mode) -> ts_fill ANTERIEUR a ts_open -> duree fantome de plusieurs jours/semaines.
// ts_fill n'est valide que s'il est >= ts_open (un fill suit l'arm) ; sinon fallback ts_open.
function durationMin(tsFill, tsOpen, tsClose) {
  const o = Date.parse(tsOpen), f = Date.parse(tsFill), b = Date.parse(tsClose);
  const a = (Number.isFinite(f) && (!Number.isFinite(o) || f >= o)) ? f : o;
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
  return Math.round((b - a) / 60000);
}

// Normalise un trade clos en une ligne plate pour le dashboard. PURE.
function normalizeTrade(t, agent) {
  return {
    agent,
    id: t.id || null,
    symbol: t.symbol || "—",
    side: t.side || null,
    strategy: t.strategy || "(inconnu)",
    // win/loss = NET (apres frais), pas le champ `outcome` brut (faux wins sur petits trades).
    outcome: (num(t.net_pnl) != null || num(t.realized_pnl) != null) ? (netOf(t) > 0 ? "win" : "loss") : (t.outcome || null),
    outcome_raw: t.outcome || null, // garde l'ancien champ pour debug/drill-down
    r_multiple: num(t.r_multiple),
    net_pnl: num(t.net_pnl),
    realized_pnl: num(t.realized_pnl),
    fees: num(t.fees),
    size: num(t.size),
    entry_actual: num(t.entry_actual),
    avg_exit: num(t.avg_exit),
    exit_reason: t.exit_reason || null,
    ts_open: t.ts_open || null,
    ts_fill: t.ts_fill || null,
    ts_close: t.ts_close || null,
    duration_min: durationMin(t.ts_fill, t.ts_open, t.ts_close),
    track: t.track || null,
    origin: t.origin || null,
    is_partial: !!t.is_partial,
    // Détail (drill-down) — souvent partiels selon l'historique.
    review: t.review || null,
    invalidation: t.invalidation || null,
    timeline: Array.isArray(t.timeline) ? t.timeline : [],
  };
}

// Totaux enrichis d'un groupe de lignes (réutilise statOf d'edges.js) + best/worst R. PURE.
function totalsOf(rows) {
  // statOf (edges.js) filtre sur status:closed -> les lignes normalisees n'ont pas ce champ.
  const s = statOf(rows.map((r) => Object.assign({ status: "closed" }, r)));
  const withR = rows.filter((r) => r.r_multiple != null);
  let best = null, worst = null;
  for (const r of withR) {
    if (best == null || r.r_multiple > best.r_multiple) best = r;
    if (worst == null || r.r_multiple < worst.r_multiple) worst = r;
  }
  return {
    n: s.n, wins: s.wins, wr: s.wr, expectancy: s.expectancy, sum_net: s.sum_net,
    best: best ? { id: best.id, symbol: best.symbol, r_multiple: best.r_multiple, net_pnl: best.net_pnl } : null,
    worst: worst ? { id: worst.id, symbol: worst.symbol, r_multiple: worst.r_multiple, net_pnl: worst.net_pnl } : null,
  };
}

// Courbe de PnL net cumulé (ordre chronologique de clôture). PURE.
function equityCurve(rows) {
  const sorted = rows.filter((r) => r.ts_close).slice().sort((a, b) => Date.parse(a.ts_close) - Date.parse(b.ts_close));
  let cum = 0;
  return sorted.map((r) => { cum += r.net_pnl || 0; return { ts: r.ts_close, cum: +cum.toFixed(2) }; });
}

// Distribution des R-multiples en buckets fixes. PURE.
const R_BUCKETS = [
  { key: "<-1", lo: -Infinity, hi: -1 },
  { key: "-1..-0.5", lo: -1, hi: -0.5 },
  { key: "-0.5..0", lo: -0.5, hi: 0 },
  { key: "0..0.5", lo: 0, hi: 0.5 },
  { key: "0.5..1", lo: 0.5, hi: 1 },
  { key: "1..2", lo: 1, hi: 2 },
  { key: ">2", lo: 2, hi: Infinity },
];
function rDistribution(rows) {
  const out = R_BUCKETS.map((b) => ({ key: b.key, n: 0 }));
  for (const r of rows) {
    if (r.r_multiple == null) continue;
    const i = R_BUCKETS.findIndex((b) => r.r_multiple >= b.lo && r.r_multiple < b.hi);
    if (i >= 0) out[i].n++;
  }
  return out;
}

// PURE : construit l'historique complet + analytics depuis les trades bruts des 2 agents.
function buildHistory(agentTrades, scalpTrades) {
  const norm = (arr, name) => (Array.isArray(arr) ? arr : [])
    .filter((t) => t && t.status === "closed" && !isTest(t))
    .map((t) => normalizeTrade(t, name));

  const agentRows = norm(agentTrades, "agent");
  const scalpRows = norm(scalpTrades, "scalp");
  const all = agentRows.concat(scalpRows);
  // Tri par clôture décroissante (les plus récents en tête).
  all.sort((a, b) => Date.parse(b.ts_close || 0) - Date.parse(a.ts_close || 0));

  // by_strategy / by_side : réutilise aggEdges (attend status:closed + side + r_multiple/net_pnl).
  const edgeRows = all.map((r) => Object.assign({ status: "closed" }, r));

  return {
    trades: all,
    analytics: {
      totals: {
        agent: totalsOf(agentRows),
        scalp: totalsOf(scalpRows),
        combined: totalsOf(all),
      },
      equity_curve: {
        combined: equityCurve(all),
        agent: equityCurve(agentRows),
        scalp: equityCurve(scalpRows),
      },
      r_distribution: rDistribution(all),
      by_strategy: aggEdges(edgeRows).by_strategy,
      by_side: aggEdges(edgeRows).by_side,
    },
  };
}

function readHistory() {
  const { resolveDirs } = require("../../trade-journal/portfolio.js");
  const { agentDir, scalpDir } = resolveDirs();
  const agentTrades = readTrades(path.join(agentDir, "trades.jsonl"));
  const scalpTrades = readTrades(path.join(scalpDir, "trades.jsonl"));
  if (!agentTrades.length && !scalpTrades.length) return { stale: true, trades: [], analytics: null };
  return buildHistory(agentTrades, scalpTrades);
}

module.exports = { buildHistory, normalizeTrade, totalsOf, equityCurve, rDistribution, readHistory };
