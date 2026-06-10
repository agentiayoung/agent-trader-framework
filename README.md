# agent-trader

**A local, LLM-driven paper-trading harness with real risk discipline.**

[![tests](https://github.com/agentiayoung/agent-trader-framework/actions/workflows/ci.yml/badge.svg)](https://github.com/agentiayoung/agent-trader-framework/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-green.svg)](https://nodejs.org/)
[![mode: paper](https://img.shields.io/badge/mode-paper%20(Bybit%20demo)-blue.svg)](DISCLAIMER.md)

An autonomous trading agent that runs as scheduled local routines (Task Scheduler / cron -> `claude -p`), scans a multi-pair crypto universe across timeframes, takes setups that were validated out-of-sample, executes bracketed orders on **Bybit demo**, and keeps a full decision journal, observability layer, and continuous self-evaluation loop.

> [!CAUTION]
> Experimental software for **paper trading (Bybit DEMO)** and research. Not financial advice, no warranty. The strategy parameters shipped here are **illustrative** and almost certainly overfit — re-validate out-of-sample on your own data. See [DISCLAIMER.md](DISCLAIMER.md).

Most "AI trading bot" repos are a thin wrapper around a prompt. This one is the opposite: the LLM decides *what* to trade, but a deterministic, tested core decides *whether the order is allowed to exist at all*.

## What makes it different

- **Deterministic guard pipeline (`preflight`)** — one gate before every bracket aggregates all non-negotiable risk rules (mandatory stop-loss, anti-sweep SL geometry, R:R floor for trend setups, circuit breaker, daily quota, aggregate exposure) into a single `ALLOW`/`BLOCK` verdict. The LLM cannot forget a check.
- **Anti-sweep stop placement (`sl-check`)** — refuses stops parked on the obvious liquidity pocket (just past a swing high/low or round number), enforcing a buffer beyond the wicks and a per-family ATR floor.
- **Risk-first position sizing** — size is always a percentage of equity risk, with edge-scaling (Kelly-lite), leverage clamp, and **drawdown-scaled (anti-martingale)** tapering that shrinks risk as you lose.
- **Out-of-sample edge research (`/edge-sprint`)** — a documented protocol: map the live market, pre-register hypotheses, run `optimize.js` with train/test split + per-regime buckets + a **random-control baseline** (a candidate must *beat random* to be considered robust). Mirage-resistant by construction.
- **Honest accounting** — modeled fees -> net edge, live slippage tracking (planned-vs-actual in R), bracket verification (naked position / oversized SL / inverted side), and a reconcile loop where the exchange is the source of truth.
- **Observability** — per-trade timeline, daily digest, heartbeat + dead-man watchdog, weekly review, monthly edge revalidation.

## Architecture

```
trade-journal/   Decision core (pure Node.js, zero network deps for tests):
                 journal.js (log/sync/stats/reconcile/preflight/sl-check/...) +
                 guards.js + scan.js + optimize.js + backtest.js + sizing.js +
                 bracket-check.js + slippage.js + edge-watch.js + score.js
skills/bybit/    Exchange execution (ccxt, Bybit demo) — brackets, trailing
skills/shared/   TradingView strategy generation (Pine v6) + analysis
tradingview/     Pine library, webhook listener (FastAPI) + signal executor
routines/        Scheduled SOP runner + health-check watchdog + task registration
tests/           Offline / dry-run suites (run-all.sh)
```

The decision layer is pure and offline-testable; the execution layer is the only thing that touches the exchange and the only thing that holds credentials (via env, never committed).

## Quick start

Requirements: **Node.js 22+**, a POSIX shell for the test runner, and the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (the agent that runs the routines).

```bash
git clone <your-fork-url> agent-trader
cd agent-trader
cp .env.example config/.env      # fill in your Bybit DEMO keys (BYBIT_DEMO=1)
cd skills/bybit && npm install && cd ../..

bash tests/run-all.sh            # offline suite, should be green

# dry-run a single decision gate:
node trade-journal/journal.js preflight '{"symbol":"BTC","side":"long","setup":"S1","entry":105000,"stop_loss":103000,"take_profits":[{"px":107000},{"px":109500}]}'
```

Then wire the routines (`routines/`) into Task Scheduler (Windows) or cron, pointing at `run-routine.ps1` / a cron equivalent. See [AGENTS.md](AGENTS.md) for how an LLM agent is expected to operate the system, and [STRATEGIES.md](STRATEGIES.md) for the strategy families.

## What is intentionally NOT here

This is the **framework**, not a turnkey money printer:

- The author's specific validated edge values and live trade history are **not** published. The strategy parameters present in the code are illustrative defaults — treat them as a starting point to re-validate, not as signal.
- No credentials, no personal infrastructure, no live-trading auto-enable.

## Documentation

- [AGENTS.md](AGENTS.md) — how an LLM agent operates the system (the routine SOP).
- [STRATEGIES.md](STRATEGIES.md) — the strategy families and the OOS research protocol.
- [routines/trade-routine.md](routines/trade-routine.md) — the full standard operating procedure.
- [DISCLAIMER.md](DISCLAIMER.md) — read this before doing anything.
- [CONTRIBUTING.md](CONTRIBUTING.md) · [SECURITY.md](SECURITY.md) · [CHANGELOG.md](CHANGELOG.md)

## Project status

Early and active. Paper-trading only; APIs and parameters will change. Not production-grade — treat it as a research harness you adapt and re-validate, not a turnkey bot.

## Feedback wanted

This is shared to get eyes on the **risk architecture and research methodology**. Issues and PRs on the guard pipeline, `sl-check` geometry, sizing math, the OOS/random-control protocol, or the reconcile logic are especially welcome. Tell me where it's wrong.

## License

[MIT](LICENSE).

