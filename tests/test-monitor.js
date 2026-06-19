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

// 11) tout protege + gerée recemment -> pas d'alerte
const att3 = needsAttention({ positions: [{ id: 'c', symbol: 'BTC', side: 'long', status: 'open', has_sl: true }], state: { c: { last_managed_ts: now - 1 * 3600 * 1000 } }, now, maxAgeHours: 5 });
assert.strictEqual(att3.alert, false);

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

console.log('test-monitor OK (15 assertions)');
