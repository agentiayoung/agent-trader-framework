#!/usr/bin/env node
"use strict";
// Tests offline deterministes du moteur de structure (structure.js). Zero reseau.
// Series OHLC synthetiques a pivots NETS (zigzag) -> structures connues.
// Run: node tests/test-structure.js
const { marketStructure, swings, trendFromSwings, cols } = require("../trade-journal/structure.js");
let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log("  PASS  " + name); } else { failed++; console.log("  FAIL  " + name); } }

// Construit un zigzag : chaque anchor = extreme NET (spike), 3 fillers internes vers l'anchor suivant.
// anchors = [{px, kind:'high'|'low'}]. step=3 -> anchors espaces de 4 barres, pivots propres (k=2).
function buildZigzag(anchors, step) {
  step = step || 3;
  const bars = []; let ts = 0;
  for (let p = 0; p < anchors.length; p++) {
    const cur = anchors[p];
    if (cur.kind === "high") bars.push([ts++, cur.px - 2, cur.px, cur.px - 3, cur.px - 1, 100]);
    else bars.push([ts++, cur.px + 2, cur.px + 3, cur.px, cur.px + 1, 100]);
    if (p < anchors.length - 1) {
      const nxt = anchors[p + 1];
      for (let s = 1; s <= step; s++) {
        const t = s / (step + 1);
        const mid = cur.px + (nxt.px - cur.px) * t;
        bars.push([ts++, mid, mid + 0.5, mid - 0.5, mid, 100]);
      }
    }
  }
  return bars;
}

// ── 1) UPTREND (HH + HL) ──
const up = buildZigzag([
  { px: 100, kind: "low" }, { px: 115, kind: "high" }, { px: 105, kind: "low" }, { px: 125, kind: "high" },
  { px: 112, kind: "low" }, { px: 135, kind: "high" }, { px: 120, kind: "low" }, { px: 145, kind: "high" },
]);
const sUp = marketStructure(up, 2);
ok("uptrend -> trend up", sUp.trend === "up");
ok("uptrend -> last_bos dir up", sUp.last_bos && sUp.last_bos.dir === "up");
ok("uptrend -> sequence contient HH", sUp.sequence.includes("HH"));
ok("uptrend -> swings non vide", sUp.swings.length > 0);

// verif des helpers bruts
const { H, L } = cols(up);
const sw = swings(H, L, 2, 120);
ok("swings detecte highs ET lows", sw.some((s) => s.type === "high") && sw.some((s) => s.type === "low"));
ok("trendFromSwings up", trendFromSwings(sw) === "up");

// ── 2) DOWNTREND (LH + LL) ──
const dn = buildZigzag([
  { px: 150, kind: "high" }, { px: 130, kind: "low" }, { px: 140, kind: "high" }, { px: 120, kind: "low" },
  { px: 130, kind: "high" }, { px: 110, kind: "low" }, { px: 120, kind: "high" }, { px: 100, kind: "low" },
]);
const sDn = marketStructure(dn, 2);
ok("downtrend -> trend down", sDn.trend === "down");
ok("downtrend -> last_bos dir down", sDn.last_bos && sDn.last_bos.dir === "down");
ok("downtrend -> sequence contient LL", sDn.sequence.includes("LL"));

// ── 3) CHoCH : uptrend etabli PUIS cassure baissiere (cloture sous le dernier swing low) ──
const choch = buildZigzag([
  { px: 100, kind: "low" }, { px: 115, kind: "high" }, { px: 105, kind: "low" }, { px: 125, kind: "high" },
  { px: 112, kind: "low" }, { px: 120, kind: "high" }, { px: 90, kind: "low" }, // 90 < 112 = CHoCH down
]);
const sCho = marketStructure(choch, 2);
ok("CHoCH -> last_choch present", sCho.last_choch !== null);
ok("CHoCH -> direction down (retournement baissier)", sCho.last_choch && sCho.last_choch.dir === "down");
// MSS = CHoCH + momentum : avec mssBodyAtr=0 tout CHoCH devient MSS
const sChoMss = marketStructure(choch, 2, { mssBodyAtr: 0 });
ok("MSS detecte si momentum (mssBodyAtr=0)", sChoMss.last_mss && sChoMss.last_mss.dir === "down");

// ── 4) phase : impulse vs correction ──
const impulse = up.slice();
impulse.push([999, 145, 170, 144, 169, 100]); // grosse bougie haussiere alignee (corps 24 >> 1.2*atr)
const sImp = marketStructure(impulse, 2);
ok("phase impulse sur grosse bougie alignee", sImp.phase === "impulse");

// ── 5) garde-fous : historique insuffisant -> note, pas d'exception ──
const tiny = marketStructure([[0, 1, 2, 0.5, 1.5, 10], [1, 1.5, 2.5, 1, 2, 10]], 1);
ok("historique court -> note + trend range", tiny.trend === "range" && /insuffisant/.test(tiny.note || ""));
ok("bars vide -> pas d'exception", marketStructure([], 1).trend === "range");
ok("bars null -> pas d'exception", marketStructure(null, 1).trend === "range");

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
