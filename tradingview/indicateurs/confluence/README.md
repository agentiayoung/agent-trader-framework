# Confluence Alerts — Intégration des indicateurs au moteur

Ce dossier contient les snippets `alertcondition` à ajouter à chaque indicateur Pine pour qu'il émette des alertes au format JSON attendu par le **Confluence Engine** (`confluence_engine/`).

## Architecture

```
[Indicateur Pine sur TradingView]
    ↓ alertcondition (payload JSON)
[Alerte TradingView avec webhook URL]
    ↓ POST
[FastAPI /webhook/confluence]
    ↓ adapt → Signal
[ConfluenceEngine.ingest()]
    ↓ score(ticker, side) sur fenêtre 5 min
[build_recommendation()]
    ↓ si score >= 70
[TelegramNotifier]
```

## Format de payload standardisé

Toutes les alertes émettent ce format minimal :

```json
{
  "secret": "<WEBHOOK_SECRET>",
  "indicator": "synapse_trail | trend_channels | vwap | ai_signal | luxalgo | orderblock | support_resistance",
  "ticker": "{{ticker}}",
  "tf": "{{interval}}",
  "side": "long | short",
  "ts": {{timenow}},
  ... champs spécifiques à l'indicateur ...
}
```

Le champ `secret` est vérifié côté webhook (équivalent du `key` legacy). Les champs supplémentaires (`grade`, `bias`, `event`, `tmf_value`, …) sont remontés dans `Signal.metadata` et utilisés par le scoring.

## Configuration TradingView

1. Coller le snippet correspondant à la fin du script Pine
2. Compiler (Save + Add to chart)
3. Clic droit sur le chart → Add alert
4. Condition → choisir l'alertcondition nommée (ex: `Confluence Synapse BUY`)
5. Notifications → Webhook URL : `https://<your-host>/webhook/confluence`
6. Message : laisser vide (le payload est embarqué dans `alertcondition`)
7. **⚠️ Once Per Bar Close** activé (anti-repaint)

## Fichiers de ce dossier

| Fichier | Rôle |
|---------|------|
| `alert_snippets.pine` | Snippets copy-paste pour les 5 indicateurs (synapse_trail, trend_channels, vwap, ai_signal, luxalgo) |
| `ai_signal_confluence.pine` | Version complète d'AI Signal avec alertes confluence intégrées (référence) |
| `README.md` | Ce fichier |

## Indicateurs non-alertants

`orderblock` et `support_resistance` ne sont pas câblés aux alertes confluence en v1 — ils enrichiraient surtout le contexte (TMF, zones) mais leur logique d'événement est plus difficile à isoler proprement. Leur intégration sera ajoutée en v2 si le forward test montre qu'ils améliorent le scoring.

## Secret

Le `WEBHOOK_SECRET` est lu côté serveur depuis `config/.env`. Le snippet le code en dur dans la chaîne de l'alertcondition — **ne jamais committer un secret réel dans Pine**. Utiliser un placeholder `"REPLACE_WITH_SECRET"` dans le fichier versionné et le remplacer dans TradingView avant déploiement.
