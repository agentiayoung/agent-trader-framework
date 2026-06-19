#!/usr/bin/env node
"use strict";
// Tests offline deterministes du moteur de confluence 0-100 (confluence.js). Zero reseau.
// Run: node tests/test-confluence.js
const { confluence, scoreSide, W } = require("../trade-journal/confluence.js");
let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log("  PASS  " + name); } else { failed++; console.log("  FAIL  " + name); } }

// ── Setup HAUSSIER FORT : structure up + support frais + bougie confirmee + orderflow aligne ──
const bullStrong = {
  px: 100, atr: 2,
  structure: { trend: "up", last_mss: { dir: "up" } },
  zones: [
    { type: "support", side: "bull", dist_atr: 0.2, status: "fresh", strength: 0.8, confluence: ["fvg", "eql"] },
    { type: "eqh", dist_atr: 3, confluence: [] },
  ],
  candles: { confirmation_valid: true, side: "long", strength: 0.7, location_quality: 1, pattern: "hammer" },
  orderflow: { sweep: { detected: true, bias: "long", side: "sell_side" }, cvd_divergence: "bull", oi_signal: "new_longs", absorption: { detected: true, against: "short" } },
};
const rBull = confluence(bullStrong);
ok("setup haussier fort -> side long", rBull.side === "long");
ok("setup haussier fort -> score > 75", rBull.score > 75);
ok("setup haussier fort -> score14 sur echelle /14", rBull.score14 === +(rBull.score * 14 / 100).toFixed(1) && rBull.score14 <= 14);
ok("setup haussier fort -> tier A+ (score14>=9)", rBull.tier === "A+");
ok("setup haussier fort -> decision long", rBull.decision === "long");
ok("setup haussier fort -> conviction = tier", rBull.conviction === "A+");
ok("setup haussier fort -> would_gate true (atteint plancher /14)", rBull.would_gate === true);
ok("breakdown a 5 composantes", ["structure", "zone", "candle", "orderflow", "liquidity"].every((k) => k in rBull.breakdown));
ok("reasons non vide", Array.isArray(rBull.reasons) && rBull.reasons.length > 0);

// ── Aucune setup : range, pas de zone, pas de bougie ──
const flat = { px: 100, atr: 2, structure: { trend: "range" }, zones: [], candles: { confirmation_valid: false, side: null }, orderflow: {} };
const rFlat = confluence(flat);
ok("aucune setup -> score bas", rFlat.score < 40);
ok("aucune setup -> no_trade", rFlat.decision === "no_trade");
ok("aucune setup -> would_gate false", rFlat.would_gate === false);

// ── Prix DANS une zone mais bougie NON confirmee -> wait ──
const atZone = {
  px: 100, atr: 2,
  structure: { trend: "up" },
  zones: [{ type: "support", side: "bull", dist_atr: 0.3, status: "fresh", strength: 0.6, confluence: [] }],
  candles: { confirmation_valid: false, side: null, location_quality: 0 },
  orderflow: {},
};
ok("prix dans zone sans confirmation -> wait", confluence(atZone).decision === "wait");

// ── Setup BAISSIER -> side short ──
const bearStrong = {
  px: 100, atr: 2,
  structure: { trend: "down", last_mss: { dir: "down" } },
  zones: [{ type: "resistance", side: "bear", dist_atr: 0.2, status: "fresh", strength: 0.8, confluence: ["fvg"] }, { type: "eql", dist_atr: 3 }],
  candles: { confirmation_valid: true, side: "short", strength: 0.7, location_quality: 1, pattern: "shooting_star" },
  orderflow: { sweep: { detected: true, bias: "short", side: "buy_side" }, cvd_divergence: "bear", oi_signal: "new_shorts" },
};
const rBear = confluence(bearStrong);
ok("setup baissier -> side short", rBear.side === "short");
ok("setup baissier -> decision short", rBear.decision === "short");

// ── scoreSide : bornes 0-100 (composantes clampees) ──
const maxed = scoreSide("long", bullStrong);
ok("score d'un sens <= 100", maxed.score <= 100);
ok("chaque composante <= son poids", maxed.breakdown.structure <= W.structure && maxed.breakdown.candle <= W.candle && maxed.breakdown.orderflow <= W.orderflow);

// ── observabilite : un setup valide sous le plancher reste une PROPOSITION (pas de gate dur) ──
const mid = {
  px: 100, atr: 2,
  structure: { trend: "up" },
  zones: [{ type: "support", side: "bull", dist_atr: 0.4, status: "mitigated", strength: 0.5, confluence: [] }],
  candles: { confirmation_valid: true, side: "long", strength: 0.5, location_quality: 0.6, pattern: "hammer" },
  orderflow: {},
};
const rMid = confluence(mid);
ok("setup moyen valide -> propose long (basse conviction si tier sub)", rMid.side === "long" && rMid.decision === "long");
ok("conviction sub si score14 < plancher B", rMid.score14 < 6 ? rMid.conviction === "sub" : true);
ok("would_gate false si sous le plancher /14", rMid.score14 < 6 ? rMid.would_gate === false : true);

// ── plancher /14 unifie : floor14 par defaut = B (6), retro-compat threshold 0-100 ──
ok("floor14 par defaut = 6 (tier B)", confluence(bullStrong).floor14 === 6);
ok("threshold 0-100 retro-compat -> converti en /14", confluence(bullStrong, { threshold: 75 }).floor14 === +(75 * 14 / 100).toFixed(1));
ok("floor14 explicite respecte", confluence(bullStrong, { floor14: 9 }).floor14 === 9);

// ── garde-fous ──
ok("state vide -> no_trade, pas d'exception", confluence({}).decision === "no_trade");
ok("contrat de sortie complet (avec score14/tier/conviction)", ["score", "score14", "tier", "side", "decision", "conviction", "would_gate", "floor14", "breakdown", "reasons", "opposite"].every((k) => k in rBull));

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
