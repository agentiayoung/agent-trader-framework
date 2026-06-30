"use strict";
// ═══════════════════════════════════════════════════════════════════
// dashboard/api/edges.js — Performance par edge des 2 agents (PUR).
//
// Agrège les trades CLOS (`trades.jsonl`) par stratégie et par côté :
// n, win-rate, expectancy (moyenne des R-multiples), PnL net cumulé.
// Calcule directement à partir des trades (pas de dépendance aux modules
// scalp-only demo-exit/scoreboard). LECTURE SEULE.
// ═══════════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");

// Stratégie synthétique posée par cmd_reconcile sur un fill Bybit sans trade armé
// correspondant (journal.js:952/961). Ce n'est PAS une stratégie : c'est un artefact de
// réconciliation (fragment de scale-out non réclamé par le trade armé, ou quasi-duplicat).
// L'inclure dans by_strategy le faisait remonter comme « stratégie la plus fréquente » et
// faussait wr/sum_net/by_side. On le SORT des stats d'edge et on l'expose à part (`reconcile`).
// NB : ne cible QUE la strategy synthétique exacte — un id `bybit-*` repurposé vers une vraie
// stratégie (ex. S1_short_bounce) garde sa strategy et reste compté normalement.
const RECONCILE_STRATEGY = "reconcile_orphan";
const isReconcileArtifact = (t) => t && t.strategy === RECONCILE_STRATEGY;

// PnL net d'un trade (fallback realized si net absent). Le NET (apres frais) est le verdict
// win/loss — un gain BRUT mange par les frais = une PERTE nette (fix 29.06 : le champ `outcome`
// historique etait calcule sur le brut -> faux wins sur les petits trades).
const netOf = (t) => (typeof t.net_pnl === "number" ? t.net_pnl : (typeof t.realized_pnl === "number" ? t.realized_pnl : 0));

// Stats d'un groupe de trades clos. PURE. Win/loss = NET (jamais le champ `outcome` brut).
function statOf(trades) {
  const closed = trades.filter((t) => t && t.status === "closed");
  const withR = closed.filter((t) => typeof t.r_multiple === "number");
  const wins = closed.filter((t) => netOf(t) > 0).length;
  const sumR = withR.reduce((s, t) => s + t.r_multiple, 0);
  const sumNet = closed.reduce((s, t) => s + (typeof t.net_pnl === "number" ? t.net_pnl : 0), 0);
  return {
    n: closed.length,
    wins,
    wr: closed.length ? (wins / closed.length) * 100 : 0,
    expectancy: withR.length ? sumR / withR.length : null,
    sum_net: sumNet,
  };
}

// Agrège un journal (tableau de trades) -> stats globales + par stratégie + par côté. PURE.
// Les artefacts de réconciliation (`reconcile_orphan`) sont EXCLUS des stats d'edge (base,
// by_strategy, by_side) et résumés à part dans `reconcile` (n + PnL net non attribué à une
// stratégie). Leur PnL reste comptabilisé pour l'equity ailleurs (cmd_reconcile), pas ici.
function aggEdges(trades) {
  const all = Array.isArray(trades) ? trades : [];
  const list = all.filter((t) => !isReconcileArtifact(t)); // stats d'edge = vraies stratégies seulement
  const base = statOf(list);

  const byStratMap = {};
  for (const t of list) {
    if (!t || t.status !== "closed") continue;
    const k = t.strategy || "(inconnu)";
    (byStratMap[k] = byStratMap[k] || []).push(t);
  }
  const by_strategy = Object.keys(byStratMap)
    .map((k) => {
      const s = statOf(byStratMap[k]);
      return { strategy: k, n: s.n, wr: s.wr, avg_r: s.expectancy, sum_net: s.sum_net };
    })
    .sort((a, b) => b.n - a.n);

  const longs = list.filter((t) => t && t.side === "long");
  const shorts = list.filter((t) => t && t.side === "short");
  const by_side = { long: statOf(longs), short: statOf(shorts) };

  // Bloc séparé : fills réconciliés hors-stratégie (affiché comme une ligne distincte).
  const reconcile = statOf(all.filter(isReconcileArtifact));

  return Object.assign({}, base, { by_strategy, by_side, reconcile });
}

// PURE : les 2 agents.
function buildEdges(agentTrades, scalpTrades) {
  return { agent: aggEdges(agentTrades || []), scalp: aggEdges(scalpTrades || []) };
}

function readTrades(file) {
  try {
    return fs.readFileSync(file, "utf-8").trim().split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  } catch (_) { return []; }
}

function readEdges() {
  const { resolveDirs } = require("../../trade-journal/portfolio.js");
  const { agentDir, scalpDir } = resolveDirs();
  return buildEdges(readTrades(path.join(agentDir, "trades.jsonl")), readTrades(path.join(scalpDir, "trades.jsonl")));
}

module.exports = { aggEdges, buildEdges, statOf, readEdges, netOf };
