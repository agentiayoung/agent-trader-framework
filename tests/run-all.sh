#!/bin/bash
# ---------------------------------------------------------------------------
# Agent Trader Test Suite Runner
# ---------------------------------------------------------------------------
# Runs all test files and reports overall results.
#
# Usage: bash tests/run-all.sh
# ---------------------------------------------------------------------------

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=== Agent Trader Test Suite ==="
echo "Project: $PROJECT_DIR"
echo "Date: $(date)"
echo ""

TOTAL_SUITES=0
PASSED_SUITES=0
FAILED_SUITES=0
FAILED_NAMES=""

run_test() {
  local name="$1"
  local cmd="$2"
  TOTAL_SUITES=$((TOTAL_SUITES + 1))

  echo "--- [$TOTAL_SUITES] $name ---"
  if eval "$cmd"; then
    PASSED_SUITES=$((PASSED_SUITES + 1))
    echo "  Suite: PASS"
  else
    FAILED_SUITES=$((FAILED_SUITES + 1))
    FAILED_NAMES="$FAILED_NAMES  - $name\n"
    echo "  Suite: FAIL"
  fi
  echo ""
}

# ---- Offline tests (no network required) ------------------------------------

run_test "TradingView Strategy" \
  "node '$SCRIPT_DIR/test-tradingview.js'"

run_test "Signal Executor (dry-run)" \
  "node '$SCRIPT_DIR/test-signal-executor.js'"

run_test "Score /14 (offline)" \
  "node '$SCRIPT_DIR/test-score.js'"

run_test "Score-eval bucketing (offline)" \
  "node '$SCRIPT_DIR/test-score-eval.js'"

run_test "Universe registry (offline)" \
  "node '$SCRIPT_DIR/test-universe.js'"

run_test "Timeline par trade (offline)" \
  "node '$SCRIPT_DIR/test-timeline.js'"

run_test "Digest / heartbeat (offline)" \
  "node '$SCRIPT_DIR/test-digest.js'"


run_test "Trade-note Obsidian (offline)" \
  "node '$SCRIPT_DIR/test-trade-note.js'"

run_test "Review hebdo (offline)" \
  "node '$SCRIPT_DIR/test-review.js'"

run_test "Sizing / clamp levier (offline)" \
  "node '$SCRIPT_DIR/test-sizing.js'"

run_test "Bracket-check (offline)" \
  "node '$SCRIPT_DIR/test-bracket-check.js'"

run_test "Reconcile laddered-aware (offline)" \
  "node '$SCRIPT_DIR/test-reconcile-match.js'"

run_test "Guard pipeline pre-bracket (offline)" \
  "node '$SCRIPT_DIR/test-guards.js'"

run_test "Entry context capture (offline)" \
  "node '$SCRIPT_DIR/test-entry-context.js'"

run_test "Bybit microstructure feed (offline)" \
  "node '$SCRIPT_DIR/test-feed.js'"

run_test "Market structure engine (offline)" \
  "node '$SCRIPT_DIR/test-structure.js'"

run_test "Zones detector engine (offline)" \
  "node '$SCRIPT_DIR/test-zones.js'"

run_test "Candle confirmation engine (offline)" \
  "node '$SCRIPT_DIR/test-candles.js'"

run_test "Orderflow metrics engine (offline)" \
  "node '$SCRIPT_DIR/test-orderflow.js'"

run_test "Confluence 0-100 engine (offline)" \
  "node '$SCRIPT_DIR/test-confluence.js'"

run_test "Perception aggregator (offline)" \
  "node '$SCRIPT_DIR/test-perception.js'"

run_test "Origin conv/routine (offline)" \
  "node '$SCRIPT_DIR/test-origin.js'"

run_test "Cycle lens / bottom-watch (offline)" \
  "node '$SCRIPT_DIR/test-cycle.js'"

run_test "Indicateurs enrichis: divergence/OBV/beta (offline)" \
  "node '$SCRIPT_DIR/test-indicators.js'"

run_test "R-multiple + roundPx (fix DOGE sub-dollar/laddered, offline)" \
  "node '$SCRIPT_DIR/test-rmultiple.js'"

run_test "Manage-check / resserrement SL squeeze (offline)" \
  "node '$SCRIPT_DIR/test-manage.js'"

run_test "Risk-verify / risque geometrique reel (fix sizing DOGE, offline)" \
  "node '$SCRIPT_DIR/test-risk-verify.js'"

run_test "Price-action / mode histo court tradable en DEMO (offline)" \
  "node '$SCRIPT_DIR/test-price-action.js'"

run_test "Options-context / gravity map Deribit (max-pain/walls/GEX, offline)" \
  "node '$SCRIPT_DIR/test-options.js'"

run_test "Thesis-check / perception sante de these (offline)" \
  "node '$SCRIPT_DIR/test-thesis.js'"

run_test "Trail trend-adaptatif / laisser courir les tendances (offline)" \
  "node '$SCRIPT_DIR/test-trail.js'"

run_test "Placement FADE ancre structure live (rungs/SL/TP, offline)" \
  "node '$SCRIPT_DIR/test-placement.js'"

run_test "Relief-rally detecteur (anti short de bottom, offline)" \
  "node '$SCRIPT_DIR/test-relief-rally.js'"

run_test "Dispersion / hedge L+S (offline)" \
  "node '$SCRIPT_DIR/test-dispersion.js'"

run_test "Perception candidates / longs bilateraux F4 (offline)" \
  "node '$SCRIPT_DIR/test-perception-candidates.js'"

run_test "Bottom-confirmed / rail bilateral long (offline)" \
  "node '$SCRIPT_DIR/test-bottom-confirmed.js'"

run_test "Slippage / cout reel (offline)" \
  "node '$SCRIPT_DIR/test-slippage.js'"

run_test "Edge-watch / revalidation (offline)" \
  "node '$SCRIPT_DIR/test-edge-watch.js'"

run_test "Optimize random-control (offline)" \
  "node '$SCRIPT_DIR/test-optimize-random.js'"

run_test "Validation robuste : CPCV/Deflated Sharpe/null bootstrap (offline)" \
  "node '$SCRIPT_DIR/test-validation.js'"

run_test "Modele de fill LIMIT probabiliste (offline)" \
  "node '$SCRIPT_DIR/test-fillmodel.js'"

run_test "Prompt coverage (plancher dur)" \
  "node '$SCRIPT_DIR/test-prompt-coverage.js'"

run_test "Bybit marge isolee (offline)" \
  "node '$SCRIPT_DIR/test-bybit-isolated.js'"

run_test "Strategy log (offline)" \
  "node '$SCRIPT_DIR/test-strategy-log.js'"

run_test "Trajectoire MFE/MAE/give-back/velocite (offline)" \
  "node '$SCRIPT_DIR/test-trajectory.js'"

# ---- Execution tests ---------------------------------------------------------
# (Suites hyperliquid/polymarket/risk-management/pnl-tracker archivées le
#  09.06.2026 avec leurs skills → archive/openclaw/tests/)

run_test "Bybit Scaled Bracket (offline dry_run)" \
  "node '$SCRIPT_DIR/test-bybit-bracket.js'"

run_test "Monitor persistant (offline)" \
  "node '$SCRIPT_DIR/test-monitor.js'"

run_test "Portfolio live cross-agent (offline)" \
  "node '$SCRIPT_DIR/test-portfolio.js'"

# ---- Summary -----------------------------------------------------------------

echo "============================================"
echo "  Test Suite Summary"
echo "============================================"
echo "  Total:  $TOTAL_SUITES suites"
echo "  Passed: $PASSED_SUITES"
echo "  Failed: $FAILED_SUITES"

if [ $FAILED_SUITES -gt 0 ]; then
  echo ""
  echo "  Failed suites:"
  echo -e "$FAILED_NAMES"
  echo "============================================"
  exit 1
else
  echo ""
  echo "  All suites passed."
  echo "============================================"
  exit 0
fi
