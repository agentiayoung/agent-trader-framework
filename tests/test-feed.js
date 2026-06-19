#!/usr/bin/env node
"use strict";
// Tests offline deterministes du feed de microstructure (skills/bybit/feed.js). Zero reseau.
// Run: node tests/test-feed.js
const F = require("../skills/bybit/feed.js");
let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log("  PASS  " + name); } else { failed++; console.log("  FAIL  " + name); } }

// ── normalizeOrderBook : tronque, spread, mid ──
const rawOb = { bids: [[100, 5], [99.5, 3], [99, 10], [98, 1]], asks: [[100.5, 4], [101, 2], [101.5, 8]] };
const ob = F.normalizeOrderBook(rawOb, 3);
ok("book tronque a topN=3", ob.bids.length === 3 && ob.asks.length === 3);
ok("best_bid/ask corrects", ob.best_bid === 100 && ob.best_ask === 100.5);
ok("spread = 0.5", ob.spread === 0.5);
ok("mid = 100.25", ob.mid === 100.25);
const obEmpty = F.normalizeOrderBook({}, 5);
ok("book vide -> spread/mid null, pas d'exception", obEmpty.spread === null && obEmpty.mid === null && obEmpty.bids.length === 0);
ok("book null -> safe", F.normalizeOrderBook(null, 5).best_bid === null);

// ── bookImbalance : signe + bornes ──
ok("imbalance acheteur (+)", F.bookImbalance({ bids: [[1, 8]], asks: [[1, 2]] }, 5) === 0.6);
ok("imbalance vendeur (-)", F.bookImbalance({ bids: [[1, 2]], asks: [[1, 8]] }, 5) === -0.6);
ok("imbalance equilibre = 0", F.bookImbalance({ bids: [[1, 5]], asks: [[1, 5]] }, 5) === 0);
ok("imbalance book vide -> null", F.bookImbalance({ bids: [], asks: [] }, 5) === null);
ok("imbalance respecte depth", F.bookImbalance({ bids: [[1, 5], [1, 100]], asks: [[1, 5]] }, 1) === 0);

// ── wallLevels : top-k par quantite ──
const walls = F.wallLevels(rawOb, 2);
ok("bid_walls top-2 par qty", walls.bid_walls[0].qty === 10 && walls.bid_walls[1].qty === 5);
ok("ask_walls top-2 par qty", walls.ask_walls[0].qty === 8 && walls.ask_walls[1].qty === 4);

// ── normalizeOI / normalizeFunding : parsing + null-safe ──
ok("OI depuis openInterestAmount", F.normalizeOI({ openInterestAmount: 1234.5 }) === 1234.5);
ok("OI fallback openInterest", F.normalizeOI({ openInterest: 99 }) === 99);
ok("OI null -> null", F.normalizeOI(null) === null);
ok("funding depuis fundingRate", F.normalizeFunding({ fundingRate: -0.0003 }) === -0.0003);
ok("funding depuis info", F.normalizeFunding({ info: { fundingRate: "0.0001" } }) === 0.0001);
ok("funding null -> null", F.normalizeFunding(undefined) === null);

// ── aggressionFromTrades : net buy/sell ──
const agBuy = F.aggressionFromTrades([{ side: "buy", amount: 10 }, { side: "sell", amount: 1 }]);
ok("agression buy dominante", agBuy.aggression === "buy" && agBuy.buy_vol === 10 && agBuy.sell_vol === 1);
const agNeutral = F.aggressionFromTrades([{ side: "buy", amount: 5 }, { side: "sell", amount: 5 }]);
ok("agression equilibree -> neutral", agNeutral.aggression === "neutral");
ok("agression trades vides -> neutral", F.aggressionFromTrades([]).aggression === "neutral");

// ── toPair / baseSym ──
ok("toPair BTC -> BTC/USDT:USDT", F.toPair("BTC") === "BTC/USDT:USDT");
ok("toPair idempotent", F.toPair("ETH/USDT:USDT") === "ETH/USDT:USDT");
ok("baseSym suffixe ccxt", F.baseSym("SOL/USDT:USDT") === "SOL");

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
