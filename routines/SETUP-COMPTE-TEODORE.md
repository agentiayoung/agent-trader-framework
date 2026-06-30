# Faire tourner les routines sur le compte Max de Teodore

> **Pourquoi** : les routines (`claude -p` headless via Task Scheduler) tournaient sur le compte
> interactif de Hugo (`agent.ia.young@gmail.com`) et heurtaient les blocages de quota
> (« You're out of extra usage »). On les isole sur un **compte Max dédié (Teodore)** sans toucher
> la session interactive de Hugo.

## Mécanisme (confirmé via le guide Claude Code)
`CLAUDE_CONFIG_DIR` isole les **credentials** (`.credentials.json` sous ce dir = le compte logué là).
`run-routine.ps1` est déjà câblé (12.06) : **avant chaque `claude -p`**, il pointe `CLAUDE_CONFIG_DIR`
vers `C:\Users\admin\.claude-teodore` **UNIQUEMENT si ses credentials existent** (sinon fallback sur le
compte courant → zéro casse tant que le login n'est pas fait). Override : `$env:ROUTINE_CLAUDE_CONFIG_DIR`.
La session interactive de Hugo (`claude` normal) reste sur `~/.claude` / son compte — **non affectée**.

## Étape unique à faire (par Teodore, interactif — login OAuth navigateur)
> Le login est un OAuth navigateur : **Teodore doit le faire lui-même** (impossible de pré-fournir
> ses identifiants en script). À faire une seule fois, dans un terminal PowerShell sur cette machine :

```powershell
# 1) Pointer le config dir dédié
$env:CLAUDE_CONFIG_DIR = "C:\Users\admin\.claude-teodore"

# 2) Se loguer avec le compte Max de TEODORE (suivre l'OAuth navigateur, choisir le compte Max)
claude login

# 3) (1re fois) lancer un claude rapide pour accepter la confiance du dossier projet si demandé
cd "C:\Users\admin\Desktop\DEV CLAUDE CODE\projets\agent-trader"
claude -p "dis OK" --permission-mode acceptEdits
# -> repondre 'trust' si une invite de confiance du dossier apparait

# 4) Verifier le compte actif (doit afficher le compte de Teodore)
claude /status   # ou: type C:\Users\admin\.claude-teodore\.credentials.json existe
```

Après ça, `C:\Users\admin\.claude-teodore\.credentials.json` existe → **les routines basculent
automatiquement sur le compte de Teodore** au prochain tir (le log de routine affiche
`[COMPTE] routine sur CLAUDE_CONFIG_DIR=... (compte dedie Max)`).

## Vérifier que ça marche
- Lancer un run manuel : `routines\ROUTINE-MANUELLE.bat` (ou la tâche planifiée).
- Dans `routines\logs\routine_*.log`, la 1re ligne doit être `[COMPTE] routine sur CLAUDE_CONFIG_DIR=C:\Users\admin\.claude-teodore (compte dedie Max)`.
- Si elle dit `credentials dedies absents` → le login Teodore n'a pas (encore) été fait dans ce dir.

## Notes / gotchas
- **`CLAUDE_CODE_OAUTH_TOKEN`** (s'il est défini globalement) **prime sur le config dir** → le script
  le retire (`Remove-Item Env:`) dans le scope de la routine quand le dir dédié est actif.
- Le `settings.json` global n'est PAS lu sous un autre `CLAUDE_CONFIG_DIR` → on a **copié** le
  `settings.json` (permissions, pour éviter les prompts headless) dans `.claude-teodore`. Le `.mcp.json`
  et `.claude/settings.json` du PROJET se chargent quand même (ils sont dans le dossier de travail).
- À partir du **15.06.2026**, `claude -p` sur abonnement tire d'un **crédit Agent SDK mensuel séparé**
  des limites interactives (annonce Anthropic) → le compte dédié reste pertinent (quota propre).
- Pour révoquer : supprimer `C:\Users\admin\.claude-teodore\.credentials.json` (routines reviennent au compte par défaut).
