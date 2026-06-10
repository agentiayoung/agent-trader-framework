# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions follow semver once past 0.x.

## [0.1.0] — Initial public release

First public snapshot of the framework. Paper-trading only (Bybit demo).

### Core
- **Deterministic guard pipeline (`preflight`)** — single ALLOW/BLOCK gate before every bracket, aggregating mandatory stop-loss, anti-sweep SL geometry, R:R floor for trend setups, circuit breaker, daily quota, and aggregate exposure.
- **Anti-sweep stop placement (`sl-check`)** — buffer beyond wicks + per-family ATR floor.
- **Risk-first sizing** — percentage-of-equity risk with edge-scaling, leverage clamp, and drawdown-scaled (anti-martingale) tapering.
- **Bracket verification & reconcile** — naked-position / oversized-SL / inverted-side detection; exchange-as-source-of-truth reconcile with orphan-order sweep.

### Research
- **`optimize.js`** — train/test split, per-regime buckets, modeled fees, and a **random-control baseline** (candidates must beat random to count as robust).
- **Slippage tracking** — planned-vs-actual friction in R; monthly edge revalidation.

### Execution & ops
- **Bybit demo** execution via ccxt (limit/maker brackets, scaled entries, native trailing).
- **TradingView pipeline** — Pine v6 generation, webhook listener, signal executor.
- **Observability** — per-trade timeline, daily digest, heartbeat + dead-man watchdog, weekly review.

### Notes
- Strategy parameters and edge values are **illustrative** (see `DISCLAIMER.md`). Re-validate out-of-sample before trusting any number.
