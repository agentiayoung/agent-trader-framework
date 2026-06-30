// Test PUR (offline, deterministe : ts fige, pas de Date.now) du module de monitoring persistant.
// planMonitoring DECOUPLE de thesis.js : on lui INJECTE les verdicts (thesisHealth les produit en
// prod) -> il les mappe en ACTIONS deterministes + garantit la PERSISTANCE (SL present + gap de
// gestion detecte). C'est ce qui assure que les routines closent/adaptent SL-TP a chaque passage.
const assert = require('assert');
const { planMonitoring } = require('../trade-journal/monitor.js');

const now = 1000000000000; // ms fixe

const verdicts = [
  { id: 'p1', symbol: 'BTC', verdict: 'running',  suggested: 'hold_let_run',            unreal_R: 1.5,  trail: { mode: 'loose' } },
  { id: 'p3', symbol: 'SUI', verdict: 'weakening', suggested: 'tighten_sl',             unreal_R: -0.2, trail: null },
  { id: 'p4', symbol: 'XRP', verdict: 'flipped',   suggested: 'take_partial_tighten_be', unreal_R: -0.1, trail: null },
  { id: 'p5', symbol: 'LINK', verdict: 'mature',   suggested: 'take_partial_lock',       unreal_R: 0.8,  trail: null },
];
const positions = [
  { id: 'p1', symbol: 'BTC',  side: 'long',  status: 'open', has_sl: true },
  { id: 'p2', symbol: 'ETH',  side: 'short', status: 'open', has_sl: false }, // NUE -> place_sl CRITIQUE
  { id: 'p3', symbol: 'SUI',  side: 'short', status: 'open', has_sl: true },
  { id: 'p4', symbol: 'XRP',  side: 'short', status: 'open', has_sl: true },
  { id: 'p5', symbol: 'LINK', side: 'short', status: 'open', has_sl: true },
  { id: 'pX', symbol: 'OLD',  side: 'short', status: 'open', has_sl: true }, // gere il y a 6h -> stale
];
const state = { pX: { symbol: 'OLD', last_managed_ts: now - 6 * 3600 * 1000, last_action: 'keep' } };

const res = planMonitoring({ verdicts, positions, state, now, maxAgeHours: 5 });

// 1) chaque position OPEN est planifiee (aucune oubliee)
assert.strictEqual(res.n, 6, 'n plans');
const byId = Object.fromEntries(res.plans.map((p) => [p.id, p]));

// 2) gagnante >=1R qui court -> set_trailing (protege le gain ENTRE les routines)
assert.strictEqual(byId.p1.action, 'set_trailing');

// 3) position NUE -> place_sl CRITIQUE (plancher dur de persistance : jamais de position sans SL)
assert.strictEqual(byId.p2.action, 'place_sl');
assert.strictEqual(byId.p2.priority, 'critical');
assert.ok(res.criticals.some((c) => c.id === 'p2'), 'p2 dans criticals');

// 4) mapping verdict -> action
assert.strictEqual(byId.p3.action, 'tighten_sl');      // weakening
assert.strictEqual(byId.p4.action, 'take_partial_be'); // flipped
assert.strictEqual(byId.p5.action, 'take_partial_lock'); // mature

// 5) PERSISTANCE : pX gere il y a 6h (> maxAge 5h) -> flagge stale (gap de monitoring detecte)
assert.ok(res.stale.some((s) => s.id === 'pX'), 'pX devrait etre stale');

// 6) newState restampe TOUTES les positions gerees a now (l'etat persiste entre routines)
assert.strictEqual(res.newState.p1.last_managed_ts, now);
assert.strictEqual(res.newState.pX.last_managed_ts, now);

// 7) pas de verdict (paire absente du scan) -> keep par defaut, jamais d'action destructrice
const res2 = planMonitoring({ verdicts: [], positions: [{ id: 'z', symbol: 'Z', side: 'long', status: 'open', has_sl: true }], state: {}, now });
assert.strictEqual(res2.plans[0].action, 'keep');

// 8) une position non-open (closed) est ignoree
const res3 = planMonitoring({ verdicts: [], positions: [{ id: 'c', symbol: 'C', side: 'long', status: 'closed', has_sl: true }], state: {}, now });
assert.strictEqual(res3.n, 0);

// ── BACKSTOP WATCHDOG (needsAttention) : check LEGER (sans scan/thesis) pour le dead-man horaire.
// Doit crier si une position est NUE (place_sl) ou si elle n'a pas ete gerée depuis > maxAge (gap).
const { needsAttention, summarize } = require('../trade-journal/monitor.js');

// 9) position nue -> alert
const att1 = needsAttention({ positions: [{ id: 'a', symbol: 'ETH', side: 'short', status: 'open', has_sl: false }], state: {}, now });
assert.strictEqual(att1.alert, true);
assert.ok(att1.naked.some((x) => x.id === 'a'));

// 10) position gerée il y a 6h (> maxAge 5h) -> alert stale
const att2 = needsAttention({ positions: [{ id: 'b', symbol: 'SUI', side: 'short', status: 'open', has_sl: true }], state: { b: { last_managed_ts: now - 6 * 3600 * 1000 } }, now, maxAgeHours: 5 });
assert.strictEqual(att2.alert, true);
assert.ok(att2.stale.some((x) => x.id === 'b'));

// 11) tout protege + gerée recemment -> pas d'alerte (has_tp absent = retro-compat, pas de faux flag)
const att3 = needsAttention({ positions: [{ id: 'c', symbol: 'BTC', side: 'long', status: 'open', has_sl: true }], state: { c: { last_managed_ts: now - 1 * 3600 * 1000 } }, now, maxAgeHours: 5 });
assert.strictEqual(att3.alert, false);

// 11b) TP MANQUANT (22.06) : position OUVERTE avec TP prevus mais 0 TP sur Bybit -> flag missing_tp + alert
const att4 = needsAttention({ positions: [{ id: 'd', symbol: 'XRP', side: 'short', status: 'open', has_sl: true, has_tp: false, take_profits: [{ px: 1 }, { px: 0.9 }] }], state: { d: { last_managed_ts: now } }, now });
assert.strictEqual(att4.alert, true, 'TP manquant -> alert');
assert.ok(att4.missing_tp.some((x) => x.id === 'd'), 'd dans missing_tp');
assert.ok(att4.reasons.some((r) => /SANS TP/.test(r)), 'reason SANS TP');
// 11c) position AVEC TP poses -> pas de faux flag
const att5 = needsAttention({ positions: [{ id: 'e', symbol: 'SOL', side: 'long', status: 'open', has_sl: true, has_tp: true, take_profits: [{ px: 110 }] }], state: { e: { last_managed_ts: now } }, now });
assert.strictEqual(att5.missing_tp.length, 0, 'has_tp:true -> pas de missing_tp');

// 12) summarize : resume actionnable (criticals + stale + compte d'actions)
const s = summarize(res);
assert.ok(/MONITOR/.test(s));
assert.ok(/place_sl/.test(s));
assert.ok(s.includes('ETH')); // la position nue p2 (ETH) doit figurer dans le resume

// 13) watchdogState : age du dernier monitoring depuis l'etat seul (backstop dead-man, sans reseau)
const { watchdogState } = require('../trade-journal/monitor.js');
const w0 = watchdogState({}, now);
assert.strictEqual(w0.n_tracked, 0);
assert.strictEqual(w0.freshest_age_min, null);
const w1 = watchdogState({ a: { last_managed_ts: now - 30 * 60000 }, b: { last_managed_ts: now - 120 * 60000 } }, now);
assert.strictEqual(w1.n_tracked, 2);
assert.strictEqual(w1.freshest_age_min, 30); // le PLUS RECENT (30 min), pas le plus vieux

// ── breakevenAfterTp1 (LEVIER #1 19.06) : SL au breakeven des que le pic (MFE) a atteint TP1 ──
const { breakevenAfterTp1 } = require('../trade-journal/monitor.js');

// 14) SHORT, TP1 atteint (mfe 0.8 >= tp1R 0.6) + prix encore en profit -> be_due + apply, SL au BE (entree)
const be1 = breakevenAfterTp1({ side: 'short', entry: 100, stop_loss: 105, take_profits: [{ px: 97 }], px: 96 }, { mfe_R: 0.8 });
assert.strictEqual(be1.be_due, true, 'be1 due');
assert.strictEqual(be1.apply, true, 'be1 apply (prix en profit)');
assert.strictEqual(be1.new_sl, 100, 'be1 SL au breakeven = entree');

// 15) SHORT, TP1 atteint MAIS prix repasse au-dessus du BE (round-trip) -> be_due mais PAS apply (give-back en cours)
const be2 = breakevenAfterTp1({ side: 'short', entry: 100, stop_loss: 105, take_profits: [{ px: 97 }], px: 101 }, { mfe_R: 0.8 });
assert.strictEqual(be2.be_due, true, 'be2 due');
assert.strictEqual(be2.apply, false, 'be2 pas apply (prix repasse sous le BE)');

// 16) TP1 PAS atteint (mfe 0.4 < tp1R 0.6) -> pas de BE
const be3 = breakevenAfterTp1({ side: 'short', entry: 100, stop_loss: 105, take_profits: [{ px: 97 }], px: 99 }, { mfe_R: 0.4 });
assert.strictEqual(be3.be_due, false, 'be3 pas due (TP1 pas atteint)');

// 17) SL deja au breakeven -> pas d'action (idempotent)
const be4 = breakevenAfterTp1({ side: 'short', entry: 100, stop_loss: 100, take_profits: [{ px: 97 }], px: 96 }, { mfe_R: 0.9 });
assert.strictEqual(be4.be_due, false, 'be4 SL deja au BE');

// 18) LONG miroir : TP1 atteint + en profit -> apply, SL au BE
const be5 = breakevenAfterTp1({ side: 'long', entry: 100, stop_loss: 95, take_profits: [{ px: 103 }], px: 104 }, { mfe_R: 0.7 });
assert.strictEqual(be5.be_due, true, 'be5 due');
assert.strictEqual(be5.apply, true, 'be5 apply');
assert.strictEqual(be5.new_sl, 100, 'be5 SL au breakeven');

// 19) mfe null (pas de trajectoire) -> pas d'action
const be6 = breakevenAfterTp1({ side: 'short', entry: 100, stop_loss: 105, take_profits: [{ px: 97 }], px: 96 }, { mfe_R: null });
assert.strictEqual(be6.be_due, false, 'be6 pas de trajectoire');

// ── tpTakePlan (23.06) : garantir que le TP1 (20%) est PRIS (re-post / bank) ──────────────────
const { tpTakePlan, inferFracs } = require('../trade-journal/monitor.js');

// SOL-like : short, TP1 deja DEPASSE par le prix mais ABSENT de Bybit -> BANK le partiel maintenant.
const sol = tpTakePlan({ side: 'short', px: 71.95, plannedTps: [73.308, 70.304, 69.42], postedTpPxs: [70.304, 69.42], size: 98, tpTaken: [] });
assert.strictEqual(sol.incomplete, true, 'SOL TP1 manquant -> incomplete');
assert.strictEqual(sol.actions.length, 1, 'SOL : 1 action (TP1)');
assert.strictEqual(sol.actions[0].action, 'bank', 'SOL TP1 deja depasse -> bank');
assert.ok(Math.abs(sol.actions[0].qty - 19.6) < 0.1, 'SOL bank qty = 20% de 98 (~19.6)');

// ETH-like : short, TP1 ENCORE DEVANT (px au-dessus du TP1) + ABSENT -> REPOST conditionnel.
const eth = tpTakePlan({ side: 'short', px: 1723, plannedTps: [1710, 1685], postedTpPxs: [], size: 3.82, tpTaken: [] });
assert.strictEqual(eth.actions.length, 2, 'ETH : 2 TP manquants');
assert.strictEqual(eth.actions[0].action, 'repost', 'ETH TP1 encore devant -> repost');
assert.ok(Math.abs(eth.actions[0].qty - 0.764) < 0.01, 'ETH TP1 qty = 20% de 3.82');

// Tous les TP deja sur Bybit -> rien a faire (couverture complete)
const full = tpTakePlan({ side: 'short', px: 100, plannedTps: [98, 95], postedTpPxs: [98, 95], size: 10, tpTaken: [] });
assert.strictEqual(full.incomplete, false, 'couverture complete -> rien');
assert.strictEqual(full.actions.length, 0, '0 action');

// IDEMPOTENCE : TP1 deja banke (dans tpTaken) -> NE PAS re-banker
const idem = tpTakePlan({ side: 'short', px: 71.95, plannedTps: [73.308, 70.304, 69.42], postedTpPxs: [70.304, 69.42], size: 78.4, tpTaken: [73.308] });
assert.strictEqual(idem.actions.length, 0, 'TP1 deja banke -> aucune action (anti double-prise)');

// LONG miroir : TP1 deja depasse (px au-dessus) absent -> bank
const lon = tpTakePlan({ side: 'long', px: 105, plannedTps: [103, 108], postedTpPxs: [108], size: 10, tpTaken: [] });
assert.strictEqual(lon.actions[0].action, 'bank', 'LONG TP1 depasse -> bank');

// fracs explicites respectees
const fr = tpTakePlan({ side: 'short', px: 90, plannedTps: [{ px: 88, frac: 0.15 }, { px: 80, frac: 0.85 }], postedTpPxs: [80], size: 100, tpTaken: [] });
assert.ok(Math.abs(fr.actions[0].qty - 15) < 0.01, 'frac explicite 0.15 respectee');

// inferFracs : 3 TP -> TP1 20%
assert.deepStrictEqual(inferFracs([1, 2, 3]), [0.2, 0.5, 0.3], 'inferFracs 3 TP = 0.2/0.5/0.3');
assert.deepStrictEqual(inferFracs([1, 2]), [0.2, 0.8], 'inferFracs 2 TP = 0.2/0.8');

// ── TIME-STOP (29.06, OOS ~4j mean-rev) : timeStopDue + integration planMonitoring/needsAttention ──
const { timeStopDue } = require('../trade-journal/monitor.js');
const H = 3600 * 1000;
// mean-rev tenu 5j (>4j cap) -> due ; tenu 3j -> pas due
const old5j = { strategy: 'MR8_stochrsi_revert', ts_open: new Date(now - 5 * 24 * H).toISOString() };
const young3j = { strategy: 'MR8_stochrsi_revert', ts_open: new Date(now - 3 * 24 * H).toISOString() };
assert.strictEqual(timeStopDue(old5j, now).due, true, 'mean-rev 5j -> time-stop du');
assert.strictEqual(timeStopDue(young3j, now).due, false, 'mean-rev 3j -> pas encore');
// TENDANCE jamais (S1/S2/S12), meme tenue 16j
assert.strictEqual(timeStopDue({ strategy: 'S1_short_bounce', ts_open: new Date(now - 16 * 24 * H).toISOString() }, now).due, false, 'tendance S1 -> jamais de time-stop');
assert.strictEqual(timeStopDue({ strategy: 'S2_short_continuation', ts_open: new Date(now - 16 * 24 * H).toISOString() }, now).due, false, 'tendance S2 -> jamais');
// gate AGENT_TIMESTOP=0 -> off ; opts.capBars override ; ts_open absent -> pas due (sur)
assert.strictEqual(timeStopDue(old5j, now, { enabled: false }).due, false, 'gate off -> pas due');
assert.strictEqual(timeStopDue({ strategy: 'MR8', ts_open: new Date(now - 2.5 * 24 * H).toISOString() }, now, { capBars: 12 }).due, true, 'cap 12b (2j) -> 2.5j du');
assert.strictEqual(timeStopDue({ strategy: 'MR8' }, now).due, false, 'sans ts_open -> pas due (degradation sure)');
// planMonitoring : une position mean-rev vieille -> action time_stop_close (prime sur verdict/naked)
const tsPlan = planMonitoring({ verdicts: [], positions: [{ id: 'ts1', symbol: 'SUI', side: 'short', status: 'open', has_sl: true, strategy: 'MR8_stochrsi_revert', ts_open: new Date(now - 5 * 24 * H).toISOString() }], state: {}, now });
assert.strictEqual(tsPlan.plans[0].action, 'time_stop_close', 'planMonitoring -> time_stop_close');
assert.strictEqual(tsPlan.plans[0].priority, 'high', 'time_stop_close priorite high');
// needsAttention : flag time_stop (defensif)
const attTs = needsAttention({ positions: [{ id: 'ts2', symbol: 'SUI', side: 'short', status: 'open', has_sl: true, strategy: 'MR8', ts_open: new Date(now - 6 * 24 * H).toISOString() }], state: { ts2: { last_managed_ts: now } }, now });
assert.strictEqual(attTs.alert, true, 'time-stop -> alert');
assert.ok(attTs.time_stop.some((x) => x.id === 'ts2'), 'ts2 dans time_stop');

console.log('test-monitor OK (49 assertions)');
