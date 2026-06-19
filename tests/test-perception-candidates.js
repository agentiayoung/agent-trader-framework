#!/usr/bin/env node
"use strict";
// Tests offline deterministes de scan.perceptionCandidates (F4, longs bilateraux via perception).
// Zero reseau. Surface des candidats directionnels que le CATALOGUE d'edges rate (souvent des LONGS
// en bear) en track:experiment, depuis la perception (structure CHoCH/MSS + zone fraiche + bougie).
// Run: node tests/test-perception-candidates.js
const { perceptionCandidates } = require("../trade-journal/scan.js");
let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log("  PASS  " + name); } else { failed++; console.log("  FAIL  " + name); } }

// helper : row avec perception compacte
function row(pair, over) {
  return Object.assign({ pair, px: 100, regime_d: "range", divergence: null, setup: null,
    perception: { trend: "range", choch: null, mss: null, nearest_zone: null, candle: null,
      confluence: { score14: 8, side: "long", tier: "B" } } }, over);
}

// ── 1) LONG perception valide : tier B + MSS up + zone fraiche proche, catalogue VIDE -> candidat ──
const r1 = row("AAA", { setup: null, perception: { trend: "bull", choch: null, mss: "up",
  nearest_zone: { type: "support", dist_atr: 0.6, status: "fresh" }, candle: null,
  confluence: { score14: 8.5, side: "long", tier: "B" } } });
const c1 = perceptionCandidates([r1]);
ok("LONG perception (MSS up + zone fraiche, catalogue vide) -> 1 candidat", c1.length === 1 && c1[0].side === "long");
ok("candidat tagge source:perception + track:experiment", c1[0].source === "perception" && c1[0].track === "experiment");
ok("candidat porte perception_score14 + reason", c1[0].perception_score14 === 8.5 && /MSS up/.test(c1[0].reason));

// ── 2) bougie de confirmation seule (sans zone) suffit comme appui concret ──
const r2 = row("BBB", { perception: { trend: "bull", choch: "up", mss: null, nearest_zone: null,
  candle: "engulfing:long", confluence: { score14: 7, side: "long", tier: "B" } } });
ok("LONG avec bougie confirmee (sans zone) -> candidat", perceptionCandidates([r2]).length === 1);

// ── 3) REJETS ──
// tier < B (score14 < 6)
ok("score14 < 6 -> rejete", perceptionCandidates([row("C1", { perception: { trend: "bull", mss: "up",
  nearest_zone: { type: "support", dist_atr: 0.5, status: "fresh" }, confluence: { score14: 5, side: "long", tier: "sub" } } })]).length === 0);
// structure NON alignee (side long mais mss down / trend bear)
ok("structure non alignee -> rejete", perceptionCandidates([row("C2", { perception: { trend: "bear", mss: "down",
  nearest_zone: { type: "support", dist_atr: 0.5, status: "fresh" }, confluence: { score14: 9, side: "long", tier: "A+" } } })]).length === 0);
// pas d'appui concret (ni zone proche <=1ATR, ni bougie)
ok("sans zone proche ni bougie -> rejete", perceptionCandidates([row("C3", { perception: { trend: "bull", mss: "up",
  nearest_zone: { type: "support", dist_atr: 2.0, status: "fresh" }, candle: null, confluence: { score14: 9, side: "long", tier: "A+" } } })]).length === 0);
// bougie NON confirmee ("?") ne compte pas comme appui
ok("bougie non confirmee (?) seule -> rejete", perceptionCandidates([row("C3b", { perception: { trend: "bull", mss: "up",
  nearest_zone: null, candle: "engulfing?", confluence: { score14: 8, side: "long", tier: "B" } } })]).length === 0);
// le catalogue couvre DEJA ce sens (setup long) -> deja dans opportunities, pas un candidat perception
ok("catalogue couvre deja le sens -> rejete (deja classe)", perceptionCandidates([row("C4", { setup: { type: "S5_long", side: "long" },
  perception: { trend: "bull", mss: "up", nearest_zone: { type: "support", dist_atr: 0.5, status: "fresh" }, confluence: { score14: 9, side: "long", tier: "A+" } } })]).length === 0);
// row en erreur / sans perception -> ignore
ok("row error/sans perception -> ignore", perceptionCandidates([{ pair: "E", error: "x" }, { pair: "F", perception: null }]).length === 0);

// ── 4) SHORT perception quand le catalogue est LONG (bilateral symetrique) ──
const rS = row("SHT", { setup: { type: "S5_long", side: "long" }, perception: { trend: "bear", choch: "down", mss: null,
  nearest_zone: { type: "resistance", dist_atr: 0.4, status: "fresh" }, candle: "pinbar:short",
  confluence: { score14: 8, side: "short", tier: "B" } } });
const cS = perceptionCandidates([rS]);
ok("SHORT perception alors que catalogue=long -> candidat short", cS.length === 1 && cS[0].side === "short");

// ── 5) tri par conviction (score14 desc) ──
const sorted = perceptionCandidates([
  row("LO", { perception: { trend: "bull", mss: "up", nearest_zone: { type: "support", dist_atr: 0.5, status: "fresh" }, confluence: { score14: 7, side: "long", tier: "B" } } }),
  row("HI", { perception: { trend: "bull", mss: "up", nearest_zone: { type: "support", dist_atr: 0.5, status: "fresh" }, confluence: { score14: 9.5, side: "long", tier: "A+" } } }),
]);
ok("tri par perception_score14 desc (HI avant LO)", sorted.length === 2 && sorted[0].pair === "HI" && sorted[1].pair === "LO");

// ── 6) robustesse : entree vide / null ──
ok("rows vide -> []", perceptionCandidates([]).length === 0);
ok("rows null -> [] (pas d'exception)", perceptionCandidates(null).length === 0);

console.log(`\n  perceptionCandidates: ${passed} pass, ${failed} fail`);
process.exit(failed ? 1 : 0);
