@echo off
REM ============================================================
REM  Lance TradingView Desktop (install Microsoft Store / Appx)
REM  en mode CDP debug (port 9222) pour le MCP tradingview-desktop.
REM  Resout le chemin dynamiquement (robuste aux mises a jour de version).
REM  Double-clic pour lancer. Pas besoin de -ExecutionPolicy Bypass.
REM ============================================================
powershell -NoProfile -Command "$p=(Get-AppxPackage *TradingView*).InstallLocation; if(-not $p){Write-Host 'TradingView Desktop introuvable (Appx).'; exit 1}; $exe=Join-Path $p 'TradingView.exe'; Start-Process -FilePath $exe -ArgumentList '--remote-debugging-port=9222'; Write-Host ('Lance en mode debug CDP 9222: '+$exe)"
echo.
echo TradingView Desktop lance avec le port debug CDP 9222.
echo IMPORTANT : garde l'indicateur "Ranked Support ^& Resistance Zones (Zeiierman)"
echo affiche sur le chart pour que l'agent puisse lire les zones.
echo Laisse cette app ouverte pendant la semaine de validation des routines.
timeout /t 6 >nul
