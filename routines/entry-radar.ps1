# entry-radar.ps1 (M002/S04) -- RADAR D'ENTREE entre les routines (~15 min, SANS LLM, 0 token).
# Lit armed-watch.json (intentions armees par la routine), confirme la bougie (confirm.js) et
# pose le limit MAKER quand la confirmation joue (preflight DUR avant de poser). Meme classe que
# monitor-tick : code pur node, zero appel claude -p. Decouple le TIMING d'entree du cron 4h.
# Garde-fous DURS : preflight (SL/geometrie/sizing), LIMIT maker, expiry, no-duplicate, DEMO only.
# ACTIF (22.06, GO Hugo) : pose en LIVE sur le compte DEMO. Mettre ENTRY_RADAR_DRYRUN=1 pour repasser
# en dry-run (observation sans poser). Le radar no-op si armed-watch est vide.
# Usage : powershell -File routines\entry-radar.ps1
$ErrorActionPreference = "Continue"
$proj = "C:\Users\admin\Desktop\DEV CLAUDE CODE\projets\agent-trader"
Set-Location $proj
$logdir = "$proj\routines\logs"; New-Item -ItemType Directory -Force -Path $logdir | Out-Null
$log = "$logdir\entry-radar.log"
function Log($m) { Add-Content -Path $log -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m" }
$env:DEMO_ACTIVE = "1"
# SIGNAL-TICK (30.06, parite scalp) : le scan VALIDE (scan.js) produit les alertes a la cloture
# (self-sourced) -> tv-alerts.jsonl, AVANT le radar. Self-gated : no-op si SIGNAL_TICK!=1 (config/.env).
# Pas de GUI, pas de TV requis. Le radar ne pose QUE les intentions armees par le LLM (les autres = feed).
try { node "$proj\trade-journal\signal-tick.js" 2>&1 | Out-Null } catch { Log "signal-tick skip: $($_.Exception.Message)" }
# LIVE par defaut (pose sur le compte demo) ; dry-run UNIQUEMENT si ENTRY_RADAR_DRYRUN=1 explicitement.
$dry = if ($env:ENTRY_RADAR_DRYRUN -eq "1") { "--dry-run" } else { "" }
try {
  $out = if ($dry) { node "$proj\trade-journal\entry-radar.js" $dry 2>&1 | Out-String } else { node "$proj\trade-journal\entry-radar.js" 2>&1 | Out-String }
  try {
    $r = $out | ConvertFrom-Json
    $np = $r.posted.Count; $nd = $r.dropped.Count; $rem = $r.remaining
    if ($np -gt 0) {
      Log "POSE=$np DROP=$nd REMAIN=$rem dry=$($r.dry_run)"
      $syms = ($r.posted | ForEach-Object { "$($_.symbol) $($_.side)" }) -join ", "
      try { node "$proj\trade-journal\notify.js" "RADAR: $np entree(s) confirmee(s) -> $syms (dry=$($r.dry_run))" | Out-Null } catch {}
    } else {
      Log "rien a poser (remain=$rem drop=$nd)"
    }
  } catch {
    $tail = if ($out.Length -gt 200) { $out.Substring(0, 200) } else { $out }
    Log "parse skip: $tail"
  }
} catch {
  Log "ERR entry-radar: $($_.Exception.Message)"
  try { node "$proj\trade-journal\notify.js" "WARN entry-radar a echoue: $($_.Exception.Message). Verifier PC/Node." | Out-Null } catch {}
  exit 1
}
exit 0
