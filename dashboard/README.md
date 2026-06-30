# Trading desk (web, local, read-only) — 2 agents

Tableau de bord web **LECTURE SEULE** des 2 agents (agent-trader 4H + scalp-trader),
demo Bybit. Aucune exécution d'ordre, aucune écriture, aucun secret exposé.
`127.0.0.1` uniquement, **GET only** (POST/PUT → 405).

## Lancer
```bash
cd projets/agent-trader
node dashboard/server.js          # puis ouvrir http://127.0.0.1:8787
# port :   DASHBOARD_PORT=9000 node dashboard/server.js
# cache :  DASHBOARD_CACHE_MS=5000 (TTL mémoire des réponses API, défaut 5 s)
```

### Toujours-on (recommandé)
Tâche planifiée `AgentTrader-Dashboard` (démarre au logon, keep-alive, survit à la session) :
```powershell
# installer (EN ADMIN) :
powershell -ExecutionPolicy Bypass -File routines\register-dashboard-task.ps1
# retirer :
powershell -ExecutionPolicy Bypass -File routines\register-dashboard-task.ps1 -Remove
```
Daemon `dashboard/dashboard-daemon.ps1` (relance node < 5 s si arrêt) · logs `dashboard/dashboard.log`.
Alternative manuelle : double-clic `dashboard/START-DASHBOARD.bat`.

## Onglets (SPA vanilla, poll adaptatif 15 s / 60 s)
- **Overview** — equity totale, PnL/WR/R agrégés, santé des 2 agents (breaker, dernière
  routine, fraîcheur heartbeat), positions actives consolidées.
- **Agents** — courbes equity (SVG) + table par agent (equity/jour/DD/breaker/WR/R/PnL).
- **Marché** — régime BTC/ADX, posture, dispersion/corrélation, Fear&Greed, bottom-watch.
- **GEX / Options** — BTC + ETH : gamma régime, barre de niveaux (put/flip/spot/max-pain/call),
  net GEX, skew 25d, ATM IV, put/call. Source Deribit (`options-context.js`).
- **Grille** — 30 actifs, table triable + heatmap : px, %24h, RSI d/h, StochRSI, MACD, ADX,
  trend, régime, cycle%, OBV (= signal de volume ; pas de volume brut exposé par le scan).
- **Edges** — perf par agent : n/WR/expectancy/PnL net, par côté et par stratégie (top 8).

Chaque section porte un **badge de fraîcheur** (âge de la source) → une routine qui n'a pas
tourné se voit immédiatement. Dégradation gracieuse : une source manquante affiche `stale`,
jamais une page vide.

## API (JSON, read-only)
| Route | Source | Producteur |
|---|---|---|
| `/api/portfolio` | journaux + equity 2 agents | `trade-journal/portfolio.js` |
| `/api/market` | `scan-latest.market` | `api/market.js` |
| `/api/options` | `scan-latest.market.options` | `api/options.js` |
| `/api/grid` | `scan-latest.all[]` | `api/grid.js` |
| `/api/routines` | `routines/heartbeat.json` ×2 | `api/routines.js` |
| `/api/edges` | `trades.jsonl` ×2 | `api/edges.js` |
| `/api/health` | mtime des sources | `api/freshness.js` |

## Architecture
- `server.js` — http natif (zéro dépendance), dispatch `API{}` + cache TTL mémoire.
- `index.html` — SPA autonome (vanilla JS + renderers SVG maison, offline).
- `api/*.js` — agrégateurs **purs**, testés offline (`tests/test-dashboard-api.js` +
  `tests/test-dashboard-grid.js`). Aucune logique de trading dupliquée.

Demo-only. Réversible (le dashboard ne touche jamais au moteur de trading).
