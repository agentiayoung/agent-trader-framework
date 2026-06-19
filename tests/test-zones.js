#!/usr/bin/env node
"use strict";
// Tests offline deterministes du detecteur de zones (zones.js). Zero reseau.
// Run: node tests/test-zones.js
const Z = require("../trade-journal/zones.js");
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

// ── FVG bull : L[k] > H[k-2] ──
const H = [99, 101, 100, 103, 106], L = [97, 99, 98, 101, 105], C = [98, 100, 99, 102, 105];
const fvg = Z.fvgZones(H, L, C, 2, 60);
ok("FVG bull detecte", fvg.some((z) => z.side === "bull" && z.lo === 100 && z.hi === 105));
ok("FVG bull fresh (rien apres)", fvg.find((z) => z.side === "bull").status === "fresh");
// FVG bear : H[k] < L[k-2]
const H2 = [110, 108, 109, 104, 101], L2 = [108, 106, 107, 102, 99], C2 = [109, 107, 108, 103, 100];
const fvg2 = Z.fvgZones(H2, L2, C2, 2, 60);
ok("FVG bear detecte", fvg2.some((z) => z.side === "bear"));

// ── Order block bull : bougie baissiere avant impulsion haussiere ──
const O = [10, 12, 10, 16], Hb = [13, 13, 16, 17], Lb = [9, 10, 9, 15], Cb = [11, 11, 15, 16];
const ob = Z.orderBlockZones(O, Hb, Lb, Cb, 2);
ok("Order block bull detecte", ob.some((z) => z.side === "bull" && z.lo === 10 && z.hi === 13));

// ── VWAP : moyenne ponderee volume ──
const vwBars = [[0, 10, 11, 9, 10, 100], [1, 10, 12, 10, 11, 100]];
const vw = Z.vwapZone(vwBars, 1);
ok("VWAP ~10.5", vw && Math.abs(vw.mid - 10.5) < 0.01 && vw.type === "vwap");
ok("VWAP vol nul -> null", Z.vwapZone([[0, 10, 11, 9, 10, 0]], 1) === null);

// ── Volume Profile : HVN ou se concentre le volume ──
const vpBars = [];
for (let i = 0; i < 20; i++) vpBars.push([i, 100, 101, 99, 100, 1000]); // gros volume vers 100
for (let i = 0; i < 5; i++) vpBars.push([20 + i, 110, 111, 109, 110, 10]); // faible vers 110
const vp = Z.volumeProfile(vpBars, 1, {});
ok("Volume Profile retourne HVN + LVN", vp.some((z) => z.type === "hvn") && vp.some((z) => z.type === "lvn"));
ok("HVN proche de 100 (concentration volume)", vp.find((z) => z.type === "hvn").mid < 105);

// ── Periodes precedentes : PDH/PDL ──
const daily = [[0, 10, 12, 9, 11, 100], [1, 11, 15, 10, 14, 100]];
const pp = Z.prevPeriodZones(daily, null, 1);
ok("PDH ~12 (high de la barre daily precedente)", pp.some((z) => z.type === "pdh" && Math.abs(z.mid - 12) < 0.2));
ok("PDL ~9", pp.some((z) => z.type === "pdl" && Math.abs(z.mid - 9) < 0.2));

// ── EQH/EQL : niveaux egaux (pool de liquidite) ──
const eqBars = buildZigzag([
  { px: 100, kind: "low" }, { px: 120, kind: "high" }, { px: 105, kind: "low" }, { px: 120, kind: "high" }, // 2 highs egaux a 120 = EQH
  { px: 108, kind: "low" }, { px: 130, kind: "high" },
]);
const eq = Z.equalLevels(eqBars, 2, {});
ok("EQH detecte (highs egaux = liquidite)", eq.some((z) => z.type === "eqh"));

// ── Agregateur buildZones sur un zigzag ──
const bars = buildZigzag([
  { px: 100, kind: "low" }, { px: 120, kind: "high" }, { px: 105, kind: "low" }, { px: 130, kind: "high" },
  { px: 112, kind: "low" }, { px: 140, kind: "high" }, { px: 118, kind: "low" }, { px: 150, kind: "high" },
]);
const r = Z.buildZones(bars, 3, { tf: "4h" });
ok("buildZones retourne des zones", r.zones.length > 0);
ok("buildZones a un nearest", r.nearest !== null);
ok("zones triees par dist_atr croissant", r.zones.every((z, i) => i === 0 || z.dist_atr >= r.zones[i - 1].dist_atr));
ok("chaque zone a le contrat (type/lo/hi/mid/status/dist_atr)", r.zones.every((z) => z.type && z.lo != null && z.hi != null && z.mid != null && z.status && z.dist_atr != null));
ok("buildZones expose support et/ou resistance", r.zones.some((z) => z.type === "support" || z.type === "resistance" || z.type === "flip"));

// ── garde-fous ──
ok("historique court -> note, pas d'exception", /insuffisant/.test(Z.buildZones([[0, 1, 2, 0.5, 1.5, 1]], 1).note || ""));
ok("bars vide -> pas d'exception", Array.isArray(Z.buildZones([], 1).zones));

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
