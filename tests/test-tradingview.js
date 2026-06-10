#!/usr/bin/env node
"use strict";

// ---------------------------------------------------------------------------
// TradingView Strategy Skill Tests
// ---------------------------------------------------------------------------
// Tests the pure-logic tradingview module with synthetic data.
// No network calls, no API keys needed.
//
// Run: node tests/test-tradingview.js
// ---------------------------------------------------------------------------

const tv = require("../skills/shared/tradingview/index.js");

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

function assert(condition, message) {
  if (!condition) throw new Error(message || "Assertion failed");
}

async function run() {
  console.log("\n=== TradingView Strategy Tests ===\n");

  // ---- tv_generate_strategy -------------------------------------------------

  await test("tv_generate_strategy: enforces all mandatory Pine v6 rules", async () => {
    const r = tv.tv_generate_strategy({
      description: "Trend following BTC", market: "BTCUSDT", timeframe: "4h", style: "trend",
    });
    assert(r.ok === true, "should be ok");
    const p = r.pine_script;
    assert(p.indexOf("//@version=6") === 0, "must start with //@version=6");
    assert(p.includes("process_orders_on_close=true"), "must include process_orders_on_close=true");
    assert(p.includes("commission_value=0.1"), "must include commissions >=0.1%");
    assert(p.includes("kill_switch"), "must include a kill switch");
    assert(p.includes("input."), "must expose params via input.*");
    assert(p.includes("MODULE 7 : WEBHOOK"), "must include the webhook payload block");
  });

  await test("tv_generate_strategy: style maps to signal_type", async () => {
    const mr = tv.tv_generate_strategy({ description: "x", market: "BTC", timeframe: "1h", style: "mean_reversion" });
    assert(mr.signal_type === "rsi_mean_reversion", "mean_reversion -> rsi_mean_reversion, got " + mr.signal_type);
    const br = tv.tv_generate_strategy({ description: "x", market: "BTC", timeframe: "1h", style: "breakout" });
    assert(br.signal_type === "bb_breakout", "breakout -> bb_breakout, got " + br.signal_type);
    const sc = tv.tv_generate_strategy({ description: "x", market: "BTC", timeframe: "15m", style: "scalping" });
    assert(sc.signal_type === "macd_momentum", "scalping -> macd_momentum, got " + sc.signal_type);
  });

  await test("tv_generate_strategy: defaults style to trend (ema_crossover)", async () => {
    const r = tv.tv_generate_strategy({ description: "x", market: "ETH", timeframe: "4h" });
    assert(r.signal_type === "ema_crossover", "default -> ema_crossover, got " + r.signal_type);
  });

  await test("tv_generate_strategy: classifies asset class", async () => {
    assert(tv.tv_generate_strategy({ description: "x", market: "EURUSD", timeframe: "5m" }).asset_class === "forex", "EURUSD = forex");
    assert(tv.tv_generate_strategy({ description: "x", market: "SPY", timeframe: "15m" }).asset_class === "stocks", "SPY = stocks");
    assert(tv.tv_generate_strategy({ description: "x", market: "BTCUSDT", timeframe: "1h" }).asset_class === "crypto", "BTCUSDT = crypto");
  });

  // ---- tv_analyze_backtest --------------------------------------------------

  await test("tv_analyze_backtest: passing metrics -> deploy", async () => {
    const r = tv.tv_analyze_backtest({ win_rate: 62, profit_factor: 1.9, max_drawdown: 14, total_trades: 120, sharpe: 1.4 });
    assert(r.verdict === "deploy", "should be deploy, got " + r.verdict);
    assert(r.all_thresholds_passed === true, "all thresholds should pass");
    assert(r.overfit_flag === false, "no overfit");
  });

  await test("tv_analyze_backtest: over-fit (WR>85, PF>10) -> optimize despite passing", async () => {
    const r = tv.tv_analyze_backtest({ win_rate: 88, profit_factor: 12, max_drawdown: 6, total_trades: 300 });
    assert(r.overfit_flag === true, "should flag overfit");
    assert(r.verdict === "optimize", "overfit must not deploy, got " + r.verdict);
    assert(r.issues.some(i => i.includes("RED FLAG")), "should list red flags");
  });

  await test("tv_analyze_backtest: poor metrics -> reject", async () => {
    const r = tv.tv_analyze_backtest({ win_rate: 38, profit_factor: 0.9, max_drawdown: 40, total_trades: 20 });
    assert(r.verdict === "reject", "should reject, got " + r.verdict);
    assert(r.issues.length > 0, "should list issues");
  });

  await test("tv_analyze_backtest: high DD -> optimize with sizing fix", async () => {
    const r = tv.tv_analyze_backtest({ win_rate: 60, profit_factor: 1.6, max_drawdown: 30, total_trades: 80 });
    assert(r.verdict === "optimize", "should optimize, got " + r.verdict);
    assert(r.checks.max_drawdown.pass === false, "DD should fail");
    assert(r.recommendations.some(x => x.toLowerCase().includes("risk")), "should recommend reducing risk");
  });

  await test("tv_analyze_backtest: missing metrics returns error", async () => {
    const r = tv.tv_analyze_backtest({ win_rate: 60 });
    assert(r.ok === false, "should error on missing metrics");
    assert(r.error.includes("Missing"), "error should mention missing fields");
  });

  // ---- tv_select_strategy ---------------------------------------------------

  await test("tv_select_strategy: crypto 4h trending returns a recommendation", async () => {
    const r = tv.tv_select_strategy({ market: "BTC", timeframe: "4h", regime: "trending" });
    assert(r.ok === true, "should be ok");
    assert(r.recommended !== null, "should recommend a strategy");
    assert(r.asset_class === "crypto", "BTC = crypto");
    assert(r.timeframe_bucket === "medium", "4h = medium, got " + r.timeframe_bucket);
    assert(r.recommended.match_score >= 5, "strong match expected");
    assert(typeof r.starting_params === "object", "should provide starting params");
  });

  await test("tv_select_strategy: forex 5m ranging matches BBRSI", async () => {
    const r = tv.tv_select_strategy({ market: "EURUSD", timeframe: "5m", regime: "ranging" });
    assert(r.asset_class === "forex", "EURUSD = forex");
    assert(r.timeframe_bucket === "short", "5m = short");
    const ids = [r.recommended.id].concat(r.alternatives.map(a => a.id));
    assert(ids.includes("BB_RSI_MEAN_REVERSION"), "BBRSI should be among matches: " + ids.join(","));
  });

  await test("tv_select_strategy: stocks breakout matches ORB", async () => {
    const r = tv.tv_select_strategy({ market: "SPY", timeframe: "15m", regime: "breakout" });
    assert(r.asset_class === "stocks", "SPY = stocks");
    const ids = [r.recommended.id].concat(r.alternatives.map(a => a.id));
    assert(ids.includes("ORB"), "ORB should be among matches: " + ids.join(","));
  });

  await test("tv_select_strategy: missing market returns error", async () => {
    const r = tv.tv_select_strategy({ timeframe: "4h" });
    assert(r.ok === false, "should error without market");
  });

  // ---- tv_create_webhook_config ---------------------------------------------

  await test("tv_create_webhook_config: bybit routes and is implemented", async () => {
    const r = tv.tv_create_webhook_config({ strategy_id: "BBRSI", exchange: "BYBIT" });
    assert(r.ok === true, "should be ok");
    assert(r.routes_to_skill === "bybit", "should route to bybit");
    assert(r.execution_implemented === true, "bybit implemented");
    assert(r.alert_message.strategy_id === "BBRSI", "payload carries strategy_id");
    assert(r.alert_message.signal === "{{strategy.order.action}}", "payload uses TV placeholder");
  });

  await test("tv_create_webhook_config: hyperliquid is a stub (archived 09.06.2026)", async () => {
    const r = tv.tv_create_webhook_config({ strategy_id: "BBRSI", exchange: "HYPERLIQUID" });
    assert(r.execution_implemented === false, "hyperliquid no longer implemented");
    assert(r.warnings.some(w => w.includes("NON implemente")), "should warn about stub");
  });

  await test("tv_create_webhook_config: stub exchange warns not implemented", async () => {
    const r = tv.tv_create_webhook_config({ strategy_id: "X", exchange: "BINANCE" });
    assert(r.execution_implemented === false, "binance is a stub");
    assert(r.warnings.some(w => w.includes("NON implemente")), "should warn about stub");
  });

  await test("tv_create_webhook_config: never echoes secret value", async () => {
    process.env.WEBHOOK_SECRET = "supersecret123";
    const r = tv.tv_create_webhook_config({ strategy_id: "X", exchange: "HYPERLIQUID" });
    assert(r.alert_message.key === "<WEBHOOK_SECRET>", "key must be a placeholder, not the value");
    assert(JSON.stringify(r).indexOf("supersecret123") === -1, "secret value must never appear in output");
    assert(r.secret_configured === true, "should report secret as configured");
    delete process.env.WEBHOOK_SECRET;
  });

  await test("tv_create_webhook_config: missing strategy_id returns error", async () => {
    const r = tv.tv_create_webhook_config({ exchange: "HYPERLIQUID" });
    assert(r.ok === false, "should error without strategy_id");
  });

  // ---- tv_healthcheck -------------------------------------------------------

  await test("tv_healthcheck: reports library and routing", async () => {
    const r = tv.tv_healthcheck();
    assert(r.strategy_count >= 10, "at least 10 strategies expected, got " + r.strategy_count);
    assert(r.exchanges_implemented.includes("BYBIT"), "bybit implemented");
    assert(!r.exchanges_implemented.includes("HYPERLIQUID"), "hyperliquid no longer implemented");
    assert(r.exchanges_stubbed.includes("HYPERLIQUID"), "hyperliquid stubbed (archived)");
    assert(typeof r.env_status === "object", "env_status object expected");
  });

  // ---- Summary --------------------------------------------------------------

  console.log("\n--- TradingView Strategy Tests ---");
  console.log(passed + "/" + (passed + failed) + " tests passed");
  if (failed > 0) {
    console.log("\nFailed tests:");
    results.filter(r => r.status === "fail").forEach(r => {
      console.log("  - " + r.name + ": " + r.error);
    });
  }
  console.log("");

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => {
  console.error("Test runner crashed:", e);
  process.exit(2);
});
