#!/usr/bin/env node
"use strict";
// Tests offline deterministes du barème /14 (score.js). Zero reseau.
// Run: node tests/test-score.js
const { enrichScore, SCALE } = require("../trade-journal/score.js");
let passed = 0, failed = 0;
function eq(name, got, exp) {
  const g = JSON.stringify(got), e = JSON.stringify(exp);
  if (g === e) { passed++; console.log("  PASS  " + name); }
  else { failed++; console.log("  FAIL  " + name + " -> got " + g + " exp " + e); }
}
function ok(name, cond) { if (cond) { passed++; console.log("  PASS  " + name); } else { failed++; console.log("  FAIL  " + name); } }

// Barème somme bien à 14
eq("SCALE somme = 14", Object.values(SCALE).reduce((a, b) => a + b, 0), 14);

// Cas A+ : score plein, R:R eleve, gate ouvert
const a = enrichScore(
  { components: { zeiierman: 2, rsi: 2, macd: 2, regime: 1, supertrend: 1, stochrsi: 1, ai_signal: 1, fib: 1, adx: 1, vwap: 1, candle: 1 },
    gate: { regime_strong_opp: false, supertrend_flip_opp: false }, zones: "zeiierman" },
  { entry: 100, sl: 96, tp: 112 });
eq("A+ total", a.total, 14);
eq("A+ rr", a.rr, 3);
eq("A+ tier", a.tier, "A+");
ok("A+ gate.passed", a.gate.passed === true);

// Cas B : score moyen, R:R 2
const b = enrichScore(
  { components: { zeiierman: 2, rsi: 2, macd: 2 }, gate: {} },
  { entry: 100, sl: 95, tp: 110 });
eq("B total", b.total, 6);
eq("B rr", b.rr, 2);
eq("B tier", b.tier, "B");

// Cas sub : score faible -> label 'sub' (PAS un blocage)
const c = enrichScore({ components: { zeiierman: 2, candle: 1 }, gate: {} }, { entry: 100, sl: 98, tp: 104 });
eq("sub total", c.total, 3);
eq("sub tier", c.tier, "sub");

// Gating dur : gate.passed=false meme avec score haut (instrumentation, pas blocage)
const g = enrichScore(
  { components: { zeiierman: 2, rsi: 2, macd: 2, regime: 1, supertrend: 1, stochrsi: 1, adx: 1 },
    gate: { regime_strong_opp: true, supertrend_flip_opp: false } },
  { entry: 100, sl: 96, tp: 112 });
ok("gate bloque malgre score 10", g.total === 10 && g.gate.passed === false);

// Clamp : une composante hors-bornes est ramenee a sa valeur max
const cl = enrichScore({ components: { zeiierman: 9, rsi: 2 }, gate: {} }, { entry: 100, sl: 95, tp: 110 });
eq("clamp zeiierman a 2", cl.components.zeiierman, 2);
eq("clamp total", cl.total, 4);

// Composante inconnue ignoree
const uk = enrichScore({ components: { zeiierman: 2, bogus: 5 }, gate: {} }, { entry: 1, sl: 0.9, tp: 1.2 });
ok("composante inconnue ignoree", uk.total === 2 && uk.components.bogus === undefined);

// Sans niveaux -> rr null, tier 'sub' (A+/B exigent un RR)
const nr = enrichScore({ components: { zeiierman: 2, rsi: 2, macd: 2, regime: 1, supertrend: 1, stochrsi: 1, adx: 1, vwap: 1, candle: 1 }, gate: {} }, {});
ok("sans rr -> rr null", nr.rr === null);
eq("sans rr -> tier sub (RR requis)", nr.tier, "sub");

// Bloc enrichi a toutes les cles attendues (stockable tel quel)
const stored = enrichScore({ components: { zeiierman: 2, rsi: 2 }, gate: { regime_strong_opp: false }, zones: "zeiierman" }, { entry: 50, sl: 48, tp: 56 });
ok("bloc stockable a les cles attendues",
  ["components", "total", "rr", "tier", "gate", "zones"].every((k) => k in stored));

console.log(`\n  score.js: ${passed} pass, ${failed} fail`);
process.exit(failed ? 1 : 0);
