#!/usr/bin/env node
"use strict";
// Tests offline du monitoring trend-adaptatif (chantier B, approved 15.06). Zero reseau.
// Design : docs/plans/2026-06-15-trend-adaptive-trailing-design.md.
// Laisser COURIR les tendances gagnantes (S1/S2/S3/S12 + S5-trending) via un trail ADAPTATIF
// dans le verdict running ; les MEAN-REVERSION (MR8/MR4, S5-range) gardent leur TP FIXE.
// OBSERVABILITE (le LLM agit sur trail.mode), pas un exit auto. Run: node tests/test-trail.js
const { adxDir } = require("../trade-journal/scan.js");
const { trailGuidance, isTrendSetup, thesisHealth } = require("../trade-journal/thesis.js");
const { trendWinnerStats } = require("../trade-journal/review.js");
let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log("  PASS  " + name); } else { failed++; console.log("  FAIL  " + name); } }

// ── adxDir : direction de l'ADX (la tendance se renforce/s'essouffle) ──
// Tendance FRAICHE (chop puis trend) -> DX bondit, l'ADX lisse GRIMPE -> rising.
function chopThenTrend() { const C = []; for (let i = 0; i < 70; i++) C.push(100 + (i % 2 === 0 ? 0.4 : -0.4)); for (let i = 0; i < 35; i++) C.push(100 + i * 2); return { H: C.map((c) => c + 0.5), L: C.map((c) => c - 0.5), C }; }
const up = chopThenTrend();
ok("adxDir rising : tendance fraiche (chop -> trend, ADX grimpe)", adxDir(up.H, up.L, up.C, 14) === "rising");
// Tendance forte PUIS plat (chop) -> DX s'effondre -> ADX falling.
function trendThenChop() { const C = []; for (let i = 0; i < 70; i++) C.push(100 + i); for (let i = 0; i < 40; i++) C.push(170 + (i % 2 === 0 ? 0.3 : -0.3)); return { H: C.map((c) => c + 0.5), L: C.map((c) => c - 0.5), C }; }
const tc = trendThenChop();
ok("adxDir falling : tendance forte qui s'aplatit (ADX retombe)", adxDir(tc.H, tc.L, tc.C, 14) === "falling");
ok("adxDir null : serie trop courte sans crash", adxDir([1, 2, 3], [1, 2, 3], [1, 2, 3], 14) === null);

// ── isTrendSetup : classification trend vs MR (scope "Tous" = S1/S2/S3/S12 + S5-trending) ──
ok("S1 = trend", isTrendSetup("S1_short_bounce") === true);
ok("S2 = trend", isTrendSetup("S2_short_continuation") === true);
ok("S3 = trend (scope Tous)", isTrendSetup("S3_long_oversold") === true);
ok("S12 = trend", isTrendSetup("S12_squeeze_break") === true);
ok("MR8 = MR (jamais trend)", isTrendSetup("MR8_stochrsi_revert", { regime_d: "trending" }) === false);
ok("MR4 = MR (jamais trend)", isTrendSetup("MR4_bb_trendfilt", { regime_d: "strong" }) === false);
ok("S5 en range = MR (TP fixe)", isTrendSetup("S5_fade_range", { regime_d: "range" }) === false);
ok("S5 en trending = trend (scope Tous, approved)", isTrendSetup("S5_fade_range", { regime_d: "trending" }) === true);
ok("S5 en strong = trend", isTrendSetup("S5_fade_range", { regime_d: "strong" }) === true);
ok("S5 sans regime = MR par defaut (prudent)", isTrendSetup("S5_fade_range", {}) === false);

// ── trailGuidance : suggestion de trail pour un GAGNANT qui court ──
const shortPos = { side: "short", strategy: "S1_short_bounce", stop_loss: 110, entry_actual: 100 };
// renforce : ADX rising + momentum AVEC nous (macd bear) + rien contre -> LOOSE (laisser courir)
ok("LOOSE : S1 short, ADX rising + macd bear (momentum avec nous)", trailGuidance(shortPos, { adx_dir: "rising", macd: "bear", regime_d: "strong" }).mode === "loose");
// s'essouffle : ADX falling -> TIGHTEN (verrouiller)
ok("TIGHTEN : S1 short, ADX falling", trailGuidance(shortPos, { adx_dir: "falling", macd: "bear", regime_d: "strong" }).mode === "tighten_to_mature");
// s'essouffle : momentum se retourne (divergence bull contre un short) -> TIGHTEN
ok("TIGHTEN : S1 short, divergence bull (momentum se retourne)", trailGuidance(shortPos, { adx_dir: "flat", divergence: "bull", regime_d: "strong" }).mode === "tighten_to_mature");
// stable : ADX flat, momentum neutre/avec nous, rien contre -> NORMAL
ok("NORMAL : S1 short, ADX flat sans signal contre", trailGuidance(shortPos, { adx_dir: "flat", macd: "bear", regime_d: "strong" }).mode === "normal");
// MR -> fixed_tp QUOI QU'IL ARRIVE (meme ADX rising)
ok("FIXED_TP : MR8 ignore l'ADX (un MR revient)", trailGuidance({ side: "long", strategy: "MR8_stochrsi_revert" }, { adx_dir: "rising", macd: "bull", regime_d: "trending" }).mode === "fixed_tp");
ok("FIXED_TP : S5 en range garde le TP fixe", trailGuidance({ side: "short", strategy: "S5_fade_range" }, { adx_dir: "rising", macd: "bear", regime_d: "range" }).mode === "fixed_tp");
ok("ADAPTATIF : S5 en trending devient adaptatif", trailGuidance({ side: "short", strategy: "S5_fade_range" }, { adx_dir: "rising", macd: "bear", regime_d: "trending" }).mode === "loose");
// atr_mult indicatif : loose > normal > tighten
const lm = trailGuidance(shortPos, { adx_dir: "rising", macd: "bear", regime_d: "strong" }).atr_mult;
const tm = trailGuidance(shortPos, { adx_dir: "falling", regime_d: "strong" }).atr_mult;
ok("atr_mult loose > tighten (desserre vs resserre)", lm > tm);
ok("fixed_tp -> atr_mult null", trailGuidance({ side: "long", strategy: "MR8_stochrsi_revert" }, {}).atr_mult === null);

// ── Integration thesisHealth : trail attache UNIQUEMENT au verdict running ──
// S1 short gagnant (px 96 vs entry 100, SL 110 -> unrealR 0.4) + aucun flip -> running + trail.
const scanRunning = [{ pair: "FOO", px: 96, trend: "bear", macd: "bear", divergence: null, obv: { trend: "down" }, reclaim_d50: false, cycle: { at_cycle_low: false }, regime_d: "strong", adx_dir: "rising", setup: { side: "short", type: "S1_short_bounce" } }];
const posRunning = [{ id: "t1", symbol: "FOO/USDT:USDT", side: "short", status: "open", strategy: "S1_short_bounce", stop_loss: 110, entry_actual: 100 }];
const hr = thesisHealth(posRunning, scanRunning, {});
ok("thesisHealth : verdict running sur le gagnant S1", hr.positions[0].verdict === "running");
ok("thesisHealth : trail attache au running (loose, ADX rising)", hr.positions[0].trail && hr.positions[0].trail.mode === "loose");

// MR8 gagnant qui court -> running mais trail fixed_tp (ne pas laisser courir un MR).
const scanMr = [{ pair: "BAR", px: 96, trend: "bear", macd: "bear", divergence: null, obv: { trend: "down" }, reclaim_d50: false, cycle: { at_cycle_low: false }, regime_d: "range", adx_dir: "rising", setup: { side: "short", type: "MR8_stochrsi_revert" } }];
const posMr = [{ id: "t2", symbol: "BAR/USDT:USDT", side: "short", status: "open", strategy: "MR8_stochrsi_revert", stop_loss: 110, entry_actual: 100 }];
const hm = thesisHealth(posMr, scanMr, {});
ok("thesisHealth : MR8 running garde trail.fixed_tp", hm.positions[0].verdict === "running" && hm.positions[0].trail.mode === "fixed_tp");

// Position FLIPPED (perdante, 2 signaux forts) -> pas de trail (null).
const scanFlip = [{ pair: "BAZ", px: 105, trend: "bull", macd: "bull", divergence: "bull", obv: { trend: "up" }, reclaim_d50: true, cycle: { at_cycle_low: false }, regime_d: "trending", adx_dir: "rising", setup: { side: "long", type: "S8_breakout" } }];
const posFlip = [{ id: "t3", symbol: "BAZ/USDT:USDT", side: "short", status: "open", strategy: "S1_short_bounce", stop_loss: 110, entry_actual: 100 }];
const hf = thesisHealth(posFlip, scanFlip, {});
ok("thesisHealth : verdict flipped (perdant, signaux forts)", hf.positions[0].verdict === "flipped");
ok("thesisHealth : pas de trail sur un flipped (null)", hf.positions[0].trail == null);

// ── trendWinnerStats : mesure forward-test (plafond de R des trend-winners) ──
ok("trendWinnerStats : vide -> n 0", trendWinnerStats([]).n === 0);
const tradesMix = [
  { status: "closed", outcome: "win", r_multiple: 1.5, strategy: "S1_short_bounce" },
  { status: "closed", outcome: "win", r_multiple: 3.2, strategy: "S12_squeeze_break" },
  { status: "closed", outcome: "loss", r_multiple: -1.0, strategy: "S2_short_continuation" }, // loss exclue
  { status: "closed", outcome: "win", r_multiple: 2.0, strategy: "MR8_stochrsi_revert" },     // MR exclue
  { status: "open", outcome: "win", r_multiple: 4.0, strategy: "S1_short_bounce" },            // pas closed exclue
  { status: "closed", outcome: "win", r_multiple: null, strategy: "S3_long_oversold" },        // R non-numerique exclue
];
const tw = trendWinnerStats(tradesMix);
ok("trendWinnerStats : ne compte que les trend-winners clos a R numerique (n=2)", tw.n === 2);
ok("trendWinnerStats : max_r = 3.2 (S12)", tw.max_r === 3.2);
ok("trendWinnerStats : avg_r = 2.35 ((1.5+3.2)/2)", tw.avg_r === 2.35);

console.log("\n" + passed + " pass / " + failed + " fail");
process.exit(failed ? 1 : 0);
