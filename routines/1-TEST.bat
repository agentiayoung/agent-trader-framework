@echo off
title Test Routine Trading (1 session)
echo Lancement d une session de routine de test...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-routine.ps1"
echo.
echo === Test termine. Resultat dans routineslogs ===
pause
