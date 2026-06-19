#!/usr/bin/env node
"use strict";
// Tests offline du detecteur de DISPERSION (scan.js dispersion). Zero reseau.
// Design : docs/plans/2026-06-16-bilateral-dispersion-monitoring-design.md.
// Le L+S simultane (hedge) est un WASH en regime correle (corr 0.82, 15.06) et devient un EDGE en
// DISPERSION (les paires se decouplent). dispersion() informe quand le hedge est pertinent (jamais un gate dur).
// Run: node tests/test-dispersion.js
const { dispersion } = require("../trade-journal/scan.js");
let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log("  PASS  " + name); } else { failed++; console.log("  FAIL  " + name); } }
const rowsCorr = (corrs) => corrs.map((c, i) => ({ pair: "ALT" + i, beta: { vs_btc: 1, corr: c } }));

// ── concentrated : corr eleve -> wash, hedge OFF ──
const conc = dispersion(rowsCorr([0.8, 0.85, 0.82, 0.79, 0.9, 0.88, 0.81, 0.83]));
ok("concentrated : mean_corr eleve", conc.mean_corr >= 0.7);
ok("concentrated : regime=concentrated", conc.regime === "concentrated");
ok("concentrated : hedge_enabled=false (wash correle)", conc.hedge_enabled === false);

// ── dispersed : corr bas + >=3 decouples -> hedge ON ──
const disp = dispersion(rowsCorr([0.2, 0.3, 0.1, 0.35, 0.25, 0.15, 0.4, 0.3]));
ok("dispersed : mean_corr bas", disp.mean_corr < 0.5);
ok("dispersed : n_decoupled >=3", disp.n_decoupled >= 3);
ok("dispersed : regime=dispersed", disp.regime === "dispersed");
ok("dispersed : hedge_enabled=true", disp.hedge_enabled === true);

// ── mixed : entre les deux ──
const mix = dispersion(rowsCorr([0.6, 0.6, 0.6, 0.6, 0.6]));
ok("mixed : regime=mixed (0.5<=mean<0.7, pas assez de decouples)", mix.regime === "mixed");
ok("mixed : hedge_enabled=false", mix.hedge_enabled === false);

// ── la condition dispersed exige mean<0.5 ET n_decoupled>=3 (le ET) ──
const lowMeanFewDecoupled = dispersion(rowsCorr([0.1, 0.2, 0.7, 0.7, 0.7])); // mean 0.48 mais seulement 2 decouples
ok("mean<0.5 mais <3 decouples -> PAS dispersed (le ET)", lowMeanFewDecoupled.regime !== "dispersed" && lowMeanFewDecoupled.hedge_enabled === false);

// ── BTC exclu + lignes error/null ignorees ──
const withNoise = dispersion([
  { pair: "BTC", beta: { vs_btc: 1, corr: 1 } },        // BTC exclu (corr 1 sinon fausserait)
  { pair: "X", error: "timeout" },                       // error ignore
  { pair: "Y", beta: null },                             // beta null ignore
  ...rowsCorr([0.2, 0.25, 0.3]),
]);
ok("BTC + error + beta:null exclus, compte 3 paires", withNoise.n_pairs === 3);
ok("BTC corr=1 n'est pas compte dans mean_corr", withNoise.mean_corr < 0.5);

// ── garde-fou : trop peu de paires -> unknown, hedge OFF ──
const few = dispersion(rowsCorr([0.3, 0.2]));
ok("moins de 3 paires -> regime unknown, hedge off", few.regime === "unknown" && few.hedge_enabled === false);
ok("rows vide -> unknown sans crash", dispersion([]).regime === "unknown");
ok("rows null -> unknown sans crash", dispersion(null).regime === "unknown");

console.log("\n" + passed + " pass / " + failed + " fail");
process.exit(failed ? 1 : 0);
