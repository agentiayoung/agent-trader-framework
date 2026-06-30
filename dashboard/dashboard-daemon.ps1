# ===================================================================
#  dashboard-daemon.ps1 -- keep-alive du serveur dashboard (read-only).
#  Relance node si le serveur s'arrete. Lance par la tache planifiee
#  AgentTrader-Dashboard (au logon). ASCII-only. Aucune execution d'ordre.
#  http://127.0.0.1:8787 (DASHBOARD_PORT pour changer).
# ===================================================================
$proj = "C:\Users\admin\Desktop\DEV CLAUDE CODE\projets\agent-trader"
$srv  = "$proj\dashboard\server.js"
$log  = "$proj\dashboard\dashboard.log"
Set-Location $proj
$port = if ($env:DASHBOARD_PORT) { [int]$env:DASHBOARD_PORT } else { 8787 }
while ($true) {
  $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  # Libere le port AVANT de demarrer : tue tout listener residuel (instance
  # manuelle/bloquee) pour repartir sur le code a jour sans EADDRINUSE.
  try {
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique |
      ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
  } catch {}
  Add-Content -Path $log -Value "$ts demarrage serveur dashboard (port $port)"
  try { & node "$srv" *>> $log 2>&1 } catch { Add-Content -Path $log -Value "$ts erreur node: $_" }
  Add-Content -Path $log -Value "$ts serveur arrete -> relance dans 5s"
  Start-Sleep -Seconds 5
}
