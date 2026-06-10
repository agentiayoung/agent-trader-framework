#!/usr/bin/env node
"use strict";
// Tests offline deterministes de digest.js (observabilité). Zero reseau.
// Run: node tests/test-digest.js
const { buildDigest, buildHeartbeat, isStale } = require("../trade-journal/digest.js");
let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log("  PASS  " + name); } else { failed++; console.log("  FAIL  " + name); } }

const state = {
  ts: "2026-06-09T22:07+02:00", equity: 49998.5, day_pnl_pct: -0.42, drawdown_pct: 0.8, halt: false,
  open: [{ side: "short", symbol: "BTC", size: 0.006, entry_actual: 63200,
           timeline: [{ mark: 63477, upnl: -1.6, decision: "keep" }] }],
  pending: [{ side: "short", symbol: "AVAX", size: 5200, entry_planned: 6.91 }],
  today_trades: 1, today_no_trades: 2, stale_count: 0, score_eval_n: 0,
};

const d = buildDigest(state);
ok("digest contient equity", d.includes("49999 USDT") || d.includes("49998 USDT"));
ok("digest contient jour -0.42%", d.includes("-0.42%"));
ok("digest breaker OK", d.includes("✅ OK"));
ok("digest positions 2/4", d.includes("Positions 2/4"));
ok("digest ligne BTC avec mark+uPnL", d.includes("short BTC") && d.includes("mark 63477") && d.includes("uPnL -1.6") && d.includes("keep"));
ok("digest AVAX pending non noté", d.includes("short AVAX") && d.includes("non noté"));
ok("digest today 1 trade 2 no-trade", d.includes("1 trade(s), 2 no-trade(s)"));
ok("digest pas de warn stale (count 0)", !d.includes("NON noté(s)"));

// halt + stale
const d2 = buildDigest({ ts: "x", equity: 45000, day_pnl_pct: -6.1, halt: true, open: [], pending: [], stale_count: 2, score_eval_n: 4 });
ok("digest HALT", d2.includes("🛑 HALT"));
ok("digest warn stale count 2", d2.includes("⚠️ 2 trade(s)"));
ok("digest score-eval n=4", d2.includes("n=4"));

// heartbeat objet
const hb = buildHeartbeat(state);
ok("heartbeat compte open/pending", hb.open === 1 && hb.pending === 1);
ok("heartbeat halt false", hb.halt === false);
ok("heartbeat equity numerique", hb.equity === 49998.5);

// dead-man : isStale
ok("isStale: heartbeat absent = stale", isStale(null, 1000, 300) === true);
ok("isStale: recent = OK", isStale(1000, 1000 + 60 * 1000, 300) === false);          // 1 min < 300
ok("isStale: vieux = stale", isStale(1000, 1000 + 6 * 3600 * 1000, 300) === true);   // 6h > 300 min

console.log(`\n  digest.js: ${passed} pass, ${failed} fail`);
process.exit(failed ? 1 : 0);
