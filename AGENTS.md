# AGENTS.md — operating guide for the trading agent

This file tells an LLM agent (Claude Code or similar) how to operate the system. It is loaded as context at the start of each routine.

## Golden rules (non-negotiable)

- **Paper only.** Default exchange wiring is Bybit demo (`BYBIT_DEMO=1`). Never enable a live/mainnet mode without an explicit, deliberate decision and your own audited keys.
- **Date = system clock.** Get the date from `node trade-journal/journal.js today`. Never trust an ambient "current date" string.
- **The journal is the source of truth in the repo; the exchange is the source of truth for live state.** Read `trade-journal/JOURNAL.md` + `LESSONS.md` before any decision; reconcile against the exchange with `journal.js reconcile`.
- **One gate before every order.** Run `journal.js preflight` before placing any bracket. `ok:false` means do not place the order — read `blocks[]`. It aggregates: mandatory SL, anti-sweep SL geometry, R:R floor (trend setups), circuit breaker, daily quota, aggregate exposure. It is deterministic; it exists so you cannot forget a check.
- **Risk is constant, size is derived.** Always size via `journal.js size` (percentage-of-equity risk, edge-scaled, drawdown-scaled, leverage-clamped). Never a fixed notional.

## Routine SOP (each scheduled run)

1. **Date + reconcile + risk + exposure.** Get the date, reconcile open/pending trades against the exchange, check the circuit breaker (`journal.js risk` -> `halt:true` => manage only, no new trades), check aggregate exposure.
2. **Manage existing positions.** For each open/pending trade, read its brief (`journal.js trade <id>`: thesis + invalidation + current R + score decay), then keep / trail (native trailing stop mandatory once >=1R) / scale / exit / cancel. Record the management step with `journal.js note` (per-trade timeline).
3. **Scan.** `node trade-journal/scan.js` over the pair universe; deep-dive the best candidates; read the regime + `regime_fit` per candidate.
4. **Decide.** For each candidate, take the trade only if: a valid out-of-sample edge for the setup, the R:R / geometry rule holds, a clean entry level exists, and the hard gate passes (no opposing strong regime). The conviction score sizes the trade; it does not gate it.
5. **Execute.** Define entry/SL from structure, size it, then **run `preflight`** — if `ok:false`, stop. Place a limit (maker) bracket by default. For mean-reversion (and trend setups in trending/strong regimes), use the laddered entry. Then `verify-bracket` post-fill.
6. **Document.** `journal.js log` (with thesis, invalidation, and a scoring block), regenerate the report/dashboard, send a notification if actionable, emit a heartbeat.

## Post-trade reflection

For every trade closed since the last run, write a short review (thesis played? exit conform to plan? lesson?). New patterns go into `LESSONS.md`.

## Commands (journal.js)

`today` · `reconcile` · `risk` · `exposure` · `size` · `sl-check` · `preflight` · `log` · `note` · `sync` · `stats` · `score-eval` · `slippage` · `trade <id>` · `review` · `digest` · `heartbeat` · `verify-bracket` · `report` · `dashboard`

Run the offline test suite with `bash tests/run-all.sh` before changing any decision module.
