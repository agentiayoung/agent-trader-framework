# Lance une session Claude Code headless qui execute la routine de trading.
# Tourne en LOCAL -> acces complet : repo, config/.env (cles Bybit), skills node, MCP screener.
# Usage : powershell -File routines\run-routine.ps1            (auto / planifie)
#         powershell -File routines\run-routine.ps1 -Manual    (manuel : test ou trade delibere par Hugo)
param([switch]$Manual)
$ErrorActionPreference = "Stop"
# Logs en UTF-8 sans BOM : evite la corruption NUL/UTF-16 du redirect *>> $log melange a Add-Content
# (logs illisibles + diagnostic routine-status impossible). Console + redirections en UTF-8.
try { $OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}
# GARDE-FOU MCP (fix 19.06) : borne chaque appel d'outil MCP -> un MCP qui ne repond pas ne peut plus
# faire HANGER un run (cas 22:07 du 18.06 : 2h+ bloque sur un MCP). 30s/appel + 20s init serveur.
if (-not $env:MCP_TOOL_TIMEOUT) { $env:MCP_TOOL_TIMEOUT = "15000" }
if (-not $env:MCP_TIMEOUT) { $env:MCP_TIMEOUT = "20000" }
$proj = "C:\Users\admin\Desktop\DEV CLAUDE CODE\projets\agent-trader"
Set-Location $proj
New-Item -ItemType Directory -Force -Path "$proj\routines\logs" | Out-Null
$src = if ($Manual) { "manuel" } else { "auto" }
$ts  = Get-Date -Format "yyyy-MM-dd_HH-mm"
$log = "$proj\routines\logs\routine_${ts}_${src}.log"

# WATCHDOG (29.06) : borne le wall-clock de CHAQUE passe claude -p. Sans ca, opus + ~20 serveurs MCP
# peut HANGER indefiniment (cas 29.06 15:55 : >30 min, log fige) et empiler les runs en brulant du
# budget. Timeout via $env:ROUTINE_TIMEOUT_MIN (defaut 12 ; 0 = desactive). Le prompt est passe en
# STDIN (fichier temp UTF-8) -> aucun probleme de quoting du prompt geant. Start-Process -PassThru
# donne le PID -> au depassement, taskkill /T /F tue l'ARBRE (claude + enfants MCP node detaches =
# le bug du 29.06). Retour : exit code du process (124 = timeout watchdog ; 125 = echec lancement).
function Invoke-ClaudeTimed {
  param([string]$Prompt, [string[]]$ClaudeArgs, [string]$LogPath, [int]$TimeoutMin)
  $pf = [System.IO.Path]::GetTempFileName()
  $of = "$pf.out"; $ef = "$pf.err"
  [System.IO.File]::WriteAllText($pf, $Prompt, (New-Object System.Text.UTF8Encoding $false))
  $code = 0
  # 'claude' est un .ps1 (non lancable par Start-Process) -> on cible le shim .cmd de npm (lancable,
  # gere correctement les args a espaces/parentheses comme --allowedTools). Resolu via PATH, fallback %APPDATA%.
  $claudeExe = (Get-Command "claude.cmd" -ErrorAction SilentlyContinue).Source
  if (-not $claudeExe) { $claudeExe = Join-Path $env:APPDATA "npm\claude.cmd" }
  try {
    $p = Start-Process -FilePath $claudeExe -ArgumentList $ClaudeArgs -NoNewWindow -PassThru `
         -RedirectStandardInput $pf -RedirectStandardOutput $of -RedirectStandardError $ef
    if ($TimeoutMin -gt 0) {
      if (-not $p.WaitForExit($TimeoutMin * 60 * 1000)) {
        Add-Content -Path $LogPath -Value "[WATCHDOG] timeout ${TimeoutMin}min -> kill arbre PID $($p.Id)"
        try { taskkill /PID $p.Id /T /F 2>&1 | Out-Null } catch {}
        try { [void]$p.WaitForExit(5000) } catch {}
        $code = 124
      } else { $code = $p.ExitCode }
    } else { $p.WaitForExit(); $code = $p.ExitCode }
    # ExitCode peut revenir $null pour un shim .cmd -> coerce a 0 (le vrai gate de completude = la
    # ligne ajoutee au journal, verifiee plus bas ; on ne veut pas un faux INCOMPLETE sur succes).
    if ($null -eq $code) { $code = 0 }
  } catch {
    Add-Content -Path $LogPath -Value "[WATCHDOG] echec lancement claude: $_"
    $code = 125
  }
  foreach ($fpart in @($of, $ef)) { if (Test-Path $fpart) { Get-Content $fpart -Raw -ErrorAction SilentlyContinue | Add-Content -Path $LogPath } }
  Remove-Item $pf, $of, $ef -Force -ErrorAction SilentlyContinue
  return $code
}
$routineTimeoutMin = if ($env:ROUTINE_TIMEOUT_MIN) { [int]$env:ROUTINE_TIMEOUT_MIN } else { 12 }

# RADAR D'ENTREE (M002, GO Hugo 22.06) : ENTRY_RADAR_ARM=1 -> l'orchestrateur ARME les trades
# (journal.js arm) au lieu de poser direct ; le radar (entry-radar.js : appel en FIN de routine +
# tache planifiee 15 min) confirme la bougie PAR FAMILLE puis pose le limit MAKER + preflight + log.
# Mettre a "0" pour revenir au post direct (reversible). Mode -Manual = post DIRECT (decision Hugo).
if (-not $env:ENTRY_RADAR_ARM) { $env:ENTRY_RADAR_ARM = "1" }
$radarArm = ($env:ENTRY_RADAR_ARM -eq "1") -and (-not $Manual)
$armDirective = if ($radarArm) { "MODE ENTREE = RADAR (ENTRY_RADAR_ARM=1, GO Hugo 22.06) : a l'etape (6), NE POSE PAS le bracket toi-meme via bybit_place_limit_bracket. A la place, APRES un preflight ok, ARME chaque trade decide via node trade-journal/journal.js arm avec un JSON {symbol, side, setup, level (= ton entree/zone de fade), sl, take_profits (les memes paliers que placement.js : TP1 a 0.2xATR proche pour banquer vite / TP2 consequent / runner), risk_usd, atr, rationale, invalidation, track}. Le radar d'entree (entry-radar.js, tourne en FIN de routine + toutes les 15 min) CONFIRME la bougie PAR FAMILLE (MR/S5/MR4 = immediat ; zone = sweep+reclaim ; S1/S2/S12 tendance = rejet au niveau) PUIS pose le limit MAKER + preflight DUR + journalise AUTOMATIQUEMENT avec ta rationale (tag entry_via:radar). Tu fais TOUJOURS scan / selection / zones / placement / sizing / preflight comme d'habitude ; SEULE la pose finale passe par arm au lieu de bybit_place_limit_bracket, et tu NE logges PAS toi-meme le trade arme (le radar le fait). Le reste (gestion des positions DEJA ouvertes, monitor.js, reconcile, thesis-check, report) est STRICTEMENT INCHANGE. " } else { "" }

$promptBull = "ROLE = PROPOSEUR BULL (read-only, AUCUNE execution: tu n'as PAS bybit, tu ne poses AUCUN ordre, tu ne reconcilies pas). Ta SEULE sortie = ecrire le fichier trade-journal/proposals/bull.json. Lis routines/trade-routine.md et applique PHASE 1 (CONTEXTE/SENTIMENT, en LECTURE seule: pas de reconcile ni de gestion) puis PHASE 2 (role PROPOSEUR BULL). PHILOSOPHIE price-action-first: la PRICE ACTION DECIDE, les edges (regime_fit/EDGE/matrice) INFORMENT = contexte de confluence, jamais un entonnoir. BILATERAL reel: tu cherches le MEILLEUR LONG. Etapes: (1) lis trade-journal/LESSONS.md + JOURNAL.md + tradingview/STRATEGY_MATRIX.md (contexte). (2) node trade-journal/scan.js -> lis scan.opportunities cote long + scan.perception_candidates (F4 = candidats LONG que le catalogue d'edges RATE : confluence tier>=B + structure MSS/CHoCH up + zone fraiche/bougie ; track:experiment, OBSERVABILITE, la price action decide) + scan.price_action_tradable (actifs histo court = PRICE ACTION PURE) + market.* (posture, regime, bottom_watch, dispersion, options, fear_greed) + divergence/obv/beta. (3) SOURCE UNIQUE = node scan.js (deterministe, rapide : il a DEJA perception + confluence + tous les actifs + opportunities + perception_candidates). Tu listes/choisis tes candidats DEPUIS scan.js, PAS de MCP cote proposeur (un MCP bloquant a fait tourner un run 2h+ le 18.06 -> les proposeurs n'ont plus acces aux MCP). C'est l'ORCHESTRATEUR qui fera la confirmation MCP profonde (coin_analysis / zones Desktop) sur le seul trade RETENU. (4) Choisis TOUS les candidats LONG qui qualifient (jusqu'a 4 ; crypto via scan.opportunities ET non-crypto via scan.price_action_tradable equities/ETF bullish ; NE DROPPE AUCUN setup long valable = propose chaque proposition possible) par LECTURE DE STRUCTURE (support/retrace tenu, reclaim, divergence haussiere, momentum 1H, niveau-aimant put_wall/max_pain). Chaque opportunite porte un bloc perception (confluence 0-100 structure/zones/bougie, deterministe) = appui de confluence (informe, ne gate pas). PLANCHER DUR a respecter dans la proposition: SL anti-sweep (au-dela des meches + buffer >=0.3xATR), geometrie par famille, DEMO. CONTEXTE = INFO JAMAIS BLOCAGE (directive Hugo 18.06) : divergence:bear / relief_rally / Extreme Fear / STRONG bear = a NOTER dans warnings de la proposition (risque squeeze/dead-cat -> suggere taille reduite + SL anti-sweep large + PREFERER les actifs DECORRELES gold XAUT / stocks Mag7/SPY/QQQ qui ne sont PAS squeezes par un relief-rally CRYPTO), ce N'EST JAMAIS un interdit de proposer. En demo le gate reclaim EMA200d est leve pour track:experiment. TU PROPOSES TOUJOURS LE MEILLEUR LONG du jour (le moins mauvais si le regime est hostile) en couvrant crypto + stocks + gold -> proposals JAMAIS vide un jour de marche ouvert ; no_proposal_reason UNIQUEMENT si litteralement aucune structure exploitable nulle part (tres rare). (5) ECRIS trade-journal/proposals/bull.json au format EXACT de PHASE 2: role,date,time,market_read,proposals[{symbol,side,entry,sl,tp,setup_context,price_action,thesis,invalidation,conviction,edges_note,warnings}],no_proposal_reason. Tu ne logges RIEN au journal, tu ne notifies pas, tu ne poses aucun bracket. Termine par 1 ligne: BULL: reco ou no-proposal."
$promptBear = "ROLE = PROPOSEUR BEAR (read-only, AUCUNE execution: pas de bybit, aucun ordre, pas de reconcile). Ta SEULE sortie = ecrire le fichier trade-journal/proposals/bear.json. Lis routines/trade-routine.md et applique PHASE 1 (CONTEXTE, LECTURE seule) puis PHASE 2 (role PROPOSEUR BEAR). PHILOSOPHIE price-action-first: la PRICE ACTION DECIDE, les edges INFORMENT (contexte, pas un entonnoir). BILATERAL reel: tu cherches le MEILLEUR SHORT. Etapes: (1) lis trade-journal/LESSONS.md + JOURNAL.md + tradingview/STRATEGY_MATRIX.md. (2) node trade-journal/scan.js -> scan.opportunities cote short + scan.perception_candidates cote short (F4 = setups que le catalogue rate, track:experiment) + price_action_tradable + market.* + divergence/obv/beta. (3) SOURCE UNIQUE = node scan.js (deterministe, rapide : il a DEJA perception + confluence + tous les actifs + opportunities + perception_candidates). Tu listes/choisis tes candidats DEPUIS scan.js, PAS de MCP cote proposeur (un MCP bloquant a fait tourner un run 2h+ le 18.06 -> les proposeurs n'ont plus acces aux MCP). C'est l'ORCHESTRATEUR qui fera la confirmation MCP profonde (coin_analysis / zones Desktop) sur le seul trade RETENU. (4) Choisis TOUS les candidats SHORT qui qualifient (jusqu'a 4 ; crypto via scan.opportunities ET non-crypto via scan.price_action_tradable equities/ETF bearish ; NE DROPPE AUCUN setup short valable = propose chaque proposition possible) par LECTURE DE STRUCTURE (resistance/rejet, lower-high, divergence baissiere, momentum 1H baissier, niveau-aimant call_wall). Chaque opportunite porte un bloc perception (confluence 0-100 structure/zones/bougie, deterministe) = appui de confluence (informe, ne gate pas). PLANCHER DUR: SL anti-sweep (au-dela des meches + buffer >=0.3xATR), geometrie par famille, DEMO. CONTEXTE = INFO JAMAIS BLOCAGE (directive Hugo 18.06) : divergence:bull / at_cycle_low / relief_rally.active = a NOTER dans warnings (squeeze prouve DOGE/TAO/LINK/XRP/SUI -> suggere taille reduite + SL anti-sweep + PREFERER actifs DECORRELES gold XAUT / stocks Mag7/SPY/QQQ), ce N'EST JAMAIS un interdit de proposer. TU PROPOSES TOUJOURS LE MEILLEUR SHORT du jour en couvrant crypto + stocks + gold -> proposals JAMAIS vide un jour de marche ouvert ; no_proposal_reason UNIQUEMENT si litteralement aucune structure exploitable nulle part. (5) ECRIS trade-journal/proposals/bear.json au format EXACT de PHASE 2 (memes champs que bull, side=short). Tu ne logges RIEN, ne notifies pas, ne poses aucun bracket. Termine par 1 ligne: BEAR: reco ou no-proposal."
$promptOrch = $armDirective + "ROLE = ORCHESTRATEUR (le SEUL qui execute, suit, documente). PRIORITE #1 = LE TRADE LIVE EN ROUTINES: prise de position + monitoring proactif sur la data LIVE; le backtest/edge-sprint = INPUT pour COMPRENDRE, PAS le produit; biais vers l'ACTION (le no-trade est legitime mais PAS le defaut). DEMO_ACTIVE (on est en DEMO): objectif #1 = TRADER ACTIVEMENT pour tester/optimiser l'infra; les gates BLOQUANTS (halt/drawdown, perte-jour, quota, exposition, R:R, posture defensive, throttle relief-rally) deviennent du CONTEXTE que TU arbitres (preflight les renvoie en warnings avec demo_active:true). RESTENT DURS et non negociables: SL obligatoire, geometrie anti-sweep (sl-check), sizing correct (risk_usd = size x dist SL), DEMO only (jamais de reel). PHILOSOPHIE price-action-first: la PRICE ACTION DECIDE, les edges INFORMENT (contexte de confluence, pas un entonnoir). BILATERAL reel: long ET short a egalite; si aucun short ne qualifie, prends le MEILLEUR LONG (track:experiment). Lis routines/trade-routine.md et applique PHASE 1 (CONTEXTE/SENTIMENT complete) puis PHASE 3 (ORCHESTRATEUR). Lis d'abord trade-journal/LESSONS.md + JOURNAL.md + tradingview/STRATEGY_MATRIX.md + tradingview/DESKTOP_INDICATORS.md + tradingview/ZEIIERMAN_ZONES.md. Etapes OBLIGATOIRES dans l'ordre: (0) node trade-journal/journal.js today. (1) node trade-journal/journal.js reconcile (orphan_orders -> node skills/bybit/index.js bybit_cancel_all) + risk (breaker) + exposure. MONITORING DETERMINISTE PERSISTANT (OBLIGATOIRE, filet anti-oubli, AVANT toute prise de nouveau trade): node trade-journal/monitor.js en passant les positions de reconcile en argument JSON -> applique CHAQUE plan retourne: place_sl (priority:critical) = poser le SL IMMEDIATEMENT (position nue INTERDITE = plancher dur), set_trailing = bybit_set_trailing_stop (gagnante >=1R), tighten_sl / take_partial_be / take_partial_lock selon l'action; tout stale[] = ALERTER (gap de gestion). Cela GARANTIT qu'aucune position open n'est oubliee ni laissee sans SL entre les routines (monitor-state.json persiste le suivi). PUIS GERER chaque position/pending: brief node trade-journal/journal.js trade <id>, keep/cancel/reposition, entree-rebond ratee, pruning, trailing natif >=1R, note timeline (node trade-journal/journal.js note), reflexion post-trade 3 questions sur les trades clotures (node trade-journal/journal.js set). (2) node trade-journal/scan.js (univers multi-actifs; tradable:true SEULEMENT; histo court = price_action track:experiment demi-taille; scan.opportunities est TRIE par combined_score = edge x confluence /14 alignee, chaque opp porte combined_score + perception_score14 + perception_aligned -> les MEILLEURS trades en TETE, perception_aligned:false = confluence a l'oppose du setup = prudence ; scan.perception_candidates = F4 candidats directionnels souvent LONGS que le catalogue d'edges RATE -> levier BILATERAL, a prendre en track:experiment, OBSERVABILITE non backtestee) PUIS node trade-journal/journal.js thesis-check (monitoring bidirectionnel running/mature/flipped/weakening, trail trend-adaptatif, relief-aware) -- chaque position porte aussi sa TRAJECTOIRE {mfe_R (pic atteint), mae_R (pire creux), giveback_pct (% du pic rendu), velocity}: GIVE-BACK fort (un gagnant qui rend >40% du pic) -> PRENDRE LE TP PLUS TOT (take_partial + resserrer) ; velocity stalling/reversing -> resserrer le trail ; MAE profond mais recupere -> NE PAS resserrer trop tot (anti-sweep). Cite les chiffres trajectoire dans la note timeline. Lis market.posture/regime/bottom_watch/dispersion/options/fear_greed. PERCEPTION (OBSERVABILITE, Phase 9): chaque opportunite du scan porte un bloc perception {trend, choch/mss, nearest_zone, candle, confluence{score14 (echelle /14 = LA MEME que le scoring /14 en place), tier A+/B/sub, side, decision wait/long/short/no_trade, conviction}} calcule en DETERMINISTE (chaine structure->zones->bougie). LIS-le comme CONFLUENCE: la PRICE ACTION DECIDE, la confluence INFORME (PAS un gate dur). Le tier confluence parle la MEME langue que ton /14 et pilote le SIZING: tier A+ (score14>=9) = haute conviction pleine taille, B (>=6) = demi-taille, sub = confluence faible (prudence/demi ou skip). Sur ton/tes candidat(s) retenu(s) lance node trade-journal/journal.js perception <SYMBOL> pour la confluence PROFONDE (avec orderflow: cvd, sweep, oi_signal, absorption) et CITE score14+tier+breakdown dans la rationale. decision:wait = prix dans une zone sans reaction confirmee. Croise ce /14 DETERMINISTE (OHLCV) avec ton /14 lu sur Desktop = double lecture de confluence. AUSSI: node skills/bybit/feed.js <SYMBOL> pour la microstructure LIVE (imbalance, walls bid/ask, OI, funding, aggression flow) = OBSERVABILITE PURE, contexte de rationale (wall ask proche resistance = obstacle; funding negatif + imbalance bids = squeeze; jamais un gate). NOTE AUDIT 18.06: le score14 du scan est plafonne a ~10/14 (orderflow=0 dans le scan compact car pas de fetch trades pour les 18 paires); le plein score orderflow n'est disponible qu'ici via journal.js perception. (3) ARBITRAGE: lis trade-journal/proposals/bull.json + trade-journal/proposals/bear.json (s'ils existent; sinon genere tes candidats depuis le scan), confronte bull case vs bear case au SENTIMENT LIVE, choisis le ou les meilleur(s) trade(s) en bilateral (hedge L+S seulement si dispersion.hedge_enabled). PONDERE le CONTEXTE (relief_rally / defensive / Extreme Fear / STRONG bear = INFO a interpreter, JAMAIS un blocage - directive Hugo 18.06) : en regime hostile -> reduire la taille, PREFERER les actifs DECORRELES (gold XAUT / stocks ne sont PAS squeezes par un relief-rally CRYPTO), preferer confluence A+ + geometrie anti-sweep propre, eventuellement attendre un meilleur prix (limit). TU EXECUTES TOUJOURS la/les meilleure(s) opportunite(s) du jour parmi les propositions (biais ACTION en demo) ; le no-trade TOTAL n'est legitime QUE si AUCUNE proposition n'a de geometrie valide au preflight. Les garde-fous DURS (SL/geometrie anti-sweep/sizing/no-duplicate/DEMO) restent intacts et non negociables. (4) ZONES Desktop: node scripts/tv-preflight.js puis lecture Zeiierman/Fib/StochRSI/AI Supertrend/AI Signal/regime (fallback pivots screener si CDP down, zones=screener_fallback). (5) DISPOSITION node trade-journal/placement.js pour tout FADE (S1/S2/S5/MR4/MR8) + entree echelonnee (MR, et S1/S2 trending) + taille node trade-journal/journal.js size avec edge (S5 1.4 / MR8 1.2 / S1 1.0 / S2 0.8 trending / S12 0.8 trending / MR4 0.6 / S3 0.6). (6) GATE node trade-journal/journal.js preflight (ok:false=STOP hors demo; en demo les bloquants sont des warnings arbitres, SL+geometrie restent DURS) PUIS node skills/bybit/index.js bybit_place_limit_bracket (limit/maker par defaut, marge ISOLEE par position) PUIS node trade-journal/journal.js verify-bracket (critical:true -> corriger le SL a la taille reelle) PUIS node trade-journal/journal.js log (rationale + zones + setup S# + bloc score{components,gate,zones} + bloc perception (RECOPIE le perception de l'opportunite retenue dans le payload -> le code derive score_perception /14 DETERMINISTE aligne au sens, alimente score-eval.by_perception) + champ invalidation + contre_these sur A+; track:experiment pour long de bottom/price-action; risk_usd OBLIGATOIRE sur un ladder). no_trade -> log status:no_trade + hypo{symbol,side,entry,sl,tp}. (7) SUIVI/recyclage: applique les verdicts thesis-check; mature/flipped liberent un slot -> chercher le prochain trade. (8) node trade-journal/journal.js strategy-log (sentiment/bull_case/bear_case/decision/why/adjustments) PUIS node trade-journal/journal.js report PUIS node trade-journal/journal.js dashboard, notify si actionnable. Garde-fous NON negociables: DEMO only, SL obligatoire, R:R>=2 tendance / geometrie ATR validee MR, max 3 trades/jour, max 5 positions LIVE (8 actifs live+pending; BINDING = risque agrege <=12%/sens et <=18% book, pas le compte), circuit breaker, cap correlation. Termine par le resume au format attendu (avec la ligne ARBITRAGE bull/bear)."

# Allowlist SCOPEE (les gardes restent actives) : node (skills + journal + analyse),
# lecture/ecriture repo, screener ET desktop (zones Zeiierman) -- rien d'autre.
# Pas de shell destructif, pas de git, pas de mainnet. Headless via --allowedTools.
$tools = "Bash(node:*) Read Write Edit Glob Grep mcp__tradingview-screener__* mcp__tradingview-desktop__*"
# Mode MANUEL : prefixe le prompt -> source=manual, exempt du quota max-3/jour (Hugo decide), garde-fous risque intacts.
# Un run manuel CONTRIBUE autant qu'un run auto (meme SOP + heartbeat + obsidian-sync, non gated ci-dessous).
# Inclusion : SEUL strategy MANUAL_TEST_* est exclu des stats/score-eval/slippage ; source:manual REEL compte.
if ($Manual) { $promptOrch = "*** RUN MANUEL (lance a la main par Hugo). source=manual. Un run manuel APPORTE AUTANT A L'ANALYSE qu'un run auto: fais la SOP COMPLETE (PHASE 1 + PHASE 3) -> fais AVANCER les trades en temps reel et capture toute opportunite live. EXEMPTE du quota max-3-trades/jour (Hugo decide) MAIS respecte TOUS les autres garde-fous (SL obligatoire, R:R>=2 tendance / geometrie ATR validee MR, max 5 positions LIVE (8 actifs live+pending; BINDING = risque agrege <=12%/sens, pas le compte), cap correlation, circuit breaker, DEMO only). Ajoute le champ source:manual dans CHAQUE journal.js log, prefixe le resume final par [MANUEL]. ETIQUETAGE: un trade manuel REEL garde son VRAI setup (S1/S3/S5/MR4/MR8) + source:manual -> il COMPTE pleinement dans la perf. N'utilise MANUAL_TEST_* QUE pour un test de plomberie sans valeur d'analyse (exclu des stats). LABO 2-PISTES: setup catalogue valide = piste PRODUCTION; geometrie nouvelle (deep accum, swing, contra-trend hors catalogue) = piste EXPERIMENT -> track:experiment + tier D (~0.75%). *** " + $promptOrch }
# DEFENSIF = EXPERIMENTS, PAS NO_TRADE (GO Hugo 26.06) : en posture DEFENSIVE / capitulation, l'agent
# faisait du "no_trade discipline" -> 8 no_trade / 2 trades en 48h. En DEMO le but = accumuler de la data.
# Directive (gated, reversible AGENT_DEFENSIVE_EXPERIMENTS=0) : prendre QUAND MEME le meilleur setup en
# track:experiment + tier D (taille minuscule) ; no_trade total seulement si geometrie invalide partout.
if (-not $env:AGENT_DEFENSIVE_EXPERIMENTS) { $env:AGENT_DEFENSIVE_EXPERIMENTS = "1" }
if ($env:AGENT_DEFENSIVE_EXPERIMENTS -ne "0") {
  $promptOrch = $promptOrch + " *** DEFENSIF = EXPERIMENTS, PAS NO_TRADE (GO Hugo 26.06) : en posture DEFENSIVE / capitulation / Extreme Fear, le 'no_trade discipline' n'est PAS le comportement DEMO. Prends QUAND MEME le MEILLEUR setup du scan (long de bottom OU short aligne a la tendance) en track:experiment + tier D (taille MINUSCULE ~0.1-0.15 pourcent, geometrie anti-sweep DURE, SL obligatoire) pour ACCUMULER de la data forward-test demo. Tu ne fades PAS la capitulation a PLEINE taille (risque dead-cat) -> tier D minuscule, c'est pour la DONNEE pas l'edge. no_trade TOTAL = UNIQUEMENT si AUCUN setup n'a de geometrie valide au preflight (rare). Garde-fous DURS (SL/geometrie/sizing/DEMO/caps) intacts. REEL INTERDIT. *** "
}
# #6 Completude de routine : on capture l'etat AVANT pour detecter un demi-echec silencieux.
$tradesFile = "$proj\trade-journal\trades.jsonl"
$beforeLines = 0; try { $beforeLines = (Get-Content $tradesFile -ErrorAction SilentlyContinue | Measure-Object -Line).Lines } catch {}

# D1 TIERING DE MODELE : Opus 4.8 (qualite de decision) par defaut ; mais si GESTION PURE
# (4/4 positions -> AUCUN nouveau trade possible), Sonnet suffit (KEEP/trail/note) = economie.
# Override global : $env:ROUTINE_MODEL. Mode manuel = toujours Opus (decision deliberee).
$model = if ($env:ROUTINE_MODEL) { $env:ROUTINE_MODEL } else { "claude-opus-4-8" }
# Budget Max 20x (29.06, chantier A) : OPUS PARTOUT. Les proposeurs BULL/BEAR passent en opus, et les
# 2 downgrades-vers-sonnet (gestion pure) ne s'appliquent QUE si ROUTINE_TIER_DOWNGRADE=1 (defaut off
# = on garde opus meme en gestion pure). Reversible : ROUTINE_TIER_DOWNGRADE=1 restaure l'economie sonnet.
# LATENCE (29.06, audit "routines lentes") : proposeurs en SONNET (rapides, read-only, suffisants pour
# proposer des candidats) ; l'ORCHESTRATEUR reste opus (la decision). opus x3 passes = trop lent (~26 min
# observe) et l'orchestrateur opus hangait au-dela du watchdog. Tiered = vitesse SANS perdre la qualite de
# decision. Reversible : ROUTINE_MODEL_PROPOSER=claude-opus-4-8 restaure des proposeurs opus.
$modelProposer = if ($env:ROUTINE_MODEL_PROPOSER) { $env:ROUTINE_MODEL_PROPOSER } else { "sonnet" }
$tierDowngrade = ($env:ROUTINE_TIER_DOWNGRADE -eq "1")
if ($tierDowngrade -and -not $Manual -and -not $env:ROUTINE_MODEL) {
  try {
    $expo = node "$proj\trade-journal\journal.js" exposure | ConvertFrom-Json
    if ((-not $expo.can_add_long) -and (-not $expo.can_add_short)) { $model = "sonnet"; Add-Content -Path $log -Value "[TIERING] aucun nouveau trade possible (caps/risque) -> gestion pure -> Sonnet" }
  } catch {}
}
# ORIGINE d'EXECUTION (contexte, orthogonal au track) : la routine stampe deterministiquement
# l'origine de tout trade logge -> journal.js cmd_log lit $env:TRADE_ORIGIN par defaut (le LLM n'a
# pas a y penser). routine_auto = planifie / routine_manual = -Manual (Hugo). Une session conv avec
# Claude n'a PAS cet env -> tradeOrigin() infere 'conv'. Permet stats.by_origin (conv vs routines,
# complementaires : memes datas de forward-test, splittables pour comparer).
$env:TRADE_ORIGIN = if ($Manual) { "routine_manual" } else { "routine_auto" }
# DEMO_ACTIVE (16.06, GO Hugo) : on est en DEMO -> objectif #1 = TRADER ACTIVEMENT pour tester/optimiser
# l'infra. Les gates BLOQUANTS (breaker/halt drawdown, quota, exposition, R:R) sont degrades en
# OBSERVABILITE par guards.js (preflight renvoie warnings, pas blocks) -> le LLM DECIDE. L'INTEGRITE
# reste DURE (SL obligatoire + geometrie + sizing). Mettre a "0" pour re-durcir les gates (fin de demo).
if (-not $env:DEMO_ACTIVE) { $env:DEMO_ACTIVE = "1" }
# COMPTE CLAUDE DES ROUTINES : isole le compte/abonnement utilise par 'claude -p' headless du
# compte interactif (defaut ~/.claude). Permet de faire tourner les routines sur un compte Max
# DEDIE (ex. Teodore) -> evite les blocages de quota partages avec la session interactive Hugo.
# CLAUDE_CONFIG_DIR isole les credentials (.credentials.json sous ce dir = le compte loggue la).
# ROBUSTE : n'utilise le dir dedie QUE si ses credentials existent (sinon fallback compte courant,
# zero casse tant que Teodore n'a pas fait 'claude login' dans ce dir). Override : $env:ROUTINE_CLAUDE_CONFIG_DIR.
$routineConfigDir = if ($env:ROUTINE_CLAUDE_CONFIG_DIR) { $env:ROUTINE_CLAUDE_CONFIG_DIR } else { "C:\Users\admin\.claude-teodore" }
if (Test-Path (Join-Path $routineConfigDir ".credentials.json")) {
  $env:CLAUDE_CONFIG_DIR = $routineConfigDir
  Remove-Item Env:\CLAUDE_CODE_OAUTH_TOKEN -ErrorAction SilentlyContinue
  Add-Content -Path $log -Value "[COMPTE] routine sur CLAUDE_CONFIG_DIR=$routineConfigDir (compte dedie Max)"
} else {
  Add-Content -Path $log -Value "[COMPTE] credentials dedies absents ($routineConfigDir) -> compte par defaut (faire 'claude login' dans ce dir pour basculer Teodore)"
}
# PANEL_MODE (16.06) : 3 passes chainees BULL + BEAR (read-only) -> ORCHESTRATEUR.
# Defaut "1". "0" = fallback ancienne passe unique (orchestrateur seul, sans propositions).
# Override : $env:PANEL_MODE (lecture seule, on ne mute pas l'env).
$panelMode = if ($env:PANEL_MODE) { $env:PANEL_MODE } else { "1" }
# Proposeurs = ZERO capacite d'execution : Bash restreint a scan.js (node skills/bybit/... ne
# matche pas -> bloque en headless), pas de Edit. Seul l'orchestrateur ($tools, Bash(node:*)) execute.
# PROPOSEURS SANS MCP (fix 19.06 : un MCP bloquant a fait tourner le run 22:07 du 18.06 pendant 2h+).
# Les proposeurs n'ont QUE scan.js (qui a deja perception + tous les actifs) + lecture/ecriture -> ils
# ne PEUVENT PLUS se bloquer sur un MCP. L'orchestrateur garde les MCP (+ MCP_TOOL_TIMEOUT en garde-fou).
$toolsProposer = "Bash(node trade-journal/scan.js:*) Read Write Glob Grep"
$proposalsDir = "$proj\trade-journal\proposals"
New-Item -ItemType Directory -Force -Path $proposalsDir | Out-Null
# PANEL TOUJOURS ACTIF (directive Hugo 18.06) : le panel BULL/BEAR doit tourner a CHAQUE run pour
# garantir des PROPOSITIONS DE TRADES TOUS LES JOURS, quel que soit le regime (relief_rally / defensive /
# Extreme Fear = CONTEXTE a interpreter, JAMAIS un blocage). Les proposeurs scannent TOUS les actifs
# (crypto + stocks Mag7/SPY/QQQ + gold XAUT) et proposent toujours ; l'orchestrateur arbitre avec le
# contexte. (L'ancien skip defensif single-pass a ete RETIRE : il supprimait les propositions les jours
# defensifs = exactement le bug a corriger. Latence -> parallelisation supervisee + proposeurs allegis.)
if ($panelMode -eq "1") {
  Remove-Item "$proposalsDir\*.json" -ErrorAction SilentlyContinue
  Add-Content -Path $log -Value "[PANEL] mode=1 : passe BULL puis BEAR (read-only, $modelProposer) puis ORCHESTRATEUR ($model) -- propositions GARANTIES chaque jour, tous actifs"
  $prevEAPp = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $tProp = [math]::Max(4, [int]($routineTimeoutMin / 2))
  # max-turns 30 (29.06) : le proposeur scanne + ecrit sa proposition en ~10-15 turns ; a 60 il
  # sur-tournait jusqu'au watchdog 6 min (gaspillage). 30 = marge large, cape la sur-course.
  [void](Invoke-ClaudeTimed -Prompt $promptBull -ClaudeArgs @("-p", "--model", $modelProposer, "--max-turns", "30", "--permission-mode", "acceptEdits", "--allowedTools", $toolsProposer) -LogPath $log -TimeoutMin $tProp)
  [void](Invoke-ClaudeTimed -Prompt $promptBear -ClaudeArgs @("-p", "--model", $modelProposer, "--max-turns", "30", "--permission-mode", "acceptEdits", "--allowedTools", $toolsProposer) -LogPath $log -TimeoutMin $tProp)
  $ErrorActionPreference = $prevEAPp
  # TIERING #2 (22.06, audit conso) : downgrade Opus -> Sonnet SI les DEUX proposeurs n'ont produit
  # AUCUN candidat (gestion pure REELLE : rien a armer ce run -> l'orchestrateur ne fait que gerer).
  # Evidence-based (compte les proposals ecrits), PAS regime-based : ne contredit PAS la directive
  # "trader chaque jour" (un jour defensif AVEC propositions reste Opus). Biais vers Opus si doute
  # (parse echoue / fichier absent -> on garde Opus). N'agit que si pas deja Sonnet/override/manuel.
  if ($tierDowngrade -and ($model -eq "claude-opus-4-8") -and -not $Manual -and -not $env:ROUTINE_MODEL) {
    try {
      $nb = 0; $nbear = 0; $parsed = $true
      if (Test-Path "$proposalsDir\bull.json") { $nb = ((Get-Content "$proposalsDir\bull.json" -Raw | ConvertFrom-Json).proposals | Measure-Object).Count } else { $parsed = $false }
      if (Test-Path "$proposalsDir\bear.json") { $nbear = ((Get-Content "$proposalsDir\bear.json" -Raw | ConvertFrom-Json).proposals | Measure-Object).Count } else { $parsed = $false }
      if ($parsed -and ($nb -eq 0) -and ($nbear -eq 0)) {
        $model = "sonnet"; Add-Content -Path $log -Value "[TIERING] 0 proposition BULL+BEAR -> gestion pure -> Sonnet (orchestrateur)"
      }
    } catch { Add-Content -Path $log -Value "[TIERING] parse proposals echoue -> Opus conserve (biais securite): $_" }
  }
} else {
  Remove-Item "$proposalsDir\*.json" -ErrorAction SilentlyContinue
  Add-Content -Path $log -Value "[PANEL] mode=0 (fallback) : orchestrateur seul -- proposals purges, il genere ses propres candidats depuis le scan"
}
# Passe ORCHESTRATEUR = le SEUL executant. Le bloc completude/heartbeat/obsidian/exit ci-dessous
# enveloppe CETTE passe (inchange : le $claudeExit = $LASTEXITCODE suivant capture SON exit).
$orchTurns = if ($env:ROUTINE_ORCH_MAXTURNS) { $env:ROUTINE_ORCH_MAXTURNS } else { "70" }
$claudeExit = Invoke-ClaudeTimed -Prompt $promptOrch -ClaudeArgs @("-p", "--model", $model, "--max-turns", $orchTurns, "--permission-mode", "acceptEdits", "--allowedTools", $tools) -LogPath $log -TimeoutMin $routineTimeoutMin
# RADAR D'ENTREE : poser les intentions armees DEJA confirmees (MR=immediat) en fin de routine -> le
# trade part sans attendre la tache planifiee 15 min ; les zone/tendance restent armees pour le radar
# entre les routines. No-op si armed-watch vide. Code pur (0 token). Best-effort (n'affecte pas l'exit).
if ($env:ENTRY_RADAR_ARM -eq "1") {
  try { node "$proj\trade-journal\entry-radar.js" *>> $log 2>&1 } catch { Add-Content -Path $log -Value "[RADAR] fin de routine echec non bloquant: $_" }
}
Remove-Item Env:\TRADE_ORIGIN -ErrorAction SilentlyContinue
Remove-Item Env:\CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue

# POST-CLAUDE = HOUSEKEEPING BEST-EFFORT. Fix 16.06 : sous $ErrorActionPreference='Stop', un appel
# native (node) qui sort !=0 ou ecrit sur stderr peut lever une erreur terminante et TUER le script
# AVANT routine-status (bug observe : last_status_ts fige des 13.06 cote scalp, intermittent agent ;
# le log finissait pile sur la sortie d'obsidian-trades-sync). On neutralise pour cette section
# (Continue) + try/catch par appel, et on persiste la COMPLETUDE EN PREMIER (chemin watchdog
# deterministe, avant tout appel reseau/fragile). Restaure l'EAP en fin.
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'

# #6 CHECK COMPLETUDE D'ABORD : une routine COMPLETE logge TOUJOURS au moins 1 decision (trade ou
# no_trade = +1 ligne). Si claude a echoue (exit!=0) OU aucune nouvelle ligne -> DEMI-ECHEC -> alerte.
$afterLines = 0; try { $afterLines = (Get-Content $tradesFile -ErrorAction SilentlyContinue | Measure-Object -Line).Lines } catch {}
# FILET COMPLETUDE (parite scalp) : claude sorti PROPREMENT (exit 0) mais 0 nouvelle decision logee
# -> on ecrit un no_trade DETERMINISTE (le journal a TOUJOURS 1 record par routine = donnee live a
# jour, last_complete:true). On NE masque PAS un vrai echec : un exit!=0 reste incomplet (alerte).
if (-not $Manual -and $claudeExit -eq 0 -and $afterLines -le $beforeLines) {
  Add-Content -Path $log -Value "[COMPLETUDE] aucune decision logee -> no_trade auto (filet)"
  # AUCUN JSON passe a node (fix 26.06) : la commande deterministe `auto-no-trade` construit le record
  # cote JS. Avant, passer un JSON depuis PowerShell le re-tokenisait sur les guillemets/espaces -> JSON
  # casse ("Unterminated string") -> node echouait -> le filet n'ecrivait JAMAIS -> last_complete=false perpetuel.
  try { node "$proj\trade-journal\journal.js" auto-no-trade *>> $log 2>&1 } catch { Add-Content -Path $log -Value "[NO-TRADE-AUTO] echec: $_" }
  try { $afterLines = (Get-Content $tradesFile -ErrorAction SilentlyContinue | Measure-Object -Line).Lines } catch {}
}
$complete = ($claudeExit -eq 0 -and $afterLines -gt $beforeLines)
if (-not $Manual -and -not $complete) {
  $why = if ($claudeExit -eq 124) { "claude timeout watchdog (${routineTimeoutMin}min)" } elseif ($claudeExit -ne 0) { "claude exit=$claudeExit" } else { "aucune nouvelle entree journal (pas de decision/no-trade loggee)" }
  Add-Content -Path $log -Value "[COMPLETUDE] ROUTINE INCOMPLETE: $why"
  try { node "$proj\trade-journal\journal.js" routine-status "{\`"complete\`":false,\`"reason\`":\`"$why\`"}" *>> $log 2>&1 } catch { Add-Content -Path $log -Value "[ROUTINE-STATUS] echec: $_" }
} else {
  try { node "$proj\trade-journal\journal.js" routine-status '{\"complete\":true}' *>> $log 2>&1 } catch { Add-Content -Path $log -Value "[ROUTINE-STATUS] echec: $_" }
}

# Heartbeat (dead-man) : trace que la routine a tourne + ping HEALTHCHECK_PING_URL. Best-effort.
try { node "$proj\trade-journal\journal.js" heartbeat *>> $log 2>&1 } catch { Add-Content -Path $log -Value "[HEARTBEAT] echec: $_" }

# Fiche + notes de trades Obsidian (deterministe, no-op si vault absent). Best-effort.
try { node "$proj\trade-journal\obsidian-sync.js" *>> $log 2>&1 } catch {}
try { node "$proj\trade-journal\obsidian-trades-sync.js" *>> $log 2>&1 } catch {}

# Portfolio live unifie des 2 agents (PORTFOLIO.md + note Obsidian, lecture seule). Best-effort.
try { node "$proj\trade-journal\portfolio.js" *>> $log 2>&1 } catch {}

# Archivage des propositions BULL/BEAR (tracabilite G8, audit 18.06) : la passe suivante ecrase
# proposals/*.json (Remove-Item ne touche QUE les .json directs, pas archive/). On en garde une
# copie horodatee pour reconstruire l'arbitrage a posteriori. Best-effort, jamais bloquant.
if ($panelMode -eq "1") {
  try {
    if (Test-Path "$proposalsDir\*.json") {
      $propArchive = "$proposalsDir\archive\${ts}_${src}"
      New-Item -ItemType Directory -Force -Path $propArchive | Out-Null
      Copy-Item "$proposalsDir\*.json" -Destination $propArchive -ErrorAction SilentlyContinue
    }
  } catch { Add-Content -Path $log -Value "[PROPOSALS-ARCHIVE] echec non bloquant: $_" }
}

# Alerte Telegram si incomplet, APRES la persistance watchdog (best-effort, jamais bloquant).
if (-not $Manual -and -not $complete) {
  try { node "$proj\trade-journal\notify.js" "ROUTINE INCOMPLETE ($src) -- $why. Cycle a moitie fait, verifier $log" *>> $log 2>&1 }
  catch { Add-Content -Path $log -Value "[NOTIFY] echec non bloquant (chemin watchdog deja persiste): $_" }
}

$ErrorActionPreference = $prevEAP

Write-Output "Routine ($src) terminee -> $log"

# EXIT DETERMINISTE (assainit le LastTaskResult schtasks) : sans exit explicite, le code
# de sortie heritait de $LASTEXITCODE d'un appel natif (claude -p peut sortir !=0 de facon
# BENIGNE sur un run pourtant complet) -> schtasks affichait LastResult=1 chronique alors que
# la routine completait (last_complete:true dans heartbeat.json). On aligne donc le code de
# sortie sur la VERITE de completude : 0 si complete (ou manuel), 1 seulement sur demi-echec
# reel. Le watchdog health-check.ps1 reste base sur last_complete (heartbeat.json), independant.
if ($Manual -or $complete) { exit 0 } else { exit 1 }
