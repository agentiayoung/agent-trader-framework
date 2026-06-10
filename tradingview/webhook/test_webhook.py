"""
Minimal tests for the TradingView webhook listener.
Run: cd tradingview/webhook && WEBHOOK_SECRET=test123 TV_SIGNALS_DIR=./signals_test python test_webhook.py
(or: pytest test_webhook.py)
No network: uses FastAPI TestClient (in-process).
"""

import os
import shutil
import sys
from pathlib import Path

# Configure env BEFORE importing the app (module reads env at import time).
os.environ.setdefault("WEBHOOK_SECRET", "test123")
TEST_DIR = Path(os.environ.setdefault("TV_SIGNALS_DIR", "./signals_test"))

from fastapi.testclient import TestClient  # noqa: E402
import webhook_listener  # noqa: E402

client = TestClient(webhook_listener.app)

VALID = {
    "strategy_id": "BBRSI",
    "signal": "buy",
    "ticker": "BTCUSDT",
    "exchange": "BYBIT",
    "contracts": "0.01",
    "position_size": "0.01",
    "price": "65000",
    "time": "1716800000",
    "timeframe": "60",
    "key": "test123",
}

passed = 0
failed = 0


def check(name, cond):
    global passed, failed
    if cond:
        passed += 1
        print(f"  PASS  {name}")
    else:
        failed += 1
        print(f"  FAIL  {name}")


def run():
    print("\n=== Webhook Listener Tests ===\n")

    # health
    r = client.get("/health")
    check("GET /health -> 200", r.status_code == 200)
    check("health reports secret configured", r.json().get("secret_configured") is True)

    # valid signal
    r = client.post("/webhook/tradingview", json=VALID)
    check("POST valid signal -> 200", r.status_code == 200)
    body = r.json()
    check("response status ok", body.get("status") == "ok")
    check("signal normalized side=long", body["signal"]["side"] == "long")
    check("signal action=open (position_size>0)", body["signal"]["action"] == "open")
    check("routes to bybit (implemented)", body["signal"]["execution_implemented"] is True)
    fname = body.get("signal_file")
    check("signal file written", fname is not None and (TEST_DIR / fname).exists())

    # bad key
    bad = dict(VALID, key="wrong")
    r = client.post("/webhook/tradingview", json=bad)
    check("POST bad key -> 401", r.status_code == 401)

    # stub exchange still 200 but flagged not implemented
    # (HYPERLIQUID = stub depuis le 09.06.2026, skill archive -> archive/openclaw/)
    stub = dict(VALID, exchange="HYPERLIQUID")
    r = client.post("/webhook/tradingview", json=stub)
    check("POST stub exchange -> 200", r.status_code == 200)
    check("stub flagged execution_implemented=false", r.json()["signal"]["execution_implemented"] is False)

    # invalid JSON
    r = client.post("/webhook/tradingview", content=b"not json",
                    headers={"Content-Type": "application/json"})
    check("POST invalid JSON -> 400", r.status_code == 400)

    print(f"\n{passed}/{passed + failed} tests passed\n")
    # cleanup
    if TEST_DIR.exists():
        shutil.rmtree(TEST_DIR, ignore_errors=True)
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(run())
