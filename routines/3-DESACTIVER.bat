@echo off
title Desactiver les routines
echo Suppression des taches planifiees...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0register-tasks.ps1" -Remove
echo.
echo === Routines desactivees. ===
pause
