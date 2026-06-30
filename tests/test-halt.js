#!/usr/bin/env node
"use strict";
// Tests offline du breaker de halt (computeHalt / isRealMoney). Zero reseau.
// REGLE (GO Hugo 25.06) : le breaker DRAWDOWN (RM_MAX_DRAWDOWN_PCT, 10%) ne HALT que sur ARGENT REEL
// (BYBIT_DEMO === "0"). En DEMO les deux agents continuent de trader malgre dd>10%. La PERTE-JOUR
// (kill-switch) reste DURE dans les deux cas (demo ET reel).
// Run: node tests/test-halt.js
const { computeHalt, isRealMoney } = require("../trade-journal/journal.js");
let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log("  PASS  " + name); } else { failed++; console.log("  FAIL  " + name); } }

const dailyLoss = 3, maxDd = 10;

// ── DRAWDOWN : reel only ──
ok("demo + dd 15% (>10) -> PAS de halt",
  computeHalt({ dayPnl: 0, dd: 15, dailyLoss, maxDd, realMoney: false }).halt === false);
ok("reel + dd 15% (>10) -> HALT",
  computeHalt({ dayPnl: 0, dd: 15, dailyLoss, maxDd, realMoney: true }).halt === true);
ok("demo + dd 15% -> ddBreach=false",
  computeHalt({ dayPnl: 0, dd: 15, dailyLoss, maxDd, realMoney: false }).ddBreach === false);
ok("reel + dd 15% -> ddBreach=true",
  computeHalt({ dayPnl: 0, dd: 15, dailyLoss, maxDd, realMoney: true }).ddBreach === true);
ok("reel + dd 9% (<10) -> PAS de halt",
  computeHalt({ dayPnl: 0, dd: 9, dailyLoss, maxDd, realMoney: true }).halt === false);
ok("dd exactement 10% -> PAS de halt (strict >)",
  computeHalt({ dayPnl: 0, dd: 10, dailyLoss, maxDd, realMoney: true }).halt === false);

// ── PERTE-JOUR (kill-switch) : DURE en demo ET en reel ──
ok("demo + perte jour -4% (>3) -> HALT (kill-switch dur en demo)",
  computeHalt({ dayPnl: -4, dd: 0, dailyLoss, maxDd, realMoney: false }).halt === true);
ok("reel + perte jour -4% -> HALT",
  computeHalt({ dayPnl: -4, dd: 0, dailyLoss, maxDd, realMoney: true }).halt === true);
ok("perte jour -4% -> dayBreach=true",
  computeHalt({ dayPnl: -4, dd: 0, dailyLoss, maxDd, realMoney: false }).dayBreach === true);
ok("perte jour -2% (<3) -> PAS de halt",
  computeHalt({ dayPnl: -2, dd: 0, dailyLoss, maxDd, realMoney: false }).halt === false);

// ── Cas combine : le 24.06 reel (demo, dd 10.08%, jour +0.6%) ──
ok("demo dd 10.08% jour +0.6% -> PAS de halt (le scenario reel du 25.06)",
  computeHalt({ dayPnl: 0.6, dd: 10.08, dailyLoss, maxDd, realMoney: false }).halt === false);

// ── Robustesse : null/absent ──
ok("dd null -> pas de ddBreach",
  computeHalt({ dayPnl: 0, dd: null, dailyLoss, maxDd, realMoney: true }).ddBreach === false);
ok("dayPnl null -> pas de dayBreach",
  computeHalt({ dayPnl: null, dd: 0, dailyLoss, maxDd, realMoney: true }).dayBreach === false);

// ── isRealMoney : pilote sur BYBIT_DEMO === "0" (la condition exacte des vrais ordres) ──
const save = process.env.BYBIT_DEMO;
process.env.BYBIT_DEMO = "0"; ok("BYBIT_DEMO=0 -> isRealMoney true", isRealMoney() === true);
process.env.BYBIT_DEMO = "1"; ok("BYBIT_DEMO=1 -> isRealMoney false", isRealMoney() === false);
delete process.env.BYBIT_DEMO; ok("BYBIT_DEMO absent -> isRealMoney false (demo par defaut)", isRealMoney() === false);
if (save === undefined) delete process.env.BYBIT_DEMO; else process.env.BYBIT_DEMO = save;

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
