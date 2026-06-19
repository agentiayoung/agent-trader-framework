# monitor-tick.ps1 (F3.3, 19.06) -- MONITORING ENTRE LES ROUTINES (~20-30 min, SANS LLM).
# READ-ONLY : 'journal.js monitor-tick' fetch positions + SL server-side -> needsAttention
# (position NUE / STALE) + planMonitoring (flipped/mature/set_trailing si scan-latest frais)
# -> ALERTE Telegram (alerte seule, AUCUN ordre place). Ferme l'angle mort 4h : une position
# NUE est detectee en ~30 min au lieu d'attendre la prochaine routine.
# Met a jour monitor-state.json -> le watchdog horaire (health-check.ps1) ne fausse plus.
# AUTO-EXECUTION = OFF (approved requis). Usage : powershell -File routines\monitor-tick.ps1
$ErrorActionPreference = "Continue"
$proj = Split-Path -Parent $PSScriptRoot
Set-Location $proj
$logdir = "$proj\routines\logs"; New-Item -ItemType Directory -Force -Path $logdir | Out-Null
$log = "$logdir\monitor-tick.log"
function Log($m) { Add-Content -Path $log -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m" }
$env:DEMO_ACTIVE = "1"
try {
  $out = node "$proj\trade-journal\journal.js" monitor-tick 2>&1 | Out-String
  try {
    $r = $out | ConvertFrom-Json
    if ($r.alert) { Log "ALERTE n=$($r.n) criticals=$($r.criticals.Count) stale=$($r.stale.Count) actionable=$($r.actionable) notified=$($r.notified)" }
    else { Log "OK n=$($r.n) (rien a signaler) : $($r.summary)" }
  } catch {
    $tail = if ($out.Length -gt 200) { $out.Substring(0, 200) } else { $out }
    Log "parse skip: $tail"
  }
} catch {
  Log "ERR monitor-tick: $($_.Exception.Message)"
  try { node "$proj\trade-journal\notify.js" "WARN monitor-tick a echoue: $($_.Exception.Message). Verifier PC/Node." | Out-Null } catch {}
  exit 1
}
exit 0
