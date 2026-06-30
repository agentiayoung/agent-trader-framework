@echo off
title Activer les routines agent-trader (6 routines/jour + monitoring + EntryRadar)
:: --- Auto-elevation administrateur (UAC) ---
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Demande des droits administrateur ^(accepte la fenetre UAC^)...
  powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
echo Enregistrement des taches planifiees (6 routines + HealthCheck + MonitorTick + Digest + WeeklyReview + EdgeRevalidation + EntryRadar)...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0register-tasks.ps1"
echo.
echo === Termine. Verifier ci-dessus : toutes les lignes OK. ===
echo Pour desactiver : lancer 3-DESACTIVER.bat
pause
