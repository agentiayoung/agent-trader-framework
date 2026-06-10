# 🧪 Prompt de test d'intégration — routines + TradingView + indicateurs

> Copie-colle le bloc ci-dessous dans une **nouvelle conversation** (projet `agent-trader` ouvert,
> TradingView Desktop lancé en debug avec le layout d'indicateurs visible). Objectif : vérifier que
> les routines **prennent bien** l'analyse TradingView Desktop, les indicateurs, et TOUTES les
> intégrations ajoutées (zones Zeiierman, /14, gating, garde-fou date, heures, fix reconcile).
> Le test produit un tableau PASS/FAIL puis exécute une routine réelle.

---

```
Contexte : projet agent-trader (projets/agent-trader). Trading crypto autonome, paper trading.
Bybit DEMO (BYBIT_DEMO=1). Mission : TESTER que les routines intègrent bien l'analyse TradingView
Desktop + les indicateurs + toutes les nouvelles intégrations. Ne casse jamais la config. DEMO only.

LIS D'ABORD : trade-journal/LESSONS.md + trade-journal/JOURNAL.md + tradingview/STRATEGY_MATRIX.md
+ tradingview/DESKTOP_INDICATORS.md + tradingview/ZEIIERMAN_ZONES.md + tradingview/TV_CONNECTION_AUDIT.md
+ routines/trade-routine.md.

═══════════════════════════════════════════════════════════════════════════
PARTIE 1 — VÉRIFICATION DES INTÉGRATIONS (prouve chaque brique avec des données réelles)
Pour CHAQUE point : exécute, montre la sortie réelle, et marque PASS/FAIL.
═══════════════════════════════════════════════════════════════════════════
T1. DATE/HEURE : `node trade-journal/journal.js today` → doit renvoyer date+time+datetime+tz cohérents
    avec l'horloge réelle. Compare avec `date` (bash). PASS si identiques.
T2. GARDE-FOU DATE : tente `node trade-journal/journal.js log '{"strategy":"SELFTEST","symbol":"ZZZ",
    "status":"no_trade","ts_open":"2030-01-01","id":"selftest-zzz-20300101","side":"-","size":0,
    "entry":0,"stop_loss":0,"rationale":"test garde-fou"}'` → DOIT afficher "DATE CORRIGEE" sur stderr
    et logger avec la date système (PAS 2030). PUIS supprime l'entrée SELFTEST de trades.jsonl
    (node, filtre strategy!=='SELFTEST') et `journal.js report`. PASS si corrigé + nettoyé.
T3. PRÉAMBULE : `reconcile` (doit être aligned, NE PAS annuler un pending au repos) + `risk`
    (halt false attendu) + `exposure`. Vérifie les ordres Bybit réels (skills/bybit). PASS si
    le journal reflète la vérité Bybit (positions + ORDRES ouverts + closed PnL).
T4. SCREENER 14 paires : `node trade-journal/scan.js` → renvoie scanned:14 + opportunités. PASS si 14.
T5. CDP TradingView : `node scripts/tv-preflight.js` (exit 0 attendu) PUIS tool MCP tv_health_check
    → success:true. Si down : tv_launch {kill_existing:true} puis re-check. PASS si CDP up.
T6. ZONES ZEIIERMAN : choisis le TOP candidat du scan. chart_set_symbol BYBIT:<TOP>USDT.P +
    chart_set_timeframe "240" → chart_get_state (confirme symbole + indicateurs visibles) →
    data_get_pine_boxes {study_filter:"Zeiierman", verbose:true}. PASS si zones {high,low} renvoyées ;
    CLASSE-les support (high<prix) / résistance (low>prix) et donne la zone la plus proche dans chaque sens.
T7. AUTO FIB : data_get_pine_lines → doit contenir "Auto Fib Retracement/Extension" avec niveaux
    (0/0.236/0.382/0.5/0.618/1...). PASS si niveaux Fib présents. Note si un Fib 0.5/0.618 coïncide
    avec un bord de zone Zeiierman (confluence).
T8. INDICATEURS DESKTOP : data_get_study_values → doit renvoyer StochRSI (K,D), AI Supertrend, TEMA,
    AI Signal, RSI. PASS si ≥4 présents. Parse le format FR ("64 029,5" → 64029.5). Donne prix vs
    AI Supertrend (au-dessus/dessous) et StochRSI extrême (>80 / <20).
T9. RÉGIME : data_get_pine_labels {study_filter:"Trend Channels", max_labels:6} → doit contenir un
    label de régime ("STRONG BULL/BEAR" ou M↑/M↓/H/L). PASS si régime lisible.
T10. MULTI-PAIRES : chart_set_symbol vers une 2e paire (ex. BYBIT:ETHUSDT.P) → re-lis
    data_get_pine_boxes {Zeiierman} → PASS si les zones changent (recalcul par symbole). Remets le TOP.
T11. SCORING /14 + GATING : assemble screener (EMA/MACD/ADX du coin_analysis) + Desktop (zones,
    StochRSI, AI Supertrend, régime, Fib) → calcule le score /14 du TOP candidat et applique le
    GATING DUR (régime STRONG opposé OU flip supertrend contraire = no-trade). Montre le détail du score.
T12. SIZING : `node trade-journal/journal.js size '{"entry":<bord de zone>,"stop_loss":<au-delà>,
    "tier":"B"}'` → renvoie une taille cohérente (risque 2.5%). PASS si calcul correct.

→ Affiche un TABLEAU récap T1..T12 avec PASS/FAIL + 1 ligne de preuve chacun.

═══════════════════════════════════════════════════════════════════════════
PARTIE 2 — ROUTINE RÉELLE (utilise tout ce qui précède)
═══════════════════════════════════════════════════════════════════════════
Exécute la décision selon routines/trade-routine.md + STRATEGY_MATRIX.md (/14) :
- entrée SEULEMENT si le prix touche/approche une zone Zeiierman ALIGNÉE avec la confluence ET que
  le gating passe. Limit au bord de zone, SL au-delà, TP = zone suivante. Sinon no_trade documenté.
- Si trade : bybit_place_limit_bracket + journal.js log (rationale incluant les zones lues +
  zones=zeiierman|screener_fallback + le score /14 + l'état du gating).
- Termine par journal.js report + dashboard.

Garde-fous NON négociables : DEMO only, SL obligatoire, R:R≥2, max 3 trades/jour, max 4 positions,
circuit breaker (halt si perte jour>5% ou drawdown>10%), cap corrélation (max 3 même sens).
Positions à vérifier d'abord via reconcile : BTC short 0.006 @63200, AVAX short 5200 @6.91 (pending).

═══════════════════════════════════════════════════════════════════════════
PARTIE 3 — VERDICT
═══════════════════════════════════════════════════════════════════════════
Conclus par : "INTÉGRATIONS : X/12 PASS". Liste tout FAIL avec la cause probable + le fix suggéré.
Confirme explicitement : (a) les zones Zeiierman ont bien été lues sur le Desktop (pas le fallback),
(b) les indicateurs Desktop ont nourri le scoring /14, (c) le gating a été appliqué,
(d) la date/heure venait de l'horloge système.
```
