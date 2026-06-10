# ============================================================================
# install-tv-cdp-task.ps1 - Enregistre la tache planifiee qui garde
# TradingView Desktop en mode CDP debug (port 9222) 24/7.
# ----------------------------------------------------------------------------
# Cree/replace une tache "TradingView-CDP-Watchdog" qui lance le watchdog :
#   - au logon de l'utilisateur,
#   - puis toutes les 5 minutes (auto-reparation apres crash/reboot/ouverture
#     manuelle de TV sans debug).
#
# A lancer UNE FOIS :
#   powershell -ExecutionPolicy Bypass -File scripts\install-tv-cdp-task.ps1
#
# Desinstaller : Unregister-ScheduledTask -TaskName "TradingView-CDP-Watchdog" -Confirm:$false
# ============================================================================

$ErrorActionPreference = "Stop"
$taskName  = "TradingView-CDP-Watchdog"
$watchdog  = Join-Path $PSScriptRoot "tv-cdp-watchdog.ps1"

if (-not (Test-Path $watchdog)) {
    Write-Host "X Watchdog introuvable: $watchdog" -ForegroundColor Red
    exit 1
}

# Action : powershell silencieux -> watchdog
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watchdog`""

# Trigger 1 : au logon de l'utilisateur courant
$trigLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# Trigger 2 : repetition toutes les 5 min. Duree finie valide (365j) car
# [TimeSpan]::MaxValue serialise en P99999999... -> rejete par Task Scheduler (HRESULT 0x80041318).
# Le watchdog se re-arme aussi a chaque logon (trigLogon), donc couverture continue.
$trigRepeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 365)

# GUI app -> doit tourner dans la session interactive de l'utilisateur
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

# Remplacer si existe deja
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "i Ancienne tache supprimee (remplacement)." -ForegroundColor DarkGray
}

Register-ScheduledTask -TaskName $taskName `
    -Action $action -Trigger @($trigLogon, $trigRepeat) `
    -Principal $principal -Settings $settings `
    -Description "Maintient TradingView Desktop en mode CDP debug (port 9222) pour le MCP tradingview-desktop." | Out-Null

Write-Host "OK Tache '$taskName' enregistree (logon + toutes les 5 min)." -ForegroundColor Green
Write-Host "   Lancement immediat pour amorcer..." -ForegroundColor Cyan
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 10

# Verification (ASCII pur pour eviter les soucis d'encodage PowerShell 5.1)
$logPath = Join-Path $PSScriptRoot 'tv-cdp-watchdog.log'
try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:9222/json/version" -UseBasicParsing -TimeoutSec 3
    if ($r.StatusCode -eq 200) {
        Write-Host "OK CDP repond sur le port 9222 - le MCP tradingview-desktop peut se connecter." -ForegroundColor Green
    }
} catch {
    Write-Host "! CDP pas encore joignable (TV peut mettre quelques secondes; la tache re-verifiera toutes les 5 min)." -ForegroundColor Yellow
    Write-Host "  Log: $logPath" -ForegroundColor DarkGray
}
