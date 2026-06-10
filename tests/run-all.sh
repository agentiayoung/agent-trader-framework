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

run_test "Guard pipeline pre-bracket (offline)" \
  "node '$SCRIPT_DIR/test-guards.js'"

run_test "Slippage / cout reel (offline)" \
  "node '$SCRIPT_DIR/test-slippage.js'"

run_test "Edge-watch / revalidation (offline)" \
  "node '$SCRIPT_DIR/test-edge-watch.js'"

run_test "Optimize random-control (offline)" \
  "node '$SCRIPT_DIR/test-optimize-random.js'"

# ---- Execution tests ---------------------------------------------------------
# (Suites hyperliquid/polymarket/risk-management/pnl-tracker archivées le
#  09.06.2026 avec leurs skills → archive/openclaw/tests/)

run_test "Bybit Scaled Bracket (offline dry_run)" \
  "node '$SCRIPT_DIR/test-bybit-bracket.js'"

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
