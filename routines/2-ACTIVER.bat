@echo off
title Activer les 6 routines/jour (clotures 4H)
echo Enregistrement des 6 taches planifiees (02h07 / 06h07 / 10h07 / 14h07 / 18h07 / 22h07)...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0register-tasks.ps1"
echo.
echo === Termine. Verifier ci-dessus : 6/6 taches enregistrees. ===
echo Pour desactiver : lancer 3-DESACTIVER.bat
pause
