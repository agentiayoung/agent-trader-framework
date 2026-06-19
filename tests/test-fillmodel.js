#!/usr/bin/env node
"use strict";
// Tests offline du modele de fill LIMIT probabiliste (#2 fondation, approved 16.06). Zero reseau.
// Design : docs/plans/2026-06-16-foundation-validation-fill-design.md (anti "touche = rempli", B4/B6/O1).
// Run: node tests/test-fillmodel.js
const F = require("../trade-journal/fillmodel.js");
const { mulberry32, strSeed } = require("../trade-journal/optimize.js");
let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log("  PASS  " + name); } else { failed++; console.log("  FAIL  " + name); } }
const near = (a, b, eps) => Math.abs(a - b) <= (eps == null ? 1e-9 : eps);

// ── fillProbability = exp(-k*|dATR|), clamp [0,1] ──
ok("fill au prix (dATR=0) -> 1", near(F.fillProbability(0, 1.2), 1));
ok("fill decroit avec la distance", F.fillProbability(0.5, 1.2) > F.fillProbability(1.0, 1.2));
ok("fill a 1xATR (k=1.2) ~ 0.301", near(F.fillProbability(1, 1.2), Math.exp(-1.2), 1e-9));
ok("fill toujours dans [0,1]", F.fillProbability(10, 1.2) >= 0 && F.fillProbability(0, 5) <= 1);
ok("dATR negatif traite en valeur absolue", near(F.fillProbability(-0.5, 1.2), F.fillProbability(0.5, 1.2)));
ok("k plus grand -> fill plus bas a meme distance", F.fillProbability(0.5, 2.0) < F.fillProbability(0.5, 1.0));

// ── frais maker vs taker en R ──
// entry=100, risk=2 -> takerFeeR = 2*0.00055*100/2 = 0.055 ; makerFeeR = 2*0.0002*100/2 = 0.02
ok("takerFeeR", near(F.takerFeeR(100, 2), 0.055));
ok("makerFeeR", near(F.makerFeeR(100, 2), 0.02));
ok("maker < taker (avantage B1)", F.makerFeeR(100, 2) < F.takerFeeR(100, 2));
ok("feeR=0 si risk=0 (garde-fou)", F.makerFeeR(100, 0) === 0 && F.takerFeeR(100, 0) === 0);

// ── bernoulli seede (reproductible) ──
const rng1 = mulberry32(strSeed("fill|BTC")), rng2 = mulberry32(strSeed("fill|BTC"));
const seq1 = [], seq2 = [];
for (let i = 0; i < 5; i++) { seq1.push(F.bernoulli(0.5, rng1)); seq2.push(F.bernoulli(0.5, rng2)); }
ok("bernoulli reproductible (meme seed -> meme sequence)", JSON.stringify(seq1) === JSON.stringify(seq2));
ok("bernoulli(1) toujours true", F.bernoulli(1, mulberry32(1)) === true);
ok("bernoulli(0) toujours false", F.bernoulli(0, mulberry32(1)) === false);
// loi des grands nombres : ~p sur bcp de tirages
let cnt = 0; const rng = mulberry32(42); for (let i = 0; i < 10000; i++) if (F.bernoulli(0.3, rng)) cnt++;
ok("bernoulli(0.3) ~ 30% sur 10k tirages", Math.abs(cnt / 10000 - 0.3) < 0.03);

// ── adverseHaircutR : placeholder calibrable, defaut 0 ──
ok("adverseHaircut defaut 0", F.adverseHaircutR() === 0);
ok("adverseHaircut renvoie la valeur passee", near(F.adverseHaircutR(0.05), 0.05));

console.log("\n" + passed + " pass / " + failed + " fail");
process.exit(failed ? 1 : 0);
