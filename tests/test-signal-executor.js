#!/usr/bin/env node
"use strict";

// ---------------------------------------------------------------------------
// Signal Executor Tests — spawns the executor in DRY-RUN against a temp inbox
// and asserts routing / SL-mandatory / skip behaviour. Offline (Bybit bracket
// dry_run is pure; no live orders, no keys needed).
//
// Run: node tests/test-signal-executor.js
// ---------------------------------------------------------------------------

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const TMP = path.join(__dirname, "_tmp_exec_signals");
const EXECUTOR = path.join(__dirname, "..", "tradingview", "executor", "signal_executor.js");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  PASS  " + name); }
  catch (e) { failed++; console.log("  FAIL  " + name + ": " + e.message); }
}
function assert(c, m) { if (!c) throw new Error(m || "Assertion failed"); }

function writeSignal(name, sig) {
  fs.writeFileSync(path.join(TMP, name), JSON.stringify(sig));
}
function readProcessed(name) {
  return JSON.parse(fs.readFileSync(path.join(TMP, "processed", name), "utf-8"));
}

// ── Setup temp inbox ──
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

writeSignal("1-BTC.json", {
  routes_to_skill: "bybit", execution_implemented: true, exchange: "BYBIT",
  market: "BTC", side: "long", action: "open", position_size: 0.006,
  entry: 70000, stop_loss: 67000, take_profits: [{ px: 71000, frac: 0.5 }, { px: 72000, frac: 0.5 }],
});
writeSignal("2-ETH.json", {
  routes_to_skill: "bybit", execution_implemented: true, exchange: "BYBIT",
  market: "ETH", side: "long", action: "open", position_size: 0.1,
  entry: 2000, stop_loss: null, take_profits: [], // missing SL → must be rejected
});
writeSignal("3-SOL.json", {
  routes_to_skill: "binance", execution_implemented: false, exchange: "BINANCE",
  market: "SOL", side: "short", action: "open", position_size: 1,
  entry: 150, stop_loss: 160, take_profits: [{ px: 140, frac: 1.0 }],
});

// ── Run executor once (dry-run: EXECUTOR_LIVE unset) ──
execFileSync(process.execPath, [EXECUTOR, "--once"], {
  env: { ...process.env, TV_SIGNALS_DIR: TMP, EXECUTOR_MAX_PER_CYCLE: "10", EXECUTOR_LIVE: "" },
  stdio: "pipe",
});

console.log("\n=== Signal Executor Tests ===\n");

test("bybit open → dry-run bracket executed (not live)", () => {
  const p = readProcessed("1-BTC.json");
  assert(p.processed === true, "file archived");
  assert(p.outcome.dry_run === true, "outcome.dry_run true");
  assert(p.outcome.executed === false, "not live-executed");
  assert(p.outcome.result && p.outcome.result.dry_run === true, "bracket returned dry_run plan");
  assert(p.outcome.result.plan_summary.order_count === 4, "entry + SL + 2 TP = 4 orders");
});

test("missing stop_loss → rejected (SL obligatoire)", () => {
  const p = readProcessed("2-ETH.json");
  assert(p.outcome.rejected, "should be rejected, got " + JSON.stringify(p.outcome));
});

test("execution_implemented=false → skipped, no trade", () => {
  const p = readProcessed("3-SOL.json");
  assert(p.outcome.skipped, "should be skipped, got " + JSON.stringify(p.outcome));
});

test("inbox drained (all files moved to processed/)", () => {
  const remaining = fs.readdirSync(TMP).filter((f) => f.endsWith(".json"));
  assert(remaining.length === 0, "no signals left in inbox, found " + remaining.length);
});

// ── Cleanup ──
fs.rmSync(TMP, { recursive: true, force: true });

console.log("\n--- Signal Executor Tests ---");
console.log(passed + "/" + (passed + failed) + " tests passed\n");
process.exit(failed > 0 ? 1 : 0);
