// ─────────────────────────────────────────────────────────────────────────────
// monitor.js — MONITORING PERSISTANT des positions (clore / adapter SL-TP a CHAQUE routine)
// ─────────────────────────────────────────────────────────────────────────────
// PROBLEME (directive Hugo 16.06) : avec la refonte en panel (proposeurs bull/bear +
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

// ── TIME-STOP (29.06, OOS valide ~4j pour mean-reversion) ───────────────────────────────────
// Une position MEAN-REVERSION (MR8/MR4/S5/S3) tenue au-dela de AGENT_TIMESTOP_BARS barres 4H doit
// etre CLOSE : OOS prouve qu'au-dela de ~4j le hold DRAGUE et degrade l'expectancy (+0.011R a 24b vs
// 60b), cf. SUI tenu 16j. Routage par ARCHETYPE : la TENDANCE (S1/S2/S12) sort deja en ~4 barres ->
// time-stop INUTILE (OOS) -> JAMAIS applique. PUR. Gate AGENT_TIMESTOP (defaut ON, =0 off). Necessite
// pos.ts_fill||ts_open + pos.strategy ; sinon -> pas due (degradation sure, on ne clot jamais a l'aveugle).
const TF_MS_4H = 4 * 3600 * 1000;
const MEANREV_TS_RE = /^(MR8|MR4|S5|S3)/i;
function timeStopDue(pos, now, opts = {}) {
  const none = { due: false };
  const off = opts.enabled != null ? !opts.enabled : process.env.AGENT_TIMESTOP === '0';
  if (off || !pos || !now) return none;
  if (!MEANREV_TS_RE.test(String(pos.strategy || pos.setup || ''))) return none; // tendance/inconnu -> jamais
  const openTs = Date.parse(pos.ts_fill || pos.ts_open || pos.opened_at || '');
  if (Number.isNaN(openTs)) return none;
  const capBars = opts.capBars != null ? +opts.capBars : (+process.env.AGENT_TIMESTOP_BARS || 24);
  const ageH = (now - openTs) / 3600000;
  const capH = capBars * 4;
  if (ageH < capH) return { due: false, age_h: +ageH.toFixed(1), cap_h: capH };
  return { due: true, age_h: +ageH.toFixed(1), cap_h: capH, cap_bars: capBars,
    reason: `TIME-STOP : mean-rev (${pos.strategy || pos.setup}) tenu ${ageH.toFixed(1)}h > ${capBars}b (${capH}h ~ ${(capBars / 6).toFixed(0)}j) -> clore (OOS : tenir au-dela degrade l'expectancy)` };
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
    const ts = p.status === 'open' ? timeStopDue(p, now) : { due: false };
    if (ts.due) {
      // TIME-STOP : mean-rev tenu trop longtemps -> clore (flat = risk-reducing). Prime sur le verdict
      // (et sur place_sl : clore retire aussi le risque d'une position nue).
      action = 'time_stop_close'; priority = 'high'; reason = ts.reason;
    } else if (p.status === 'open' && !isProtected(p)) {
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
// N'a PAS besoin du scan/thesis (donc appelable a froid, sans verdicts) : detecte les risques de
// PERSISTANCE = position NUE (pas de SL = CRITIQUE) ou GAP de gestion (non gerée depuis > maxAgeHours)
// ou TP MANQUANT (22.06 : une position OUVERTE qui avait des TP prevus mais 0 TP pose sur Bybit =
// WARN -> "trades sans TP" rendu VISIBLE ; cause = 110093 differe-au-fill / cap 10 stops / routine
// morte). Sert de filet meme si une routine orchestrateur meurt. PUR.
// -> { alert, naked[], stale[], missing_tp[], reasons[] }
function needsAttention({ positions = [], state = {}, now = 0, maxAgeHours = DEFAULT_MAX_AGE_H } = {}) {
  const naked = [], stale = [], missing_tp = [], time_stop = [], reasons = [];
  const maxAgeMs = maxAgeHours * 3600 * 1000;
  for (const p of positions) {
    if (!p || p.status !== 'open') continue;
    if (!isProtected(p)) { naked.push({ id: p.id, symbol: p.symbol }); reasons.push(`${p.symbol} NUE (pas de SL)`); }
    // TIME-STOP (defensif) : une position mean-rev au-dela du cap est flaguee meme si une routine meurt.
    const tsd = timeStopDue(p, now);
    if (tsd.due) { time_stop.push({ id: p.id, symbol: p.symbol, age_h: tsd.age_h, cap_h: tsd.cap_h }); reasons.push(`${p.symbol} TIME-STOP du (${tsd.age_h}h > ${tsd.cap_h}h) -> clore`); }
    // TP MANQUANT : la position avait des TP PREVUS (plan non vide) mais AUCUN TP pose sur Bybit.
    // has_tp non defini (ancien appelant) -> on ne flague pas (retro-compat). Si tous les TP ont ete
    // touches il ne reste qu'un runner trail -> WARN benin (a verifier), pas CRITIQUE comme le SL nu.
    const plannedTps = Array.isArray(p.take_profits) ? p.take_profits.length : 0;
    if (p.has_tp === false && plannedTps > 0) {
      missing_tp.push({ id: p.id, symbol: p.symbol, planned: plannedTps });
      reasons.push(`${p.symbol} SANS TP sur Bybit (${plannedTps} prevus) -> re-poser les TP ou confirmer runner-trail`);
    }
    const prev = state[p.id];
    if (prev && prev.last_managed_ts && now && (now - prev.last_managed_ts) > maxAgeMs) {
      const gap_h = +((now - prev.last_managed_ts) / 3600000).toFixed(1);
      stale.push({ id: p.id, symbol: p.symbol, gap_h }); reasons.push(`${p.symbol} non gerée depuis ${gap_h}h`);
    }
  }
  return { alert: naked.length > 0 || stale.length > 0 || missing_tp.length > 0 || time_stop.length > 0, naked, stale, missing_tp, time_stop, reasons };
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

// breakevenAfterTp1 (19.06, LEVIER #1 du post-mortem live SL/TP) : des que le PIC (MFE) a atteint
// TP1, le SL du reliquat doit passer a l'ENTREE -> tue le give-back (un gagnant TP1 qui round-trip
// en perte pleine). PUR. Le breakeven ne fait que RESSERRER le SL (jamais augmenter le risque).
//   pos  : { side, entry|entry_actual, stop_loss, take_profits[], px }
//   traj : { mfe_R }  (pic en R depuis l'entree, robuste au round-trip ; null -> pas d'action)
//   -> { be_due, apply, new_sl, in_profit_now, tp1_R, mfe_R, reason }
//   be_due = TP1 atteint ET SL pas encore au BE  (ALERTE toujours, meme si auto-exec off)
//   apply  = be_due ET prix encore du bon cote (SL-BE posable comme conditionnel sans trigger immediat)
function breakevenAfterTp1(pos, traj, opts = {}) {
  const o = { trigger_frac: 0.95, buffer_r: 0, ...opts };
  const isShort = pos && pos.side === 'short';
  const entry = Number(pos && (pos.entry != null ? pos.entry : pos.entry_actual));
  const sl = Number(pos && pos.stop_loss);
  const tps = Array.isArray(pos && pos.take_profits) ? pos.take_profits : [];
  const tp1raw = tps[0];
  const tp1 = Number(tp1raw && typeof tp1raw === 'object' ? tp1raw.px : tp1raw);
  const mfe = traj && traj.mfe_R != null ? Number(traj.mfe_R) : null;
  const px = Number(pos && pos.px);
  const none = { be_due: false, apply: false, new_sl: null, in_profit_now: null, tp1_R: null, mfe_R: mfe, reason: 'n/a' };
  if (![entry, sl, tp1].every(Number.isFinite) || mfe == null) return none;
  const risk = Math.abs(entry - sl);
  if (!(risk > 0)) return none;
  const tp1R = Math.abs(tp1 - entry) / risk;
  if (!(tp1R > 0)) return none;
  const slAtBe = isShort ? sl <= entry + 1e-9 : sl >= entry - 1e-9; // SL deja au BE (ou mieux)
  const reached = mfe >= tp1R * o.trigger_frac;                      // le pic a (quasi) atteint TP1
  if (slAtBe) return { ...none, reason: 'SL deja au breakeven ou mieux' };
  if (!reached) return { ...none, tp1_R: +tp1R.toFixed(2), reason: `TP1 pas atteint (mfe ${mfe}R < ${tp1R.toFixed(2)}R)` };
  const new_sl = +(entry + (isShort ? -1 : 1) * o.buffer_r * risk).toFixed(8);
  const inProfitNow = Number.isFinite(px) ? (isShort ? px < new_sl : px > new_sl) : true;
  return {
    be_due: true, apply: inProfitNow, new_sl, in_profit_now: inProfitNow,
    tp1_R: +tp1R.toFixed(2), mfe_R: mfe,
    reason: inProfitNow
      ? `TP1 atteint (mfe ${mfe}R >= ${tp1R.toFixed(2)}R) -> SL au breakeven ${new_sl}`
      : `TP1 atteint mais prix repasse sous le BE -> give-back EN COURS (gerer a la main, pas de SL-BE auto)`,
  };
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

// ── tpTakePlan : GARANTIT que chaque TP (surtout le TP1 = partiel rapide 20%) est PRIS ───────────
// (23.06, directive Hugo "si gain de 20%, prendre TP1"). Pour un fade short, l'entree est au-dessus
// du marche -> au placement le TP1 (proche) est souvent AU-DESSUS du prix courant -> Bybit le rejette
// (110093) -> il est DIFFERE et JAMAIS re-pose -> jamais pris. Ce plan, lance par monitor-tick sur une
// position OUVERTE (remplie), compare les TP PREVUS (journal) aux TP REELLEMENT POSES (Bybit) et, pour
// chaque TP manquant : REACHED (le prix a deja atteint/depasse le niveau) -> BANK (market reduce-only,
// capture le partiel maintenant) ; sinon -> REPOST (conditionnel valide post-fill, fillera au niveau).
// IDEMPOTENT : un TP deja banke (px dans tpTaken) ou deja pose (px dans postedTpPxs) n'est jamais repris.
// PUR. -> { incomplete, actions:[{px, frac, qty, action:'bank'|'repost', reached}] }.
function inferFracs(tps, tp1Frac) {
  const f1 = Number.isFinite(tp1Frac) ? tp1Frac : 0.2;
  if (tps.every((t) => t && typeof t === "object" && Number.isFinite(t.frac))) return tps.map((t) => t.frac);
  const n = tps.length;
  if (n <= 1) return [1];
  if (n === 2) return [f1, +(1 - f1).toFixed(4)];
  if (n === 3) return [f1, +(1 - f1 - 0.3).toFixed(4), 0.3];
  const rest = +((1 - f1) / (n - 1)).toFixed(4);
  return [f1, ...Array(n - 1).fill(rest)];
}
function tpTakePlan({ side, px, plannedTps = [], postedTpPxs = [], size, tpTaken = [], tp1Frac, atrTol } = {}) {
  const out = { incomplete: false, actions: [] };
  const isShort = side === "short";
  const tps = (plannedTps || []).map((t) => (t && t.px != null) ? { px: +t.px, frac: t.frac } : { px: +t, frac: undefined })
    .filter((t) => Number.isFinite(t.px));
  if (!tps.length || !(size > 0) || !Number.isFinite(px)) return out;
  const fracs = inferFracs(tps, tp1Frac);
  const tol = Number.isFinite(atrTol) ? atrTol : Math.max(Math.abs(px) * 0.0005, 1e-9); // ~5bps de match de px
  const near = (a, b) => Math.abs(a - b) <= tol;
  const posted = (postedTpPxs || []).map(Number).filter(Number.isFinite);
  const taken = (tpTaken || []).map(Number).filter(Number.isFinite);
  tps.forEach((t, i) => {
    if (posted.some((p) => near(p, t.px))) return;            // deja sur Bybit
    if (taken.some((p) => near(p, t.px))) return;             // deja banke (idempotence)
    out.incomplete = true;
    const frac = Number.isFinite(t.frac) ? t.frac : fracs[i];
    const qty = +(frac * size).toFixed(8);
    const reached = isShort ? (px <= t.px) : (px >= t.px);    // le prix a atteint/depasse le niveau
    out.actions.push({ px: t.px, frac, qty, action: reached ? "bank" : "repost", reached });
  });
  return out;
}

module.exports = { planMonitoring, actionForVerdict, isProtected, needsAttention, summarize, watchdogState, breakevenAfterTp1, tpTakePlan, inferFracs, timeStopDue, loadState, saveState, STATE_PATH };
