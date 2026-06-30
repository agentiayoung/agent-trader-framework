// Test PUR (offline, deterministe : aucune dependance reseau/Date.now) de confirm.js (M002/S01).
// confirm.js = logique de CONFIRMATION DE BOUGIE PAR FAMILLE, le coeur du radar d'entree.
// Le radar (S03) appelle confirmCandle() a chaque tick : il ne POSE le limit maker que si la
// bougie confirme. La discipline OOS (design 2026-06-22) dicte la logique par famille :
//   - MR (S5/MR8/MR4)         -> IMMEDIAT (MR8_e_confirm rejete OOS : attendre TUE l'edge MR).
//   - ZONE (M004 sweep+reclaim) -> sweep close + reclaim close = la confirmation VALIDEE OOS.
//   - TREND (S1/S2/S12)       -> bougie de rejet/continuation AU niveau (greffe sur edge valide).
//   - LONG_WATCH (S_long_*)   -> meme logique trend, mais forward-test (reel interdit, n<30).
// Le radar entre toujours en LIMIT MAKER au niveau (price) ; jamais market au close (_chase negatif).
const assert = require('assert');
const { confirmCandle, setupFamily } = require('../trade-journal/confirm.js');

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };
const eq = (a, b, msg) => { assert.strictEqual(a, b, msg); n++; };

// Helper bougie [ts,o,h,l,c,v]
const bar = (o, h, l, c) => [0, o, h, l, c, 1];

// ===================================================================
// 1) MEAN-REVERSION = confirmation IMMEDIATE (pas d'attente)
// ===================================================================
const mr = confirmCandle('mr', 'long', [], 100, { atr: 2 });
eq(mr.confirmed, true, 'MR confirme immediatement (pas d attente)');
eq(mr.price, 100, 'MR price = niveau (limit immediat)');
ok(/immediat|mean-rev/i.test(mr.reason), 'MR reason explicite');
eq(mr.family, 'mr', 'MR family normalisee');
// MR confirme meme SANS bougies (l'edge MR n'attend rien)
eq(confirmCandle('mean_reversion', 'short', null, 50, {}).confirmed, true, 'MR alias + bars null -> confirme');

// MR doit etre confirme quelle que soit la donnee de bougie (ne JAMAIS attendre).
const mrBad = confirmCandle('mr', 'long', [bar(100, 101, 99, 100.5)], 100, { atr: 2 });
eq(mrBad.confirmed, true, 'MR ne depend pas de la forme de bougie');

// ===================================================================
// 2) ZONE = sweep + reclaim close (mirror M004 zone-reaction, validee OOS)
// ===================================================================
// LONG : support a 100. Une meche balaie SOUS 100-0.15*atr (=99.7) puis une bougie referme >=100.
const zoneLongBars = [
  bar(102, 103, 101, 101.5),   // contexte
  bar(101, 101.5, 99.2, 99.4), // SWEEP : low 99.2 < 99.7, close 99.4 encore sous (pas reclaim)
  bar(99.5, 100.8, 99.3, 100.4) // RECLAIM : close 100.4 >= 100
];
const zL = confirmCandle('zone', 'long', zoneLongBars, 100, { atr: 2 });
eq(zL.confirmed, true, 'ZONE long : sweep+reclaim confirme');
eq(zL.price, 100, 'ZONE long price = niveau (limit maker au reclaim)');
ok(/sweep/i.test(zL.reason) && /reclaim/i.test(zL.reason), 'ZONE reason mentionne sweep+reclaim');

// LONG sans sweep : touche propre du niveau (close au-dessus mais AUCUNE meche au-dela du seuil) -> PAS confirme
const zoneCleanTouch = [
  bar(102, 103, 101, 101.5),
  bar(101, 101.5, 100.1, 100.6), // low 100.1 > seuil 99.7 : pas de sweep
  bar(100.6, 101, 100.2, 100.8)
];
eq(confirmCandle('zone', 'long', zoneCleanTouch, 100, { atr: 2 }).confirmed, false, 'ZONE long : touche propre sans sweep -> NON confirme');

// SHORT : resistance a 200. Meche balaie SUR 200+0.15*atr (=200.3) puis bougie referme <=200.
const zoneShortBars = [
  bar(198, 199, 197, 198.5),
  bar(199, 200.8, 198.8, 200.5), // SWEEP : high 200.8 > 200.3, close 200.5 encore au-dessus
  bar(200.4, 200.4, 199, 199.6)  // RECLAIM : close 199.6 <= 200
];
const zS = confirmCandle('zone', 'short', zoneShortBars, 200, { atr: 2 });
eq(zS.confirmed, true, 'ZONE short : sweep+reclaim confirme');

// ZONE sans atr -> ne peut pas mesurer le seuil de sweep -> non confirme + raison
const zNoAtr = confirmCandle('zone', 'long', zoneLongBars, 100, {});
eq(zNoAtr.confirmed, false, 'ZONE sans atr -> non confirme');
ok(/atr/i.test(zNoAtr.reason), 'ZONE sans atr -> raison cite atr');

// ZONE bougies vides -> non confirme (pas d'entree sur du vide)
eq(confirmCandle('zone', 'long', [], 100, { atr: 2 }).confirmed, false, 'ZONE bars vides -> non confirme');

// ===================================================================
// 3) TREND = bougie de confirmation (rejet au niveau, continuation)
// ===================================================================
// SHORT continuation a 200 (resistance) : la DERNIERE bougie close monte tester 200 (high>=200)
// PUIS referme dessous (close<200) = rejet -> confirme. Le radar pose un limit MAKER a 200.
const trendShortOk = [
  bar(197, 198, 196, 197.5),
  bar(198, 200.5, 197.8, 199.2) // high 200.5 >= 200 (teste), close 199.2 < 200 (rejet)
];
const tS = confirmCandle('trend', 'short', trendShortOk, 200, { atr: 2 });
eq(tS.confirmed, true, 'TREND short : rejet au niveau confirme');
eq(tS.price, 200, 'TREND price = niveau (limit maker au rejet)');
ok(/rejet|continuation|niveau/i.test(tS.reason), 'TREND reason explicite');

// SHORT non confirme : la derniere bougie CLOSE AU-DESSUS du niveau (pas de rejet) -> attendre
const trendShortNo = [
  bar(197, 198, 196, 197.5),
  bar(199, 201, 198.5, 200.6) // close 200.6 > 200 : pas de rejet
];
eq(confirmCandle('trend', 'short', trendShortNo, 200, { atr: 2 }).confirmed, false, 'TREND short : close au-dessus -> NON confirme');

// SHORT non confirme : la derniere bougie n'a PAS atteint le niveau (high < level) -> rien a confirmer
const trendShortUntested = [
  bar(195, 196, 194, 195.5),
  bar(195, 197, 194.5, 196) // high 197 < 200 : niveau pas teste
];
eq(confirmCandle('trend', 'short', trendShortUntested, 200, { atr: 2 }).confirmed, false, 'TREND short : niveau pas teste -> NON confirme');

// LONG continuation a 100 (support) : derniere bougie wick sous 100 (low<=100) PUIS close >100 = rejet haussier
const trendLongOk = [
  bar(103, 104, 102, 103),
  bar(101, 102, 99.5, 100.8) // low 99.5 <= 100 (teste), close 100.8 > 100 (rejet haussier)
];
eq(confirmCandle('trend', 'long', trendLongOk, 100, { atr: 2 }).confirmed, true, 'TREND long : rejet haussier confirme');

// ===================================================================
// 4) LONG_WATCH = meme logique trend mais FORWARD-TEST (reel interdit)
// ===================================================================
const lw = confirmCandle('long_watch', 'long', trendLongOk, 100, { atr: 2 });
eq(lw.confirmed, true, 'LONG_WATCH : confirme comme trend long');
eq(lw.forward_test, true, 'LONG_WATCH : flag forward_test=true (reel interdit)');
ok(/forward/i.test(lw.reason), 'LONG_WATCH reason cite forward-test');

// ===================================================================
// 5) Validation des entrees + setupFamily()
// ===================================================================
// famille inconnue -> non confirme + raison (jamais d'entree par defaut)
const unk = confirmCandle('chaos', 'long', [], 100, { atr: 2 });
eq(unk.confirmed, false, 'famille inconnue -> non confirme');
// side invalide -> non confirme
eq(confirmCandle('mr', 'sideways', [], 100, {}).confirmed, false, 'side invalide -> non confirme');
// level non fini -> non confirme
eq(confirmCandle('mr', 'long', [], NaN, {}).confirmed, false, 'level NaN -> non confirme');
eq(confirmCandle('mr', 'long', [], null, {}).confirmed, false, 'level null -> non confirme');

// setupFamily : mapping nom de setup -> famille
eq(setupFamily('MR8_stochrsi_naked'), 'mr', 'MR8 -> mr');
eq(setupFamily('S5_bb_reversion'), 'mr', 'S5 -> mr');
eq(setupFamily('MR4_x'), 'mr', 'MR4 -> mr');
eq(setupFamily('S1_short_bounce_rejection'), 'trend', 'S1 -> trend');
eq(setupFamily('S2_short_continuation'), 'trend', 'S2 -> trend');
eq(setupFamily('S12_squeeze_break'), 'trend', 'S12 -> trend');
eq(setupFamily('zone_reclaim_v1'), 'zone', 'zone_reclaim -> zone');
eq(setupFamily('S_long_dip_bull'), 'long_watch', 'S_long_dip -> long_watch');
eq(setupFamily('S_long_break_bull'), 'long_watch', 'S_long_break -> long_watch');
eq(setupFamily('unknown_xyz'), null, 'inconnu -> null');

// confirmCandle accepte aussi un nom de setup via setupFamily (robustesse) : 'MR8...' resolu en mr
eq(confirmCandle(setupFamily('MR8_x'), 'long', [], 100, {}).confirmed, true, 'setupFamily->confirmCandle pipeline mr');

console.log(`test-confirm OK (${n} assertions)`);
