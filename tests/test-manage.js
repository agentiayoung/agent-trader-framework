#!/usr/bin/env node
"use strict";
// Tests offline deterministes des alertes de gestion (manage.js). Zero reseau.
// Lecon DOGE 12.06 : un short LIVE avec divergence:bull pendant alt_capitulation
// (ou at_cycle_low) doit faire RESSERRER le SL, pas garder le SL planifie.
// Run: node tests/test-manage.js
const { slTightenAlerts, pairKey } = require("../trade-journal/manage.js");
let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log("  PASS  " + name); } else { failed++; console.log("  FAIL  " + name); } }

// ── pairKey : normalise les formats de symbole ──
ok("pairKey DOGE", pairKey("DOGE") === "DOGE");
ok("pairKey DOGE/USDT:USDT", pairKey("DOGE/USDT:USDT") === "DOGE");
ok("pairKey DOGEUSDT", pairKey("DOGEUSDT") === "DOGE");

const market = { bottom_watch: { alt_capitulation: true } };
const marketNoCap = { bottom_watch: { alt_capitulation: false } };
const scanAll = [
  { pair: "DOGE", divergence: "bull", cycle: { at_cycle_low: false } },   // div bull (squeeze sous le short)
  { pair: "DOT", divergence: null, cycle: { at_cycle_low: true } },        // bottoming name
  { pair: "SUI", divergence: null, cycle: { at_cycle_low: false } },       // RAS
  { pair: "LINK", divergence: "bull", cycle: { at_cycle_low: false } },
  { pair: "AVAX", divergence: "bull", cycle: { at_cycle_low: true } },     // les deux
];

// ── 1) DOGE short open + div:bull + alt_capitulation -> tighten_sl ──
const r1 = slTightenAlerts([{ id: "d1", symbol: "DOGE", side: "short", status: "open" }], scanAll, market);
ok("DOGE short open flague (div:bull + altcap)", r1.n === 1 && r1.alerts[0].action === "tighten_sl");
ok("DOGE raison mentionne divergence", /divergence:bull/.test(r1.alerts[0].reasons.join(" ")));

// ── 2) at_cycle_low short -> tighten meme SANS div ──
const r2 = slTightenAlerts([{ id: "dot1", symbol: "DOT/USDT:USDT", side: "short", status: "open" }], scanAll, market);
ok("DOT short open flague (at_cycle_low)", r2.n === 1 && /at_cycle_low/.test(r2.alerts[0].reasons.join(" ")));

// ── 3) div:bull SANS alt_capitulation + pas atlow -> PAS flague ──
const r3 = slTightenAlerts([{ id: "l1", symbol: "LINK", side: "short", status: "open" }], scanAll, marketNoCap);
ok("LINK short NON flague si div:bull mais alt_capitulation=false", r3.n === 0);

// ── 4) at_cycle_low flague meme si alt_capitulation=false ──
const r4 = slTightenAlerts([{ id: "dot2", symbol: "DOT", side: "short", status: "open" }], scanAll, marketNoCap);
ok("DOT at_cycle_low flague meme sans altcap", r4.n === 1);

// ── 5) pending short -> action reconsider_pending ──
const r5 = slTightenAlerts([{ id: "av1", symbol: "AVAX", side: "short", status: "pending" }], scanAll, market);
ok("AVAX pending -> reconsider_pending", r5.n === 1 && r5.alerts[0].action === "reconsider_pending");

// ── 6) LONG jamais flague (cycle lens = bottom = short only) ──
const r6 = slTightenAlerts([{ id: "h1", symbol: "AVAX", side: "long", status: "open" }], scanAll, market);
ok("LONG jamais flague", r6.n === 0);

// ── 7) SUI short propre (div null, pas atlow) -> PAS flague ──
const r7 = slTightenAlerts([{ id: "s1", symbol: "SUI", side: "short", status: "open" }], scanAll, market);
ok("SUI short propre NON flague", r7.n === 0);

// ── 8) paire absente du scan -> pas d'info, pas d'alerte ──
const r8 = slTightenAlerts([{ id: "x1", symbol: "PEPE", side: "short", status: "open" }], scanAll, market);
ok("paire absente du scan -> 0 alerte", r8.n === 0);

// ── 9) statut clos/annule ignore ──
const r9 = slTightenAlerts([{ id: "c1", symbol: "DOGE", side: "short", status: "closed" }], scanAll, market);
ok("trade clos ignore", r9.n === 0);

// ── 10) multi-positions : compte exact ──
const r10 = slTightenAlerts([
  { id: "d1", symbol: "DOGE", side: "short", status: "open" },
  { id: "dot1", symbol: "DOT", side: "short", status: "open" },
  { id: "s1", symbol: "SUI", side: "short", status: "open" },
], scanAll, market);
ok("3 positions -> 2 flaguees (DOGE+DOT, pas SUI)", r10.n === 2);
ok("alt_capitulation reporte", r10.alt_capitulation === true);

console.log(`\n${passed} pass / ${failed} fail`);
process.exit(failed ? 1 : 0);
