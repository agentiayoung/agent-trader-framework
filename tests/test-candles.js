#!/usr/bin/env node
"use strict";
// Tests offline deterministes de la reconnaissance de bougies contextuelle (candles.js). Zero reseau.
// Run: node tests/test-candles.js
const Cd = require("../trade-journal/candles.js");
let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log("  PASS  " + name); } else { failed++; console.log("  FAIL  " + name); } }
// bar = [ts,o,h,l,c,v]
const B = (o, h, l, c) => [0, o, h, l, c, 100];

// ── detectPattern : patterns isoles ──
ok("doji (indecision)", Cd.detectPattern([B(100, 102, 98, 100.05)]).pattern === "doji");
ok("hammer (rejet du bas, long)", Cd.detectPattern([B(100, 101.2, 96, 101)]).dir === "long" && Cd.detectPattern([B(100, 101.2, 96, 101)]).pattern === "hammer");
ok("shooting star (rejet du haut, short)", Cd.detectPattern([B(101, 105, 99.8, 100)]).pattern === "shooting_star");
ok("bullish engulfing", Cd.detectPattern([B(101, 101.5, 99.8, 100), B(99.5, 102.2, 99.3, 102)]).pattern === "bullish_engulfing");
ok("bearish engulfing", Cd.detectPattern([B(100, 101.2, 99.5, 101), B(101.5, 101.8, 98.5, 99)]).pattern === "bearish_engulfing");
ok("morning star (long)", Cd.detectPattern([B(106, 106.2, 100, 100.5), B(100, 100.8, 99.5, 100.2), B(100.5, 105.5, 100.3, 105)]).pattern === "morning_star");
ok("strong bull (momentum)", Cd.detectPattern([B(100, 104.1, 99.9, 104)]).pattern === "strong_bull");
ok("aucun pattern (meches equilibrees) -> none", Cd.detectPattern([B(100, 100.65, 99.65, 100.3)]).pattern === "none");

// ── locationQuality : bougie DANS une zone alignee ──
const hammerBar = B(100, 101.2, 96, 101); // low = 96
const support = [{ type: "support", lo: 95, hi: 97, side: null, confluence: [] }];
ok("hammer low dans support -> quality 1", Cd.locationQuality(hammerBar, support, "long", 2) === 1);
ok("hammer SANS zone -> quality 0", Cd.locationQuality(hammerBar, [], "long", 2) === 0);
const farZone = [{ type: "support", lo: 80, hi: 82, side: null, confluence: [] }];
ok("hammer loin de la zone -> quality 0", Cd.locationQuality(hammerBar, farZone, "long", 2) === 0);
ok("dir neutral -> quality 0", Cd.locationQuality(hammerBar, support, "neutral", 2) === 0);
// zone bull pour un short -> non pertinente
const resistance = [{ type: "resistance", lo: 104.5, hi: 105.5, side: null, confluence: [] }];
ok("shooting star high dans resistance -> quality 1", Cd.locationQuality(B(101, 105, 99.8, 100), resistance, "short", 2) === 1);

// ── confirmation : L'INVARIANT DUR ──
// (1) doji seul ne confirme JAMAIS (dir neutral)
ok("doji + zone -> confirmation_valid FALSE", Cd.confirmation([B(100, 102, 98, 100.05)], support, "neutral", { atr: 2 }).confirmation_valid === false);
// (2) hammer DANS zone support + htf non-baissier -> VALID
const okConf = Cd.confirmation([hammerBar], support, "bullish", { atr: 2 });
ok("hammer en support + htf bullish -> VALID", okConf.confirmation_valid === true && okConf.side === "long");
// (3) hammer HORS zone -> invalid (location_quality<seuil)
ok("hammer hors zone -> INVALID", Cd.confirmation([hammerBar], [], "bullish", { atr: 2 }).confirmation_valid === false);
// (4) hammer en zone mais htf baissier -> non aligne -> invalid
ok("hammer long contre htf bearish -> INVALID", Cd.confirmation([hammerBar], support, "bearish", { atr: 2 }).confirmation_valid === false);
// (5) shooting star en resistance + htf non-haussier -> VALID short
const okShort = Cd.confirmation([B(101, 105, 99.8, 100)], resistance, "bearish", { atr: 2 });
ok("shooting star en resistance + htf bearish -> VALID short", okShort.confirmation_valid === true && okShort.side === "short");

// ── garde-fous ──
ok("bars vide -> pas d'exception", Cd.confirmation([], support, "neutral", {}).confirmation_valid === false);
ok("contrat complet (champs presents)", (() => { const r = Cd.confirmation([hammerBar], support, "bullish", { atr: 2 }); return ["pattern", "strength", "location_quality", "confirmation_valid", "side"].every((k) => k in r); })());

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
