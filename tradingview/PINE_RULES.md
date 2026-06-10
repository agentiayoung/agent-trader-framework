# PINE_RULES.md — Standard Pine Script v6 (agent-trader)

> Référence unique pour écrire, valider et déployer une stratégie Pine v6
> dans la bibliothèque `tradingview/strategies/`.
> Cible : crypto intraday range/breakout (BTCUSDT.P, ETHUSDT.P, SOLUSDT.P, HBARUSDT.P) en 5m / 15m / 1H.

> ## 🎯 Point de départ de toute création = `pine/`
> **Toujours partir de `pine/TEMPLATE_COMMUNITY.pine`** et s'inspirer des références dans `pine/`
> (voir `pine/PATTERNS.md`). Ces stratégies communautaires surpassent nos premières générations grâce à :
> filtres activables, sizing basé sur le risque, session/timezone, reset journalier, gestion de trade
> (max trades/jour, daily loss, trailing), dashboard et `alertcondition`. La checklist 10 points ci-dessous
> reste le **minimum projet** ; la checklist « rendu communauté » de `pine/PATTERNS.md` est le **niveau cible**.

---

## 1. Checklist de validation avant déploiement (12 points)

Avant de déployer une stratégie en live (webhook), elle DOIT cocher les 12 cases :

| # | Point | Critère |
|---|-------|---------|
| 1 | **Syntaxe v6** | `//@version=6` en 1re ligne, `ta.*` / `input.*` partout, pas de `security()` |
| 2 | **Trades** | ≥ 30 trades/mois (BTC 15m) ET ≥ 200 trades sur la période complète |
| 3 | **Profit Factor** | PF > 1.5 sur le Strategy Tester |
| 4 | **Win Rate cohérent** | WR > 40% (trend) ou WR > 55% (mean reversion) — jamais < 35% |
| 5 | **Max Drawdown** | Max DD < 15 % |
| 6 | **Kill switch** | `input.bool` "🔴 Kill Switch" → `strategy.close_all()` |
| 7 | **Commission** | `commission_type = strategy.commission.percent`, `commission_value = 0.1` (crypto perp) |
| 8 | **Slippage** | `slippage = 2` dans le header |
| 9 | **SL / TP** | SL et TP définis sur CHAQUE entrée (`strategy.exit` stop + limit) |
| 10 | **Exit robuste** | Condition de sortie anticipée avec buffer ATR + ≥ 2 barres consécutives (voir §7) |
| 11 | **Labels** | Labels `▲ Long` / `▼ Short` sur les signaux + plots SL/TP `plot.style_linebr` |
| 12 | **Webhook** | Commentaire `alert_message` JSON présent en bas du fichier |

> ❌ Aucune stratégie ne passe en live si un seul de ces points échoue.
> Garde-fou : si `strategy.closedtrades < 200`, un label orange s'affiche sur le chart → descendre d'un timeframe (1H→15m, 15m→5m).

---

## 2. Antipatterns interdits — ❌ → ✅

```pinescript
// ❌ Fonctions techniques sans préfixe (formes v4)
ma = sma(close, 20)
r  = rsi(close, 14)
a  = atr(14)
// ✅ Toujours le namespace ta.
ma = ta.sma(close, 20)
r  = ta.rsi(close, 14)
a  = ta.atr(14)
```

```pinescript
// ❌ input() générique
len = input(20, "Length")
// ✅ input typé
len = input.int(20, "Length", minval = 1, group = "📈 Entrée")
```

```pinescript
// ❌ var redéclaré dans un bloc conditionnel
if cond
    var float x = na   // INTERDIT : provoque une erreur / comportement imprévisible
// ✅ déclarer var au scope global, assigner dans le bloc
var float x = na
if cond
    x := close
```

```pinescript
// ❌ security() dans une stratégie (repainting / interdit projet)
htf = request.security(syminfo.tickerid, "D", close)
// ✅ travailler sur le timeframe du chart uniquement
htf = ta.sma(close, 50)
```

```pinescript
// ❌ Entrée sans stop ni cible
strategy.entry("Long", strategy.long)
// ✅ Toujours définir la sortie AVANT/AVEC l'entrée
strategy.entry("Long", strategy.long)
strategy.exit("Exit Long", from_entry = "Long", stop = sl_long, limit = tp_long)
```

```pinescript
// ❌ Header minimal (pas de commission/slippage/capital)
strategy("Ma strat", overlay = true)
// ✅ Header standard complet (voir template §3)
```

---

## 3. Template stratégie vierge (conforme v6)

```pinescript
//@version=6
strategy(
    title                   = "NN Nom de la stratégie",
    overlay                 = true,
    process_orders_on_close = true,
    calc_on_every_tick      = false,
    default_qty_type        = strategy.percent_of_equity,
    default_qty_value       = 1,
    commission_type         = strategy.commission.percent,
    commission_value        = 0.05,
    slippage                = 2,
    initial_capital         = 100000
)

// ----- 📈 Entrée -----
fast = input.int(9,  "Fast", minval = 1, group = "📈 Entrée")
slow = input.int(21, "Slow", minval = 1, group = "📈 Entrée")

// ----- 🛡️ Risque -----
atr_len  = input.int(14, "ATR Length", group = "🛡️ Risque")
atr_mult = input.float(1.5, "SL ATR Mult", step = 0.1, group = "🛡️ Risque")
tp_mult  = input.float(3.0, "TP ATR Mult", step = 0.1, group = "🛡️ Risque")
kill     = input.bool(false, "🔴 Kill Switch", group = "🛡️ Risque")

// ----- 👁️ Affichage -----
from_date = input.time(timestamp("2025-01-01"), "Backtest From", group = "👁️ Affichage")
in_window = time >= from_date

// ----- Calculs -----
atr_val = ta.atr(atr_len)
sl_long  = close - atr_mult * atr_val
tp_long  = close + tp_mult  * atr_val
sl_short = close + atr_mult * atr_val
tp_short = close - tp_mult  * atr_val

longCond  = in_window and ta.crossover(ta.ema(close, fast), ta.ema(close, slow))
shortCond = in_window and ta.crossunder(ta.ema(close, fast), ta.ema(close, slow))

// ----- Kill switch -----
if kill
    strategy.close_all("Kill Switch")

// ----- Entrées / Sorties -----
if not kill
    if longCond
        strategy.entry("Long", strategy.long)
        strategy.exit("Exit Long", from_entry = "Long", stop = sl_long, limit = tp_long)
    if shortCond
        strategy.entry("Short", strategy.short)
        strategy.exit("Exit Short", from_entry = "Short", stop = sl_short, limit = tp_short)

// ----- Visuels -----
if longCond
    label.new(bar_index, low, "▲ Long", style = label.style_label_up, color = color.green, textcolor = color.white)
if shortCond
    label.new(bar_index, high, "▼ Short", style = label.style_label_down, color = color.red, textcolor = color.white)

plot(strategy.position_size > 0 ? sl_long  : na, "SL", color = color.red,   style = plot.style_linebr, linewidth = 1)
plot(strategy.position_size > 0 ? tp_long  : na, "TP", color = color.green, style = plot.style_linebr, linewidth = 1)
plot(strategy.position_size < 0 ? sl_short : na, "SL", color = color.red,   style = plot.style_linebr, linewidth = 1)
plot(strategy.position_size < 0 ? tp_short : na, "TP", color = color.green, style = plot.style_linebr, linewidth = 1)

// ----- Garde-fou trades -----
if barstate.islast and strategy.closedtrades < 200
    label.new(bar_index, low, "⚠️ " + str.tostring(strategy.closedtrades) + " trades < 200", style = label.style_label_up, color = color.orange, textcolor = color.black, size = size.small)

// ============================================================
// WEBHOOK (alert_message) :
// {"secret":"VOTRE_SECRET","action":"{{strategy.order.action}}","symbol":"{{ticker}}","price":{{close}},"qty_pct":1,"sl":0,"tp":0,"timeframe":"{{interval}}","exchange":"hyperliquid"}
// ============================================================
```

---

## 4. Guide de lecture du Strategy Tester

| Métrique | Définition | Viser | Éviter |
|----------|-----------|-------|--------|
| **Net Profit** | Gain net après commissions | > 0, stable | Profit concentré sur 1-2 trades |
| **Profit Factor** | Gains bruts / pertes brutes | **> 1.5** | < 1.2 (fragile), > 4 (sur-optimisé) |
| **Payoff Ratio** | Gain moyen / perte moyenne | > 1.0 (breakout), peut être < 1 en range si WR haut | < 0.5 |
| **% Profitable** | Taux de trades gagnants | Range : 55-70 % · Breakout : 35-50 % | Incohérent avec le style |
| **Max Drawdown** | Plus grande baisse pic→creux | **< 15 %** | > 25 % |
| **Total Closed Trades** | Échantillon statistique | **≥ 200** | < 100 (non significatif) |
| **Avg # Bars in Trades** | Durée moyenne | Cohérent avec l'intraday | Trades qui traînent des jours |

**Lecture combinée :**
- PF > 1.5 **et** Max DD < 15 % **et** ≥ 200 trades → candidat au déploiement testnet.
- PF élevé mais < 100 trades → **over-fitting probable**, ne pas déployer.
- WR > 80 % avec Payoff < 0.3 → stratégie qui « ramasse les centimes devant le rouleau compresseur », vérifier le pire trade.

---

## 5. Guide migration v5 → v6

| Sujet | v5 | v6 |
|-------|----|----|
| Version | `//@version=5` | `//@version=6` |
| Header | params positionnels tolérés | privilégier les params nommés |
| `na` sur séries | comportement implicite | typage plus strict, initialiser `var float x = na` |
| Booléens | `bool` parfois `na` | les `bool` ne peuvent plus être `na` par défaut → init explicite |
| Histoire/`[]` | OK | OK (inchangé) |
| `strategy.*` | `strategy.entry/exit/close` | identiques |
| Fonctions ta | déjà `ta.*` en v5 | `ta.*` (inchangé vs v5 ; vigilance si copie de code v4) |
| `input` | `input.int()` etc. | identiques |

> La migration la plus fréquente vient de **code v4** copié : remplacer `sma()`→`ta.sma()`, `rsi()`→`ta.rsi()`, `atr()`→`ta.atr()`, `highest()`→`ta.highest()`, `input()`→`input.int/float/bool`, et déplacer toute déclaration `var` hors des blocs conditionnels.

---

## 7. Pathologies post-backtest réel — diagnostics connus

> Issues identifiées sur la stratégie EMA50-200_RSI_ATR_V1 (BTC 1H, WR 28%, PF 0.59).
> À appliquer systématiquement comme checklist avant de soumettre tout Pine au Strategy Tester.

| # | Pathologie | Symptôme | Cause | Correctif |
|---|-----------|---------|-------|-----------|
| P1 | **Exit trop agressive** | ~44% des trades fermés "Invalide" 1-3 barres après l'entrée | `close < ema50` déclenchait sortie sur simple oscillation | Buffer ATR + `exitBarsReq ≥ 2` barres consécutives (voir pattern ci-dessous) |
| P2 | **Entrée sur bougie adverse** | WR < 35% malgré un signal RSI correct | La bougie d'entrée était encore rouge (catching falling knife) | `close > open` obligatoire pour longs, `close < open` pour shorts |
| P3 | **RSI seuil trop permissif** | Entrées en milieu de pullback non terminé | RSI > 40 / < 60 → pullback souvent encore en cours | Seuil 35/65 + `rsiVal > rsiVal[1]` (momentum RSI amorcé) |
| P4 | **Shorts en bull macro** | 40% de shorts dans BTC 40K→107K | `trendDown` seul insuffisant — EMA50 peut croiser brièvement sous EMA200 | Pente EMA50 : `ema50 < ema50[5]` obligatoire pour valider les shorts |
| P5 | **ADX seuil insuffisant + risk trop élevé** | Trades en range + ruine accélérée à WR faible | ADX 20 laisse passer marchés latéraux ; 10% equity × WR 28% | ADX → 25, risk → 8% equity |

### Pattern — Exit robuste (P1)

```pinescript
// Paramètres
exitAtrBuf  = input.float(0.5, "Exit Buffer × ATR", group="🎯 Strategy")
exitBarsReq = input.int(2,     "Exit Bars Consécutifs", group="🎯 Strategy")

// Compteurs de barres consécutives
var int invalidLongBars  = 0
var int invalidShortBars = 0

float exitBufLong  = ema50 - atrVal * exitAtrBuf
float exitBufShort = ema50 + atrVal * exitAtrBuf

if strategy.position_size > 0
    invalidLongBars  := close < exitBufLong  ? invalidLongBars  + 1 : 0
    invalidShortBars := 0
else if strategy.position_size < 0
    invalidShortBars := close > exitBufShort ? invalidShortBars + 1 : 0
    invalidLongBars  := 0
else
    invalidLongBars  := 0
    invalidShortBars := 0

// Sortie anticipée uniquement après N barres consécutives sous le buffer
bool longExitCond  = confirmed and strategy.position_size > 0 and (invalidLongBars  >= exitBarsReq or trendDown)
bool shortExitCond = confirmed and strategy.position_size < 0 and (invalidShortBars >= exitBarsReq or trendUp)
```

### Pattern — Confirmation bougie + RSI momentum (P2 + P3)

```pinescript
// [P2] Bougies directionnelles obligatoires
bool bullCandle = close > open
bool bearCandle = close < open

// [P3] RSI seuil 35/65 + momentum : le RSI doit déjà amorcer le retournement
bool rsiCrossAboveLong  = rsiVal > rsiThreshLong  and rsiVal[1] <= rsiThreshLong and rsiVal > rsiVal[1]
bool rsiCrossBelowShort = rsiVal < rsiThreshShort and rsiVal[1] >= rsiThreshShort and rsiVal < rsiVal[1]
// rsiThreshLong défaut 35, rsiThreshShort défaut 65
```

### Pattern — Pente EMA50 (P4)

```pinescript
ema50SlopeLen    = input.int(5, "EMA50 Pente (barres)", group="🎯 Strategy")
bool ema50SlopeBullish = ema50 > ema50[ema50SlopeLen]   // pour les longs
bool ema50SlopeBearish = ema50 < ema50[ema50SlopeLen]   // pour les shorts
```

---

## 8. Workflow génération — Audit-first obligatoire

> **RÈGLE** : Avant d'écrire une seule ligne de code, Claude DOIT diagnostiquer.

```
1. LIRE le signal existant (ou la description) → identifier les hypothèses de fail
2. VÉRIFIER la checklist §1 item par item
3. APPLIQUER les 5 correctifs P1-P5 §7 si pertinents
4. ÉCRIRE le code minimal (1 tendance / 1 trigger / 1 SL / 1 TP / 1 exit invalide)
5. BACKTESTER → relever WR + PF + trades + DD
6. SI résultats décevants → diagnostiquer via le tableau §7 avant toute modification
7. NE JAMAIS ajouter de complexité tant que la base (≥ 30 trades, PF > 1.0) n'est pas atteinte
```

---

## 6. Validation automatique

Un linter statique vérifie les règles ci-dessus sur tous les `.pine` :

```bash
python tradingview/scripts/validate_pine.py
```

Voir aussi `tradingview/strategies/README.md` pour le test rapide TradingView.
