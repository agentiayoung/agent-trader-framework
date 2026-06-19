# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions follow semver once past 0.x.

## [0.2.0] — Perception layer + price-action panel

Second public snapshot. Still paper-trading only (Bybit demo). Adds a deterministic
perception layer and a price-action-first decision panel on top of the 0.1.0 core.

### Perception layer (deterministic, pure, tested)
- **Structure engine** — swings, BOS / CHoCH / MSS, trend sequence.
- **Zones engine** — S/R bands, FVG, order blocks, EQH/EQL, VWAP, volume-profile HVN/LVN, PDH/PDL, sessions, liquidity pockets.
- **Candle context** — patterns gated by `locationQuality` (candle-in-zone + HTF aligned as a hard invariant).
- **Orderflow** — CVD, delta, sweep detection, OI delta, absorption/aggression from REST snapshots.
- **Confluence 0-100** — fuses structure × zone × candle × orderflow × HTF bias into a single score plus a proposal (long / short / wait / no-trade). Sub-threshold scores are observability-first (non-blocking) until validated out-of-sample.

### Decision panel & monitoring
- **Price-action-first panel** — independent BULL and BEAR proposer passes (read-only, no execution capability) feed an orchestrator that arbitrates on live sentiment; validated edges act as confluence context, not a funnel.
- **Persistent monitoring (`monitor.js`)** — deterministic per-position action plan (place SL if naked, trail when in profit, tighten / take-partial on thesis change) so routines manage open risk on every pass.
- **Live thesis health (`thesis-check`)** — bidirectional per-position verdict (hold / weakening / flipped / running / mature).
- **Trajectory monitoring** — MFE / MAE / give-back / velocity from since-entry OHLCV to surface the between-routine blind spot.

### Research & risk
- **Robust validation** — combinatorial purged cross-validation and a Deflated Sharpe Ratio (corrects for non-normality and multiple testing) gate "validated" edges.
- **Bilateral L+S + dispersion** — correlation-aware hedging (enabled only when the book is dispersed, never when concentrated).
- **Isolated margin** per position; multi-asset registry (crypto majors plus illustrative commodity / ETF / equity perps), each non-crypto class scanned and exposure-tracked.

### Notes
- Parameters and edge values remain **illustrative** (see `DISCLAIMER.md`). Re-validate out-of-sample before trusting any number.

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
