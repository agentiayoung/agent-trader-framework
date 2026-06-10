# PATTERNS.md — Patterns Pine « community-grade »

> Patterns extraits des stratégies de référence de la communauté (dossier `pine/`).
> **C'est la base de toute création Pine future dans ce projet.** Une stratégie « rendu communauté »
> combine le standard projet (header, kill switch, webhook) AVEC ces patterns.

Références sources : `algotorma_orb_strategy.pine`, `katana_v5.pine`, `quanloki_qqe.pine`, `range_breakout.pine`.

---

## Ce qui distingue une stratégie communautaire d'un script « AI slop »

Mes stratégies v1 (`../strategies/`) perdaient toutes en backtest. Les versions communautaires sont meilleures parce qu'elles ajoutent **du contexte et du contrôle**. Différences clés :

| Dimension | ❌ v1 (faible) | ✅ Community-grade |
|-----------|---------------|--------------------|
| Filtres | Aucun ou 1 figé | Plusieurs filtres **activables** (toggle bool) : tendance, RSI, session, volatilité, stop mini |
| Sizing | `% equity` fixe | **Risque %** par trade calculé sur la distance au stop (+ compounding) |
| Timing | Aucun | **Session + timezone** + filtre **jour de semaine** |
| État | Entrée instantanée | Machine **setup → armed → trigger** + expiry de setup |
| Anti-repaint | Implicite | `barstate.isconfirmed` explicite, jamais `request.security` lookahead |
| Gestion | SL/TP fixe | **Max trades/jour, daily loss limit, trailing stop, TP en R-multiples** |
| Reset | Aucun | **Reset journalier** `ta.change(time("D"))` + `var` state |
| Visuels | 2 plots | **Boxes** (range, zones SL/TP), **lines** de niveaux, **dashboard table** (winrate, trades, points) |
| Alertes | Commentaire | `alertcondition()` natif + message |
| Ticks | prix brut | `syminfo.mintick` / `syminfo.pointvalue` (portable multi-marché) |

---

## 1. Header (community)

```pinescript
//@version=6
strategy("Nom [Auteur]", overlay=true,
     initial_capital      = 100000,
     pyramiding           = 0,
     process_orders_on_close = true,
     calc_on_every_tick   = false,
     commission_type      = strategy.commission.percent,
     commission_value     = 0.05,
     slippage             = 1,
     max_boxes_count      = 100,
     max_lines_count      = 500,
     max_labels_count     = 100)
```
> `max_*_count` obligatoire dès qu'on dessine des boxes/lines/labels en boucle (sinon plantage silencieux).

## 2. Filtres activables (LE pattern signature)

Chaque filtre = un `input.bool` + sa logique gardée par `not useX or condition`. L'utilisateur compose sa stratégie depuis les inputs.

```pinescript
useTrend   = input.bool(true,  "Filtre tendance EMA", group="Filtres")
emaLen     = input.int(200,    "EMA length", minval=1, group="Filtres")
useRsi     = input.bool(true,  "Filtre RSI", group="Filtres")
useSession = input.bool(true,  "Filtre session", group="Filtres")
useAtrDisp = input.bool(true,  "Filtre déplacement ATR", group="Filtres")

emaV   = ta.ema(close, emaLen)
trendOkL = not useTrend or close > emaV
rsiOkL   = not useRsi   or ta.rsi(close, 14) > 50
// entrée = signalBrut and trendOkL and rsiOkL and sessionOk and ...
```

## 3. Session + timezone + jours

```pinescript
tradeSession = input.session("0800-1800", "Session", group="Timing")
tz           = input.string("Etc/UTC", "Timezone", group="Timing")
inSession    = not na(time(timeframe.period, tradeSession, tz))

tradeMon = input.bool(true, "Lun", group="Timing")
// ...
d = dayofweek(time)
dayOk = (d==dayofweek.monday and tradeMon) or (d==dayofweek.tuesday and tradeTue) // ...
```

## 4. Reset journalier + état (intraday)

```pinescript
newDay = ta.change(time("D")) != 0
var float rangeHigh = na
var bool  tradedToday = false
if newDay
    rangeHigh   := na
    tradedToday := false
```

## 5. Sizing basé sur le risque

```pinescript
useCompounding = input.bool(true, "Compounding", group="Risque")
riskPercent    = input.float(1.0, "Risque % / trade", minval=0.01, maxval=20, step=0.1, group="Risque")
equityBase = useCompounding ? strategy.equity : strategy.initial_capital
riskCash   = equityBase * riskPercent / 100.0
stopDist   = math.abs(close - stopPrice)
qty        = stopDist > 0 ? riskCash / stopDist : 0.0
strategy.entry("Long", strategy.long, qty=qty)
```

## 6. Machine à états setup → trigger

```pinescript
var bool longArmed = false
if breakoutDetected
    longArmed := true
longSetup = longArmed and strategy.position_size == 0 and tradeCount < maxTrades and not dailyLossHit
if longSetup
    strategy.entry("Long", strategy.long, limit=entryLevel)
if strategy.position_size > 0
    longArmed := false      // reset après remplissage
```

## 7. Gestion : max trades/jour + daily loss

```pinescript
var int tradeCount = 0
var bool dailyLossHit = false
if strategy.closedtrades > strategy.closedtrades[1]
    tradeCount += 1
    if strategy.closedtrades.profit(strategy.closedtrades - 1) < 0
        dailyLossHit := true   // (ou cumul des pertes du jour > seuil)
```

## 8. Sorties : trailing + R-multiples

```pinescript
tpMode = input.string("2R", "TP mode", options=["1R","1.5R","2R","Trailing"], group="Risque")
if strategy.position_size > 0
    rr = tpMode=="1R"?1.0 : tpMode=="1.5R"?1.5 : 2.0
    tp = strategy.position_avg_price + rr * stopDist
    strategy.exit("Exit L", "Long", stop=stopPrice, limit=tp,
         trail_points = tpMode=="Trailing" ? trailPts : na,
         trail_offset = tpMode=="Trailing" ? trailOff : na)
```

## 9. Dashboard table (stats live)

```pinescript
var table dash = table.new(position.top_right, 2, 5, border_width=1)
if barstate.islast
    wr = strategy.closedtrades>0 ? strategy.wintrades*100.0/strategy.closedtrades : na
    table.cell(dash, 0, 0, "Trades"); table.cell(dash, 1, 0, str.tostring(strategy.closedtrades))
    table.cell(dash, 0, 1, "Winrate"); table.cell(dash, 1, 1, str.tostring(wr, "#.##")+"%")
    table.cell(dash, 0, 2, "PnL");     table.cell(dash, 1, 2, str.tostring(strategy.netprofit, "#.#"))
```

## 10. Visuels boxes/lines + alertes

```pinescript
box.new(bar_index, tp, bar_index+20, entry, bgcolor=color.new(color.green,80), border_color=color.green)
line.new(bar_index, level, bar_index, level, color=color.blue, width=2)
alertcondition(longSignal, title="BUY", message="LONG {{ticker}} {{interval}}")
```

---

## 11. Anti-patterns économiques (post-backtest réel — WR 28%, PF 0.59)

> Pathologies observées sur EMA50-200_RSI_ATR V1, BTC 1H, 32 trades. À checker systématiquement.

### ❌ Exit hair-trigger (P1 — cause principale de 44% des pertes)

```pinescript
// ❌ Se déclenche 1 barre après l'entrée (moindre oscillation)
bool longExitCond = close < ema50

// ✅ 2 barres consécutives sous buffer ATR
var int invalidLongBars = 0
float exitBufLong = ema50 - atrVal * 0.5
if strategy.position_size > 0
    invalidLongBars := close < exitBufLong ? invalidLongBars + 1 : 0
else
    invalidLongBars := 0
bool longExitCond = invalidLongBars >= 2 or trendDown
```

### ❌ Entrée sur bougie adverse — catching falling knife (P2)

```pinescript
// ❌ La bougie d'entrée est encore rouge
bool pullbackLong = rsiCrossAbove and close > ema50

// ✅ Exiger une bougie haussière confirmée
bool pullbackLong = rsiCrossAbove and close > ema50 and close > open
```

### ❌ RSI seuil 40 trop tôt dans le pullback (P3)

```pinescript
// ❌ RSI > 40 souvent au milieu d'un pullback non terminé
bool rsiCrossAboveLong = rsiVal > 40.0 and rsiVal[1] <= 40.0

// ✅ Seuil 35 + momentum déjà amorcé (rsiVal en hausse)
bool rsiCrossAboveLong = rsiVal > 35.0 and rsiVal[1] <= 35.0 and rsiVal > rsiVal[1]
```

### ❌ Shorts sans confirmation de pente EMA50 (P4 — bull macro)

```pinescript
// ❌ EMA50 peut brièvement passer sous EMA200 en bull trend
bool shortEntryCond = canTrade and pullbackShort and trendDown

// ✅ Valider que la pente EMA50 est réellement baissière sur N barres
bool ema50SlopeBearish = ema50 < ema50[5]
bool shortEntryCond = canTrade and pullbackShort and trendDown and ema50SlopeBearish
```

### ❌ ADX 20 en marché latéral + risk 10% avec WR < 40% (P5)

```pinescript
// ❌ ADX 20 laisse passer les ranges ; 10% avec WR 28% = ruine rapide
adxThreshold = input.float(20.0, ...)
default_qty_value = 10

// ✅ ADX 25 + risk 8% par trade
adxThreshold = input.float(25.0, ...)
default_qty_value = 8
```

---

## Garde-fous conservés du standard projet (toujours)

- **Kill switch** : `input.bool` → `strategy.close_all()`.
- **Anti-repaint** : `barstate.isconfirmed`, jamais de `request.security(...)` avec lookahead (le défaut v6 `lookahead_off` est OK, mais préférer le TF du chart).
- **Webhook** : commentaire `alert_message` JSON en bas (voir `../webhooks/payload_template.json`).
- **Fenêtre backtest** : `from_date = timestamp("2025-01-01")`.

## Checklist « rendu communauté » (à valider avant de livrer)

1. [ ] ≥ 3 filtres activables (toggle) pertinents pour le style
2. [ ] Sizing basé sur le risque (Risk % + compounding) OU mode fixe sélectionnable
3. [ ] Session + timezone (si intraday) + reset journalier
4. [ ] Gestion : max trades/jour OU daily loss limit
5. [ ] Sorties : SL + TP en R-multiples et/ou trailing
6. [ ] `barstate.isconfirmed` sur les signaux d'entrée
7. [ ] Dashboard table (winrate, trades, PnL)
8. [ ] Visuels boxes/lines + `alertcondition()`
9. [ ] Kill switch + commentaire webhook (standard projet)
10. [ ] Inputs groupés, `syminfo.mintick` pour les distances, `max_*_count` si dessins

> Template prêt à copier : `TEMPLATE_COMMUNITY.pine`.
