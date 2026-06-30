"use strict";
// test-bybit-snapshot.js — buildBybitSnapshot PUR (offline, deterministe).
const assert = require("assert");
const { buildBybitSnapshot, baseSym, isReduce } = require("../trade-journal/bybit-snapshot.js");
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };

const NOW = 1782500000000;
const positions = [
  { symbol: "BTC/USDT:USDT", side: "short", contracts: 0.1, entryPrice: 60000, markPrice: 59500, unrealizedPnl: 50 },
  { symbol: "ETH/USDT:USDT", side: "long", contracts: 0, entryPrice: 0 }, // size 0 -> exclu
];
const orders = [
  { symbol: "SOL/USDT:USDT", side: "buy", type: "limit", price: 72.74, amount: 67, reduceOnly: false }, // entree au repos
  { symbol: "SOL/USDT:USDT", side: "sell", type: "market", triggerPrice: 70, amount: 67, reduceOnly: true }, // SL
  { symbol: "BNBUSDT", side: "sell", type: "limit", price: 600, amount: 1, info: { reduceOnly: "true" } }, // reduce via info string
];
const s = buildBybitSnapshot(positions, orders, NOW);
eq(s.ts, NOW, "ts injecte");
ok(/2026/.test(s.generated), "generated ISO");
eq(s.positions.length, 1, "1 position (size 0 exclu)");
eq(s.positions[0].symbol, "BTC", "symbol normalise");
eq(s.positions[0].side, "short", "side");
eq(s.positions[0].size, 0.1, "size abs");
eq(s.positions[0].entry, 60000, "entry");
eq(s.positions[0].mark, 59500, "mark");
eq(s.positions[0].upnl, 50, "upnl");
eq(s.orders.length, 3, "3 orders");
eq(s.orders[0].symbol, "SOL", "order symbol normalise");
eq(s.orders[0].reduceOnly, false, "entree non-reduce");
eq(s.orders[0].px, 72.74, "px entree");
eq(s.orders[1].reduceOnly, true, "SL reduce");
eq(s.orders[1].trigger, 70, "trigger SL");
eq(s.orders[2].reduceOnly, true, "reduce via info string");
eq(s.orders[2].symbol, "BNB", "BNBUSDT normalise");
// graceful
eq(buildBybitSnapshot(null, null, NOW).positions.length, 0, "null -> positions vide");
eq(buildBybitSnapshot([], [], NOW).orders.length, 0, "vide -> orders vide");
// helpers
eq(baseSym("SOL/USDT:USDT"), "SOL", "baseSym pair");
eq(isReduce({ reduceOnly: true }), true, "isReduce bool");
eq(isReduce({ info: { reduceOnly: "true" } }), true, "isReduce info string");
eq(isReduce({}), false, "isReduce absent -> false");

console.log(`test-bybit-snapshot OK (${n} assertions)`);
