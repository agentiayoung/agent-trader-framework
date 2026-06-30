"use strict";
// ═══════════════════════════════════════════════════════════════════
// dashboard/api/grid.js — Grille multi-actifs (PUR).
//
// Digère `scan-latest.all[]` en une ligne par paire prête pour la table
// heatmap : prix, %24h, indicateurs (RSI d/h, MACD, StochRSI, ADX, trend,
// regime), h1, cycle, OBV (= signal de VOLUME du dataset ; pas de volume
// brut exposé par le scan), reclaim, beta. LECTURE SEULE, graceful.
// ═══════════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");

// PURE : digère UNE ligne de scan-latest.all[]. null si absente.
function buildRow(a) {
  if (!a) return null;
  return {
    pair: a.pair || null,
    asset_class: a.asset_class || null,
    tradable: a.tradable != null ? !!a.tradable : null,
    session: a.session || null,
    session_open: a.session_open != null ? !!a.session_open : null,
    px: a.px != null ? a.px : null,
    chg24: a.chg24 != null ? a.chg24 : null,
    dRsi: a.dRsi != null ? a.dRsi : null,
    hRsi: a.hRsi != null ? a.hRsi : null,
    macd: a.macd || null,
    stoch: a.stoch != null ? a.stoch : null,
    trend: a.trend || null,
    regime: a.regime || null,
    regime_d: a.regime_d || null,
    dAdx: a.dAdx != null ? a.dAdx : null,
    adx_dir: a.adx_dir || null,
    funding: a.funding != null ? a.funding : null,
    h1: a.h1
      ? { rsi: a.h1.rsi != null ? a.h1.rsi : null, dir: a.h1.dir || null, trend: a.h1.trend || null, macd: a.h1.macd || null, stochrsi: a.h1.stochrsi != null ? a.h1.stochrsi : null }
      : null,
    cycle: a.cycle
      ? { range_pos: a.cycle.range_pos != null ? a.cycle.range_pos : null, dist_low_pct: a.cycle.dist_low_pct != null ? a.cycle.dist_low_pct : null, at_cycle_low: !!a.cycle.at_cycle_low, days_since_low: a.cycle.days_since_low != null ? a.cycle.days_since_low : null }
      : null,
    reclaim_d50: a.reclaim_d50 != null ? !!a.reclaim_d50 : null,
    reclaim_ema200d: a.reclaim_ema200d != null ? !!a.reclaim_ema200d : null,
    divergence: a.divergence || null,
    obv: a.obv ? (a.obv.trend || null) : null,           // signal volume (OBV)
    obv_divergence: a.obv ? (a.obv.divergence || null) : null,
    beta: a.beta && a.beta.vs_btc != null ? a.beta.vs_btc : null,
  };
}

// PURE : digère le scan complet -> { rows } ou stale.
function buildGrid(scan) {
  const all = scan && scan.all;
  if (!Array.isArray(all)) return { stale: true, reason: "scan-latest.all absent" };
  return { stale: false, ts: scan.ts || null, scanned: scan.scanned != null ? scan.scanned : all.length, rows: all.map(buildRow).filter(Boolean) };
}

// Lecture réelle : scan le plus FRAIS des 2 agents + source retenue.
function readGrid() {
  const { readFreshestScan } = require("./sources.js");
  const { scan, source } = readFreshestScan();
  return Object.assign(buildGrid(scan), { scan_source: source });
}

module.exports = { buildGrid, buildRow, readGrid };
