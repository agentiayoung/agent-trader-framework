# Strategy families

> The setups below are described **generically**. The specific entry/exit parameters and the out-of-sample edge values used in the code are **illustrative defaults** — re-validate them on your own data with `optimize.js` before trusting any of them. See [DISCLAIMER.md](DISCLAIMER.md).

The system trades two broad families, routed by the live market regime (BTC daily ADX + each pair's own regime).

## Mean-reversion (range / fade)
Fade stretched moves back toward a mean when the higher timeframe is not strongly trending.

- **MR8** — StochRSI-driven reversion. Validated geometry uses a wider ATR stop (no compressed R:R).
- **MR4** — Bollinger reversion with a trend filter.
- **S5** — range fade.

Mean-reversion setups are **exempt from the R:R>=2 rule** *on the condition* that they use their validated ATR geometry (wide stop, symmetric-ish target). A compressed in-between is forbidden — it is the classic cause of stop sweeps.

## Trend / continuation
Join or fade-the-bounce in the direction of an established move; only valid when the pair is trending.

- **S1** — short-the-bounce / continuation in a downtrend.
- **S2** — continuation.
- **S3** — oversold long.
- **S12** — squeeze breakout (trending only).

Trend setups **require R:R >= 2 to the second take-profit**. In range conditions, the trend-continuation setups are a hard skip.

## Regime routing
Each scan candidate carries a `regime_fit` verdict (`good` / `avoid` / `neutral`) for the setup in its current regime. The agent privileges `good`, de-prioritizes `avoid`, and hard-skips the documented poison combinations (e.g. trend-continuation setups in a range).

## Multi-timeframe
A trend filter on a **higher** timeframe (e.g. Daily EMA200) gates entries on the lower timeframe. The 4H is the setup, the 1H is timing — not a trigger on its own.

## Laddered entry
Mean-reversion entries (and, in trending/strong regimes only, the trend-continuation setups) split into three independent limit tranches (T1 at signal, T2/T3 progressively deeper in the favorable direction), each with its own complete bracket at validated geometry. Total risk equals the normal budget; if only T1 fills, only a third of the risk is engaged.

## Research protocol (`/edge-sprint`)
New strategies are not added by intuition. The protocol: map the live market, pre-register at most three hypotheses with acceptance criteria *before* running, then run `optimize.js` with a train/test split, per-regime buckets, and a **random-control baseline** — a candidate must beat a same-universe random-entry baseline to count as robust. Wiring into the live routines happens only after an explicit human go.
