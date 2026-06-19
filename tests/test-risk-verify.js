#!/usr/bin/env node
"use strict";
// Tests offline du risque geometrique reel (risk-verify.js). Zero reseau.
// Bug DOGE 16.06 : risk_usd logge = budget 125, mais size 383280 x |entry-SL| 0.001181 = 452 ->
// R = pnl/125 = -4.35R FAUX (vrai -1.12R). Le module derive le risque REEL et signale la divergence.
// Run: node tests/test-risk-verify.js
const { geomRisk, verifyTradeRisk } = require("../trade-journal/risk-verify.js");
let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log("  PASS  " + name); } else { failed++; console.log("  FAIL  " + name); } }
function approx(a, b, eps) { return Math.abs(a - b) <= (eps == null ? 0.5 : eps); }

// ── geomRisk : size x |entry - SL| ──
ok("geomRisk simple long", approx(geomRisk({ entry_actual: 100, stop_loss: 98, size: 10 }), 20));
ok("geomRisk short (abs)", approx(geomRisk({ entry_actual: 100, stop_loss: 102, size: 5 }), 10));
ok("geomRisk fallback avg_entry", approx(geomRisk({ avg_entry: 100, stop_loss: 95, size: 2 }), 10));
ok("geomRisk fallback entry_planned", approx(geomRisk({ entry_planned: 50, stop_loss: 49, size: 4 }), 4));
ok("geomRisk null si size manquant", geomRisk({ entry_actual: 100, stop_loss: 98 }) === null);
ok("geomRisk null si SL=entry", geomRisk({ entry_actual: 100, stop_loss: 100, size: 10 }) === null);

// ── Cas DOGE reel (le bug) ──
const doge = { entry_actual: 0.08849, stop_loss: 0.087309, size: 383280, risk_usd: 125 };
const vd = verifyTradeRisk(doge);
ok("DOGE geom_risk ~452", approx(vd.geom_risk, 452.6, 1));
ok("DOGE diverged=true", vd.diverged === true);
ok("DOGE factor ~3.6", approx(vd.factor, 3.62, 0.05));
ok("DOGE authoritative = geometrie (452)", approx(vd.authoritative, 452.6, 1));
ok("DOGE R honnete ~-1.12 avec authoritative", approx(-509.39 / vd.authoritative, -1.12, 0.05));

// ── Sizing coherent (pas de divergence) ──
const clean = { entry_actual: 100, stop_loss: 98, size: 62.5, risk_usd: 125 }; // 62.5*2 = 125
const vc = verifyTradeRisk(clean);
ok("clean diverged=false", vc.diverged === false);
ok("clean authoritative = budget", approx(vc.authoritative, 125));
ok("clean factor ~1", approx(vc.factor, 1.0, 0.01));

// ── Tolerance : 20% de divergence ne declenche PAS (sous le seuil 25%) ──
const small = { entry_actual: 100, stop_loss: 98, size: 75, risk_usd: 125 }; // 150 vs 125 = x1.2
ok("divergence 20% sous tol -> non flagge", verifyTradeRisk(small).diverged === false);
const big = { entry_actual: 100, stop_loss: 98, size: 100, risk_usd: 125 }; // 200 vs 125 = x1.6
ok("divergence 60% au-dessus tol -> flagge", verifyTradeRisk(big).diverged === true);

// ── Laddered : on NE recalcule PAS (budget conserve) ──
const lad = { entry_actual: 100, stop_loss: 98, size: 383280, risk_usd: 125, entry_mode: "laddered" };
const vl = verifyTradeRisk(lad);
ok("laddered diverged=false (exempte)", vl.diverged === false);
ok("laddered authoritative = budget", approx(vl.authoritative, 125));
ok("laddered reason mentionne rungs", /rungs/.test(vl.reason));

// ── risk_usd absent -> geometrie fait foi ──
const nob = { entry_actual: 100, stop_loss: 98, size: 10 };
ok("sans budget -> authoritative = geom", approx(verifyTradeRisk(nob).authoritative, 20));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
