#!/usr/bin/env node
"use strict";
// Tests offline deterministes des metriques d'orderflow (orderflow.js). Zero reseau.
// Run: node tests/test-orderflow.js
const OF = require("../trade-journal/orderflow.js");
let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log("  PASS  " + name); } else { failed++; console.log("  FAIL  " + name); } }
const B = (o, h, l, c) => [0, o, h, l, c, 100];

// ── cumulativeDelta ──
const cd = OF.cumulativeDelta([{ side: "buy", amount: 10 }, { side: "sell", amount: 3 }, { side: "buy", amount: 2 }]);
ok("CVD = +9 (12 buy - 3 sell)", cd.cvd === 9 && cd.buy === 12 && cd.sell === 3);
ok("ratio acheteur positif", cd.ratio > 0);
ok("trades vides -> cvd 0", OF.cumulativeDelta([]).cvd === 0);

// ── divergence (prix vs CVD) ──
ok("prix monte + CVD baisse -> bear", OF.divergence([100, 105], [50, 30]) === "bear");
ok("prix baisse + CVD monte -> bull", OF.divergence([105, 100], [30, 50]) === "bull");
ok("prix et CVD alignes -> null", OF.divergence([100, 105], [30, 50]) === null);
ok("series trop courtes -> null", OF.divergence([100], [50]) === null);

// ── oiPriceSignal ──
ok("prix+ OI+ -> new_longs", OF.oiPriceSignal(1.5, 2.0) === "new_longs");
ok("prix+ OI- -> short_covering", OF.oiPriceSignal(1.5, -2.0) === "short_covering");
ok("prix- OI+ -> new_shorts", OF.oiPriceSignal(-1.5, 2.0) === "new_shorts");
ok("prix- OI- -> long_covering", OF.oiPriceSignal(-1.5, -2.0) === "long_covering");
ok("variations sous eps -> neutral", OF.oiPriceSignal(0.01, 0.01) === "neutral");
ok("OI manquant -> unknown", OF.oiPriceSignal(1, null) === "unknown");

// ── detectSweep (depuis OHLCV) ──
// serie plate ~100, low recent ~99 ; derniere bougie perce a 97 mais recloture a 100.5 = sweep des lows
const sweepBars = [];
for (let i = 0; i < 30; i++) sweepBars.push(B(100, 101, 99, 100));
sweepBars.push(B(100, 100.8, 97, 100.5)); // meche sous 99, cloture au-dessus
const sw = OF.detectSweep(sweepBars, 1, { lookback: 30, pierceAtr: 0.1 });
ok("sweep des lows detecte (stop-hunt)", sw.detected === true && sw.side === "sell_side" && sw.bias === "long");
// sweep des highs
const sweepHi = [];
for (let i = 0; i < 30; i++) sweepHi.push(B(100, 101, 99, 100));
sweepHi.push(B(100, 104, 99.5, 99.5)); // meche au-dessus 101, cloture en dessous
const swH = OF.detectSweep(sweepHi, 1, { lookback: 30, pierceAtr: 0.1 });
ok("sweep des highs detecte", swH.detected === true && swH.side === "buy_side" && swH.bias === "short");
// pas de sweep en serie normale
const normal = []; for (let i = 0; i < 30; i++) normal.push(B(100, 101, 99, 100.2));
ok("pas de sweep en serie normale", OF.detectSweep(normal, 1).detected === false);
ok("historique court -> pas de sweep", OF.detectSweep([B(100, 101, 99, 100)], 1).detected === false);

// ── absorption ──
ok("gros delta + prix immobile -> absorption", OF.absorption(1000, 0.02, { minAbsDelta: 100, maxMovePct: 0.1 }).detected === true);
ok("gros delta + gros move -> pas d'absorption", OF.absorption(1000, 2.0, { minAbsDelta: 100, maxMovePct: 0.1 }).detected === false);
ok("delta acheteur absorbe -> contre short", OF.absorption(1000, 0.02, { minAbsDelta: 100 }).against === "short");

// ── buildOrderflow agregateur ──
const r = OF.buildOrderflow({ trades: [{ side: "buy", amount: 10 }, { side: "sell", amount: 2 }], bars: sweepBars, atr: 1, priceChangePct: 0.5, oiChangePct: 1.5 });
ok("buildOrderflow expose le contrat", ["delta", "cvd", "aggression", "cvd_divergence", "oi_signal", "sweep", "absorption"].every((k) => k in r));
ok("buildOrderflow capte le sweep", r.sweep.detected === true);
ok("buildOrderflow oi_signal new_longs", r.oi_signal === "new_longs");
ok("buildOrderflow inputs vides -> pas d'exception", typeof OF.buildOrderflow({}) === "object");

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
