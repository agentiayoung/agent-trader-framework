# Lance TradingView Desktop en mode CDP debug (port 9222) sur Windows.
# Usage : powershell -ExecutionPolicy Bypass -File scripts/launch-tradingview-debug.ps1
# Le MCP tradingview-desktop se connecte ensuite via Chrome DevTools Protocol.

$ErrorActionPreference = "Stop"
$port = 9222

# Emplacements connus de TradingView Desktop sur Windows
$candidates = @(
    "$env:LOCALAPPDATA\TradingView\TradingView.exe",
    "$env:LOCALAPPDATA\Programs\TradingView\TradingView.exe",
    "$env:PROGRAMFILES\TradingView\TradingView.exe",
    "${env:PROGRAMFILES(X86)}\TradingView\TradingView.exe"
)

$exe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1

# Fallback 1: reuse the running TradingView process path (works for WindowsApps installs).
if (-not $exe) {
    $running = Get-Process TradingView -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($running -and $running.Path -and (Test-Path $running.Path)) {
        $exe = $running.Path
    }
}

# Fallback 2: search WindowsApps install.
if (-not $exe) {
    $windowsApps = Get-ChildItem "$env:PROGRAMFILES\WindowsApps" -Filter "TradingView*" -Directory -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if ($windowsApps) {
        $waExe = Join-Path $windowsApps.FullName "TradingView.exe"
        if (Test-Path $waExe) {
            $exe = $waExe
        }
    }
}

if (-not $exe) {
    Write-Host "X TradingView Desktop introuvable dans les emplacements connus :" -ForegroundColor Red
    $candidates | ForEach-Object { Write-Host "   - $_" }
    Write-Host "   - $env:PROGRAMFILES\WindowsApps\TradingView*\TradingView.exe" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "Installer TradingView Desktop : https://www.tradingview.com/desktop/" -ForegroundColor Yellow
    Write-Host "Ou utiliser le tool MCP 'tv_launch' qui auto-detecte le chemin." -ForegroundColor Yellow
    exit 1
}

# Verifier que le port 9222 n'est pas deja occupe
$inUse = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($inUse) {
    Write-Host "! Le port $port est deja en ecoute (TradingView deja lance en mode debug ?)." -ForegroundColor Yellow
    Write-Host "  Verifier avec le tool MCP 'tv_health_check'." -ForegroundColor Yellow
    exit 0
}

Start-Process -FilePath $exe -ArgumentList "--remote-debugging-port=$port"
Write-Host "OK TradingView lance sur CDP port $port ($exe)" -ForegroundColor Green
Write-Host "   Verifier la connexion : dans Claude Code, demander 'Use tv_health_check'." -ForegroundColor Cyan
