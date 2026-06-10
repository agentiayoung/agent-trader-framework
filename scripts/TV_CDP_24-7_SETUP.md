# 🖥️ TradingView Desktop — CDP debug 24/7 (MCP `tradingview-desktop`)

> Objectif : que le MCP `tradingview-desktop` (lecture des zones Zeiierman, chart, etc.)
> soit **toujours connecté** sur la machine qui exécute les routines de trading.
>
> Le MCP se connecte à TradingView via **Chrome DevTools Protocol (CDP)** sur le **port 9222**.
> TradingView doit donc tourner avec `--remote-debugging-port=9222`. Ce dossier fournit un
> **watchdog** + une **tâche planifiée** qui maintiennent ça en continu (auto-réparation).

---

## ℹ️ Fait important : TradingView Desktop = MSIX/Appx uniquement

TradingView Desktop **n'existe qu'en format MSIX/Appx** (Microsoft Store **ou** sideload
`.appinstaller`). **Il n'y a PAS de build `.exe` standalone classique.** Le téléchargement
"direct" du site (`tvd-packages.tradingview.com/.../TradingView.appinstaller`) installe
**le même paquet Appx** que celui du Store, dans `Program Files\WindowsApps`.

➡️ **Conséquence : pas besoin de réinstaller.** L'install Appx existante fonctionne déjà
pour le CDP — il suffit de lancer l'exe résolu dynamiquement via `Get-AppxPackage` avec le
flag `--remote-debugging-port=9222` (vérifié 08.06.2026, commit `c2a2986`).

> Le numéro de version est dans le chemin `WindowsApps` mais on ne le code jamais en dur :
> `Get-AppxPackage *TradingView*` résout toujours la version courante → **insensible aux updates**.

---

## 🔁 Installation du watchdog 24/7 (une seule fois)

Depuis le dossier du projet, dans une **session interactive** (ta session Windows, pas un
shell distant) :

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-tv-cdp-task.ps1
```

Ça crée la tâche planifiée **`TradingView-CDP-Watchdog`** qui :
- lance le watchdog **au logon**,
- le ré-exécute **toutes les 5 minutes** (auto-répare après crash / reboot / ouverture
  manuelle de TV sans debug),
- **tue** toute instance TV sans debug puis **relance** avec `--remote-debugging-port=9222`
  (exe résolu via `Get-AppxPackage`).

### Préparer le chart (une fois)
- Ouvrir un chart (ex. `BYBIT:BTCUSDT.P`).
- Ajouter l'indicateur **« Ranked Support & Resistance Zones (Zeiierman) »** et le laisser
  **visible**, puis **sauvegarder le layout** (les boxes Pine ne se lisent que si l'indicateur
  est affiché).

### Vérifier
Dans Claude Code : demander **« Use tv_health_check »** → doit répondre `success:true`.

---

## 🧠 Fichiers

| Fichier | Rôle |
|---|---|
| `scripts/tv-cdp-watchdog.ps1` | Vérifie le CDP (HTTP `127.0.0.1:9222/json/version`). Si down → kill TV + relance avec le flag debug. Résout l'exe via `Get-AppxPackage` (version-proof). |
| `scripts/install-tv-cdp-task.ps1` | Enregistre/remplace la tâche planifiée (logon + 5 min). À lancer une fois. |
| `scripts/tv-cdp-watchdog.log` | Journal des relances (créé au 1er besoin de relance). |
| `scripts/launch-tradingview.bat` | Lancement manuel ponctuel (double-clic). Résout l'Appx dynamiquement. |

---

## ⚡ Contraintes h24 (à connaître)

- **La machine doit rester allumée** et l'**utilisateur connecté** : `Get-AppxPackage` est
  per-user et TradingView est une app GUI → besoin d'une session interactive. Désactiver la
  mise en veille (`Paramètres → Alimentation → Veille → Jamais`).
- **Verrouiller (Win+L) = OK** (l'app continue), **se déconnecter (logout) ferme l'app**.
- Le watchdog est **insensible aux mises à jour** de TradingView (résolution dynamique).
- Si le port 9222 est pris ailleurs, changer `$port` dans les 2 scripts **et** la config du
  MCP `tradingview-desktop`.

---

## 🩺 Dépannage

| Symptôme | Cause | Fix |
|---|---|---|
| `tv_health_check` → fail | TV pas en debug | `Start-ScheduledTask -TaskName TradingView-CDP-Watchdog`, attendre ~10s |
| CDP marche puis tombe | TV ouvert manuellement sans flag (single-instance avale le debug) | Le watchdog le re-tue/relance sous 5 min |
| Zones Zeiierman vides | Indicateur pas visible | Ré-ajouter l'indicateur + sauver le layout |
| `Get-AppxPackage` vide dans le log | Lancé hors session utilisateur | La tâche tourne au **logon** (session interactive) — il faut être connecté |
| Zones d'alts sub-dollar arrondies | `verbose` manquant | Lire avec `data_get_pine_boxes {study_filter:"Zeiierman", verbose:true}` |
