#!/usr/bin/env node
"use strict";
// Tests offline deterministes de edge-watch.js (piste 5 : detection de decroissance
// d'edge entre snapshots optimize.js + bucket de regime). Zero reseau.
// Run: node tests/test-edge-watch.js
const { compareEdges, edgeOf, regimeBucket, regimeFit } = require("../trade-journal/edge-watch.js");
let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log("  PASS  " + name); } else { failed++; console.log("  FAIL  " + name); } }

// Shape = sortie optimize.js : setups[].{ setup, test_OOS:{exp,wr,n}, verdict }
const R = "✅ ROBUSTE (gagnant in & out-of-sample)";
const OF = "⚠️ overfit (bon en train, échoue en test)";

const curr = [
  { setup: "S5_MTF", test_OOS: { exp: 0.20, wr: 50, n: 40 }, verdict: R },
  { setup: "MR8_MTF", test_OOS: { exp: 0.11, wr: 58, n: 200 }, verdict: R },
  { setup: "S1_MTF", test_OOS: { exp: -0.02, wr: 42, n: 30 }, verdict: OF },     // edge passe negatif
  { setup: "MR4_MTF", test_OOS: { exp: 0.08, wr: 48, n: 60 }, verdict: OF },      // positif MAIS plus robuste
  { setup: "S2_short_continuation", signals: 50, note: "perdant" },              // non suivi -> ignore
];
const prev = [
  { setup: "S5_MTF", test_OOS: { exp: 0.30, wr: 52, n: 38 }, verdict: R },         // 0.30->0.20 = -33% (< 50%, pas de flag decay)
  { setup: "MR8_MTF", test_OOS: { exp: 0.25, wr: 60, n: 190 }, verdict: R },        // 0.25->0.11 = -56% (> 50% -> flag decay)
];

// ── edgeOf ──────────────────────────────────────────────────────────────────
ok("edgeOf: extrait exp/wr/n/robust", (() => { const e = edgeOf(curr, "S5_MTF"); return e.exp === 0.20 && e.wr === 50 && e.n === 40 && e.robust === true; })());
ok("edgeOf: robust=false si verdict non ROBUSTE", edgeOf(curr, "MR4_MTF").robust === false);
ok("edgeOf: null si setup absent", edgeOf(curr, "INEXISTANT") === null);
ok("edgeOf: null si pas de test_OOS", edgeOf(curr, "S2_short_continuation") === null);

// ── compareEdges (avec snapshot precedent) ───────────────────────────────────
const { flags, table } = compareEdges(prev, curr);
const f = flags.join(" | ");
ok("flag: S1_MTF edge <=0 (perdu)", /S1_MTF/.test(f) && /(≤0|perdu)/i.test(f));
ok("flag: MR4_MTF a perdu le verdict ROBUSTE", /MR4_MTF/.test(f) && /ROBUSTE/.test(f));
ok("flag: MR8_MTF decroissance >50%", /MR8_MTF/.test(f) && /(chute|décroiss|decroiss)/i.test(f));
ok("pas de flag pour S5_MTF (stable, drop 33% < 50%, robuste, >0)", !/S5_MTF/.test(f));
ok("table couvre les 4 setups suivis", table.length === 4);
ok("table porte prev_exp + curr_exp", table.every((r) => "prev_exp" in r && "curr_exp" in r));
ok("table S5_MTF prev 0.30 curr 0.20", (() => { const r = table.find((x) => x.setup === "S5_MTF"); return r.prev_exp === 0.30 && r.curr_exp === 0.20; })());

// ── compareEdges sans snapshot precedent (1er run) ───────────────────────────
const { flags: f0 } = compareEdges(null, curr);
const s0 = f0.join(" | ");
ok("sans prev: flag ≤0 et ROBUSTE quand meme", /S1_MTF/.test(s0) && /MR4_MTF/.test(s0));
ok("sans prev: PAS de flag decroissance (rien a comparer)", !/(chute|décroiss|decroiss)/i.test(s0));

// ── tout stable -> ✅ ────────────────────────────────────────────────────────
const allGood = [
  { setup: "S5_MTF", test_OOS: { exp: 0.22, wr: 51, n: 40 }, verdict: R },
  { setup: "MR8_MTF", test_OOS: { exp: 0.12, wr: 58, n: 200 }, verdict: R },
];
const { flags: fg } = compareEdges(allGood, allGood, { tracked: ["S5_MTF", "MR8_MTF"] });
ok("tout stable -> flag ✅ unique", fg.length === 1 && /✅/.test(fg[0]) && /stables/.test(fg[0]));

// ── tracked custom ───────────────────────────────────────────────────────────
const { table: t2 } = compareEdges(null, curr, { tracked: ["S5_MTF"] });
ok("tracked custom: 1 seul setup", t2.length === 1 && t2[0].setup === "S5_MTF");

// ── dropPct configurable ─────────────────────────────────────────────────────
const { flags: fStrict } = compareEdges(prev, curr, { tracked: ["S5_MTF"], dropPct: 0.3 });
ok("dropPct 0.3: S5 -33% declenche maintenant", /S5_MTF/.test(fStrict.join(" | ")) && /(chute|décroiss|decroiss)/i.test(fStrict.join(" | ")));

// ── regimeBucket (seuils alignes scan.js : 22 / 35) ──────────────────────────
ok("regimeBucket: >35 = strong", regimeBucket(44.9) === "strong" && regimeBucket(35.1) === "strong");
ok("regimeBucket: 22-35 = trending", regimeBucket(30) === "trending" && regimeBucket(22.1) === "trending");
ok("regimeBucket: <22 = range", regimeBucket(15) === "range" && regimeBucket(0) === "range");
ok("regimeBucket: frontieres exactes (35->trending, 22->range)", regimeBucket(35) === "trending" && regimeBucket(22) === "range");
ok("regimeBucket: null/NaN = ?", regimeBucket(null) === "?" && regimeBucket(undefined) === "?" && regimeBucket(NaN) === "?");

// ── regimeFit : routage setup<->regime (encode le finding 5a, TOP2) ──────────
// S1 = edge de TENDANCE (perd en range) ; MR8 = mean-reversion (bleed en strong) ; S5 = range.
ok("S1 en range -> avoid (bucket perdant -0.082R)", (() => { const f = regimeFit("S1_short_bounce", "range"); return f.fit === "avoid" && f.edge_R < 0; })());
ok("S1 en trending -> good (+0.354R)", regimeFit("S1_short_bounce", "trending").fit === "good");
ok("S1 en strong -> good (+0.311R)", regimeFit("S1_short_bounce", "strong").fit === "good");
ok("MR8 en range -> good (+0.13R)", regimeFit("MR8_stochrsi_revert", "range").fit === "good");
ok("MR8 en trending -> good (+0.191R)", regimeFit("MR8_stochrsi_revert", "trending").fit === "good");
ok("MR8 en strong -> avoid (bleed -0.05R)", (() => { const f = regimeFit("MR8_stochrsi_revert", "strong"); return f.fit === "avoid" && f.edge_R < 0; })());
ok("S5 en range -> good (+0.31R)", regimeFit("S5_fade_range", "range").fit === "good");
ok("S5 en trending -> neutral (n faible, pas de mesure)", regimeFit("S5_fade_range", "trending").fit === "neutral");
ok("MR4 -> neutral (marginal, pas de mesure régime fiable)", regimeFit("MR4_bb_trendfilt", "range").fit === "neutral");
ok("setup inconnu -> unknown", regimeFit("XYZ_truc", "range").fit === "unknown");
ok("régime '?' -> neutral (pas de mesure)", regimeFit("S1_short_bounce", "?").fit === "neutral");
ok("family extraite du nom (S1_... -> S1)", regimeFit("S1", "trending").fit === "good");
ok("retourne edge_R + note", (() => { const f = regimeFit("S1_short_bounce", "trending"); return typeof f.edge_R === "number" && typeof f.note === "string" && f.note.length > 0; })());

// ── S2 routé régime (validé 10.06 : edge de tendance caché) ──────────
ok("S2 en trending -> good (+0.30R)", regimeFit("S2_short_continuation", "trending").fit === "good");
ok("S2 en range -> avoid (-0.08R, skip dur SOP)", regimeFit("S2_short_continuation", "range").fit === "avoid");
ok("S2 en strong -> neutral (n test faible)", regimeFit("S2_short_continuation", "strong").fit === "neutral");

// ── S12 routé régime (validé 10.06 sprint #4, cross-TF) ──────────────
ok("S12 en trending -> good (+0.19R)", regimeFit("S12_squeeze_break", "trending").fit === "good");
ok("S12 en range -> neutral (pas de mesure 4H cohérente, SOP restreint)", regimeFit("S12_squeeze_break", "range").fit === "neutral");
ok("S12 en strong -> neutral (n faible 4H)", regimeFit("S12_squeeze_break", "strong").fit === "neutral");

// ── macroAlign (H2 : split macro des fades) ──────────────────────────
const { macroAlign } = require("../trade-journal/edge-watch.js");
ok("macroAlign: long en strong bear -> opposed", macroAlign("long", "strong", false) === "strong_opposed");
ok("macroAlign: short en strong bear -> aligned", macroAlign("short", "strong", false) === "strong_aligned");
ok("macroAlign: long en strong bull -> aligned", macroAlign("long", "strong", true) === "strong_aligned");
ok("macroAlign: short en strong bull -> opposed", macroAlign("short", "strong", true) === "strong_opposed");
ok("macroAlign: macro range -> calm", macroAlign("long", "range", false) === "calm");
ok("macroAlign: macro trending -> calm", macroAlign("short", "trending", true) === "calm");
ok("macroAlign: pas de mesure -> ?", macroAlign("long", "?", null) === "?" && macroAlign("long", "strong", null) === "?");

console.log(`\n  edge-watch.js: ${passed} pass, ${failed} fail`);
process.exit(failed ? 1 : 0);
