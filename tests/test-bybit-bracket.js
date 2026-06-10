#!/usr/bin/env node
"use strict";

// ---------------------------------------------------------------------------
// Bybit Scaled Bracket Tests (bybit_place_bracket_scaled)
// ---------------------------------------------------------------------------
// Fully offline: dry_run builds the order plan without any network/keys, and
// guard-rails throw before the signed client is ever constructed.
//
// Run: node tests/test-bybit-bracket.js
// ---------------------------------------------------------------------------

const bybit = require("../skills/bybit/index.js");

let passed = 0;
let failed = 0;
const results = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    results.push({ name, status: "pass" });
    console.log("  PASS  " + name);
  } catch (e) {
    failed++;
    results.push({ name, status: "fail", error: e.message });
    console.log("  FAIL  " + name + ": " + e.message);
  }
}

function assert(c, m) { if (!c) throw new Error(m || "Assertion failed"); }

async function assertThrows(fn, sub) {
  let threw = false;
  try { await fn(); } catch (e) {
    threw = true;
    if (sub) assert(e.message.toLowerCase().includes(sub.toLowerCase()), `Expected "${sub}", got "${e.message}"`);
  }
  assert(threw, "Expected throw");
}

const SHORT_3TP = {
  symbol: "BTCUSDT.P", side: "short", amount: 0.01, entry_px: 74100, stop_loss_px: 74330,
  take_profits: [{ px: 73350, frac: 0.4 }, { px: 72770, frac: 0.3 }, { px: 72500, frac: 0.3 }],
  dry_run: true,
};

async function run() {
  console.log("\n=== Bybit Scaled Bracket Tests ===\n");

  await test("symbol normalization BTCUSDT.P -> BTC/USDT:USDT", async () => {
    const r = await bybit("bybit_place_bracket_scaled", SHORT_3TP);
    assert(r.plan_summary.symbol === "BTC/USDT:USDT", "got " + r.plan_summary.symbol);
  });

  await test("dry_run short 3-TP: structure + sizing + reduce-only exits", async () => {
    const r = await bybit("bybit_place_bracket_scaled", SHORT_3TP);
    assert(r.dry_run === true, "dry_run");
    assert(r.plan_summary.order_count === 5, "5 orders, got " + r.plan_summary.order_count);
    const [entry, sl, ...tps] = r.plan;
    assert(entry.side === "sell" && !entry.params.reduceOnly, "entry sell, not reduce-only");
    assert(sl.side === "buy" && sl.params.reduceOnly === true && sl.params.triggerPrice === 74330, "SL reduce-only buy w/ trigger");
    assert(sl.params.triggerDirection === "above", "short SL triggers above");
    assert(tps.length === 3 && tps.every((t) =>
      t.side === "buy" && t.type === "market" && t.params.reduceOnly === true &&
      t.params.triggerPrice > 0 && t.params.triggerDirection === "below"
    ), "3 conditional reduce-only TP buys triggering below (short)");
    const sum = r.plan_summary.take_profits.reduce((s, t) => s + t.amount, 0);
    assert(Math.abs(sum - r.plan_summary.total_amount) < 1e-9, "TP amounts sum to total");
  });

  await test("reject: missing stop_loss", async () => {
    await assertThrows(() => bybit("bybit_place_bracket_scaled", { ...SHORT_3TP, stop_loss_px: undefined }), "stop_loss");
  });

  await test("reject: short SL below entry (inverted)", async () => {
    await assertThrows(() => bybit("bybit_place_bracket_scaled", { ...SHORT_3TP, stop_loss_px: 73900 }), "must be >");
  });

  await test("reject: long TP below entry (inverted)", async () => {
    await assertThrows(() => bybit("bybit_place_bracket_scaled", {
      symbol: "BTC", side: "long", amount: 0.01, entry_px: 73000, stop_loss_px: 72500,
      take_profits: [{ px: 72000, frac: 1.0 }], dry_run: true,
    }), "take-profit");
  });

  await test("reject: fractions do not sum to ~1.0", async () => {
    await assertThrows(() => bybit("bybit_place_bracket_scaled", {
      ...SHORT_3TP, take_profits: [{ px: 73350, frac: 0.5 }, { px: 72770, frac: 0.2 }],
    }), "sum to");
  });

  console.log("\n--- Bybit Scaled Bracket Tests ---");
  console.log(passed + "/" + (passed + failed) + " tests passed");
  if (failed > 0) results.filter((r) => r.status === "fail").forEach((r) => console.log("  - " + r.name + ": " + r.error));
  console.log("");
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => { console.error("Test runner crashed:", e); process.exit(2); });
