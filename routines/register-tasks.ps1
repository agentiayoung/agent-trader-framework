# Enregistre (ou supprime avec -Remove) les taches planifiees de la routine de trading.
# Logge tout dans routines\logs\register.log (pour diagnostic).
param([switch]$Remove)
$ErrorActionPreference = "Continue"

$proj = Split-Path -Parent $PSScriptRoot
$runner = "$proj\routines\run-routine.ps1"
$prefix = "AgentTrader-Routine"
# Clotures 4H alignees (heure locale , ete UTC+2). Clotures bougies 4H = UTC 00/04/08/12/16/20
# -> local ete 02/06/10/14/18/22, +7 min de settle (bougie close + indicateurs recalcules).
# NB DST hiver (UTC+1) : retrancher 1h pour rester pile aligne (01:07/05:07/.../21:07),
# sinon l'analyse se decale d'~1h (toujours apres la cloture, edge quasi inchange).
$times  = @("02:07", "06:07", "10:07", "14:07", "18:07", "22:07")
$logdir = "$proj\routines\logs"
New-Item -ItemType Directory -Force -Path $logdir | Out-Null
$log = "$logdir\register.log"
function Log($m) { $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m"; Write-Output $line; Add-Content -Path $log -Value $line }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
Log "=== register-tasks (admin=$isAdmin, remove=$Remove) ==="

if ($Remove) {
  Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -like "AgentTrader-*" } | ForEach-Object {
    try { Unregister-ScheduledTask -TaskName $_.TaskName -Confirm:$false; Log "Removed $($_.TaskName)" }
    catch { Log "ERR remove $($_.TaskName): $($_.Exception.Message)" }
  }
  Log "=== fin (remove) ==="
  return
}

$ok = 0; $i = 0
foreach ($t in $times) {
  $i++
  $name = "$prefix-$i"
  try {
    $action   = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runner`""
    $trigger  = New-ScheduledTaskTrigger -Daily -At $t
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings `
      -Description "Routine trading agent-trader ($t)" -Force -ErrorAction Stop | Out-Null
    Log "OK  $name a $t"; $ok++
  } catch {
    Log "ERR $name : $($_.Exception.Message)"
  }
}
Log "=== fin : $ok/$i taches routine enregistrees ==="
if ($ok -lt $i) { Log "ECHEC partiel -> relancer EN ADMINISTRATEUR (clic droit > Executer en tant qu'administrateur)" }

# --- Observabilite : dead-man watchdog (horaire) + digest quotidien (08:00) ---
$health = "$proj\routines\health-check.ps1"
try {
  $a1 = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$health`""
  # Repetition horaire : RepetitionDuration MaxValue est rejete par Task Scheduler -> 365 jours (cf. watchdog TV).
  $t1 = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Days 365)
  $s1 = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName "AgentTrader-HealthCheck" -Action $a1 -Trigger $t1 -Settings $s1 `
    -Description "Dead-man watchdog agent-trader (alerte Telegram si l'agent ne bat plus)" -Force -ErrorAction Stop | Out-Null
  Log "OK  AgentTrader-HealthCheck (horaire)"
} catch { Log "ERR HealthCheck : $($_.Exception.Message)" }
try {
  # F3.3 (19.06) : monitor-tick ENTRE les routines (toutes les 30 min) -> ferme l'angle mort 4h.
  # READ-ONLY + alerte seule (position NUE / STALE / flip) ; AUCUN ordre place (approved pour l'auto-exec).
  $mtick = "$proj\routines\monitor-tick.ps1"
  $am = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$mtick`""
  $tm = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 30) -RepetitionDuration (New-TimeSpan -Days 365)
  $sm = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
  Register-ScheduledTask -TaskName "AgentTrader-MonitorTick" -Action $am -Trigger $tm -Settings $sm `
    -Description "Monitoring entre routines (30 min) : alerte Telegram si position NUE/STALE/flip (alerte seule)" -Force -ErrorAction Stop | Out-Null
  Log "OK  AgentTrader-MonitorTick (30 min)"
} catch { Log "ERR MonitorTick : $($_.Exception.Message)" }
try {
  $a2 = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$health`" -Digest"
  $t2 = New-ScheduledTaskTrigger -Daily -At "08:00"
  $s2 = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName "AgentTrader-Digest" -Action $a2 -Trigger $t2 -Settings $s2 `
    -Description "Digest quotidien agent-trader (resume Telegram 08:00)" -Force -ErrorAction Stop | Out-Null
  Log "OK  AgentTrader-Digest (08:00)"
} catch { Log "ERR Digest : $($_.Exception.Message)" }
try {
  # E1 : review hebdo (meta-apprentissage) -> Telegram, dimanche 20:00
  $a3 = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$health`" -Review"
  $t3 = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At "20:00"
  $s3 = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName "AgentTrader-WeeklyReview" -Action $a3 -Trigger $t3 -Settings $s3 `
    -Description "Review hebdo agent-trader (synthese + flags Telegram, dimanche 20:00)" -Force -ErrorAction Stop | Out-Null
  Log "OK  AgentTrader-WeeklyReview (dim 20:00)"
} catch { Log "ERR WeeklyReview : $($_.Exception.Message)" }
try {
  # Piste 5b : revalidation walk-forward des EDGES (decroissance) -> Telegram, ~mensuelle (toutes les 4 semaines, dim 21:00)
  $edge = "$proj\routines\edge-revalidation.ps1"
  $a4 = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$edge`""
  $t4 = New-ScheduledTaskTrigger -Weekly -WeeksInterval 4 -DaysOfWeek Sunday -At "21:00"
  $s4 = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 1)
  Register-ScheduledTask -TaskName "AgentTrader-EdgeRevalidation" -Action $a4 -Trigger $t4 -Settings $s4 `
    -Description "Revalidation walk-forward des edges agent-trader (optimize.js NET, flag decroissance, ~mensuel)" -Force -ErrorAction Stop | Out-Null
  Log "OK  AgentTrader-EdgeRevalidation (4 sem, dim 21:00)"
} catch { Log "ERR EdgeRevalidation : $($_.Exception.Message)" }
