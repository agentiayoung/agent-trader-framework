# MCP TradingView Screener — Tools pour agent-trader

Serveur : `tradingview-screener` (.mcp.json) → `uv tool run --from git+…/atilaahmettaner/tradingview-mcp tradingview-mcp`
Repo : https://github.com/atilaahmettaner/tradingview-mcp (v0.7.1)
**Pas besoin de TradingView Desktop** — fonctionne en arrière-plan (API screener).
Noms de tools **vérifiés** sur le code cloné.

> Note : l'exchange par défaut du serveur est **KUCOIN** (le passer explicitement, ex `BINANCE`).

## Tools disponibles

### Screening marché
- `top_gainers(exchange, timeframe, limit)` → top gainers crypto/stocks
- `top_losers(exchange, timeframe, limit)` → plus grosses baisses
- `bollinger_scan(exchange, timeframe, bbw_threshold, limit)` → actifs en squeeze BB (BBW faible)
- `rating_filter(exchange, timeframe, rating, limit)` → filtre par signal BB (-3 à +3)
- `smart_volume_scanner(...)` / `volume_breakout_scanner(...)` → scans volume
- `consecutive_candles_scan(exchange, timeframe, count, direction)` → patterns de bougies
- `advanced_candle_pattern(...)` → patterns multi-timeframe

### Analyse technique individuelle
- `coin_analysis(symbol, exchange, timeframe)` → analyse complète : BB, RSI, MACD, SMA20, EMA50, EMA200, ADX, Stochastic, Volume
- `volume_confirmation_analysis(symbol, exchange, timeframe)` → confirmation par volume
- `multi_timeframe_analysis(symbol, exchange)` → vue multi-TF
- `multi_agent_analysis(symbol, exchange, timeframe)` → synthèse multi-signaux
- `combined_analysis(symbol, exchange, timeframe)` → technique + contexte

### Backtest & sentiment (bonus v0.7.1)
- `backtest_strategy(...)` / `compare_strategies(...)` / `walk_forward_backtest_strategy(...)`
- `market_sentiment(symbol, category, limit)` / `financial_news(...)`
- `yahoo_price(symbol)` / `market_snapshot()` / `bitcoin_market_pulse()`
- `stock_extended_hours(symbol)` / `stock_options_chain(...)` / `stock_options_unusual_activity(...)`

## Exchanges supportés
Crypto : BINANCE, BYBIT, KUCOIN, OKX, COINBASE, GATEIO, HUOBI, BITFINEX, BITGET, MEXC…
Stocks : NASDAQ, NYSE (+ ASX, BIST/EGX selon coinlist)

## Timeframes : 5m, 15m, 1h, 4h, 1D, 1W, 1M

## Système de rating BB (Bollinger Band)
`+3` = Strong Buy | `+2` = Buy | `+1` = Weak Buy | `0` = Neutral | `-1` = Weak Sell | `-2` = Sell | `-3` = Strong Sell

## Cas d'usage pour agent-trader

### Filtrer les opportunités avant d'ouvrir TradingView
« `top_gainers` sur BINANCE 1h → filtrer ceux avec RSI < 60 (pas encore overbought) »

### Scanner les setups BB squeeze avant breakout
« `bollinger_scan` BYBIT 4h bbw_threshold 0.03 → coins en accumulation »

### Confirmer une stratégie avant d'entrer
« `coin_analysis` BTCUSDT BINANCE 4h → vérifier EMA50 > EMA200 + RSI entre 50-65 »

### Surveillance horaire (complément du heartbeat hyperliquid)
« Chaque heure : `top_gainers` + `coin_analysis` sur BTC/ETH/SOL » — le screener identifie le setup,
puis l'agent hyperliquid applique le workflow pré-trade (rm_validate + SL) avant tout ordre.

> Le screener **n'exécute aucun ordre** : il fournit des données. Toute exécution passe par le
> skill hyperliquid (cf. AGENTS.md, workflow pré-trade).
