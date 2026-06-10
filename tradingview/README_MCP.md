# TradingView MCP — Guide de démarrage rapide (agent-trader)

Deux serveurs MCP TradingView sont configurés dans `.mcp.json` (local au projet) :

| MCP | Rôle | Prérequis |
|-----|------|-----------|
| `tradingview-desktop` | Contrôle TradingView Desktop (CDP, ≈68 tools) : Pine v6, charts, alertes, replay | TradingView Desktop lancé en mode debug (port 9222) |
| `tradingview-screener` | Screening marché temps réel (top gainers, BB scan, coin_analysis…) | Aucun — `uv` télécharge/lance à la volée |

> Tools détaillés : `MCP_DESKTOP_TOOLS.md` et `MCP_SCREENER_TOOLS.md`.

## 0. Installation (première fois / nouveau clone)
`tools/tradingview-mcp/` est gitignoré (dépendance externe). Pour (re)l'installer :
```bash
bash tools/install-mcp.sh     # clone tradingview-mcp + npm install (+ vérifie uv)
```

## 1. Activer les MCP dans Claude Code
Les MCP locaux sont chargés depuis `.mcp.json` à la racine du projet. Ouvrir Claude Code dans
`agent-trader/`, approuver les 2 serveurs au prompt, puis vérifier :
```
/mcp        → doit lister tradingview-desktop et tradingview-screener
```
Le screener fonctionne immédiatement. Le desktop nécessite l'étape 2.

## 2. Lancer TradingView Desktop en mode debug (pour tradingview-desktop)
- **Windows** : `powershell -ExecutionPolicy Bypass -File scripts/launch-tradingview-debug.ps1`
- **macOS/Linux** : `bash scripts/launch-tradingview-debug.sh`
- **ou** demander à Claude : « Use tv_launch » (auto-détecte l'OS et le chemin)

Vérifier : « Use tv_health_check » → attendu `cdp_connected: true`.

### Validation en une commande (desktop + screener)
Depuis la racine `agent-trader/` :
```powershell
powershell -ExecutionPolicy Bypass -File scripts/test-tradingview-mcp-connection.ps1
```
Sortie attendue :
- `[Desktop MCP] status: CONNECTED` si TradingView Desktop est disponible en CDP.
- `[Screener MCP] status: READY` si `uv` + tradingview-screener sont utilisables.

## 3. Les 5 workflows MCP les plus utiles

1. **Scanner le marché (screener)**
   « Use top_gainers on BINANCE 1h limit 5 » puis « coin_analysis BTCUSDT BINANCE 4h »
2. **Générer + injecter une stratégie**
   Skill `tv_generate_strategy` → `pine_set_source` → `pine_smart_compile` → `pine_get_errors`
3. **Lire les résultats de backtest**
   `data_get_strategy_results` → skill `tv_analyze_backtest` (verdict deploy/optimize/reject)
4. **Configurer l'alerte webhook**
   Skill `tv_create_webhook_config` → `alert_create` (message JSON vers le listener FastAPI)
5. **Replay / practice**
   `replay_start` (date) → `replay_step` → `replay_trade`

## 4. Pipeline complet (du screener au trade live)
```
[screener] top_gainers / coin_analysis        ← repérage opportunité (background)
        ↓
[desktop]  pine_set_source → pine_smart_compile → data_get_strategy_results
        ↓                                          ↓
        ↓                                    [skill] tv_analyze_backtest (verdict)
        ↓ (validé + walk-forward + testnet)
[desktop]  alert_create (message JSON tv_create_webhook_config)
        ↓
POST /webhook/tradingview (FastAPI, valide WEBHOOK_SECRET) → signals/<ts>-<ticker>.json
        ↓
[agent hyperliquid] heartbeat 15 min → rm_validate_trade → hl_place_order_with_sl → log
```

## 5. Résolution des problèmes courants

| Symptôme | Cause | Solution |
|----------|-------|----------|
| `cdp_connected: false` | TradingView pas lancé en debug | Relancer via le script ou `tv_launch` |
| `ECONNREFUSED` (port 9222) | TradingView fermé / port bloqué | Vérifier que TradingView tourne ; firewall |
| Port 9222 déjà occupé | Instance debug déjà active | Normal — `tv_health_check` confirme |
| `tradingview-screener` ne démarre pas | `uv` absent / pas de réseau | `uv --version` ; 1er lancement télécharge ~52 paquets |
| MCP absent de `/mcp` | `.mcp.json` non approuvé | Redémarrer Claude Code dans le dossier, approuver |
| TradingView Desktop non installé | — | https://www.tradingview.com/desktop/ (sinon screener seul suffit pour le scan) |

## Sécurité / périmètre
- Les 2 MCP sont **non officiels** (bannière affichée au démarrage). Usage conforme aux CGU TradingView.
- Aucun des MCP n'exécute d'ordre sur un exchange : l'exécution réelle reste dans le skill hyperliquid.
- `.mcp.json` est **local** au projet et ne touche pas la config MCP globale (`~/.claude/`).
