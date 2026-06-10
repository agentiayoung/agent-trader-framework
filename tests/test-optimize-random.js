#!/usr/bin/env node
"use strict";
// Test offline du random-control d'optimize.js (pattern Vibe-Trading run_bench_strict, 10.06) :
// PRNG seedé reproductible + baseline appariée au mix de sens du candidat.
// Run: node tests/test-optimize-random.js
const { mulberry32, strSeed, sideMatchedBaseline } = require("../trade-journal/optimize.js");
let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log("  PASS  " + name); } else { failed++; console.log("  FAIL  " + name); } }

// ── PRNG : déterminisme (même seed = même séquence -> snapshots reproductibles) ──
const a = mulberry32(strSeed("BTC|4h")), b = mulberry32(strSeed("BTC|4h"));
const seqA = [a(), a(), a(), a()], seqB = [b(), b(), b(), b()];
ok("mulberry32 même seed = même séquence", seqA.every((v, i) => v === seqB[i]));
const c = mulberry32(strSeed("ETH|4h"));
ok("seed différente = séquence différente", c() !== seqA[0]);
ok("valeurs dans [0,1)", seqA.every((v) => v >= 0 && v < 1));
// densité ~uniforme (grossier) : sur 10k tirages, ~10% sous 0.10
const d = mulberry32(42); let hits = 0; for (let i = 0; i < 10000; i++) if (d() < 0.10) hits++;
ok("p(x<0.10) ≈ 10% (8-12%)", hits > 800 && hits < 1200);

// ── sideMatchedBaseline : pondération par le mix de sens du candidat ──
// random longs perdent (-0.5R), random shorts gagnent (+0.3R) — marché en downtrend.
const rnd = [
  ...Array.from({ length: 20 }, () => ({ side: "long" })),
  ...Array.from({ length: 20 }, () => ({ side: "short" })),
];
const evalFn = (set) => ({ exp: set[0].side === "long" ? -0.5 : 0.3 });
// candidat 100% short -> baseline = random SHORT seul (+0.3), pas le mix both-sides (-0.1)
const candShort = Array.from({ length: 10 }, () => ({ side: "short" }));
const bShort = sideMatchedBaseline(candShort, rnd, evalFn);
ok("candidat short-only -> baseline = random short (+0.3)", bShort && bShort.exp_matched === 0.3 && bShort.side_mix_long === 0);
// candidat 50/50 -> baseline = mix -0.1
const candMix = [...Array.from({ length: 5 }, () => ({ side: "long" })), ...Array.from({ length: 5 }, () => ({ side: "short" }))];
const bMix = sideMatchedBaseline(candMix, rnd, evalFn);
ok("candidat 50/50 -> baseline mix (-0.1)", bMix && bMix.exp_matched === -0.1 && bMix.side_mix_long === 0.5);
// n random insuffisant -> null (pas de fausse confiance)
ok("n random < minN -> null", sideMatchedBaseline(candShort, rnd.slice(0, 5), evalFn) === null);
// implication verdict : un short qui fait +0.25R en downtrend NE BAT PAS le random short (+0.3)
ok("verdict: +0.25R < baseline short +0.3 -> beats_random false", 0.25 > bShort.exp_matched === false);

console.log(`\n  optimize-random: ${passed} pass, ${failed} fail`);
process.exit(failed ? 1 : 0);
