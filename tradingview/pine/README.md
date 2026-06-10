# pine/ — Références communautaires & templates

Stratégies Pine v5/v6 de la communauté qui **fonctionnent mieux** que nos premières générations.
Elles servent de **modèles de référence** pour toute création Pine future dans ce projet.

> ⚠️ Ces fichiers sont des **références** (pas le standard projet) : certains utilisent `request.security`,
> n'ont pas de kill switch ni de header commission complet. On s'inspire de leur **structure et de leurs
> patterns** (voir `PATTERNS.md`), pas de les copier tels quels en production.

## Catalogue

| Fichier | Ver | Style | Patterns remarquables à réutiliser |
|---------|-----|-------|-------------------------------------|
| `algotorma_orb_strategy.pine` | v6 | ORB (Opening Range Breakout) | Reset journalier, machine setup→armed, max trades/jour, daily loss, trailing stop (`trail_points`/`trail_offset`), lines de range, ticks `syminfo.mintick`, close horaire |
| `katana_v5.pine` | v5 | FVG 50% model | **Sizing basé sur le risque** (+ compounding), filtres activables (trend EMA200, RSI, session+tz, ATR displacement, min-stop), modes TP (1R/1.5R/2R), expiry de setup, dashboard, lines entry/stop/tp |
| `quanloki_qqe.pine` | v6 | QQE (RSI lissé) | Header propre (commission/slippage), bandes QQE, **dashboard table** (winrate, points, win/loss), `alertcondition`, labels avec prix, `strategy.closedtrades.profit()` |
| `range_breakout.pine` | v6 | Range horaire | `input.session` + timezone, **filtre jour de semaine**, **boxes** de range + zones SL/TP, `barstate.isconfirmed`, reset journalier, `tradedToday` |

## Fichiers de travail

- **`PATTERNS.md`** — patterns community-grade extraits + checklist « rendu communauté » + tableau ❌→✅.
- **`TEMPLATE_COMMUNITY.pine`** — template gold-standard prêt à copier (compile 0 err/0 warn). Combine le standard projet (header, kill switch, webhook, garde-fou) avec les patterns communautaires (filtres activables, sizing risque, session, reset journalier, gestion trade, trailing, dashboard, alertcondition).

## Archétype → fichier de référence

| Archétype | Référence locale | Style | Prompt catalogue |
|-----------|-----------------|-------|-----------------|
| Trend Following [T] | `quanloki_qqe.pine` | QQE flip, dashboard, alertcondition | `PROMPTS_CATALOG.md §A1` |
| Breakout [BO] | `algotorma_orb_strategy.pine`, `range_breakout.pine` | ORB, trailing stop, session range | `PROMPTS_CATALOG.md §A2` |
| Mean Reversion [MR] | `katana_v5.pine` | FVG 50%, sizing risque, filtres activables | `PROMPTS_CATALOG.md §A3` |
| Swing HWR [SW] | `katana_v5.pine` | 3 confluences, modes TP, dashboard | `PROMPTS_CATALOG.md §A4` |

## Créer une nouvelle stratégie (workflow)

1. **Choisir l'archétype** (T / BO / MR / SW) et consulter la table ci-dessus pour le fichier de référence.
   **Raccourci `pine-architect`** : utiliser le prompt correspondant dans `PROMPTS_CATALOG.md §A`
   pour générer directement le bloc SIGNAUX sans partir de zéro.
2. Copier `TEMPLATE_COMMUNITY.pine` → `../strategies/NN_nom.pine`. Remplacer **uniquement** le bloc `// ════ SIGNAUX ════` par la logique générée (le reste — filtres, sizing, gestion, visuels — ne bouge pas).
3. S'inspirer du fichier de référence le plus proche du style visé (table ci-dessus).
4. Valider la checklist de `PATTERNS.md` (10 points « rendu communauté »).
5. Compiler : `node ../../tools/tradingview-mcp/src/cli/index.js pine check --file ../strategies/NN_nom.pine` → viser 0 err / 0 warn. Ou `python ../scripts/validate_pine.py` → 10/10.
6. Backtester (procédure : `../INTEGRATION_REPORT.md` §6) → PF > 1.5, DD < 15 %, ≥ 200 trades.
   **Si métriques KO** : utiliser `pine-optimizer` avec le prompt `PROMPTS_CATALOG.md §C1`
   (fournir le fichier complet + métriques → diagnostic + 3 variantes ciblées).

## Voir aussi

- [`../PINE_RULES.md`](../PINE_RULES.md) — standard projet (header, syntaxe v6, garde-fous)
- [`../strategies/`](../strategies/) — bibliothèque générée (à régénérer sur la base du template)
- [`../INTEGRATION_REPORT.md`](../INTEGRATION_REPORT.md) — backtests & procédure de test
