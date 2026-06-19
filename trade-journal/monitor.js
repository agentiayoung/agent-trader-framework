// ─────────────────────────────────────────────────────────────────────────────
// monitor.js — MONITORING PERSISTANT des positions (clore / adapter SL-TP a CHAQUE routine)
// ─────────────────────────────────────────────────────────────────────────────
// PROBLEME (directive the maintainer 16.06) : avec la refonte en panel (proposeurs bull/bear +
// orchestrateur), la GESTION des positions ouvertes ne doit JAMAIS passer derriere
// l'arbitrage de nouveaux trades. Le monitoring doit etre PERSISTANT et GARANTI :
//   - chaque position open est gerée a chaque passage (verdict -> action SL/TP) ;
//   - aucune position NUE (plancher dur : un SL server-side toujours present) ;
//   - un GAP de gestion (position non touchee depuis > maxAgeHours) est DETECTE (watchdog).
//
// DECOUPLAGE : planMonitoring est PUR et recoit les VERDICTS deja calcules par thesis.js
// (thesisHealth). Il les MAPPE en actions deterministes + gere l'etat de persistance.
// Le CLI fait le cablage (reconcile positions -> thesisHealth -> planMonitoring -> etat).
// Aucune dependance reseau dans la logique = testable offline et deterministe.

const fs = require('fs');
const path = require('path');

const STATE_PATH = path.join(__dirname, 'monitor-state.json');
const DEFAULT_MAX_AGE_H = process.env.MONITOR_MAX_AGE_H ? +process.env.MONITOR_MAX_AGE_H : 5;

// verdict (thesis.js) -> action de gestion deterministe. Le SL absent prime sur tout
// (plancher dur de persistance). Sans verdict (paire absente du scan) -> keep (jamais
// d'action destructrice sur une position dont on n'a pas l'info live).
function actionForVerdict(v) {
  switch (v && v.verdict) {
    case 'flipped':   return { action: 'take_partial_be',   reason: 'these cassee -> securiser + SL break-even' };
    case 'mature':    return { action: 'take_partial_lock', reason: 'gain qui s essouffle -> securiser + resserrer le trail' };
    case 'weakening': return { action: v.suggested === 'hold_to_sl_or_reduce' ? 'hold_to_sl_or_reduce' : 'tighten_sl', reason: 'these affaiblie' };
    case 'running':   return (v.unreal_R != null && v.unreal_R >= 1)
      ? { action: 'set_trailing',    reason: 'gagnante >=1R qui court -> trailing OBLIGATOIRE (protege le gain entre routines)' }
      : { action: 'keep_trail_watch', reason: 'gagnante qui se developpe -> surveiller, trailer des >=1R' };
    default:          return { action: 'keep', reason: 'these intacte (aucun signal contre la position)' };
  }
}

// Une position est PROTEGEE si elle a un SL server-side. On accepte plusieurs formes
// (has_sl bool, sl_orders compte) ; absence avere -> NUE (place_sl critique).
function isProtected(p) {
  if (p && p.has_sl === false) return false;
  if (p && typeof p.sl_orders === 'number') return p.sl_orders > 0;
  return true; // par defaut, ne pas crier au loup si l'info n'est pas fournie
}

// planMonitoring : { verdicts[], positions[], state{}, now, maxAgeHours }
//   -> { n, plans[], criticals[], stale[], newState{} }
// PUR : aucune lecture/ecriture. now en ms (injecte = deterministe). state = monitor-state.json precedent.
function planMonitoring({ verdicts = [], positions = [], state = {}, now = 0, maxAgeHours = DEFAULT_MAX_AGE_H } = {}) {
  const vById = {};
  for (const v of verdicts) if (v && v.id != null) vById[v.id] = v;

  const plans = [], criticals = [], stale = [], newState = {};
  const maxAgeMs = maxAgeHours * 3600 * 1000;

  for (const p of positions) {
    if (!p || (p.status !== 'open' && p.status !== 'pending')) continue;
    const v = vById[p.id] || null;

    let action, priority = 'normal', reason;
    if (p.status === 'open' && !isProtected(p)) {
      // PLANCHER DUR DE PERSISTANCE : une position ouverte sans SL = nue -> poser le SL d'abord.
      action = 'place_sl'; priority = 'critical';
      reason = 'POSITION NUE : aucun SL server-side -> poser le SL immediatement (plancher dur).';
      criticals.push({ id: p.id, symbol: p.symbol });
    } else {
      const m = actionForVerdict(v);
      action = m.action; reason = m.reason;
      if (action === 'place_sl' || action === 'take_partial_be' || action === 'take_partial_lock') priority = 'high';
    }

    // PERSISTANCE / WATCHDOG : la position etait-elle gerée trop vieux (gap de monitoring) ?
    const prev = state[p.id];
    if (prev && prev.last_managed_ts && now && (now - prev.last_managed_ts) > maxAgeMs) {
      stale.push({ id: p.id, symbol: p.symbol, last_managed_ts: prev.last_managed_ts, gap_h: +((now - prev.last_managed_ts) / 3600000).toFixed(1) });
    }

    plans.push({
      id: p.id, symbol: p.symbol, side: p.side, status: p.status,
      action, priority, verdict: v ? v.verdict : 'no_scan',
      unreal_R: v ? v.unreal_R : null, trail: v ? v.trail : null,
      suggested: v ? v.suggested : null, has_sl: isProtected(p), reason,
    });
    // restampe l'etat a now (la position vient d'etre gerée ce run)
    newState[p.id] = { symbol: p.symbol, last_managed_ts: now, last_action: action };
  }

  return { n: plans.length, plans, criticals, stale, newState };
}

// needsAttention : BACKSTOP LEGER pour le dead-man watchdog horaire (health-check.ps1).
// N'a PAS besoin du scan/thesis (donc appelable a froid, sans verdicts) : detecte les 2
// risques de PERSISTANCE = position NUE (pas de SL) ou GAP de gestion (non gerée depuis
// > maxAgeHours). Sert de filet meme si une routine orchestrateur meurt (quota) -> le
// monitoring ne decroche jamais silencieusement. PUR. -> { alert, naked[], stale[], reasons[] }
function needsAttention({ positions = [], state = {}, now = 0, maxAgeHours = DEFAULT_MAX_AGE_H } = {}) {
  const naked = [], stale = [], reasons = [];
  const maxAgeMs = maxAgeHours * 3600 * 1000;
  for (const p of positions) {
    if (!p || p.status !== 'open') continue;
    if (!isProtected(p)) { naked.push({ id: p.id, symbol: p.symbol }); reasons.push(`${p.symbol} NUE (pas de SL)`); }
    const prev = state[p.id];
    if (prev && prev.last_managed_ts && now && (now - prev.last_managed_ts) > maxAgeMs) {
      const gap_h = +((now - prev.last_managed_ts) / 3600000).toFixed(1);
      stale.push({ id: p.id, symbol: p.symbol, gap_h }); reasons.push(`${p.symbol} non gerée depuis ${gap_h}h`);
    }
  }
  return { alert: naked.length > 0 || stale.length > 0, naked, stale, reasons };
}

// summarize : resume actionnable (1 ligne) d'un resultat planMonitoring -> log/Telegram.
function summarize(res) {
  if (!res || !res.plans) return 'MONITOR: rien a gerer';
  const counts = {};
  for (const p of res.plans) counts[p.action] = (counts[p.action] || 0) + 1;
  const actStr = Object.entries(counts).map(([a, n]) => `${a}:${n}`).join(' ');
  const crit = (res.criticals || []).length
    ? ` | CRITIQUE place_sl: ${res.criticals.map((c) => c.symbol).join(',')}` : '';
  const st = (res.stale || []).length
    ? ` | STALE: ${res.stale.map((s) => `${s.symbol}(${s.gap_h}h)`).join(',')}` : '';
  return `MONITOR: ${res.n} positions | actions ${actStr}${crit}${st}`;
}

// watchdogState : depuis l'etat persiste SEUL (aucun reseau) -> age du dernier monitoring.
// Permet au dead-man horaire de detecter "des positions sont ouvertes MAIS monitor.js n'a
// pas tourne recemment" (= wiring casse silencieusement) sans aucun appel exchange. PUR.
function watchdogState(state, now) {
  const ids = Object.keys(state || {});
  if (!ids.length) return { n_tracked: 0, freshest_age_min: null };
  let freshest = 0;
  for (const id of ids) { const t = (state[id] && state[id].last_managed_ts) || 0; if (t > freshest) freshest = t; }
  return { n_tracked: ids.length, freshest_age_min: freshest && now ? +(((now - freshest) / 60000).toFixed(1)) : null };
}

// ── Etat persistant (I/O, hors logique pure) ────────────────────────────────
function loadState(p = STATE_PATH) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}
function saveState(newState, p = STATE_PATH) {
  fs.writeFileSync(p, JSON.stringify(newState, null, 2));
}

// ── CLI : cable reconcile(positions) -> thesisHealth(verdicts) -> planMonitoring -> etat ──
// Usage : node trade-journal/monitor.js '<positionsJSON>'
//   positionsJSON = sortie reconcile (tableau de positions {id,symbol,side,status,stop_loss,has_sl,sl_orders,...})
//   scan-latest.json (ecrit par scan.js) fournit scanAll + market pour thesisHealth.
// Imprime le plan JSON (l'orchestrateur AGIT dessus) et persiste monitor-state.json.
if (require.main === module) {
  const arg = process.argv[2];
  // Mode dead-man (aucun reseau) : age du dernier monitoring depuis monitor-state.json.
  if (arg === '--watchdog') {
    console.log(JSON.stringify(watchdogState(loadState(), Date.now())));
    process.exit(0);
  }
  let positions = [];
  try { positions = arg ? JSON.parse(arg) : []; } catch (e) { console.error('positions JSON invalide:', e.message); process.exit(2); }

  let scanAll = [], market = {};
  try {
    const scan = JSON.parse(fs.readFileSync(path.join(__dirname, 'scan-latest.json'), 'utf8'));
    scanAll = scan.all || scan.opportunities || [];
    market = scan.market || {};
  } catch { /* pas de scan -> verdicts vides -> keep (jamais destructeur) */ }

  let verdicts = [];
  try {
    const { thesisHealth } = require('./thesis.js');
    verdicts = thesisHealth(positions, scanAll, market).positions || [];
  } catch (e) { console.error('[monitor] thesisHealth indisponible:', e.message); }

  const now = Date.now();
  const state = loadState();
  const res = planMonitoring({ verdicts, positions, state, now });
  saveState(res.newState);
  console.log(JSON.stringify({ n: res.n, criticals: res.criticals, stale: res.stale, plans: res.plans }, null, 2));
}

module.exports = { planMonitoring, actionForVerdict, isProtected, needsAttention, summarize, watchdogState, loadState, saveState, STATE_PATH };
