# Revalidation walk-forward des EDGES (piste 5b) -> Telegram.
# Lance edge-revalidate.js (qui run optimize.js sur la donnee marche, snapshot, compare
# au dernier snapshot) et envoie les flags de decroissance d'edge sur Telegram.
# Tache MENSUELLE (AgentTrader-EdgeRevalidation, ~toutes les 4 semaines).
# Independant de notre compteur de trades : re-valide les edges sur la donnee marche.
#
# Usage : powershell -File routines\edge-revalidation.ps1
$ErrorActionPreference = "Stop"
$proj = "C:\Users\admin\Desktop\DEV CLAUDE CODE\projets\agent-trader"
Set-Location $proj
$logdir = "$proj\routines\logs"; New-Item -ItemType Directory -Force -Path $logdir | Out-Null
$log = "$logdir\edge-revalidation.log"
function Log($m) { Add-Content -Path $log -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m" }

Log "=== edge-revalidation start ==="
try {
  $out = node "$proj\trade-journal\edge-revalidate.js" | Out-String
  $r = $out | ConvertFrom-Json
} catch {
  Log "ERR edge-revalidate: $($_.Exception.Message)"
  node "$proj\trade-journal\notify.js" "WARN Agent Trader: edge-revalidation a echoue ($($_.Exception.Message)). Verifier reseau/optimize.js." | Out-Null
  exit 1
}

$flags = ($r.flags -join "`n")
$cmp = if ($r.compared_to) { "vs $($r.compared_to)" } else { "1er snapshot" }
$msg = "Edge revalidation $($r.date) ($cmp, $($r.pairs) paires)`n$flags"
node "$proj\trade-journal\notify.js" $msg | Out-Null
Log "OK ($cmp) flags: $($r.flags -join ' | ')"
Log "=== edge-revalidation fin ==="
