#!/usr/bin/env node
"use strict";
// Test offline du bucketing de score-eval sur une fixture synthétique.
// Run: node tests/test-score-eval.js
const { evalScores } = require("../trade-journal/score.js");
let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log("  PASS  " + name); } else { failed++; console.log("  FAIL  " + name); } }

// Fixture : trades clôturés avec bloc score + r_multiple
const fixture = [
  { status: "closed", strategy: "MR8", r_multiple: 2.0, score: { total: 12, tier: "A+", gate: { passed: true }, components: { zeiierman: 2, rsi: 2 } } },
  { status: "closed", strategy: "MR8", r_multiple: 1.0, score: { total: 10, tier: "A+", gate: { passed: true }, components: { zeiierman: 2, rsi: 0 } } },
  { status: "closed", strategy: "S5", r_multiple: -1.0, score: { total: 5, tier: "sub", gate: { passed: true }, components: { zeiierman: 0, rsi: 2 } } },
  { status: "closed", strategy: "S1", r_multiple: -1.0, score: { total: 7, tier: "B", gate: { passed: false }, components: { zeiierman: 2, rsi: 0 } } },
  { status: "open", strategy: "X", score: { total: 9 } }, // ignoré (pas clôturé)
  { status: "closed", strategy: "Y", r_multiple: 0.5 },   // ignoré (pas de score)
  { status: "closed", strategy: "MANUAL_TEST", source: "manual", r_multiple: 5.0, score: { total: 4, tier: "sub", gate: { passed: true }, components: {} } }, // ignoré (source:manual) — R distinctif
];

const r = evalScores(fixture);
ok("4 trades scorés clôturés (manual exclu)", r.n === 4);
ok("bucket <6 = 1 seul trade (S5 R-1), pas le manual", r.by_bucket["<6"] && r.by_bucket["<6"].n === 1 && r.by_bucket["<6"].avg_r === -1);
// bucket 12+ : 1 trade R 2.0
ok("bucket 12+ avgR=2", r.by_bucket["12+"] && r.by_bucket["12+"].avg_r === 2 && r.by_bucket["12+"].n === 1);
// bucket 9-11 : 1 trade R 1.0
ok("bucket 9-11 avgR=1", r.by_bucket["9-11"] && r.by_bucket["9-11"].avg_r === 1);
// bucket <6 : 1 trade R -1
ok("bucket <6 avgR=-1", r.by_bucket["<6"] && r.by_bucket["<6"].avg_r === -1);
// bucket 6-8 : 1 trade R -1
ok("bucket 6-8 avgR=-1", r.by_bucket["6-8"] && r.by_bucket["6-8"].avg_r === -1);
// tier A+ : 2 trades, avgR 1.5, WR 100%
ok("tier A+ avgR=1.5 n=2", r.by_tier["A+"] && r.by_tier["A+"].n === 2 && r.by_tier["A+"].avg_r === 1.5);
// composante zeiierman présente (>0) : trades 1,2,4 -> R [2,1,-1] avgR 0.67 ; absente : trade 3 -> R -1
ok("composante zeiierman present avgR > absent",
  r.by_component.zeiierman && r.by_component.zeiierman.present.avg_r > r.by_component.zeiierman.absent.avg_r);
// gate passed=true : trades 1,2,3 -> R [2,1,-1] ; passed=false : trade 4 -> R -1
ok("gate passed/blocked split", r.by_gate.passed.n === 3 && r.by_gate.blocked.n === 1);

// ── Régression 10.06 (cas HYPE réel) : bloc score BRUT (pas de total/tier — ex. écrasé par
// `journal.js set` lors d'un repositionnement) → evalScores doit DÉRIVER le total des
// composantes (via le barème), pas bucketer à 0 ("<6"). Tier dérivé des niveaux du trade.
const rawFixture = [
  {
    status: "closed", strategy: "MR8_MTF", r_multiple: -0.25,
    entry_actual: 56.75, stop_loss: 54.75, take_profits: [{ px: 60 }, { px: 61.48 }],
    // composantes somment à 8 ; gate en clés brutes (pas de .passed)
    score: { components: { zeiierman: 2, rsi: 1, regime: 1, supertrend: 1, stochrsi: 1, adx: 1, candle: 1 }, gate: { regime_opposite: false }, zones: "zeiierman" },
  },
];
const r2 = evalScores(rawFixture);
ok("bloc brut: total dérivé des composantes -> bucket 6-8 (pas <6)",
  r2.by_bucket["6-8"] && r2.by_bucket["6-8"].n === 1 && !r2.by_bucket["<6"]);
ok("bloc brut: tier dérivé (8/14 + rr 1.63 -> sub, pas crash)", r2.by_tier["sub"] && r2.by_tier["sub"].n === 1);
ok("bloc brut: composante zeiierman comptée présente", r2.by_component.zeiierman && r2.by_component.zeiierman.present.n === 1);

console.log(`\n  score-eval: ${passed} pass, ${failed} fail`);
process.exit(failed ? 1 : 0);
