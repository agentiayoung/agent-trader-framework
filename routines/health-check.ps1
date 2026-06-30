# Dead-man switch LOCAL de l'agent trader.
# Lit le heartbeat (ecrit a chaque routine) ; si perime (> HEARTBEAT_MAX_AGE_MIN,
# defaut 300 min = 5h car routines toutes les 4h) -> ALERTE Telegram.
# Detecte : Task Scheduler desactive, claude CLI en echec, TV Desktop down, PC qui dort.
# (Le dead-man EXTERNE qui survit au PC eteint = HEALTHCHECK_PING_URL pingue par 'journal.js heartbeat'.)
#
# -Digest : envoie aussi le digest consolide (resume quotidien).
# Usage : powershell -File routines\health-check.ps1            (watchdog horaire)
#         powershell -File routines\health-check.ps1 -Digest    (resume quotidien)
param([switch]$Digest, [switch]$Review)
$ErrorActionPreference = "Stop"
$proj = "C:\Users\admin\Desktop\DEV CLAUDE CODE\projets\agent-trader"
Set-Location $proj
$logdir = "$proj\routines\logs"; New-Item -ItemType Directory -Force -Path $logdir | Out-Null
$log = "$logdir\health-check.log"
function Log($m) { Add-Content -Path $log -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m" }

try {
  $r = node "$proj\trade-journal\journal.js" heartbeat-check | ConvertFrom-Json
} catch {
  Log "ERR heartbeat-check: $($_.Exception.Message)"
  node "$proj\trade-journal\notify.js" "WARN Agent Trader: health-check n'a pas pu lire le heartbeat ($($_.Exception.Message)). Verifier PC/Node." | Out-Null
  exit 1
}

if ($r.stale) {
  $msg = "AGENT TRADER DOWN -- aucun heartbeat depuis > $($r.max_age_min) min (dernier: $($r.last)). Verifier: PC allume, Task Scheduler actif, TradingView Desktop, claude CLI."
  node "$proj\trade-journal\notify.js" $msg | Out-Null
  Log "STALE -> alerte envoyee (last=$($r.last))"
} elseif ($r.last_complete -eq $false) {
  # GAP COMBLE (10.06) : l'agent est VIVANT (heartbeat frais) MAIS la derniere routine n'a PAS trade
  # (claude mort tot = cap usage, les post-steps PowerShell ont quand meme tire le heartbeat).
  # Le stale-check seul ratait ce cas (faux 'OK'). Reset auto au prochain run complet.
  $msg = "AGENT TRADER INCOMPLET -- vivant (heartbeat $($r.last)) mais la derniere routine n'a PAS trade: $($r.last_incomplete_reason). Cap usage probable (reset ~23h10) -- aucune gestion ce cycle. Verifier."
  node "$proj\trade-journal\notify.js" $msg | Out-Null
  Log "INCOMPLETE -> alerte envoyee (raison=$($r.last_incomplete_reason))"
} else {
  Log "OK (last=$($r.last), open=$($r.open), pending=$($r.pending), complete)"
}

# BACKSTOP MONITORING (16.06) : meme heartbeat OK, verifier que monitor.js a tourne recemment
# QUAND des positions sont ouvertes (detecte un wiring monitor casse silencieusement). Lecture
# SEULE de monitor-state.json (AUCUN reseau -> jamais de faux positif reseau). Best-effort.
try {
  $open = 0; try { $open = [int]$r.open } catch {}
  if ($open -gt 0) {
    $w = node "$proj\trade-journal\monitor.js" --watchdog | ConvertFrom-Json
    $maxAgeMin = if ($env:MONITOR_MAX_AGE_H) { [double]$env:MONITOR_MAX_AGE_H * 60 } else { 300 }
    $tracked = [int]$w.n_tracked
    $ageOk = ($null -ne $w.freshest_age_min) -and ([double]$w.freshest_age_min -le $maxAgeMin)
    if ($tracked -eq 0 -or -not $ageOk) {
      $age = if ($null -ne $w.freshest_age_min) { "$($w.freshest_age_min) min" } else { "jamais" }
      node "$proj\trade-journal\notify.js" "WARN monitoring: $open position(s) ouverte(s) mais monitor.js n'a pas tourne recemment (suivi: $tracked positions, dernier: $age). Verifier le wiring monitor dans la routine." | Out-Null
      Log "MONITOR-WATCHDOG alerte (open=$open tracked=$tracked age=$($w.freshest_age_min))"
    } else {
      Log "monitor-watchdog OK (open=$open tracked=$tracked age=$($w.freshest_age_min) min)"
    }
  }
} catch { Log "monitor-watchdog skip: $($_.Exception.Message)" }

if ($Digest) {
  node "$proj\trade-journal\journal.js" digest send | Out-Null
  Log "digest envoye"
}
if ($Review) {
  node "$proj\trade-journal\journal.js" review send | Out-Null
  Log "review hebdo envoyee"
}
