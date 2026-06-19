#!/usr/bin/env node
"use strict";
// Tests offline deterministes de la disposition FADE ancree structure (placement.js).
// Cf. design sweep-fade §8. Zero reseau. Run: node tests/test-placement.js
const { buildPlacement, floorAtr } = require("../trade-journal/placement.js");
let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log("  PASS  " + name); } else { failed++; console.log("  FAIL  " + name); } }
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

// ── floorAtr par famille ──
ok("floor MR8 = 2.5", floorAtr("MR8_MTF") === 2.5);
ok("floor S1 = 1.5", floorAtr("S1_short_bounce") === 1.5);
ok("floor inconnu = 1", floorAtr("XYZ") === 1);

// ── SHORT — cas SUI-like : entrees AU-DESSUS de la resistance, SL bien haut, TP supports ──
const s = buildPlacement({
  side: "short", setup: "MR8_MTF", entry_zone: 0.768, atr: 0.0198, risk_usd: 1200,
  overshoot_zones: [0.78, 0.80, 0.82], target_levels: [0.749, 0.731, 0.691], swing: 0.7805,
});
ok("3 rungs", s.rungs.length === 3);
ok("R1 = bout de la resistance (entry_zone)", s.rungs[0].entry === 0.768);
ok("R2 ancre sur 1ere zone overshoot au-dessus", s.rungs[1].entry === 0.78);
ok("R3 ancre sur 2e zone overshoot", s.rungs[2].entry === 0.8);
ok("tous les rungs AU-DESSUS de la resistance (short)", s.rungs.every(r => r.entry >= 0.768));
ok("SL au-dessus du rung le plus haut (bien haut)", s.sl > 0.80);
ok("SL >= floor 2.5xATR du rung le plus proche", s.sl_dist_closest_atr >= 2.5 - 0.02);
ok("SL au-dela du swing", s.sl > 0.7805);
ok("TP QUICK = front-run du support le plus proche (0.749 + 0.15xATR = 0.75197)", near(s.tp_zones.quick, 0.75197, 1e-4));
ok("QUICK plus proche de l'entree que main (1er TP rapide)", Math.abs(0.768 - s.tp_zones.quick) < Math.abs(0.768 - s.tp_zones.main_before_support));
ok("TP main AVANT le support le plus bas (>0.691, court pour un short)", s.tp_zones.main_before_support > 0.691 && s.tp_zones.main_before_support < 0.768);
ok("TP runner AU-DELA du support le plus bas (<0.691)", s.tp_zones.runner_beyond_support < 0.691);
ok("rung profond (R3) porte le runner", s.rungs[2].is_runner === true && s.rungs[0].is_runner === false);
ok("R1 TP1 = QUICK (1er partiel rapide)", near(s.rungs[0].take_profits[0].px, s.tp_zones.quick));
ok("R3 (profond) = 3 paliers quick/main/runner", s.rungs[2].take_profits.length === 3
  && near(s.rungs[2].take_profits[0].px, s.tp_zones.quick) && near(s.rungs[2].take_profits[1].px, s.tp_zones.main_before_support) && near(s.rungs[2].take_profits[2].px, s.tp_zones.runner_beyond_support));
ok("R1/R2 (non profonds) = 2 paliers quick/main", s.rungs[0].take_profits.length === 2 && s.rungs[1].take_profits.length === 2
  && near(s.rungs[0].take_profits[1].px, s.tp_zones.main_before_support));
ok("fracs somment a 1 sur chaque rung", s.rungs.every(r => near(r.take_profits.reduce((a, t) => a + t.frac, 0), 1)));
ok("TP tous SOUS l'entree (short valide)", s.rungs.every(r => r.take_profits.every(t => t.px < r.entry)));
ok("n_stops = 10 (3 SL + 2+2+3 TP, cap Bybit)", s.n_stops === 10);
// risque EGAL par rung, total = budget
const totalRisk = s.rungs.reduce((a, r) => a + r.size * Math.abs(s.sl - r.entry), 0);
ok("risque total = budget 1200", near(totalRisk, 1200, 1));
ok("risque EGAL par rung (400 chacun)", s.rungs.every(r => r.risk_usd === 400));
ok("R3 (proche du SL) = plus GROSSE size que R1", s.rungs[2].size > s.rungs[0].size);
ok("pas de warning geometrie", !s.warnings.some(w => /floor/.test(w)));

// ── LONG — miroir : entrees SOUS le support, SL bien bas, TP resistances ──
const l = buildPlacement({
  side: "long", setup: "S1_MTF", entry_zone: 100, atr: 2, risk_usd: 900,
  overshoot_zones: [97, 94, 91], target_levels: [105, 110, 118], swing: 99.5,
});
ok("LONG: rungs SOUS le support", l.rungs.every(r => r.entry <= 100));
ok("LONG: R1 = support", l.rungs[0].entry === 100);
ok("LONG: SL SOUS le rung le plus bas (bien bas, ~floor 1.5xATR)", l.sl < 94 && l.sl <= 91 + 0.02);
ok("LONG: TP tous AU-DESSUS de l'entree", l.rungs.every(r => r.take_profits.every(t => t.px > r.entry)));
ok("LONG: runner AU-DELA de la resistance haute (>118)", l.tp_zones.runner_beyond_support > 118);
ok("LONG: main avant la resistance haute (<118)", l.tp_zones.main_before_support < 118 && l.tp_zones.main_before_support > 100);

// ── FALLBACK ATR : pas de zones overshoot -> ladder +0.5xATR ; pas de targets -> TP ATR ──
const f = buildPlacement({ side: "short", setup: "S1_MTF", entry_zone: 50, atr: 1, risk_usd: 600 });
ok("fallback: 3 rungs en +0.5xATR", f.rungs[1].entry === 50.5 && f.rungs[2].entry === 51);
ok("fallback: marque fallback_used", f.fallback_used === true);
ok("fallback: SL >= floor S1 1.5xATR", f.sl_dist_closest_atr >= 1.5 - 0.02);
ok("fallback: TP ATR (quick 0.7x/main 2x/runner 3x sous l'entree)", near(f.tp_zones.quick, 49.3) && f.tp_zones.main_before_support === 48 && f.tp_zones.runner_beyond_support === 47);
ok("fallback: warning targets manquants", f.warnings.some(w => /target/.test(w)));

// ── garde-fous d'input ──
let threw = false; try { buildPlacement({ side: "x", entry_zone: 1, atr: 1, risk_usd: 1 }); } catch { threw = true; }
ok("rejette side invalide", threw);
threw = false; try { buildPlacement({ side: "short", entry_zone: 1, atr: 0, risk_usd: 1 }); } catch { threw = true; }
ok("rejette atr<=0", threw);

console.log(`\n${passed} pass / ${failed} fail`);
process.exit(failed ? 1 : 0);
