# ============================================================================
# tv-cdp-watchdog.ps1 -- Maintient TradingView Desktop en mode CDP debug (h24)
# ----------------------------------------------------------------------------
# TradingView Desktop est distribue UNIQUEMENT en MSIX/Appx (Microsoft Store
# ou sideload .appinstaller). Il n'existe PAS de .exe standalone. Cet Appx
# accepte quand meme --remote-debugging-port quand on lance l'exe resolu via
# Get-AppxPackage (verifie 08.06.2026, commit c2a2986).
#
# Ce watchdog verifie que le Chrome DevTools Protocol ecoute sur le port 9222.
# Si NON :
#   1. tue toute instance TradingView existante (single-instance ignore le flag
#      si TV tourne deja sans debug = la cause classique du "CDP down"),
#   2. relance TradingView.exe (chemin Appx resolu dynamiquement) avec
#      --remote-debugging-port=9222.
#
# DOIT tourner dans la SESSION INTERACTIVE de l'utilisateur (Get-AppxPackage est
# per-user + TradingView est une app GUI). -> lance par tache planifiee au logon.
#
# Usage manuel : powershell -ExecutionPolicy Bypass -File scripts/tv-cdp-watchdog.ps1
# ============================================================================

$ErrorActionPreference = "SilentlyContinue"
$port = 9222
$log  = Join-Path $PSScriptRoot "tv-cdp-watchdog.log"

function Write-Log($msg) {
    $line = "{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
    Add-Content -Path $log -Value $line
    Write-Host $line
}

function Test-Cdp {
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/json/version" -UseBasicParsing -TimeoutSec 3
        return ($r.StatusCode -eq 200)
    } catch { return $false }
}

function Resolve-TVExe {
    # 1) MSIX/Appx (cas reel TradingView) -- resolution dynamique, version-proof
    $pkg = Get-AppxPackage *TradingView* -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($pkg -and $pkg.InstallLocation) {
        $exe = Join-Path $pkg.InstallLocation "TradingView.exe"
        if (Test-Path $exe) { return $exe }
    }
    # 2) Fallback hypothetique build .exe (si un jour TradingView en publie un)
    $candidates = @(
        "$env:LOCALAPPDATA\Programs\TradingView\TradingView.exe",
        "$env:LOCALAPPDATA\TradingView\TradingView.exe"
    )
    foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
    # 3) Fallback : process deja en cours
    $running = Get-Process TradingView -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1
    if ($running -and (Test-Path $running.Path)) { return $running.Path }
    return $null
}

# --- Boucle de verification -------------------------------------------------
if (Test-Cdp) {
    # CDP deja up : rien a faire (silencieux pour ne pas spammer le log toutes les 5 min)
    exit 0
}

Write-Log "CDP injoignable sur port $port -> tentative de relance."

# Tuer les instances existantes (sinon le single-instance avale le flag)
$procs = Get-Process TradingView -ErrorAction SilentlyContinue
if ($procs) {
    Write-Log ("Arret de {0} instance(s) TradingView existante(s)." -f $procs.Count)
    $procs | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
}

$exe = Resolve-TVExe
if (-not $exe) {
    Write-Log "ERREUR: TradingView introuvable (Get-AppxPackage *TradingView* vide). Installer depuis le Store ou https://tvd-packages.tradingview.com/stable/latest/win32/TradingView.appinstaller"
    exit 1
}

Start-Process -FilePath $exe -ArgumentList "--remote-debugging-port=$port"
Write-Log ("TradingView relance en CDP debug: {0}" -f $exe)

# Verification post-lancement (laisse le temps a Electron de demarrer)
Start-Sleep -Seconds 8
if (Test-Cdp) {
    Write-Log "OK: CDP repond maintenant sur le port $port."
} else {
    Write-Log "AVERTISSEMENT: CDP toujours injoignable apres relance (TV met parfois >8s a demarrer; la prochaine passe re-verifiera)."
}
exit 0
