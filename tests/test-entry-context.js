#!/usr/bin/env node
"use strict";
// Tests offline deterministes de la capture de contexte d'analyse (entry-context.js). Zero reseau.
// Run: node tests/test-entry-context.js
const { buildEntryContext, baseSym, zonesFallbackRate } = require("../trade-journal/entry-context.js");
let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log("  PASS  " + name); } else { failed++; console.log("  FAIL  " + name); } }

// Scan factice representatif de scan-latest.json
const scan = {
  ts: "2026-06-18T13:00:00.000Z",
  market: {
    regime: "STRONG_TREND", btc_daily_adx: 48.1,
    posture: { stance: "defensive", reasons: ["relief_rally"] },
    dispersion: { regime: "concentrated", mean_corr: 0.81 },
    fear_greed: { value: 14, label: "Extreme Fear" },
    bottom_watch: { relief_rally: { active: true }, alt_capitulation: true, bottom_confirmed: false },
    options: {
      btc: { max_pain: 65500, call_wall: 67000, put_wall: 65000, gamma_regime: "positive", skew_25d: 12 },
      eth: null,
    },
  },
  opportunities: [
    { pair: "LTC", setup: "S2_short_continuation", side: "short", score: 25.2, regime_fit: { fit: "neutral" }, divergence: null, cycle: { range_pos: 1.2, at_cycle_low: true }, beta: { vs_btc: 0.9 } },
    { pair: "SUI", setup: "MR8_stochrsi_revert", side: "short", score: 18.5, regime_fit: { fit: "good" }, divergence: "bull", cycle: { range_pos: 30, at_cycle_low: false }, beta: { vs_btc: 1.3 } },
    { pair: "HYPE", setup: "MR8_MTF", side: "long", score: 12.1, regime_fit: { fit: "good" }, divergence: null, cycle: null, beta: { vs_btc: 1.8 } },
    { pair: "XRP", setup: "S1_short_bounce", side: "short", score: 9.0, regime_fit: { fit: "avoid" }, divergence: null, cycle: null, beta: null },
  ],
  all: [],
};

// ── 1) snapshot marche capture les champs cles ──
const ec = buildEntryContext({ symbol: "SUI", zones: "screener_fallback" }, scan);
ok("scan_ts preserve", ec.scan_ts === "2026-06-18T13:00:00.000Z");
ok("regime capture", ec.market.regime === "STRONG_TREND");
ok("posture aplatie (stance)", ec.market.posture === "defensive");
ok("dispersion aplatie (regime)", ec.market.dispersion === "concentrated");
ok("fear_greed compact", ec.market.fear_greed.value === 14 && ec.market.fear_greed.label === "Extreme Fear");
ok("relief_rally booleen", ec.market.relief_rally === true);
ok("alt_capitulation booleen", ec.market.alt_capitulation === true);
ok("bottom_confirmed booleen", ec.market.bottom_confirmed === false);

// ── 2) this_pair = la paire du trade, pas une autre ──
ok("this_pair = SUI", ec.this_pair && ec.this_pair.pair === "SUI");
ok("this_pair setup correct", ec.this_pair.setup === "MR8_stochrsi_revert");
ok("this_pair regime_fit aplati", ec.this_pair.regime_fit === "good");
ok("this_pair divergence", ec.this_pair.divergence === "bull");
ok("this_pair beta aplati", ec.this_pair.beta === 1.3);

// ── 3) top3 trie par |score| ──
ok("top3 longueur 3", ec.top3.length === 3);
ok("top3[0] = LTC (score le plus haut)", ec.top3[0].pair === "LTC");
ok("top3 ne contient pas XRP (4e)", !ec.top3.some((o) => o.pair === "XRP"));

// ── 4) options compactes ──
ok("options btc compactes", ec.options.btc.max_pain === 65500 && ec.options.btc.gamma_regime === "positive");
ok("options eth null preserve", ec.options.eth === null);

// ── 5) zones_source repris du trade ──
ok("zones_source capture", ec.zones_source === "screener_fallback");

// ── 6) symbole avec suffixe ccxt matche la base ──
ok("baseSym BTC/USDT:USDT -> BTC", baseSym("BTC/USDT:USDT") === "BTC");
const ec2 = buildEntryContext({ symbol: "LTC/USDT:USDT" }, scan);
ok("this_pair matche malgre suffixe ccxt", ec2.this_pair && ec2.this_pair.pair === "LTC");

// ── 7) scan absent/invalide -> note, jamais d'exception ──
const ecNone = buildEntryContext({ symbol: "BTC" }, null);
ok("scan absent -> note", ecNone.scan_ts === null && /non capture|absent/.test(ecNone.note));
const ecEmpty = buildEntryContext({ symbol: "BTC" }, { ts: "x" });
ok("scan sans market -> note", ecEmpty.note != null);

// ── 8) paire inconnue -> this_pair null (pas d'erreur) ──
const ecUnknown = buildEntryContext({ symbol: "DOESNOTEXIST" }, scan);
ok("paire inconnue -> this_pair null", ecUnknown.this_pair === null && Array.isArray(ecUnknown.top3));

// ── 9) zonesFallbackRate : taux de screener_fallback sur trades recents (G2) ──
const nowIso = new Date().toISOString();
const oldIso = new Date(Date.now() - 30 * 86400000).toISOString();
const tr = [
  { ts_open: nowIso, zones: "screener_fallback (Desktop off)" },
  { ts_open: nowIso, zones: "zeiierman" },
  { ts_open: nowIso, zones: "screener_fallback" },
  { ts_open: nowIso }, // pas de champ zones -> ignore
  { ts_open: oldIso, zones: "screener_fallback" }, // trop vieux -> ignore (fenetre 7j)
];
const zf = zonesFallbackRate(tr, 7);
ok("zonesFallbackRate n=3 (recents avec zones)", zf.n === 3);
ok("zonesFallbackRate fallback=2", zf.fallback === 2);
ok("zonesFallbackRate desktop=1", zf.desktop === 1);
ok("zonesFallbackRate rate=0.67", zf.rate === 0.67);
ok("zonesFallbackRate vide -> rate null", zonesFallbackRate([], 7).rate === null);

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
