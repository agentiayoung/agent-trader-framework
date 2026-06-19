"use strict";
// ═══════════════════════════════════════════════════════════════════
// manage.js — alertes de GESTION deterministes (resserrement de SL).
//
// PUR : aucune I/O, aucun reseau, deterministe (testable offline).
//
// Raison d'etre (audit 12.06) : DOGE short a perdu -0.96R (-997 USDT) dans le
// squeeze de soulagement que la lentille CYCLE avait annonce. Au run 14:07 DOGE
// portait `divergence:bull` (vendeurs epuises) mais a garde son SL planifie ->
// stoppe. Au contraire DOT (at_cycle_low) avait ete PROACTIVEMENT resserre au
// run 10:07 (SL 1.008->0.966) -> petite perte -0.34R. La difference = un signal
// de retournement sur un short LIVE doit declencher un resserrement de SL, pas
// un simple watch.
//
// Ce module CROISE les positions actives avec le scan (divergence/cycle par paire
// + bottom_watch.alt_capitulation) et flague les shorts a risque de squeeze. Le
// LLM de la routine APPLIQUE (resserre/sort) — c'est de l'observabilite DURE
// (deterministe + surface obligatoire), pas un auto-trade.
//
// Cote SHORT uniquement : la lentille cycle est un detecteur de BOTTOM (fin de
// bear). Pas de "top_watch" symetrique cote long tant qu'il n'est pas defini/valide.
// ═══════════════════════════════════════════════════════════════════

// Normalise un symbole de trade ("DOGE", "DOGE/USDT:USDT", "DOGEUSDT") -> clef paire ("DOGE").
function pairKey(symbol) {
  return String(symbol || "").toUpperCase().replace(/USDT.*$/, "").replace(/[^A-Z0-9]/g, "");
}

// slTightenAlerts : pour chaque position OPEN/PENDING, croise avec le scan.
//   positions : trades actifs [{id, symbol, side, status}]
//   scanAll   : scan.all (toutes les paires : {pair, divergence, cycle:{at_cycle_low}, ...})
//   market    : scan.market ({bottom_watch:{alt_capitulation}})
// Retourne { alt_capitulation, n, alerts:[{id,symbol,side,status,action,reasons[]}] }.
// action : open -> "tighten_sl" (resserrer/breakeven) ; pending -> "reconsider_pending"
//          (un short qu'on s'apprete a armer dans une zone de retournement = a reconsiderer).
function slTightenAlerts(positions, scanAll, market) {
  const byPair = {};
  for (const r of (scanAll || [])) if (r && r.pair && !r.error) byPair[r.pair] = r;
  const altCap = !!(market && market.bottom_watch && market.bottom_watch.alt_capitulation);
  const alerts = [];
  for (const p of (positions || [])) {
    if (p.status !== "open" && p.status !== "pending") continue;
    if (p.side !== "short") continue;                 // cycle lens = detecteur de bottom -> short only
    const r = byPair[pairKey(p.symbol)];
    if (!r) continue;                                  // paire absente du scan -> pas d'info
    const reasons = [];
    if (r.divergence === "bull" && altCap) {
      reasons.push("divergence:bull pendant alt_capitulation (vendeurs epuises SOUS le short = squeeze probable, lecon DOGE 12.06 -0.96R)");
    }
    if (r.cycle && r.cycle.at_cycle_low) {
      reasons.push("at_cycle_low (short dans une zone d'accumulation generationnelle = downside quasi nul, squeeze max -- lecon DOT 12.06, resserre proactivement)");
    }
    if (reasons.length) {
      alerts.push({
        id: p.id, symbol: p.symbol, side: p.side, status: p.status,
        action: p.status === "open" ? "tighten_sl" : "reconsider_pending",
        reasons,
      });
    }
  }
  return { alt_capitulation: altCap, n: alerts.length, alerts };
}

module.exports = { slTightenAlerts, pairKey };
