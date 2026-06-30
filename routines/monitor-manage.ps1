# monitor-manage.ps1 (Phase A, 25.06) -- SUIVI ACTIF DES TRADES ENTRE LES ROUTINES (agent 4h, ~30 min, SANS LLM).
# Lance 'journal.js monitor-tick' avec l'AUTO-EXECUTION RISK-REDUCING activee : le moteur deterministe
# (thesis.js -> planMonitoring -> monitor-exec.js) decide PAR POSITION cut / prise de profit /
# continuation / resserrement, et EXECUTE l'action via Bybit (take_partial / move_sl / set_trailing).
# RISK-REDUCING ONLY : jamais ouvrir, flipper, scale-in, ni elargir un SL (les ENTREES restent a la
# routine LLM). Idempotent (partiels one-shot memorises dans monitor_managed). Cadence 30 min (l'agent
# 4h evolue lentement -> 30 min suffit). REGLE FICHIER : ASCII-only.
$ErrorActionPreference = "Continue"
$proj = "C:\Users\admin\Desktop\DEV CLAUDE CODE\projets\agent-trader"
Set-Location $proj
$logdir = "$proj\routines\logs"; New-Item -ItemType Directory -Force -Path $logdir | Out-Null
$log = "$logdir\monitor-manage.log"
function Log($m) { Add-Content -Path $log -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m" }
$env:DEMO_ACTIVE = "1"
$env:MONITOR_TICK_AUTO_MANAGE = "1"   # cut / prise de profit / continuation / tighten -> EXECUTE
$env:MONITOR_TICK_AUTO_BE = "1"       # breakeven-apres-TP1 -> deplace le SL au point mort
# Echelle ATR/trajectoire = TF du setup 4h-agent (1h pour la gestion fine).
if (-not $env:MONITOR_TRAJ_TF) { $env:MONITOR_TRAJ_TF = "1h" }
try {
  $out = node "$proj\trade-journal\journal.js" monitor-tick 2>&1 | Out-String
  # SNAPSHOT BYBIT (27.06) : rafraichit bybit-live.json entre les routines -> le dashboard montre la
  # verite Bybit a ~30 min (best-effort, ne casse jamais le tick).
  try { node "$proj\trade-journal\journal.js" bybit-snapshot *> $null 2>&1 } catch {}
  try {
    $r = $out | ConvertFrom-Json
    $mng = if ($r.manage_actions) { $r.manage_actions.Count } else { 0 }
    if ($r.alert) { Log "ALERTE n=$($r.n) manage=$mng criticals=$($r.criticals.Count) stale=$($r.stale.Count) be_moved=$($r.be_moved.Count) notified=$($r.notified)" }
    else { Log "OK n=$($r.n) (rien a gerer) : $($r.summary)" }
  } catch {
    $tail = if ($out.Length -gt 200) { $out.Substring(0, 200) } else { $out }
    Log "parse skip: $tail"
  }
} catch {
  Log "ERR monitor-manage: $($_.Exception.Message)"
  try { node "$proj\trade-journal\notify.js" "WARN monitor-manage agent a echoue: $($_.Exception.Message). Verifier PC/Node." | Out-Null } catch {}
  exit 1
}
exit 0
