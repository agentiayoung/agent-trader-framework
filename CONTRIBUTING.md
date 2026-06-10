# Contributing

Thanks for looking at this. The point of open-sourcing it is to get scrutiny on the **risk architecture and research methodology** — that's where review is most valuable.

## Ground rules

- **Paper only.** Never add a code path that enables live/mainnet trading by default, and never commit credentials. The default must stay `BYBIT_DEMO=1`.
- **The decision core is pure and tested.** Modules under `trade-journal/` (guards, sizing, bracket-check, score, slippage, edge-watch, etc.) have zero network dependencies and are covered by offline tests. Keep them that way — exchange/network calls live in `skills/`.
- **TDD.** Add or update a test under `tests/` before changing a decision module. The suite must stay green: `bash tests/run-all.sh`.
- **No new threshold without evidence.** Risk parameters and strategy edges are not tuned by intuition. If you change one, justify it with an out-of-sample result (`optimize.js`, train/test split, beat-random control) or keep it as observability only.

## Setup

```bash
npm install                       # root (no runtime deps; for scripts)
cd skills/bybit && npm install && cd ../..
cd skills/shared/tradingview && npm install && cd ../../..
cp .env.example config/.env       # Bybit DEMO keys, BYBIT_DEMO=1
npm test                          # bash tests/run-all.sh
```

## Good first issues

- Strengthen `trade-journal/guards.js` (the pre-order gate) or `bracket-check.js` (anti-sweep SL geometry) with edge cases.
- Harden the reconcile logic against more exchange quirks.
- Port the routine runner beyond Windows Task Scheduler (a clean cron / systemd-timer path).
- Improve the OOS protocol: more robust random-control, walk-forward variants.

## PRs

Keep them focused and atomic. Describe what you changed and how you verified it (paste test output). Found a security issue? See [SECURITY.md](SECURITY.md) — don't open a public issue for it.
