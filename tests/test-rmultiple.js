#!/usr/bin/env node
"use strict";
// Tests offline deterministes du calcul R + arrondi prix (journal.js). Zero reseau.
// Bug 12.06 (DOGE) : `.toFixed(2)` ecrasait entry_actual/avg_exit d'un alt sub-dollar
// (0.086 -> 0.09) -> entry==exit -> R price-based = 0 alors que realized -997.71/risk 1034 = -0.96.
// Run: node tests/test-rmultiple.js
const { computeRMultiple, roundPx } = require("../trade-journal/journal.js");
let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log("  PASS  " + name); } else { failed++; console.log("  FAIL  " + name); } }

// ── roundPx : preserve la precision selon la magnitude ──
ok("roundPx DOGE 0.0860333 garde 6 dec (PAS 0.09)", roundPx(0.0860333) === 0.086033);
ok("roundPx 0.09 reste 0.09", roundPx(0.09) === 0.09);
ok("roundPx XRP 1.1523 -> 4 dec", roundPx(1.1523) === 1.1523);
ok("roundPx BTC 63250.55 -> 2 dec", roundPx(63250.55) === 63250.55);
ok("roundPx micro 0.00012349 -> 8 dec", roundPx(0.00012349) === 0.00012349);
ok("roundPx 0 -> 0", roundPx(0) === 0);
ok("roundPx NaN -> NaN", Number.isNaN(roundPx("x")));
// DOGE bug rejoue : 0.0860333 != 0.0888 apres roundPx (entry != exit, R calculable)
ok("roundPx ne colle PAS entry et exit sub-dollar", roundPx(0.0860333) !== roundPx(0.0888));

// ── computeRMultiple : PRIMAIRE = realized_pnl / risk_usd (robuste laddered) ──
ok("DOGE laddered corrompu (entry==exit) mais risk_usd -> -0.96 (PAS 0)",
  computeRMultiple({ side: "short", entry_actual: 0.09, stop_loss: 0.0881, avg_exit: 0.09, risk_usd: 1034, realized_pnl: -997.7142 }) === -0.96);
ok("win short via pnl/risk -> 1.5", computeRMultiple({ risk_usd: 1000, realized_pnl: 1500 }) === 1.5);
ok("risk_usd=0 ignore (pas de div par zero) -> fallback prix", computeRMultiple({ risk_usd: 0, realized_pnl: -100, side: "short", entry_actual: 100, stop_loss: 110, avg_exit: 90 }) === 1);

// ── fallback geometrie prix quand pas de risk_usd ──
ok("fallback short R=1 (entry100 sl110 exit90)", computeRMultiple({ side: "short", entry_actual: 100, stop_loss: 110, avg_exit: 90 }) === 1);
ok("fallback long R=-1 (entry100 sl90 exit90)", computeRMultiple({ side: "long", entry_actual: 100, stop_loss: 90, avg_exit: 90 }) === -1);
ok("fallback sub-dollar OK apres roundPx (entry 0.086033 exit 0.0888)",
  computeRMultiple({ side: "short", entry_actual: 0.086033, stop_loss: 0.0888, avg_exit: 0.0888 }) === -1);
ok("degenere entry==exit SANS risk_usd -> 0 (montre que le fix vient de risk_usd)",
  computeRMultiple({ side: "short", entry_actual: 0.09, stop_loss: 0.0881, avg_exit: 0.09 }) === 0);
ok("rien d'exploitable -> null", computeRMultiple({ side: "short" }) === null);

console.log(`\n${passed} pass / ${failed} fail`);
process.exit(failed ? 1 : 0);
