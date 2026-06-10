# MCP TradingView Desktop — Tools disponibles pour agent-trader

Serveur : `tradingview-desktop` (.mcp.json) → `tools/tradingview-mcp/src/server.js`
Repo : https://github.com/tradesdontlie/tradingview-mcp (CDP, port 9222)
Noms de tools ci-dessous **vérifiés** sur le code cloné (≈68 tools).

## Démarrage
1. Lancer TradingView Desktop en mode debug :
   - Windows : `powershell -ExecutionPolicy Bypass -File scripts/launch-tradingview-debug.ps1`
   - macOS/Linux : `bash scripts/launch-tradingview-debug.sh`
   - ou via MCP : demander à Claude « Use tv_launch » (auto-détection de l'OS)
2. Vérifier la connexion : « Use tv_health_check » → attendu `cdp_connected: true`

## Tools les plus utiles pour agent-trader

### Connexion & diagnostic
- `tv_health_check` → état de la connexion CDP (cdp_connected, version)
- `tv_launch` → lance TradingView Desktop en mode debug (auto-détecte Mac/Win/Linux)
- `tv_discover` → découvre les onglets/charts ouverts
- `tv_ui_state` → état de l'UI courante

### Lecture de chart (lecture seule, safe)
- `chart_get_state` → symbole actuel, timeframe, indicateurs chargés
- `quote_get` → prix actuel, OHLC, volume
- `chart_get_visible_range` / `chart_set_visible_range` → fenêtre temporelle visible
- `data_get_study_values` → valeurs RSI, MACD, BB, EMA en temps réel
- `data_get_ohlcv` → bougies OHLCV (utiliser des fenêtres courtes pour la compacité)
- `data_get_indicator` → valeurs d'un indicateur précis
- `data_get_pine_lines` / `data_get_pine_labels` / `data_get_pine_tables` / `data_get_pine_boxes` → objets Pine (S/R, annotations, tableaux)
- `data_get_strategy_results` → métriques du Strategy Tester (net profit, WR, PF, max DD)
- `data_get_trades` / `data_get_equity` → liste des trades + courbe d'equity du backtest

### Développement Pine Script v6
- `pine_new` / `pine_open` / `pine_list_scripts` → gérer les scripts
- `pine_set_source` → injecter du code Pine Script v6
- `pine_get_source` → relire le code courant
- `pine_compile` / `pine_smart_compile` → compiler (smart = avec diagnostics)
- `pine_get_errors` → erreurs de compilation
- `pine_check` → validation rapide
- `pine_get_console` → log.info() du script
- `pine_save` → sauvegarder dans le cloud TradingView
- `pine_analyze` → analyse statique offline (sans chart)

### Contrôle du chart
- `chart_set_symbol` → changer de symbole (ex : BTCUSD, AAPL)
- `chart_set_timeframe` → changer le timeframe (1, 5, 15, 60, D…)
- `chart_set_type` → type de chart (candles, line…)
- `chart_manage_indicator` / `indicator_set_inputs` / `indicator_toggle_visibility` → gérer les indicateurs
- `alert_create` / `alert_list` / `alert_delete` → gérer les alertes (dont webhook)

### Replay & Practice
- `replay_start` → mode replay à une date donnée
- `replay_step` / `replay_autoplay` → avancer (barre par barre / auto)
- `replay_trade` → simuler des entrées/sorties en replay
- `replay_status` / `replay_stop` → état / retour au temps réel

### Screenshots, panes, batch & UI
- `capture_screenshot` → capture du chart pour analyse visuelle
- `pane_set_layout` / `pane_list` / `pane_focus` / `pane_set_symbol` → multi-panes
- `layout_list` / `layout_switch` → layouts sauvegardés
- `tab_new` / `tab_list` / `tab_switch` / `tab_close` → onglets
- `watchlist_add` / `watchlist_get` → watchlist
- `batch_run` → exécuter une action sur plusieurs symboles/timeframes
- `ui_*` (click, type_text, evaluate, find_element, open_panel, keyboard…) → contrôle bas niveau (à n'utiliser que si un tool dédié n'existe pas)

## Workflow typique — générer et tester une stratégie

1. `chart_set_symbol("BTCUSDT")` + `chart_set_timeframe("60")`
2. Générer le Pine v6 avec le skill : `tv_generate_strategy` (skill tradingview-strategy)
3. `pine_set_source(<code>)` → `pine_smart_compile()` → `pine_get_errors()` (corriger si besoin)
4. `data_get_strategy_results()` → lire WR / PF / max DD du Strategy Tester
5. Diagnostiquer avec le skill : `tv_analyze_backtest({...})` → verdict deploy/optimize/reject
6. Si validé : `tv_create_webhook_config()` (skill) puis `alert_create()` avec le message JSON
   → l'alerte POST vers le webhook FastAPI → signals/ → agent hyperliquid

> ⚠️ Génération/backtest = phase manuelle (hors heartbeat). L'exécution live reste gérée par
> l'agent hyperliquid via le workflow pré-trade (rm_validate + SL obligatoire). Walk-forward +
> testnet avant tout déploiement réel.
