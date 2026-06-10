"use strict";

// ---------------------------------------------------------------------------
// TradingView Strategy -- Shared Skill Module
// ---------------------------------------------------------------------------
// Pure computation: no API calls, no state, no network dependencies.
// Generates Pine Script v6 strategies, diagnoses backtests, recommends a
// strategy from the canonical library, and builds TradingView alert payloads.
//
// The agent EXECUTES TradingView signals via the hyperliquid skill only.
// This module never places orders -- it produces code and routing config.
//
// Source of truth for strategies: ./STRATEGIES.json
// (consolidated from tradingview/*.md). Run tv_healthcheck to self-check.
// ---------------------------------------------------------------------------

const LIBRARY = require("./STRATEGIES.json");
const THRESHOLDS = LIBRARY._meta.validation_thresholds;

// Exchange names (TradingView) -> execution skill.
// Only bybit is implemented in this project (09.06.2026 : hyperliquid archivé
// → archive/openclaw/) ; the rest are documented stubs that the webhook
// listener logs and skips.
const EXCHANGE_ROUTING = {
  HYPERLIQUID: { skill: "hyperliquid", implemented: false },
  BINANCE: { skill: "binance", implemented: false },
  BYBIT: { skill: "bybit", implemented: true },
  ASTER: { skill: "aster", implemented: false },
  NASDAQ: { skill: "alpaca", implemented: false },
  NYSE: { skill: "alpaca", implemented: false },
};

// ---- Helpers ---------------------------------------------------------------

function classifyTimeframe(tf) {
  if (!tf) return "medium";
  const s = String(tf).toLowerCase().trim();
  // TradingView numeric intervals: 1,3,5,15,30 (minutes), 60,240 (minutes), D,W
  if (/^(1|2|3|5|10|15|30)m?$/.test(s) || ["1", "3", "5", "15", "30"].indexOf(s) !== -1) return "short";
  if (/^(1|2|3|4|6|8|12)h$/.test(s) || ["60", "120", "180", "240"].indexOf(s) !== -1) return "medium";
  if (/^(1d|d|1w|w|1day|1week|daily|weekly)$/.test(s) || ["1440", "10080"].indexOf(s) !== -1) return "long";
  // bare minute numbers >= 60 -> medium
  const n = Number(s.replace(/[mh]/g, ""));
  if (Number.isFinite(n)) {
    if (n <= 30) return "short";
    if (n < 1440) return "medium";
    return "long";
  }
  return "medium";
}

function classifyAsset(market) {
  if (!market) return "crypto";
  const m = String(market).toUpperCase();
  const cryptoHint = /(BTC|ETH|SOL|AVAX|ARB|USDT|USDC|XBT|DOGE|BNB|ADA|MATIC|LINK|OP|SUI|APT)/;
  const forexHint = /^(EUR|USD|GBP|JPY|CHF|AUD|CAD|NZD){2}$/;
  if (forexHint.test(m.replace(/[^A-Z]/g, ""))) return "forex";
  if (cryptoHint.test(m)) return "crypto";
  // common indices / US equities
  if (/(SPY|QQQ|DIA|IWM|ES|NQ|NVDA|AAPL|TSLA|MSFT|AMZN|META|GOOG)/.test(m)) return "stocks";
  return "crypto";
}

function normalizeStyle(style) {
  const s = String(style || "").toLowerCase();
  if (/scalp/.test(s)) return "scalping";
  if (/mean|revers|range/.test(s)) return "mean_reversion";
  if (/break/.test(s)) return "breakout";
  if (/moment/.test(s)) return "momentum";
  return "trend";
}

// Map a style to a Pine signal_type used by the template's signal module.
const STYLE_TO_SIGNAL = {
  trend: "ema_crossover",
  scalping: "macd_momentum",
  mean_reversion: "rsi_mean_reversion",
  breakout: "bb_breakout",
  momentum: "macd_momentum",
};

function slugifyName(description, market, timeframe) {
  const base = (description || "Strategy")
    .replace(/[^a-zA-Z0-9 ]/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 4)
    .join(" ");
  const mkt = market ? " " + String(market).toUpperCase() : "";
  const tf = timeframe ? " " + String(timeframe) : "";
  return (base + mkt + tf).trim() || "Custom Strategy";
}

// ---- tv_generate_strategy --------------------------------------------------

/**
 * Generate a complete, modular Pine Script v6 strategy following the
 * mandatory 7-module pipeline. Always includes process_orders_on_close,
 * commissions, a max-drawdown kill switch, exposed inputs, and the webhook
 * payload block. Returns the script string plus recommended params/metrics.
 */
function tv_generate_strategy(params) {
  params = params || {};
  const description = params.description || "Custom strategy";
  const market = params.market || "BTCUSDT";
  const timeframe = params.timeframe || "4h";
  const style = normalizeStyle(params.style);
  const signalType = STYLE_TO_SIGNAL[style] || "ema_crossover";
  const name = slugifyName(description, market, timeframe);

  const pine = [
    "//@version=6",
    'strategy("' + name + ' v1.0", overlay=true,',
    "    initial_capital=10000,",
    "    default_qty_type=strategy.percent_of_equity,",
    "    default_qty_value=10,",
    "    commission_type=strategy.commission.percent,",
    "    commission_value=0.1,",
    "    slippage=2,",
    "    process_orders_on_close=true)",
    "",
    "// ── MODULE 1 : INPUTS & CONFIG ──────────────────────────────",
    'signal_type    = input.string("' + signalType + '", "Signal Type",',
    '                  options=["ema_crossover","rsi_mean_reversion","bb_breakout","macd_momentum"])',
    'ema_fast       = input.int(50,  "EMA Fast",   minval=5,  maxval=200)',
    'ema_slow       = input.int(200, "EMA Slow",   minval=20, maxval=500)',
    'rsi_period     = input.int(14,  "RSI Period", minval=5,  maxval=30)',
    'rsi_oversold   = input.int(30,  "RSI Oversold")',
    'rsi_overbought = input.int(70,  "RSI Overbought")',
    'atr_period     = input.int(14,  "ATR Period")',
    'atr_sl_mult    = input.float(1.5, "ATR SL Multiplier", step=0.1)',
    'atr_tp_mult    = input.float(2.5, "ATR TP Multiplier", step=0.1)',
    'max_drawdown   = input.float(15.0, "Max Drawdown % (circuit breaker)")',
    'enable_short   = input.bool(true, "Enable Short Signals")',
    'trade_session  = input.session("0800-2200", "Trading Session")',
    "",
    "// ── MODULE 2 : INDICATEURS ──────────────────────────────────",
    "ema_f  = ta.ema(close, ema_fast)",
    "ema_s  = ta.ema(close, ema_slow)",
    "rsi    = ta.rsi(close, rsi_period)",
    "atr    = ta.atr(atr_period)",
    "[macd_line, signal_line, macd_hist] = ta.macd(close, 12, 26, 9)",
    "[bb_upper, bb_basis, bb_lower] = ta.bb(close, 20, 2.0)",
    "stoch_k = ta.stoch(close, high, low, 14)",
    "",
    "// ── MODULE 3 : SIGNAL (Entry Logic) ─────────────────────────",
    "var bool longCondition  = false",
    "var bool shortCondition = false",
    "",
    'if signal_type == "ema_crossover"',
    "    longCondition  := ta.crossover(ema_f, ema_s) and rsi > 50",
    "    shortCondition := ta.crossunder(ema_f, ema_s) and rsi < 50",
    'else if signal_type == "rsi_mean_reversion"',
    "    longCondition  := ta.crossover(rsi, rsi_oversold)  and close > ema_s",
    "    shortCondition := ta.crossunder(rsi, rsi_overbought) and close < ema_s",
    'else if signal_type == "bb_breakout"',
    "    longCondition  := ta.crossover(close, bb_upper)  and macd_hist > 0",
    "    shortCondition := ta.crossunder(close, bb_lower) and macd_hist < 0",
    'else if signal_type == "macd_momentum"',
    "    longCondition  := ta.crossover(macd_line, signal_line)  and close > ema_f",
    "    shortCondition := ta.crossunder(macd_line, signal_line) and close < ema_f",
    "",
    "// ── MODULE 4 : RISK MANAGEMENT ──────────────────────────────",
    "sl_long  = strategy.position_avg_price - atr * atr_sl_mult",
    "tp_long  = strategy.position_avg_price + atr * atr_tp_mult",
    "sl_short = strategy.position_avg_price + atr * atr_sl_mult",
    "tp_short = strategy.position_avg_price - atr * atr_tp_mult",
    "",
    "// ── MODULE 5 : CIRCUIT BREAKER (Failsafe) ───────────────────",
    "current_dd = (strategy.initial_capital - strategy.equity) / strategy.initial_capital * 100",
    "kill_switch = current_dd >= max_drawdown",
    "",
    "// ── MODULE 6 : EXECUTION ────────────────────────────────────",
    "session_ok = not na(time(timeframe.period, trade_session))",
    "",
    "if not kill_switch and session_ok",
    "    if longCondition",
    '        strategy.entry("Long", strategy.long)',
    "    if shortCondition and enable_short",
    '        strategy.entry("Short", strategy.short)',
    "",
    "if strategy.position_size > 0",
    '    strategy.exit("Exit Long",  "Long",  stop=sl_long,  limit=tp_long)',
    "if strategy.position_size < 0",
    '    strategy.exit("Exit Short", "Short", stop=sl_short, limit=tp_short)',
    "",
    "// ── MODULE 7 : WEBHOOK PAYLOAD ──────────────────────────────",
    "// Message d'alerte a configurer dans TradingView :",
    "// {",
    '//   "strategy_id": "' + name + '",',
    '//   "signal":      "{{strategy.order.action}}",',
    '//   "ticker":      "{{ticker}}",',
    '//   "exchange":    "{{exchange}}",',
    '//   "contracts":   "{{strategy.order.contracts}}",',
    '//   "position_size": "{{strategy.position_size}}",',
    '//   "price":       "{{close}}",',
    '//   "time":        "{{timenow}}",',
    '//   "timeframe":   "{{interval}}",',
    '//   "key":         "VOTRE_CLE_SECRETE"',
    "// }",
  ].join("\n");

  return {
    ok: true,
    strategy_name: name,
    signal_type: signalType,
    style: style,
    market: market,
    timeframe: timeframe,
    asset_class: classifyAsset(market),
    pine_script: pine,
    rules_enforced: [
      "//@version=6",
      "process_orders_on_close=true",
      "commission_value=0.1 (>=0.1%)",
      "kill switch (max_drawdown circuit breaker)",
      "tous les parametres exposes via input.*",
      "bloc webhook JSON commente",
    ],
    target_metrics: {
      win_rate_min: THRESHOLDS.win_rate_min,
      profit_factor_min: THRESHOLDS.profit_factor_min,
      max_drawdown_max: THRESHOLDS.max_drawdown_max,
      total_trades_min: THRESHOLDS.total_trades_min,
      sharpe_min: THRESHOLDS.sharpe_min,
    },
    next_steps: [
      "Backtester dans TradingView Strategy Tester (>= 2 ans crypto, 5 ans stocks)",
      "Verifier les metriques cibles puis lancer tv_analyze_backtest",
      "Walk-forward test (train 60% / test 40%) AVANT tout deploiement live",
      "Configurer l'alerte avec tv_create_webhook_config",
    ],
  };
}

// ---- tv_analyze_backtest ---------------------------------------------------

/**
 * Diagnose backtest metrics against the deploy thresholds and the
 * RULES_AGENT_OPTIMIZER diagnostic table. Returns a verdict
 * (deploy / optimize / reject), per-metric pass/fail, issues and fixes.
 */
function tv_analyze_backtest(params) {
  params = params || {};
  const wr = Number(params.win_rate);
  const pf = Number(params.profit_factor);
  const dd = Number(params.max_drawdown);
  const trades = Number(params.total_trades);
  const sharpe = params.sharpe !== undefined && params.sharpe !== null ? Number(params.sharpe) : null;

  const missing = [];
  if (!Number.isFinite(wr)) missing.push("win_rate");
  if (!Number.isFinite(pf)) missing.push("profit_factor");
  if (!Number.isFinite(dd)) missing.push("max_drawdown");
  if (!Number.isFinite(trades)) missing.push("total_trades");
  if (missing.length > 0) {
    return { ok: false, error: "Missing/invalid metrics: " + missing.join(", ") };
  }

  const checks = {
    win_rate: { value: wr, min: THRESHOLDS.win_rate_min, pass: wr >= THRESHOLDS.win_rate_min },
    profit_factor: { value: pf, min: THRESHOLDS.profit_factor_min, pass: pf >= THRESHOLDS.profit_factor_min },
    max_drawdown: { value: dd, max: THRESHOLDS.max_drawdown_max, pass: dd < THRESHOLDS.max_drawdown_max },
    total_trades: { value: trades, min: THRESHOLDS.total_trades_min, pass: trades >= THRESHOLDS.total_trades_min },
  };
  if (sharpe !== null) {
    checks.sharpe = { value: sharpe, min: THRESHOLDS.sharpe_min, pass: sharpe >= THRESHOLDS.sharpe_min };
  }

  const issues = [];
  const recommendations = [];

  // Diagnostic table (RULES_AGENT_OPTIMIZER)
  if (wr < 45 && pf >= 1.5) {
    issues.push("Win Rate < 45% mais PF > 1.5 : signal peu discriminant.");
    recommendations.push("Ajouter des filtres de confirmation (ADX, volume, sessions).");
  }
  if (wr > 70 && pf < 1.3) {
    issues.push("WR > 70% mais PF < 1.3 : SL trop serre / TP trop proche.");
    recommendations.push("Augmenter ATR SL mult (1.5->2.0) et TP mult (2.0->3.0).");
  }
  if (dd > THRESHOLDS.max_drawdown_max) {
    issues.push("Max Drawdown > " + THRESHOLDS.max_drawdown_max + "% : taille de position trop large.");
    recommendations.push("Reduire risk_pct (2%->1%) et verifier le kill switch.");
  }
  if (trades < THRESHOLDS.total_trades_min) {
    issues.push("Moins de " + THRESHOLDS.total_trades_min + " trades : echantillon insuffisant / conditions trop restrictives.");
    recommendations.push("Assouplir les conditions d'entree ou allonger la periode de backtest.");
  }
  if (pf < THRESHOLDS.profit_factor_min) {
    issues.push("Profit Factor < " + THRESHOLDS.profit_factor_min + " : revoir le risk management (ratio SL/TP).");
    recommendations.push("Augmenter le R:R ou filtrer les setups a faible edge.");
  }
  // Over-fitting red flags
  if (wr > 85) {
    issues.push("RED FLAG: WR > 85% : sur-optimisation probable (over-fit sur donnees d'entrainement).");
    recommendations.push("Walk-forward test obligatoire + valider sur d'autres actifs/timeframes.");
  }
  if (pf > 10) {
    issues.push("RED FLAG: PF > 10 : strategie sur-optimisee.");
    recommendations.push("Tester sur marches similaires ; mefiance sur periode courte.");
  }

  const allPass = Object.keys(checks).every((k) => checks[k].pass);
  const overfit = wr > 85 || pf > 10;

  let verdict;
  if (overfit) {
    verdict = "optimize"; // ne jamais deployer un over-fit, meme si les seuils passent
  } else if (allPass) {
    verdict = "deploy";
  } else if (pf >= 1.2 && dd < 35) {
    verdict = "optimize";
  } else {
    verdict = "reject";
  }

  const verdictText = {
    deploy: "Metriques minimales atteintes. Walk-forward test + paper trading testnet AVANT live.",
    optimize: "Strategie a optimiser avant deploiement. Voir recommandations.",
    reject: "Metriques insuffisantes. Repenser le signal ou abandonner cette configuration.",
  }[verdict];

  if (recommendations.length === 0 && verdict === "deploy") {
    recommendations.push("Demarrer en testnet >= 2 semaines, taille de depart = 25% de la cible.");
  }

  return {
    ok: true,
    verdict: verdict,
    verdict_text: verdictText,
    all_thresholds_passed: allPass,
    overfit_flag: overfit,
    checks: checks,
    issues: issues,
    recommendations: recommendations,
  };
}

// ---- tv_select_strategy ----------------------------------------------------

/**
 * Recommend a strategy from the canonical library based on market,
 * timeframe and regime. Scores every library entry and returns the best
 * match plus alternatives, starting params and target metrics.
 */
function tv_select_strategy(params) {
  params = params || {};
  if (!params.market) return { ok: false, error: "Missing required field: market" };

  const asset = classifyAsset(params.market);
  const tfBucket = classifyTimeframe(params.timeframe);
  const regime = params.regime ? String(params.regime).toLowerCase() : "any";

  const scored = LIBRARY.strategies.map((strat) => {
    let score = 0;
    const reasons = [];
    if (strat.asset_classes.indexOf(asset) !== -1) { score += 3; reasons.push("asset_class match (" + asset + ")"); }
    if (strat.timeframe_bucket.indexOf(tfBucket) !== -1) { score += 2; reasons.push("timeframe match (" + tfBucket + ")"); }
    if (regime === "any" || strat.regime.indexOf(regime) !== -1 || strat.regime.indexOf("any") !== -1) {
      score += 2; reasons.push("regime match (" + regime + ")");
    }
    // bonus: documented metrics give confidence
    if (strat.metrics && strat.metrics.win_rate) score += 0.5;
    return { strat: strat, score: score, reasons: reasons };
  }).sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best || best.score === 0) {
    return {
      ok: true,
      market: params.market,
      asset_class: asset,
      timeframe_bucket: tfBucket,
      regime: regime,
      recommended: null,
      note: "Aucune strategie ne matche fortement. Utiliser tv_generate_strategy avec un style explicite.",
      alternatives: [],
    };
  }

  const toSummary = (s) => ({
    id: s.strat.id,
    code: s.strat.code,
    name: s.strat.name,
    markets: s.strat.markets,
    timeframes: s.strat.timeframes,
    regime: s.strat.regime,
    metrics: s.strat.metrics,
    match_score: s.score,
    match_reasons: s.reasons,
  });

  return {
    ok: true,
    market: params.market,
    asset_class: asset,
    timeframe_bucket: tfBucket,
    regime: regime,
    recommended: toSummary(best),
    starting_params: best.strat.default_params,
    signal_type: best.strat.signal_type,
    target_metrics: {
      win_rate_min: THRESHOLDS.win_rate_min,
      profit_factor_min: THRESHOLDS.profit_factor_min,
      max_drawdown_max: THRESHOLDS.max_drawdown_max,
      total_trades_min: THRESHOLDS.total_trades_min,
    },
    alternatives: scored.slice(1, 4).filter((s) => s.score > 0).map(toSummary),
  };
}

// ---- tv_create_webhook_config ----------------------------------------------

/**
 * Build the TradingView alert message (JSON with TV placeholders) ready to
 * paste into a strategy alert, plus the resolved OpenClaw execution skill.
 * Reads the secret from WEBHOOK_SECRET if set (never logged in plain).
 */
function tv_create_webhook_config(params) {
  params = params || {};
  if (!params.strategy_id) return { ok: false, error: "Missing required field: strategy_id" };

  const exchangeRaw = String(params.exchange || "HYPERLIQUID").toUpperCase();
  const routing = EXCHANGE_ROUTING[exchangeRaw] || { skill: "default", implemented: false };
  const hasSecret = !!(process.env.WEBHOOK_SECRET && process.env.WEBHOOK_SECRET.length > 0);

  // The alert message uses TradingView placeholders; key is a literal the
  // user must fill with WEBHOOK_SECRET (we do not echo the secret value).
  const alertMessage = {
    strategy_id: params.strategy_id,
    signal: "{{strategy.order.action}}",
    ticker: "{{ticker}}",
    exchange: "{{exchange}}",
    contracts: "{{strategy.order.contracts}}",
    position_size: "{{strategy.position_size}}",
    price: "{{close}}",
    time: "{{timenow}}",
    timeframe: "{{interval}}",
    key: "<WEBHOOK_SECRET>",
  };

  const warnings = [];
  if (!routing.implemented) {
    warnings.push("Exchange '" + exchangeRaw + "' -> skill '" + routing.skill + "' NON implemente dans ce projet. Seul BYBIT execute reellement.");
  }
  if (!hasSecret) {
    warnings.push("WEBHOOK_SECRET non defini dans l'environnement. Le definir avant de demarrer le listener.");
  }

  return {
    ok: true,
    strategy_id: params.strategy_id,
    exchange: exchangeRaw,
    routes_to_skill: routing.skill,
    execution_implemented: routing.implemented,
    webhook_endpoint: "/webhook/tradingview",
    alert_message: alertMessage,
    alert_message_string: JSON.stringify(alertMessage, null, 2),
    secret_configured: hasSecret,
    warnings: warnings,
    instructions: [
      "Coller alert_message_string dans le champ 'Message' de l'alerte TradingView.",
      "Remplacer <WEBHOOK_SECRET> par la valeur exacte de l'env WEBHOOK_SECRET.",
      "URL de l'alerte = http(s)://<host>:<TV_WEBHOOK_PORT>/webhook/tradingview",
      "Le signal est ecrit dans TV_SIGNALS_DIR et lu par l'agent hyperliquid au heartbeat.",
    ],
  };
}

// ---- tv_healthcheck --------------------------------------------------------

/**
 * Self-check: library integrity, env vars for the webhook bridge, and
 * routing table. Safe to call anytime, no side effects.
 */
function tv_healthcheck() {
  const issues = [];
  if (!Array.isArray(LIBRARY.strategies) || LIBRARY.strategies.length === 0) {
    issues.push("STRATEGIES.json: aucune strategie chargee.");
  }
  const envKeys = ["WEBHOOK_SECRET", "TV_WEBHOOK_PORT", "TV_SIGNALS_DIR"];
  const envStatus = {};
  for (const k of envKeys) {
    envStatus[k] = process.env[k] !== undefined && process.env[k] !== "" ? "set" : "default/unset";
  }
  if (envStatus.WEBHOOK_SECRET !== "set") {
    issues.push("WEBHOOK_SECRET non defini : le listener refusera tous les signaux jusqu'a configuration.");
  }

  return {
    ok: issues.length === 0,
    version: "1.0.0",
    strategy_count: LIBRARY.strategies.length,
    strategy_ids: LIBRARY.strategies.map((s) => s.id),
    exchanges_implemented: Object.keys(EXCHANGE_ROUTING).filter((e) => EXCHANGE_ROUTING[e].implemented),
    exchanges_stubbed: Object.keys(EXCHANGE_ROUTING).filter((e) => !EXCHANGE_ROUTING[e].implemented),
    env_status: envStatus,
    issues: issues,
  };
}

// ---- Tool registry ---------------------------------------------------------

const TOOLS = {
  tv_generate_strategy,
  tv_analyze_backtest,
  tv_select_strategy,
  tv_create_webhook_config,
  tv_healthcheck,
};

// ---- CLI entrypoint --------------------------------------------------------

if (require.main === module) {
  const [, , toolName, rawParams] = process.argv;
  if (!toolName) {
    console.error("Usage: node index.js <toolName> '<json>'");
    console.error("Available tools: " + Object.keys(TOOLS).join(", "));
    process.exit(1);
  }
  if (!TOOLS[toolName]) {
    console.error("Unknown tool: " + toolName);
    console.error("Available: " + Object.keys(TOOLS).join(", "));
    process.exit(1);
  }
  let params = {};
  try {
    params = rawParams ? JSON.parse(rawParams) : {};
  } catch (e) {
    console.error("Invalid JSON params: " + e.message);
    process.exit(1);
  }
  try {
    const result = TOOLS[toolName](params);
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

module.exports = TOOLS;
