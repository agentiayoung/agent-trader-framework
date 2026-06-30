"use strict";
// ═══════════════════════════════════════════════════════════════════
// test-dashboard-api.js — S01 dashboard API (offline, déterministe).
// Couvre les agrégateurs PURS : market / options / freshness.
// Aucune I/O, aucun réseau : on passe des fixtures synthétiques.
// ═══════════════════════════════════════════════════════════════════
const assert = require("assert");
const { buildMarket } = require("../dashboard/api/market.js");
const { buildOptions, buildOptionsOne } = require("../dashboard/api/options.js");
const { computeFreshness } = require("../dashboard/api/freshness.js");
const { pickFreshest } = require("../dashboard/api/sources.js");

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };

// ─────────────────────────── fixtures ───────────────────────────
const SCAN = {
  ts: "2026-06-25T16:38:08.676Z",
  scanned: 29,
  market: {
    btc_daily_adx: 35.3,
    regime: "STRONG_TREND (prudence fades)",
    posture: { stance: "defensive", reasons: ["capitulation"], note: "DEFENSIVE ..." },
    dispersion: { mean_corr: 0.651, n_decoupled: 4, n_pairs: 22, regime: "mixed", hedge_enabled: false, note: "MIXED ..." },
    fear_greed: { value: 12, label: "Extreme Fear", yesterday: 17, note: "observabilite" },
    bottom_watch: {
      pairs_at_cycle_low: 7, at_cycle_low_pairs: ["AVAX", "ADA"],
      bull_div_at_low: ["GOOGL"], bull_div_any: ["TAO", "GOOGL"],
      reclaim_ema50d: 1, reclaim_pairs: ["HYPE"], reclaim_ema200d: 0,
      decoupled_from_btc: ["XAUT", "MSFT"], btc_range_pos: 33,
      fear_extreme: true, alt_capitulation: true, bottom_confirmed: false,
      relief_rally: { active: false },
    },
    options: {
      btc: { spot: 59348.38, max_pain: 71000, call_wall: 80000, put_wall: 20000, gex_flip: 64034, gamma_regime: "negative", net_gex: -1.9958, put_call: 0.73, skew_25d: 4.7, atm_iv: 51.8, n_strikes: 172, nearest_expiry: 1782460800000, read: "gamma -" },
      eth: { spot: 1564.67, max_pain: 2000, call_wall: 2000, put_wall: 1500, gex_flip: 1678, gamma_regime: "negative", net_gex: -300.43, put_call: 0.55, skew_25d: -18.9, atm_iv: 63.7, n_strikes: 161, nearest_expiry: 1782460800000, read: "gamma -" },
    },
  },
};

// ─────────────────────────── buildMarket ───────────────────────────
const mk = buildMarket(SCAN);
ok(!mk.stale, "market non-stale sur scan complet");
eq(mk.regime, "STRONG_TREND (prudence fades)", "regime propagé");
eq(mk.btc_daily_adx, 35.3, "ADX propagé");
eq(mk.posture.stance, "defensive", "posture.stance");
eq(mk.fear_greed.value, 12, "fear value");
eq(mk.fear_greed.delta, -5, "fear delta = value - yesterday (12-17)");
eq(mk.dispersion.regime, "mixed", "dispersion regime");
eq(mk.dispersion.hedge_enabled, false, "hedge_enabled propagé");
eq(mk.bottom_watch.pairs_at_cycle_low, 7, "bottom pairs count");
eq(mk.bottom_watch.bottom_confirmed, false, "bottom_confirmed");
eq(mk.bottom_watch.relief_rally_active, false, "relief_rally aplati en bool");
ok(Array.isArray(mk.bottom_watch.bull_div_at_low), "bull_div_at_low array");
eq(mk.ts, SCAN.ts, "ts propagé");

// dégradation gracieuse
eq(buildMarket(null).stale, true, "null -> stale");
eq(buildMarket({}).stale, true, "sans .market -> stale");
ok(buildMarket({ market: { regime: "X" } }).regime === "X", "market partiel ne plante pas");

// ─────────────────────────── buildOptions ───────────────────────────
const opt = buildOptions(SCAN);
ok(!opt.stale, "options non-stale");
eq(opt.btc.gamma_regime, "negative", "btc gamma_regime");
eq(opt.btc.above_flip, false, "btc spot 59348 < flip 64034 -> above_flip false");
eq(opt.eth.above_flip, false, "eth spot 1564 < flip 1678 -> above_flip false");
ok(typeof opt.btc.flip_dist_pct === "number", "flip_dist_pct numérique");
ok(opt.btc.flip_dist_pct < 0, "spot sous le flip -> dist négative");
eq(opt.btc.net_gex, -1.9958, "net_gex propagé");
eq(buildOptions(null).stale, true, "options null -> stale");
eq(buildOptions({ market: {} }).stale, true, "options absentes -> stale");

// above_flip avec spot au-dessus du flip
const above = buildOptionsOne({ spot: 70000, gex_flip: 64034, gamma_regime: "positive" });
eq(above.above_flip, true, "spot 70000 > flip -> above_flip true");
ok(above.flip_dist_pct > 0, "dist positive au-dessus du flip");
eq(buildOptionsOne(null), null, "buildOptionsOne(null) -> null");
eq(buildOptionsOne({ spot: 100 }).above_flip, null, "flip manquant -> above_flip null");

// ─────────────────────────── computeFreshness ───────────────────────────
const NOW = 1000000; // ms
const fr = computeFreshness({
  "scan-latest.json": { mtimeMs: NOW - 30000, ts: null },      // 30s
  "heartbeat.json": { mtimeMs: NOW - 9000000, ts: null },      // 9000s > seuil
  "missing.json": { mtimeMs: null, ts: null },
}, { nowMs: NOW, thresholdSec: 7200 });
eq(fr["scan-latest.json"].age_sec, 30, "age 30s");
eq(fr["scan-latest.json"].stale, false, "30s pas stale");
eq(fr["heartbeat.json"].stale, true, "9000s > 7200 -> stale");
eq(fr["missing.json"].exists, false, "fichier absent");
eq(fr["missing.json"].stale, true, "absent -> stale");
// seuil par-source override
const fr2 = computeFreshness({ "x": { mtimeMs: NOW - 100000, ts: null } }, { nowMs: NOW, thresholds: { x: 50 } });
eq(fr2["x"].stale, true, "seuil par-source 50s respecté");

// ─────────────────────────── pickFreshest (scan le plus frais) ───────────────────────────
eq(pickFreshest([{ source: "agent-trader", mtimeMs: 100 }, { source: "scalp-trader", mtimeMs: 200 }]).source, "scalp-trader", "pick le mtime le plus récent");
eq(pickFreshest([{ source: "agent-trader", mtimeMs: 300 }, { source: "scalp-trader", mtimeMs: 200 }]).source, "agent-trader", "pick agent si plus récent");
eq(pickFreshest([{ source: "a", mtimeMs: null }, { source: "b", mtimeMs: 50 }]).source, "b", "ignore les sources absentes");
eq(pickFreshest([{ source: "a", mtimeMs: null }]), null, "tout absent -> null");
eq(pickFreshest([]), null, "vide -> null");

// ─────────────────────────── positions (vérité Bybit, snapshot) ───────────────────────────
const { buildPositions, buildOne } = require("../dashboard/api/positions.js");
const NOW2 = 2000000;
const agentSnap = { ts: NOW2 - 300000, positions: [{ symbol: "BTC", side: "short", size: 0.1, entry: 60000, mark: 59500, upnl: 50 }], orders: [{ symbol: "BNB", reduceOnly: false, px: 600 }, { symbol: "BNB", reduceOnly: true, trigger: 620 }] };
const pp = buildPositions(agentSnap, null, NOW2);
eq(pp["agent-trader"].available, true, "agent snapshot dispo");
eq(pp["agent-trader"].positions.length, 1, "1 position remplie");
eq(pp["agent-trader"].pending.length, 1, "1 pending = entree au repos (non-reduce)");
eq(pp["agent-trader"].bracket_n, 1, "1 ordre bracket (reduce-only) compté à part");
eq(pp["agent-trader"].age_sec, 300, "age 300s depuis ts");
eq(pp["scalp-trader"].available, false, "snapshot absent -> available:false (pas de fausse position)");
eq(buildOne(null, NOW2).available, false, "null -> indispo");
eq(buildOne({ ts: NOW2, positions: [], orders: [] }, NOW2).pending.length, 0, "snapshot vide -> 0 pending (SOL fantome exclu par construction)");

console.log(`test-dashboard-api OK (${n} assertions)`);
