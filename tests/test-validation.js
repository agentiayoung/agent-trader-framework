#!/usr/bin/env node
"use strict";
// Tests offline du module de validation robuste (#1 fondation, GO Hugo 16.06). Zero reseau.
// Design : docs/plans/2026-06-16-foundation-validation-fill-design.md (CPCV-light + Deflated Sharpe
// + null block-bootstrap, reponse a C7/C8/C10/O6 : nos edges "valides" sont peut-etre du bruit).
// Run: node tests/test-validation.js
const V = require("../trade-journal/validation.js");
let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log("  PASS  " + name); } else { failed++; console.log("  FAIL  " + name); } }
const near = (a, b, eps) => Math.abs(a - b) <= (eps == null ? 1e-6 : eps);

// ── stats de base ──
ok("mean", near(V.mean([1, 2, 3]), 2));
ok("std echantillon (n-1)", near(V.std([2, 4, 4, 4, 5, 5, 7, 9]), 2.138, 1e-3));
ok("sharpe = mean/std", near(V.sharpe([1, -1, 1, -1, 2]), V.mean([1, -1, 1, -1, 2]) / V.std([1, -1, 1, -1, 2]), 1e-9));
ok("sharpe null si n<2", V.sharpe([1]) === null);

// ── normCdf / normPpf (testes contre valeurs connues) ──
ok("normCdf(0)=0.5", near(V.normCdf(0), 0.5, 1e-6));
ok("normCdf(1.96)~0.975", near(V.normCdf(1.96), 0.975, 1e-3));
ok("normCdf(-1.96)~0.025", near(V.normCdf(-1.96), 0.025, 1e-3));
ok("normPpf(0.5)=0", near(V.normPpf(0.5), 0, 1e-6));
ok("normPpf(0.975)~1.96", near(V.normPpf(0.975), 1.96, 1e-3));
ok("normPpf(0.025)~-1.96", near(V.normPpf(0.025), -1.96, 1e-3));

// ── deflatedSharpe : proprietes (DSR in [0,1], croit avec sr, decroit avec nTrials) ──
const base = { nTrials: 10, varTrials: 0.25, skew: 0, kurt: 3, n: 200 };
const dHigh = V.deflatedSharpe(1.2, base);
const dLow = V.deflatedSharpe(0.3, base);
ok("DSR dans [0,1]", dHigh >= 0 && dHigh <= 1 && dLow >= 0 && dLow <= 1);
ok("DSR croit avec le Sharpe", dHigh > dLow);
ok("DSR decroit avec nTrials (multiple testing)", V.deflatedSharpe(0.8, { ...base, nTrials: 200 }) < V.deflatedSharpe(0.8, { ...base, nTrials: 2 }));
ok("DSR fort (sr eleve, peu d'essais, gros n) > 0.9", V.deflatedSharpe(2.0, { nTrials: 2, varTrials: 0.1, skew: 0, kurt: 3, n: 500 }) > 0.9);
ok("DSR faible (sr bas, bcp d'essais) < 0.5", V.deflatedSharpe(0.2, { nTrials: 500, varTrials: 0.5, skew: 0, kurt: 3, n: 100 }) < 0.5);
ok("DSR nTrials<=1 -> PSR (SR0=0), sr>0 -> >0.5", V.deflatedSharpe(0.5, { nTrials: 1, varTrials: 0, skew: 0, kurt: 3, n: 200 }) > 0.5);

// ── haircutSharpe ──
ok("haircut 0.6 par defaut", near(V.haircutSharpe(1.0), 0.6));
ok("haircut facteur custom", near(V.haircutSharpe(2.0, 0.5), 1.0));

// ── cpcvFolds : combinatoire + embargo ──
const folds = V.cpcvFolds(6, 2, 1);
ok("cpcvFolds count = C(6,2) = 15", folds.length === 15);
ok("chaque fold a 2 blocs test", folds.every((f) => f.test.length === 2));
const f01 = folds.find((f) => f.test.includes(0) && f.test.includes(1));
ok("fold test=[0,1] embargo retire le bloc 2 -> train [3,4,5]", JSON.stringify(f01.train) === JSON.stringify([3, 4, 5]));
const f05 = folds.find((f) => f.test.includes(0) && f.test.includes(5));
ok("fold test=[0,5] embargo retire 1 et 4 -> train [2,3]", JSON.stringify(f05.train) === JSON.stringify([2, 3]));
ok("train et test disjoints partout", folds.every((f) => f.train.every((b) => !f.test.includes(b))));

// ── blockBootstrapPValue : p = fraction des moyennes resamplees <= 0 (H0 mean<=0, autocorr preservee) ──
const allPos = new Array(60).fill(0.5);
ok("R tout positif -> p ~ 0 (robustement >0)", V.blockBootstrapPValue(allPos, { blockLen: 5, draws: 500, seed: "t1" }) < 0.05);
const noise = []; for (let i = 0; i < 60; i++) noise.push(i % 2 === 0 ? 1 : -1); // mean 0
const pNoise = V.blockBootstrapPValue(noise, { blockLen: 5, draws: 500, seed: "t2" });
ok("R bruit moyenne 0 -> p ~ 0.5", pNoise > 0.3 && pNoise < 0.7);
ok("reproductible (meme seed -> meme p)", V.blockBootstrapPValue(noise, { blockLen: 5, draws: 500, seed: "t2" }) === pNoise);

console.log("\n" + passed + " pass / " + failed + " fail");
process.exit(failed ? 1 : 0);
