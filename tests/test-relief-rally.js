#!/usr/bin/env node
"use strict";
// Tests offline du detecteur relief-rally (scan.js reliefRally). Zero reseau.
// "Shorter apres une grosse chute qui bottom = mauvaise approche" (audit 12-15.06, 5x -1R).
// Run: node tests/test-relief-rally.js
const { reliefRally, marketPosture } = require("../trade-journal/scan.js");
let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log("  PASS  " + name); } else { failed++; console.log("  FAIL  " + name); } }

// ── ACTIF : le regime exact du bleed (Extreme Fear + capitulation + rebond large) ──
const bleed = { fear_extreme: true, alt_capitulation: true, reclaim_ema50d: 5 };
const r = reliefRally(bleed);
ok("ACTIF sur le scenario du bleed (fear+capit+reclaim5)", r.active === true);
ok("raisons listees", r.reasons.length === 3 && /reclaim/.test(r.reasons.join(" ")));
ok("note = ne pas armer de fade-short", /NE PAS armer de NOUVEAU fade-short/.test(r.note));

// ── seuil reclaim ──
ok("reclaim 3 (defaut) -> actif", reliefRally({ fear_extreme: true, alt_capitulation: true, reclaim_ema50d: 3 }).active === true);
ok("reclaim 2 < seuil -> INACTIF", reliefRally({ fear_extreme: true, alt_capitulation: true, reclaim_ema50d: 2 }).active === false);

// ── chaque condition est NECESSAIRE ──
ok("sans fear_extreme -> inactif", reliefRally({ fear_extreme: false, alt_capitulation: true, reclaim_ema50d: 5 }).active === false);
ok("sans alt_capitulation -> inactif", reliefRally({ fear_extreme: true, alt_capitulation: false, reclaim_ema50d: 5 }).active === false);
ok("marche calme (rien) -> inactif", reliefRally({ fear_extreme: false, alt_capitulation: false, reclaim_ema50d: 0 }).active === false);

// ── seuil configurable ──
ok("opts.minReclaim=6 -> reclaim5 inactif", reliefRally(bleed, { minReclaim: 6 }).active === false);

// ── robustesse ──
ok("bw null -> inactif sans crash", reliefRally(null).active === false);
ok("reclaim absent -> 0, inactif", reliefRally({ fear_extreme: true, alt_capitulation: true }).active === false);

// ── marketPosture : stance regime-adaptative (live-first 15.06) ──
ok("posture DEFENSIVE si relief_rally actif", marketPosture(20, { relief_rally: { active: true } }).stance === "defensive");
ok("posture DEFENSIVE si capitulation", marketPosture(20, { fear_extreme: true, alt_capitulation: true }).stance === "defensive");
ok("posture AGGRESSIVE si range sans trigger", marketPosture(15, { relief_rally: { active: false } }).stance === "aggressive");
ok("posture NORMAL si trending sans trigger", marketPosture(28, {}).stance === "normal");
ok("posture NORMAL si strong sans trigger", marketPosture(42, {}).stance === "normal");
ok("posture defensive PRIME sur range (relief en range)", marketPosture(15, { relief_rally: { active: true } }).stance === "defensive");

console.log("\n" + passed + " pass / " + failed + " fail");
process.exit(failed ? 1 : 0);
