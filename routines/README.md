# 🤖 Routines de trading autonomes

Sessions Claude Code planifiées qui analysent le marché et, si un setup est cohérent,
créent le trade **dans le journal ET sur Bybit (demo)** — exactement comme une conversation
manuelle. Tout est documenté pour **backtest + amélioration continue**.

## Architecture

```
Windows Task Scheduler  (2-3 plages horaires/jour, haute volatilité)
        │
        ▼
routines/run-routine.ps1   →   claude -p  (headless, LOCAL)
        │                          │ accès : repo + config/.env (clés Bybit) + skills node + MCP screener
        ▼                          ▼
routines/trade-routine.md  ──  SOP : lire journal+lessons → data (screener) → confronter/vérifier
                                      → gate de conviction → SI cohérent : bracket Bybit + journal.log
                                                              SINON : journal.log no_trade
        ▼
trade-journal/  (JOURNAL.md + LESSONS.md + trades.jsonl)  →  données d'amélioration
```

**Pourquoi Task Scheduler local (et pas un agent cloud)** : la routine doit lire `config/.env`
(clés Bybit) et lancer les skills node + le MCP screener — tout est local. Un agent distant
n'aurait pas les clés → ne pourrait pas exécuter.

## Plages horaires (haute volatilité)
Configurables dans `register-tasks.ps1`. Actuel (heure de ) — **4 sessions/jour** :
- **02:07** — daily close (00:00 UTC) + funding
- **06:37** — séance Asie
- **14:03** — pré-US / Londres
- **19:03** — séance US (vol crypto maximale)
> Minutes décalées volontairement (évite les pics d'API ronds).

## Installation
```powershell
# 1. Autoriser les commandes sans prompt (déjà dans .claude/settings.local.json)
# 2. Enregistrer les tâches planifiées :
powershell -ExecutionPolicy Bypass -File routines\register-tasks.ps1
# 3. Test manuel immédiat :
powershell -File routines\run-routine.ps1
# Désactiver : routines\register-tasks.ps1 -Remove
```

## Garde-fous (dans `trade-routine.md`)
DEMO only · SL obligatoire · max 2 trades/jour · max 4 pending · taille fixe · pas de doublon · R:R ≥ 2 · entrée limit à un niveau réel.

## 📊 Backtest & amélioration continue — 2 couches

**Couche 1 — Forward-test documenté (primaire).** Chaque run logge une décision (trade OU no-trade
+ rationale + outcome). Après N jours :
```bash
node trade-journal/journal.js sync     # clôture auto les trades remplis
node trade-journal/journal.js stats    # win rate, R moyen, PnL par stratégie
```
→ Analyser quelles conditions/strategies gagnent → enrichir `LESSONS.md` → la routine s'améliore
(elle lit LESSONS.md à chaque run). C'est la boucle d'auto-amélioration.

**Couche 2 — Backtest mécanique des setups codifiés (validation statistique).** Les setups récurrents
(ex. « short le rebond dans confluence Weekly EMA200 + 1H EMA20 quand HTF baissier ») se codifient en
règle et se backtestent sur historique via le moteur Python existant `confluence_engine/backtest/`
(klines Binance, sweep de paramètres). Valide l'edge indépendamment du jugement LLM.

**Couche 3 (avancé, optionnel) — Replay de décisions.** Rejouer la SOP sur des snapshots multi-TF
historiques pour mesurer la qualité de décision. Coûteux/non-déterministe (LLM) → réservé à audit.

## Fichiers
- `trade-routine.md` — la SOP (procédure exécutée par chaque session)
- `run-routine.ps1` — launcher `claude -p` headless
- `register-tasks.ps1` — enregistre/supprime les tâches planifiées
- `logs/` — sortie de chaque run (audit)
