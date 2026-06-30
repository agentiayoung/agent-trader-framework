#!/usr/bin/env node
"use strict";
// Tests offline de matchClosedRows (journal.js cmd_sync). Régression du bug d'attribution
// 29.06 : sur un actif sous-dollar (SUI ~0.69), le plancher de tolérance 1 USDT faisait matcher
// TOUT le symbole -> les fills d'un trade antérieur contaminaient les `exits` du suivant
// (SUI 28.06 net +28 loggé R=0.02). Le fix = tolérance relative + borne temps + dédup. Zéro réseau.
// Run: node tests/test-sync-match.js
const { matchClosedRows } = require("../trade-journal/journal.js");
let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log("  PASS  " + name); } else { failed++; console.log("  FAIL  " + name); } }

const D27 = new Date("2026-06-27T10:00:00Z").getTime();
const D28 = new Date("2026-06-28T10:00:00Z").getTime();

// Deux shorts SUI successifs (sous-dollar). Fills closed-PnL Bybit (avec orderId + updatedTime).
const rowsSUI = [
  // — trade A (27.06, entrée 0.6995) : SL fills —
  { symbol: "SUIUSDT", orderId: "A1", avgEntryPrice: "0.6995", avgExitPrice: "0.7096", qty: "920", closedPnl: "-9.78", openFee: "0", closeFee: "0", updatedTime: String(D27 + 1) },
  { symbol: "SUIUSDT", orderId: "A2", avgEntryPrice: "0.6995", avgExitPrice: "0.7096", qty: "230", closedPnl: "-2.44", openFee: "0", closeFee: "0", updatedTime: String(D27 + 2) },
  // — trade B (28.06, entrée 0.6880) : TP fills —
  { symbol: "SUIUSDT", orderId: "B1", avgEntryPrice: "0.6880", avgExitPrice: "0.6855", qty: "1070", closedPnl: "26.60", openFee: "0", closeFee: "0", updatedTime: String(D28 + 1) },
  { symbol: "SUIUSDT", orderId: "B2", avgEntryPrice: "0.6880", avgExitPrice: "0.7006", qty: "260", closedPnl: "2.55", openFee: "0", closeFee: "0", updatedTime: String(D28 + 2) },
];

const tradeA = { symbol: "SUI", side: "short", entry_actual: 0.6995, ts_open: "2026-06-27T09:55:00Z" };
const tradeB = { symbol: "SUI", side: "short", entry_actual: 0.6880, ts_open: "2026-06-28T09:55:00Z" };

// 1) Le trade B ne récupère QUE ses propres fills (pas ceux du 27.06).
const mB = matchClosedRows(tradeB, rowsSUI, new Set());
ok("B ne matche que B1/B2 (pas A1/A2)", mB.length === 2 && mB.every((x) => x.orderId.startsWith("B")));
ok("B somme PnL = +29.15 (et pas pollué par les -12)", Math.abs(mB.reduce((s, x) => s + Number(x.closedPnl), 0) - 29.15) < 0.01);

// 2) Le trade A ne matche que ses fills (borne temps n'exclut pas A : updatedTime >= ts_open de A).
const mA = matchClosedRows(tradeA, rowsSUI, new Set());
ok("A ne matche que A1/A2", mA.length === 2 && mA.every((x) => x.orderId.startsWith("A")));

// 3) Dédup : si A consomme ses fills, B reste correct ; et A ne peut PAS reprendre des fills déjà pris.
const consumed = new Set();
const mA2 = matchClosedRows(tradeA, rowsSUI, consumed); mA2.forEach((x) => consumed.add(x.orderId));
const mB2 = matchClosedRows(tradeB, rowsSUI, consumed);
ok("dédup : B après A = B1/B2 intacts", mB2.length === 2 && mB2.every((x) => x.orderId.startsWith("B")));
const mAagain = matchClosedRows(tradeA, rowsSUI, consumed);
ok("dédup : A ne reprend pas des fills déjà consommés", mAagain.length === 0);

// 4) Borne de temps : un fill antérieur à ts_open - 1h est exclu même si le prix colle.
const oldRow = [{ symbol: "SUIUSDT", orderId: "OLD", avgEntryPrice: "0.6880", avgExitPrice: "0.70", qty: "100", closedPnl: "-5", updatedTime: String(D27) }];
ok("fill antérieur à l'ouverture exclu", matchClosedRows(tradeB, oldRow, new Set()).length === 0);

// 5) Non-régression : un trade normal (BTC) matche bien ses propres fills.
const rowsBTC = [{ symbol: "BTCUSDT", orderId: "C1", avgEntryPrice: "61850", avgExitPrice: "60400", qty: "0.5", closedPnl: "725", updatedTime: String(D28 + 1) }];
const tradeBTC = { symbol: "BTC", side: "short", entry_actual: 61850, ts_open: "2026-06-25T09:00:00Z" };
ok("BTC matche son fill (non-régression)", matchClosedRows(tradeBTC, rowsBTC, new Set()).length === 1);

// 6) Le slippage <0.5% reste matché (entry_actual légèrement différent de l'avgEntryPrice).
const tradeBTCslip = { symbol: "BTC", side: "short", entry_actual: 62000, ts_open: "2026-06-25T09:00:00Z" }; // 0.24% au-dessus
ok("slippage 0.24% reste matché", matchClosedRows(tradeBTCslip, rowsBTC, new Set()).length === 1);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
