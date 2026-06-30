# valider-ps1.ps1 -- valide la SYNTAXE (Parser::ParseFile) + l'ASCII-only des .ps1 du projet agent-trader.
# Convention CLAUDE.md : tout .ps1 doit etre ASCII-only ET passer ParseFile sans erreur.
# Lancement : double-clic VALIDER-PS1.bat  (ou)  powershell -ExecutionPolicy Bypass -File routines\valider-ps1.ps1
# Sortie : [OK] par fichier valide, [FAIL] + ligne:colonne + message par erreur. Code de sortie 0 = tout bon.

$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$files = @("run-routine.ps1", "entry-radar.ps1", "register-tasks.ps1", "health-check.ps1", "monitor-tick.ps1", "monitor-manage.ps1")
$allOk = $true

Write-Host ""
Write-Host "=== Validation .ps1 agent-trader (ParseFile + ASCII) ===" -ForegroundColor Cyan
Write-Host ""

foreach ($f in $files) {
  $path = Join-Path $dir $f
  if (-not (Test-Path $path)) { Write-Host "[SKIP] $f introuvable"; continue }

  # 1) Syntaxe PowerShell via l'AST officiel.
  $tokens = $null
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors) | Out-Null

  # 2) ASCII-only (convention .ps1).
  $bytes = [System.IO.File]::ReadAllBytes($path)
  $nonAscii = @($bytes | Where-Object { $_ -gt 127 }).Count

  if ($errors.Count -eq 0 -and $nonAscii -eq 0) {
    Write-Host "[OK]   $f  (0 erreur syntaxe, 0 non-ASCII)" -ForegroundColor Green
  } else {
    $allOk = $false
    Write-Host "[FAIL] $f" -ForegroundColor Red
    if ($nonAscii -gt 0) {
      Write-Host "       $nonAscii octet(s) non-ASCII -- la convention impose ASCII-only (pas d'accents)." -ForegroundColor Yellow
    }
    foreach ($e in $errors) {
      $ln = $e.Extent.StartLineNumber
      $col = $e.Extent.StartColumnNumber
      Write-Host ("       L{0}:{1}  {2}" -f $ln, $col, $e.Message) -ForegroundColor Yellow
    }
  }
}

Write-Host ""
if ($allOk) {
  Write-Host "RESULTAT : TOUS LES .PS1 SONT VALIDES (syntaxe + ASCII)." -ForegroundColor Green
  Write-Host ""
  exit 0
} else {
  Write-Host "RESULTAT : DES ERREURS A CORRIGER (voir ci-dessus)." -ForegroundColor Red
  Write-Host ""
  exit 1
}
