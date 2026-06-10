# PROMPTS_CATALOG.md — Catalogue de prompts Pine Script v6 prêts à l'emploi

> **Règle absolue** : chaque prompt génère UNIQUEMENT le **bloc SIGNAUX** de
> `TEMPLATE_COMMUNITY.pine` (entre les deux marqueurs `// ════ SIGNAUX ════`).
> Header, filtres, sizing, gestion du risque, dashboard et alertcondition sont
> fournis par le template et **ne doivent jamais être régénérés**.
>
> Workflow complet → `../Guide complet... §13-14` · Validation → `../PINE_RULES.md`

---

## A. Prompts de création par archétype

Copie-colle le prompt de l'archétype voulu, remplis les champs `[...]`, puis
demande à Claude (ou `pine-architect`) de produire le bloc SIGNAUX.

---

### A1 — Trend Following [Archétype T]

**Profil** : suit une tendance établie, entre sur pullback ou confirmation de continuation.
**Seuils backtest cibles** : WR 45-55% · PF ≥ 1.5 · MaxDD < 15% · ≥ 200 trades/an
**TP recommandé** : Trailing ATR ou 2R · **Filtre préset** : useTrend=true, useRsi=false, useAtrDisp=optional

```text
Tu es pine-architect (expert Pine Script v6 project agent-trader).
Base-toi UNIQUEMENT sur pine/TEMPLATE_COMMUNITY.pine.

Génère UNIQUEMENT le bloc SIGNAUX (entre les deux marqueurs
"// ════ SIGNAUX ════"). Ne touche à rien en dehors de ce bloc.

ARCHÉTYPE : Trend Following
MARCHÉ    : [ex. BTCUSDT.P, ETHUSDT.P]
TIMEFRAME : [ex. 1H, 4H]

SIGNAL LONG  : [décrire la condition précise — ex. "EMA9 croise au-dessus EMA21 ET prix > EMA200 ET ADX > 25"]
SIGNAL SHORT : [décrire la condition précise — ex. "EMA9 croise en-dessous EMA21 ET prix < EMA200 ET ADX > 25"]

INDICATEURS À UTILISER : [ex. ta.ema, ta.adx, ta.supertrend]
FILTRES ACTIFS : useTrend=true, useRsi=false, useAtrDisp=[true/false]
TP MODE       : [Trailing / 2R]
ATR MULTS     : slMult=[1.5], tpMult=[3.0] (ignoré si trailing)

CONTRAINTES OBLIGATOIRES :
- Variables : longSig (bool), shortSig (bool)
- barstate.isconfirmed sur les conditions d'entrée
- Pas de request.security(), pas de calculs en dehors du bloc SIGNAUX
- Types explicites (bool, float, int)
- camelCase pour tous les noms de variables

Retourne le bloc SIGNAUX complet, rien d'autre.
```

---

### A2 — Breakout [Archétype BO]

**Profil** : entre sur cassure d'une range/canal avec confirmation de momentum.
**Seuils backtest cibles** : WR 35-50% · PF ≥ 1.8 · MaxDD < 15% · ≥ 200 trades/an
**TP recommandé** : 1.5R ou 2R · **Filtre préset** : useTrend=true, useAtrDisp=true, useRsi=optional

> Note : `TEMPLATE_COMMUNITY.pine` implémente déjà un breakout Donchian par défaut.
> Remplace le bloc SIGNAUX uniquement si tu veux un mécanisme de breakout différent
> (Pivot, ATR displacement, session range, FVG).

```text
Tu es pine-architect (expert Pine Script v6 project agent-trader).
Base-toi UNIQUEMENT sur pine/TEMPLATE_COMMUNITY.pine.

Génère UNIQUEMENT le bloc SIGNAUX (entre les deux marqueurs
"// ════ SIGNAUX ════"). Ne touche à rien en dehors de ce bloc.

ARCHÉTYPE : Breakout
MARCHÉ    : [ex. BTCUSDT.P, NQ1!, EURUSD]
TIMEFRAME : [ex. 15m, 1H]

MÉCANISME DE BREAKOUT : [ex. "Donchian channel 20 périodes", "Pivot High/Low lookback 10", "Opening Range (session 09:30-10:00 ET)"]
BUFFER ANTI-WHIPSAW  : [ex. "0.3 × ATR14 au-dessus du canal", "aucun"]
CONFIRMATION         : [ex. "volume > 1.5× moyenne 20 barres", "ATR déplacement > 1.5×ATR14", "aucune"]

INDICATEURS À UTILISER : [ex. ta.highest, ta.lowest, ta.atr, ta.ema]
FILTRES ACTIFS : useTrend=true, useAtrDisp=true, useRsi=[true/false]
TP MODE       : [1.5R / 2R]
ATR MULTS     : slMult=[1.0], tpMult=[2.0]

CONTRAINTES OBLIGATOIRES :
- Variables : longSig (bool), shortSig (bool)
- barstate.isconfirmed
- Pas de request.security()
- Types explicites, camelCase

Retourne le bloc SIGNAUX complet, rien d'autre.
```

---

### A3 — Mean Reversion [Archétype MR]

**Profil** : entre en contre-tendance sur extension extrême, en regime de range.
**Seuils backtest cibles** : WR 55-70% · PF ≥ 1.2 · MaxDD < 12% · ≥ 200 trades/an
**TP recommandé** : BB midline ou 1R · **Filtre préset** : useTrend inversé (ADX < 25), useRsi=true

> Attention : pour ce archétype, le filtre `trendOkL`/`trendOkS` doit être inversé
> ou désactivé (`useTrend=false`). Précise-le dans le prompt.

```text
Tu es pine-architect (expert Pine Script v6 project agent-trader).
Base-toi UNIQUEMENT sur pine/TEMPLATE_COMMUNITY.pine.

Génère UNIQUEMENT le bloc SIGNAUX (entre les deux marqueurs
"// ════ SIGNAUX ════"). Ne touche à rien en dehors de ce bloc.

ARCHÉTYPE : Mean Reversion
MARCHÉ    : [ex. BTCUSDT.P 1H en range, EURUSD 5m]
TIMEFRAME : [ex. 5m, 15m, 1H]

SIGNAL LONG  : [ex. "prix touche BB lower (2σ, 20) ET RSI14 < 30 ET ADX14 < 25"]
SIGNAL SHORT : [ex. "prix touche BB upper (2σ, 20) ET RSI14 > 70 ET ADX14 < 25"]

INDICATEURS À UTILISER : [ex. ta.bb, ta.rsi, ta.adx]
FILTRE RÉGIME : ADX < [25] (range uniquement) — intégrer dans longSig/shortSig directement
FILTRE useTrend : false (désactiver — sinon filtre contra-tendance invalide)
TP MODE       : [1R / BB midline]
ATR MULTS     : slMult=[1.0], tpMult=[1.5]

CONTRAINTES OBLIGATOIRES :
- Variables : longSig (bool), shortSig (bool)
- barstate.isconfirmed
- ADX threshold exposé comme input (adxThreshold, défaut 25)
- Types explicites, camelCase

Retourne le bloc SIGNAUX complet, rien d'autre.
```

---

### A4 — Swing HWR [Archétype SW — High Win Rate]

**Profil** : confluence de 3 confirmations indépendantes pour maximiser le win rate.
**Seuils backtest cibles** : WR 60-75% · PF ≥ 1.3 · MaxDD < 12% · ≥ 200 trades/an
**TP recommandé** : 1.5R · **Filtre préset** : tous filtres actifs, seuils stricts

> Trade count guard critique : si < 200 trades/an → relâcher 1 filtre à la fois.

```text
Tu es pine-architect (expert Pine Script v6 project agent-trader).
Base-toi UNIQUEMENT sur pine/TEMPLATE_COMMUNITY.pine.

Génère UNIQUEMENT le bloc SIGNAUX (entre les deux marqueurs
"// ════ SIGNAUX ════"). Ne touche à rien en dehors de ce bloc.

ARCHÉTYPE : Swing HWR (3-factor confluence)
MARCHÉ    : [ex. BTCUSDT.P, ETHUSDT.P]
TIMEFRAME : [ex. 4H, Daily]

FACTEUR 1 (structure) : [ex. "Prix > EMA200 pour long, < EMA200 pour short"]
FACTEUR 2 (momentum)  : [ex. "RSI14 entre 50 et 70 pour long, entre 30 et 50 pour short"]
FACTEUR 3 (trigger)   : [ex. "MACD histogram passe positif pour long, négatif pour short" / "Supertrend flip"]

LOGIQUE   : longSig = facteur1 ET facteur2 ET facteur3 (tous obligatoires)
FILTRES ACTIFS : useTrend=true, useRsi=true, useAtrDisp=[true/false]
TP MODE   : [1.5R]
ATR MULTS : slMult=[1.2], tpMult=[1.8]

CONTRAINTES OBLIGATOIRES :
- Variables : longSig (bool), shortSig (bool)
- barstate.isconfirmed
- Chaque facteur = variable bool nommée clairement (factorStructure, factorMomentum, factorTrigger)
- Types explicites, camelCase

Retourne le bloc SIGNAUX complet, rien d'autre.
```

---

## B. Prompts de conversion indicateur → stratégie

### B1 — Source code Pine disponible

Utilise ce prompt quand tu as le code Pine de l'indicateur source.

```text
Tu es pine-architect (expert Pine Script v6 project agent-trader).
Base-toi UNIQUEMENT sur pine/TEMPLATE_COMMUNITY.pine.

Voici le code d'un indicateur Pine :

[COLLER LE CODE DE L'INDICATEUR ICI]

Ta mission :
1. Identifier les variables booléennes ou conditions qui représentent
   le signal LONG (achat) et le signal SHORT ou SORTIE LONG (vente).
2. Mapper ces conditions sur longSig (bool) et shortSig (bool).
3. Générer UNIQUEMENT le bloc SIGNAUX (entre les deux marqueurs
   "// ════ SIGNAUX ════") prêt à coller dans TEMPLATE_COMMUNITY.pine.

Règles strictes :
- barstate.isconfirmed obligatoire sur les conditions d'entrée
- Pas de request.security() dans le bloc SIGNAUX
- Reprendre 1:1 les calculs de l'indicateur sans les transformer
- Nommer les variables intermédiaires en camelCase
- Types explicites (bool, float, int)
- Ne pas régénérer les inputs déjà dans TEMPLATE_COMMUNITY.pine
  (slMult, tpMult, etc.) — utiliser uniquement des inputs propres
  à la logique de cet indicateur

Retourne le bloc SIGNAUX complet, rien d'autre.
```

---

### B2 — Logique décrite en langage naturel

Utilise ce prompt quand tu n'as pas le code source mais que tu connais la logique.

```text
Tu es pine-architect (expert Pine Script v6 project agent-trader).
Base-toi UNIQUEMENT sur pine/TEMPLATE_COMMUNITY.pine.

Je veux convertir la logique suivante en stratégie Pine v6 :

SIGNAL LONG  : [décrire précisément — ex. "bougie close au-dessus de la bande de Bollinger supérieure après 3 bougies consécutives en-dessous ET RSI > 50"]
SIGNAL SHORT / SORTIE : [décrire précisément]
INDICATEURS  : [liste des indicateurs utilisés]

Ta mission :
1. Implémenter cette logique en Pine v6 propre.
2. Générer UNIQUEMENT le bloc SIGNAUX de TEMPLATE_COMMUNITY.pine.
3. Exposer les paramètres clés via input.* (périodes, seuils).

Règles strictes :
- barstate.isconfirmed sur les conditions finales
- Pas de request.security()
- Variables longSig (bool) et shortSig (bool) obligatoires
- camelCase, types explicites

Retourne le bloc SIGNAUX complet, rien d'autre.
```

---

## C. Prompts d'optimisation post-backtest

### C1 — Diagnostic standard (pour `pine-optimizer`)

Fournis le fichier complet + les métriques du Strategy Tester.

```text
Tu es pine-optimizer (expert optimisation Pine Script v6).

Voici la stratégie Pine complète :
[COLLER LE CODE COMPLET DU FICHIER .pine ICI]

Métriques Strategy Tester (TradingView, période [X mois], [TICKER] [TF]) :
- Win Rate         : [ex. 43%]
- Profit Factor    : [ex. 1.31]
- Max Drawdown     : [ex. 18%]
- Nb trades        : [ex. 67]
- Net P&L          : [ex. +3.5%]

Référence : PINE_RULES.md §1 (seuils : WR≥50%, PF≥1.5, MaxDD<15%, ≥200 trades/an)

Ta mission :
1. Diagnostiquer le problème principal selon la table symptôme→cause de RULES_AGENT_OPTIMIZER.md.
2. Proposer MAX 3 variantes paramétriques ciblées.
3. Chaque variante ne change QUE 1-2 paramètres (input.*).
4. Préserver EXACTEMENT la structure TEMPLATE_COMMUNITY.pine.
5. Pour chaque variante : indiquer le paramètre changé + valeur + impact attendu.

Format de réponse :
## Diagnostic
[symptôme → cause → action corrective]

## Variante 1 — [titre court]
[paramètre : ancienne_valeur → nouvelle_valeur]
[impact attendu sur WR / PF / DD]
[code Pine de la variante]

## Variante 2 — ...
## Variante 3 — ...
```

---

### C2 — Diagnostics ciblés par symptôme

Copie-colle le sous-prompt correspondant au problème observé.

**WR < 45%, PF > 1.5 (bons gagnants, trop de perdants)**
```text
Diagnostic ciblé : Win Rate trop bas avec bon R-multiple.
Cause probable : signaux trop fréquents → trop de faux positifs.
Action : resserrer 1-2 filtres (hausser seuil ADX, réduire RSI zone, activer useAtrDisp).
Propose 3 combinaisons de filtres plus strictes. Préserver la structure template.
```

**MaxDD > 25% (drawdown excessif)**
```text
Diagnostic ciblé : Max Drawdown excessif.
Causes probables : sizing trop élevé, SL trop large, ou trades perdants cumulés en série.
Action : réduire riskPercent (input) OU réduire slMult OU activer le kill switch à 15%.
Propose 3 variantes ciblées. Préserver la structure template.
```

**< 30 trades/mois (trop peu de trades)**
```text
Diagnostic ciblé : fréquence de trades insuffisante (< 30/mois).
Cause probable : filtres trop restrictifs pour ce marché/timeframe.
Action : désactiver 1 filtre (useRsi → false, ou baisser seuil ADX) OU descendre d'un timeframe.
Propose 3 variantes qui relâchent les contraintes progressivement. Préserver la structure template.
```

**PF > 5 sur backtest (over-fitting suspect)**
```text
Diagnostic ciblé : Profit Factor anormalement élevé → over-fitting probable.
Action : tester sur 2 autres actifs similaires et sur une période out-of-sample.
Vérifie : pyramiding=0 ? Commissions incluses ? process_orders_on_close=true ?
Liste les 3 paramètres les plus sensibles et propose un walk-forward test (train 60% / test 40%).
```

**WR > 70%, PF < 1.3 (nombreux petits gains, gros perdants)**
```text
Diagnostic ciblé : WR élevé mais PF faible → ratio R:R inversé.
Cause : TP trop proche ou SL trop large.
Action : augmenter tpMult OU réduire slMult OU activer trailing stop.
Propose 3 ajustements du ratio SL/TP. Préserver la structure template.
```

---

## D. Références croisées rapides

| Besoin | Document |
|--------|----------|
| Architecture 3 couches sorties | `../Guide complet... §11` |
| Templates communautaires ↔ template local | `../Guide complet... §12` |
| 4 archétypes (théorie + filtres) | `../Guide complet... §13` |
| Workflow section-par-section | `../Guide complet... §14` |
| Diagramme flux agent complet | `../Guide complet... §14` |
| Checklist validation 10 points | `../PINE_RULES.md §1` |
| Anti-patterns Pine v6 | `../PINE_RULES.md §2` |
| Symptômes → causes optimizer | `../RULES_AGENT_OPTIMIZER.md` |
| Patterns community-grade | `PATTERNS.md` |
| Template base obligatoire | `TEMPLATE_COMMUNITY.pine` |
| Références communautaires | ce dossier (`pine/`) |
