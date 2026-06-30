# ===================================================================
#  register-dashboard-task.ps1 -- enregistre (ou -Remove) la tache
#  planifiee du DASHBOARD (serveur web read-only, port 8787).
#  Demarre AU LOGON + survit a la session (keep-alive dashboard-daemon.ps1).
#  LANCER EN ADMINISTRATEUR. ASCII-only. Demo, lecture seule, aucun ordre.
#    Installer : powershell -ExecutionPolicy Bypass -File register-dashboard-task.ps1
#    Retirer   : powershell -ExecutionPolicy Bypass -File register-dashboard-task.ps1 -Remove
# ===================================================================
param([switch]$Remove)
$ErrorActionPreference = "Continue"

$proj   = "C:\Users\admin\Desktop\DEV CLAUDE CODE\projets\agent-trader"
$daemon = "$proj\dashboard\dashboard-daemon.ps1"
$name   = "AgentTrader-Dashboard"
$logdir = "$proj\routines\logs"
New-Item -ItemType Directory -Force -Path $logdir | Out-Null
$log = "$logdir\register.log"
function Log($m) { $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m"; Write-Output $line; Add-Content -Path $log -Value $line }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
Log "=== register-dashboard-task (admin=$isAdmin, remove=$Remove) ==="

if ($Remove) {
  try { Unregister-ScheduledTask -TaskName $name -Confirm:$false; Log "Removed $name" }
  catch { Log "ERR remove $name : $($_.Exception.Message)" }
  Log "=== fin (remove) ==="
  return
}

# PRINCIPAL S4U (anti-flash) : tourne que l'utilisateur soit connecte ou non, SANS mot de passe,
# en arriere-plan (pas de fenetre PowerShell qui flashe). Coherent avec les autres taches.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERNAME" -LogonType S4U -RunLevel Limited
$action    = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$daemon`""
$trigger   = New-ScheduledTaskTrigger -AtLogOn
# ExecutionTimeLimit 0 = AUCUNE limite (c'est un daemon) ; restart si le process meurt.
$settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0)

try {
  Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
  Log "Registered $name (AtLogOn, keep-alive daemon)"
  try { Start-ScheduledTask -TaskName $name; Log "Demarre maintenant -> http://127.0.0.1:8787" }
  catch { Log "ERR start $name : $($_.Exception.Message)" }
} catch {
  Log "ERR register $name : $($_.Exception.Message)"
}
Log "=== fin ==="
