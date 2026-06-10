"""
TradingView Webhook Listener — Agent Trader (OpenClaw)
======================================================
Receives TradingView strategy-alert POSTs, validates the shared secret,
normalizes the signal, and writes it as a JSON file into TV_SIGNALS_DIR.
The signal executor polls that directory (file inbox pattern) — this
service NEVER places orders itself.

Routing: only BYBIT is implemented in this project (09.06.2026 : hyperliquid
archivé → archive/openclaw/). Other exchanges (HYPERLIQUID, BINANCE, ASTER,
NASDAQ, NYSE) are logged and written with execution_implemented=false so the
executor can skip them safely.

Run locally:
    WEBHOOK_SECRET=test123 TV_SIGNALS_DIR=./signals \
      uvicorn webhook_listener:app --host 0.0.0.0 --port 8088
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("tv-webhook")

# Make the confluence_engine package importable from both Docker (/app) and
# local repo (tradingview/webhook/) layouts.
_HERE = Path(__file__).resolve().parent
_CANDIDATES = [_HERE, _HERE.parents[1]] if len(_HERE.parents) >= 2 else [_HERE]
for _candidate in _CANDIDATES:
    if (_candidate / "confluence_engine").is_dir() and str(_candidate) not in sys.path:
        sys.path.insert(0, str(_candidate))
        break

try:
    from confluence_engine.engine import ConfluenceEngine
    from confluence_engine.indicator_adapters import adapt as adapt_signal, AdapterError
    from confluence_engine.decision import build_recommendation
    from confluence_engine.telegram_notifier import TelegramNotifier
    _CONFLUENCE_AVAILABLE = True
except ImportError as _exc:
    logger.warning("confluence_engine not importable: %s — /webhook/confluence disabled", _exc)
    _CONFLUENCE_AVAILABLE = False

# ── Configuration ───────────────────────────────────────────────────────────
WEBHOOK_SECRET = os.environ.get("WEBHOOK_SECRET", "")
SIGNALS_DIR = Path(os.environ.get("TV_SIGNALS_DIR", "/signals"))
CONFLUENCE_RAW_DIR = Path(os.environ.get("CONFLUENCE_RAW_DIR", str(SIGNALS_DIR.parent / "confluence_raw")))

# TradingView exchange name -> execution skill.
# Only bybit is implemented; the rest are documented stubs.
EXCHANGE_ROUTING: dict[str, dict[str, Any]] = {
    "BINANCE": {"skill": "binance", "implemented": False},
    "BYBIT": {"skill": "bybit", "implemented": True},
    "HYPERLIQUID": {"skill": "hyperliquid", "implemented": False},
    "ASTER": {"skill": "aster", "implemented": False},
    "NASDAQ": {"skill": "alpaca", "implemented": False},
    "NYSE": {"skill": "alpaca", "implemented": False},
}

app = FastAPI(title="TradingView Webhook Listener", version="1.0.0")


# ── Models ───────────────────────────────────────────────────────────────────
class TradingViewSignal(BaseModel):
    strategy_id: Optional[str] = None
    signal: Optional[str] = None          # buy / sell (legacy) — accepts "action" alias
    ticker: Optional[str] = None          # accepts "symbol" alias (legacy spec)
    exchange: Optional[str] = None
    contracts: Optional[str] = None
    position_size: Optional[str] = None
    price: Optional[str] = None
    time: Optional[str] = None
    timeframe: Optional[str] = None
    key: Optional[str] = None             # accepts "secret" alias (legacy spec)
    sl: Optional[str] = None              # stop-loss (required for execution)
    tp: Optional[str] = None              # single take-profit (legacy / fallback)
    entry: Optional[str] = None           # limit entry price (defaults to `price`)
    tp1: Optional[str] = None             # scale-out take-profit ladder
    tp2: Optional[str] = None
    tp3: Optional[str] = None
    tp_fracs: Optional[str] = None        # optional CSV of fractions, e.g. "0.4,0.3,0.3"
    qty_pct: Optional[str] = None


def _normalize_legacy_aliases(body: dict[str, Any]) -> dict[str, Any]:
    """Map TradingView spec aliases (secret/action/symbol) to listener fields."""
    if "secret" in body and "key" not in body:
        body["key"] = body.pop("secret")
    if "action" in body and "signal" not in body:
        body["signal"] = body.pop("action")
    if "symbol" in body and "ticker" not in body:
        body["ticker"] = body.pop("symbol")
    return body


# ── Helpers ───────────────────────────────────────────────────────────────────
def normalize_exchange(exchange_str: Optional[str]) -> dict[str, Any]:
    """Map a TradingView exchange name to an OpenClaw skill + implemented flag."""
    if not exchange_str:
        return {"name": "UNKNOWN", "skill": "default", "implemented": False}
    key = exchange_str.upper()
    route = EXCHANGE_ROUTING.get(key, {"skill": "default", "implemented": False})
    return {"name": key, "skill": route["skill"], "implemented": route["implemented"]}


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _safe_filename(ticker: Optional[str]) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]", "_", (ticker or "UNKNOWN"))[:40]


def build_take_profits(data: TradingViewSignal) -> list[dict[str, float]]:
    """Build a scale-out TP ladder [{px, frac}, ...] from tp1/tp2/tp3 (or single tp).

    Fractions: use `tp_fracs` (CSV) if provided, else a sensible default ladder by
    count — 1 TP → [1.0], 2 → [0.5, 0.5], 3 → [0.4, 0.3, 0.3].
    """
    pxs = [_safe_float(p) for p in (data.tp1, data.tp2, data.tp3) if p not in (None, "")]
    if not pxs and data.tp not in (None, ""):
        pxs = [_safe_float(data.tp)]
    if not pxs:
        return []

    fracs: list[float] = []
    if data.tp_fracs:
        fracs = [_safe_float(x) for x in str(data.tp_fracs).split(",") if x.strip()]
    if len(fracs) != len(pxs):
        defaults = {1: [1.0], 2: [0.5, 0.5], 3: [0.4, 0.3, 0.3]}
        fracs = defaults.get(len(pxs), [round(1.0 / len(pxs), 4)] * len(pxs))

    return [{"px": px, "frac": fr} for px, fr in zip(pxs, fracs)]


def build_normalized_signal(data: TradingViewSignal) -> dict[str, Any]:
    """Normalize a raw TradingView payload into the agent's signal schema."""
    route = normalize_exchange(data.exchange)
    raw_signal = (data.signal or "").lower()
    side = "long" if raw_signal == "buy" else "short" if raw_signal == "sell" else raw_signal
    pos_size = _safe_float(data.position_size, 0.0)
    action = "open" if abs(pos_size) > 0 else "close"
    price = _safe_float(data.price, 0.0)
    entry = _safe_float(data.entry, price) if data.entry not in (None, "") else price

    return {
        "source": "tradingview",
        "received_at": int(time.time()),
        "strategy_id": data.strategy_id,
        "exchange": route["name"],
        "routes_to_skill": route["skill"],
        "execution_implemented": route["implemented"],
        "market": data.ticker,
        "side": side,
        "action": action,
        "raw_signal": raw_signal,
        "contracts": _safe_float(data.contracts, 0.0),
        "position_size": pos_size,
        "price": price,
        "entry": entry,
        "stop_loss": _safe_float(data.sl) if data.sl not in (None, "") else None,
        "take_profits": build_take_profits(data),
        "timeframe": data.timeframe,
        "tv_time": data.time,
        "processed": False,
    }


def write_signal(signal: dict[str, Any]) -> Path:
    """Persist the normalized signal as a JSON file in the inbox directory."""
    SIGNALS_DIR.mkdir(parents=True, exist_ok=True)
    fname = f"{signal['received_at']}-{_safe_filename(signal.get('market'))}.json"
    path = SIGNALS_DIR / fname
    path.write_text(json.dumps(signal, indent=2), encoding="utf-8")
    return path


# ── Routes ───────────────────────────────────────────────────────────────────
@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "service": "tradingview-webhook",
        "secret_configured": bool(WEBHOOK_SECRET),
        "signals_dir": str(SIGNALS_DIR),
        "exchanges_implemented": [k for k, v in EXCHANGE_ROUTING.items() if v["implemented"]],
    }


@app.post("/webhook/tradingview")
async def tradingview_webhook(request: Request) -> JSONResponse:
    # Parse JSON defensively (TradingView sends text/plain sometimes).
    try:
        body = await request.json()
    except Exception:
        raw = (await request.body()).decode("utf-8", errors="replace")
        try:
            body = json.loads(raw)
        except Exception:
            logger.warning("Rejected: body is not valid JSON")
            return JSONResponse({"error": "Invalid JSON body"}, status_code=400)

    body = _normalize_legacy_aliases(body)
    data = TradingViewSignal(**body)

    # Secret validation — refuse everything if the server has no secret set.
    if not WEBHOOK_SECRET:
        logger.error("Rejected: WEBHOOK_SECRET is not configured on the server")
        return JSONResponse({"error": "Server misconfigured: no secret"}, status_code=503)
    if data.key != WEBHOOK_SECRET:
        logger.warning("Rejected: invalid key for strategy_id=%s", data.strategy_id)
        return JSONResponse({"error": "Unauthorized"}, status_code=401)

    signal = build_normalized_signal(data)
    path = write_signal(signal)

    if not signal["execution_implemented"]:
        logger.info(
            "Signal stored but exchange '%s' (skill '%s') is NOT implemented — agent will skip.",
            signal["exchange"], signal["routes_to_skill"],
        )
    else:
        logger.info(
            "Signal stored: %s %s on %s -> %s (%s)",
            signal["action"], signal["side"], signal["market"],
            signal["routes_to_skill"], path.name,
        )

    return JSONResponse(
        {"status": "ok", "signal_file": path.name, "signal": signal},
        status_code=200,
    )


# ── Confluence Engine integration ─────────────────────────────────────────────
_confluence_engine: Optional[Any] = None
_confluence_notifier: Optional[Any] = None
_confluence_lock = asyncio.Lock()


def _get_confluence() -> tuple[Any, Any]:
    global _confluence_engine, _confluence_notifier
    if _confluence_engine is None:
        _confluence_engine = ConfluenceEngine()
        _confluence_notifier = TelegramNotifier()
    return _confluence_engine, _confluence_notifier


def _persist_raw_signal(payload: dict[str, Any]) -> Path:
    CONFLUENCE_RAW_DIR.mkdir(parents=True, exist_ok=True)
    ticker = _safe_filename(payload.get("ticker") or payload.get("symbol"))
    indicator = _safe_filename(payload.get("indicator"))
    fname = f"{int(time.time())}-{indicator}-{ticker}.json"
    path = CONFLUENCE_RAW_DIR / fname
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return path


@app.post("/webhook/confluence")
async def confluence_webhook(request: Request) -> JSONResponse:
    if not _CONFLUENCE_AVAILABLE:
        return JSONResponse({"error": "confluence_engine unavailable"}, status_code=503)

    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "Invalid JSON body"}, status_code=400)

    if not WEBHOOK_SECRET:
        return JSONResponse({"error": "Server misconfigured: no secret"}, status_code=503)
    if body.get("secret") != WEBHOOK_SECRET and body.get("key") != WEBHOOK_SECRET:
        logger.warning("confluence: rejected invalid key for indicator=%s", body.get("indicator"))
        return JSONResponse({"error": "Unauthorized"}, status_code=401)

    body.pop("secret", None)
    body.pop("key", None)

    try:
        signal = adapt_signal(body)
    except AdapterError as exc:
        return JSONResponse({"error": f"adapter: {exc}"}, status_code=422)

    if signal is None:
        return JSONResponse({"error": "unknown or unsupported indicator"}, status_code=422)

    raw_path = _persist_raw_signal(body)

    async with _confluence_lock:
        engine, notifier = _get_confluence()
        engine.ingest(signal)
        long_result, short_result = engine.evaluate_both_sides(signal.ticker)

    best = max((long_result, short_result), key=lambda r: r.score)
    response: dict[str, Any] = {
        "status": "ok",
        "raw_file": raw_path.name,
        "ingested": {
            "indicator": signal.indicator,
            "ticker": signal.ticker,
            "side": signal.side,
        },
        "evaluation": {
            "best_side": best.side,
            "score": best.score,
            "tier": best.tier,
            "contributing": best.contributing_indicators,
        },
    }

    if best.is_actionable():
        rec = build_recommendation(_get_confluence()[0], best)
        if rec is not None:
            response["recommendation"] = {
                "ticker": rec.ticker,
                "side": rec.side,
                "score": rec.score,
                "tier": rec.tier,
                "entry": rec.entry,
                "stop_loss": rec.stop_loss,
                "take_profit_1": rec.take_profit_1,
                "take_profit_2": rec.take_profit_2,
                "risk_reward": rec.risk_reward,
            }
            if notifier.is_configured():
                sent = await notifier.send(rec)
                response["telegram_sent"] = sent
            else:
                response["telegram_sent"] = False

    logger.info(
        "confluence: %s %s | best=%s score=%d tier=%s",
        signal.indicator, signal.ticker, best.side, best.score, best.tier,
    )
    return JSONResponse(response, status_code=200)


@app.get("/confluence/health")
def confluence_health() -> dict[str, Any]:
    if not _CONFLUENCE_AVAILABLE:
        return {"status": "disabled", "reason": "confluence_engine not importable"}
    engine, notifier = _get_confluence()
    return {
        "status": "ok",
        "window_seconds": engine.rules["window_seconds"],
        "threshold_strong": engine.rules["thresholds"]["strong_alert"],
        "threshold_weak": engine.rules["thresholds"]["weak_alert"],
        "telegram_configured": notifier.is_configured(),
        "raw_dir": str(CONFLUENCE_RAW_DIR),
    }


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("TV_WEBHOOK_PORT", "8088"))
    uvicorn.run(app, host="0.0.0.0", port=port)
