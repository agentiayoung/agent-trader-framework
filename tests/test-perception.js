#!/usr/bin/env node
"use strict";
// Tests offline deterministes de l'agregateur de perception (perception.js). Zero reseau.
// Run: node tests/test-perception.js
const { buildPerception, compactPerception, atrFrom, htfFromTrend } = require("../trade-journal/perception.js");
let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log("  PASS  " + name); } else { failed++; console.log("  FAIL  " + name); } }

function buildZigzag(anchors, step) {
  step = step || 3; const bars = []; let ts = 0;
  for (let p = 0; p < anchors.length; p++) {
    const cur = anchors[p];
    if (cur.kind === "high") bars.push([ts++, cur.px - 2, cur.px, cur.px - 3, cur.px - 1, 100]);
    else bars.push([ts++, cur.px + 2, cur.px + 3, cur.px, cur.px + 1, 100]);
    if (p < anchors.length - 1) { const nxt = anchors[p + 1]; for (let s = 1; s <= step; s++) { const t = s / (step + 1); const mid = cur.px + (nxt.px - cur.px) * t; bars.push([ts++, mid, mid + 0.5, mid - 0.5, mid, 100]); } }
  }
  return bars;
}

// ── htfFromTrend / atrFrom ──
ok("htf up -> bullish", htfFromTrend("up") === "bullish");
ok("htf down -> bearish", htfFromTrend("down") === "bearish");
ok("htf range -> neutral", htfFromTrend("range") === "neutral");
const bars = buildZigzag([
  { px: 100, kind: "low" }, { px: 120, kind: "high" }, { px: 105, kind: "low" }, { px: 130, kind: "high" },
  { px: 112, kind: "low" }, { px: 140, kind: "high" }, { px: 118, kind: "low" }, { px: 150, kind: "high" },
]);
ok("atrFrom retourne un nombre positif", atrFrom(bars, 14) > 0);

// ── buildPerception : assemble le market_state + confluence ──
const p = buildPerception({ bars, atr: 3, tf: "4h" });
ok("perception a structure", p.structure && p.structure.trend);
ok("perception a zones (array)", Array.isArray(p.zones));
ok("perception a candles", p.candles && "confirmation_valid" in p.candles);
ok("perception a confluence 0-100", p.confluence && typeof p.confluence.score === "number" && p.confluence.score >= 0 && p.confluence.score <= 100);
ok("perception htf_bias coherent", ["bullish", "bearish", "neutral"].includes(p.htf_bias));
ok("orderflow null si non fourni", p.orderflow === null);

// orderflow injecte -> pris en compte
const p2 = buildPerception({ bars, atr: 3, tf: "4h", orderflow: { sweep: { detected: true, bias: "long", side: "sell_side" }, cvd_divergence: "bull", oi_signal: "new_longs" } });
ok("orderflow injecte present", p2.orderflow && p2.orderflow.sweep.detected === true);

// ── compactPerception : resume leger ──
const cp = compactPerception(p);
ok("compact a trend", "trend" in cp);
ok("compact a confluence {score,score14,tier,side,decision}", cp.confluence && "score" in cp.confluence && "score14" in cp.confluence && "tier" in cp.confluence && "side" in cp.confluence && "decision" in cp.confluence);
ok("compact confluence expose opp14 (sens oppose, F1)", cp.confluence && "opp14" in cp.confluence);
ok("compact nearest_zone (objet ou null)", cp.nearest_zone === null || (cp.nearest_zone && "type" in cp.nearest_zone));
ok("compact null si perc null", compactPerception(null) === null);

// ── garde-fous ──
ok("bars insuffisants -> note + no_trade", buildPerception({ bars: [[0, 1, 2, 0.5, 1.5, 1]] }).confluence.decision === "no_trade");
ok("bars vide -> pas d'exception", buildPerception({ bars: [] }).confluence.decision === "no_trade");
ok("opts vide -> pas d'exception", typeof buildPerception({}) === "object");

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
