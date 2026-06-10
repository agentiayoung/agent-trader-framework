---
name: tradingview-strategy
description: Generation de strategies Pine Script v6, diagnostic de backtest, selection de strategie depuis la bibliotheque, et configuration des alertes webhook TradingView. A consulter avant de generer ou deployer une strategie.
---

# TradingView Strategy — Skill Partage

Pure logique, zero appel API. Le skill **genere du code et de la config** ; il n'execute jamais d'ordre. L'execution des signaux TradingView passe uniquement par le skill `hyperliquid` (perps crypto), apres le workflow pre-trade complet (`rm_validate_trade` -> `tg_propose_trade` si Tier 2/3 -> `hl_place_order_with_sl`).

## Tools

| Tool | Role |
|------|------|
| `tv_generate_strategy({description, market, timeframe, style})` | Genere un Pine Script v6 complet (pipeline 7 modules). |
| `tv_analyze_backtest({win_rate, profit_factor, max_drawdown, total_trades, sharpe?})` | Diagnostic + verdict deploy/optimize/reject. |
| `tv_select_strategy({market, timeframe, regime})` | Recommande une strategie depuis `STRATEGIES.json`. |
| `tv_create_webhook_config({strategy_id, exchange})` | Construit le message d'alerte JSON TradingView + routing skill. |
| `tv_healthcheck()` | Verifie la bibliotheque + env webhook + table de routing. |

## Regles Pine Script v6 (OBLIGATOIRES)

1. TOUJOURS `//@version=6` en premiere ligne
2. TOUJOURS `process_orders_on_close=true` (anti-biais look-ahead)
3. TOUJOURS les commissions (minimum 0.1%)
4. TOUJOURS un kill switch (max drawdown circuit breaker)
5. Indicateurs via `ta.*` uniquement (ta.ema, ta.rsi, ta.macd, ta.bb, ta.atr, ta.stoch, ta.crossover, ta.crossunder)
6. TOUS les parametres exposes via `input.*`
7. `var` pour les variables persistantes ; pas de `request.security()` en boucle
8. Pas de repainting ; entrees sur close confirmee

## Structure pipeline (7 modules)

`MODULE 1 INPUTS` → `MODULE 2 INDICATEURS` → `MODULE 3 SIGNAL` → `MODULE 4 RISK (SL/TP ATR)` → `MODULE 5 CIRCUIT BREAKER` → `MODULE 6 EXECUTION` → `MODULE 7 WEBHOOK PAYLOAD`. Seul le MODULE 3 (signal) change d'une strategie a l'autre.

## Metriques minimales pour deploiement live

| Metrique | Minimum | Ideal |
|---|---|---|
| Win Rate | 55% | 65%+ |
| Profit Factor | 1.5 | 2.0+ |
| Max Drawdown | < 25% | < 15% |
| Trades | 50+ | 100+ |
| Sharpe | > 1.0 | > 1.5 |

**Red flags over-fitting** : WR > 85%, PF > 10, perfs tres differentes sur actifs similaires, backtest sur actif monotone. Walk-forward test (train 60% / test 40%) obligatoire avant live.

## Bibliotheque de strategies

10 strategies canoniques dans `STRATEGIES.json` (ex : BBRSI 75% WR, DMI Toolbox 64% WR PF 3.34, Weighted Multi-Signal). `tv_select_strategy` les filtre par asset class / timeframe / regime.

## Routing exchange

Seul **HYPERLIQUID** est implemente (route vers le skill `hyperliquid`). BINANCE/BYBIT/ASTER/NASDAQ/NYSE sont des stubs documentes : le webhook listener les logge et les ignore.

## Pipeline signal → execution

```
Alerte TradingView (JSON) → POST /webhook/tradingview (FastAPI, valide WEBHOOK_SECRET)
  → ecrit TV_SIGNALS_DIR/<ts>-<ticker>.json
  → agent hyperliquid lit signals/ au heartbeat (15 min)
  → workflow pre-trade 9 etapes → hl_place_order_with_sl → log → archive signals/processed/
```

## Variables d'environnement

| Variable | Defaut | Role |
|---|---|---|
| `WEBHOOK_SECRET` | — | Auth TradingView ↔ listener (champ `key`) |
| `TV_WEBHOOK_PORT` | 8088 | Port d'ecoute FastAPI |
| `TV_SIGNALS_DIR` | /signals | Dossier inbox partage webhook ↔ agent |
