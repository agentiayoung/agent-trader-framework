@echo off
REM ===================================================================
REM  Trading Desk dashboard - lanceur IDEMPOTENT (lecture seule, demo).
REM  - Si un serveur tient deja le port 8787 (tache planifiee/daemon),
REM    on ouvre juste le navigateur : AUCUN second serveur (zero conflit).
REM  - Sinon, on sert en keep-alive (redemarre si arret).
REM  Ouvrir : http://127.0.0.1:8787  (set DASHBOARD_PORT=9000 pour changer)
REM ===================================================================
title Trading Desk Dashboard (read-only)
cd /d "%~dp0.."
if "%DASHBOARD_PORT%"=="" set DASHBOARD_PORT=8787

REM --- deja en cours ? (un listener sur le port) -> ouvrir et sortir ---
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort $env:DASHBOARD_PORT -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if %ERRORLEVEL%==0 (
  echo Dashboard deja en cours sur http://127.0.0.1:%DASHBOARD_PORT% - ouverture du navigateur.
  start "" "http://127.0.0.1:%DASHBOARD_PORT%"
  goto end
)

echo Demarrage du dashboard sur http://127.0.0.1:%DASHBOARD_PORT% (Ctrl+C pour stopper)...
start "" "http://127.0.0.1:%DASHBOARD_PORT%"
:loop
node dashboard\server.js
echo.
echo [%date% %time%] serveur arrete - redemarrage dans 5s (Ctrl+C pour stopper)
timeout /t 5 /nobreak >nul
goto loop

:end
