// Test PUR (offline, deterministe) de armed-watch.js (M002/S02).
// armed-watch = le HANDOFF routine -> radar : la routine ECRIT ses intentions de setup au lieu de
// poser un limit aveugle ; le radar (S03) les LIT, confirme la bougie, puis pose le limit maker.
// Ce module valide/normalise les intentions, gere le no-duplicate (idempotence) et l'expiry.
const assert = require('assert');
const aw = require('../trade-journal/armed-watch.js');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };

const now = 1000000000000; // ms fige
const H = 3600 * 1000;

const baseSetup = {
  symbol: 'BTC', side: 'short', setup: 'S2_short_continuation',
  level: 63500, sl: 64200, take_profits: [{ px: 62000 }], risk_usd: 250, tf: '4h',
};

// 1) validateSetup : un setup complet est valide ; famille resolue depuis le nom de setup
const v = aw.validateSetup(baseSetup);
eq(v.ok, true, 'setup complet valide');
eq(v.setup.family, 'trend', 'famille resolue S2 -> trend');
eq(v.setup.confirm_type, 'continuation_close', 'confirm_type derive de la famille trend');

// MR -> confirm_type immediate (long : sl SOUS le level)
const longSetup = { ...baseSetup, side: 'long', setup: 'MR8_x', level: 63500, sl: 62800, take_profits: [{ px: 65000 }] };
eq(aw.validateSetup(longSetup).setup.confirm_type, 'immediate', 'MR -> immediate');
// zone -> sweep_reclaim
eq(aw.validateSetup({ ...baseSetup, setup: 'zone_reclaim_v1' }).setup.confirm_type, 'sweep_reclaim', 'zone -> sweep_reclaim');

// 2) validateSetup rejette les champs manquants / invalides (jamais d'intention bancale)
ok(!aw.validateSetup({ ...baseSetup, sl: undefined }).ok, 'SL manquant -> invalide');
ok(!aw.validateSetup({ ...baseSetup, level: 'x' }).ok, 'level non numerique -> invalide');
ok(!aw.validateSetup({ ...baseSetup, side: 'up' }).ok, 'side invalide -> invalide');
ok(!aw.validateSetup({ ...baseSetup, setup: 'totally_unknown' }).ok, 'setup sans famille -> invalide');

// 3) armSetup : ajoute, stampe armed_ts + expiry, genere un id deterministe
let watch = aw.emptyWatch(now);
eq(watch.setups.length, 0, 'watch vide');
watch = aw.armSetup(watch, baseSetup, now, { expiryHours: 8 });
eq(watch.setups.length, 1, 'setup arme');
const s0 = watch.setups[0];
ok(s0.id, 'id genere');
eq(s0.armed_ts, now, 'armed_ts stampe');
eq(s0.expiry_ts, now + 8 * H, 'expiry_ts = now + 8h');

// 4) no-duplicate : ré-armer le MEME (symbol+side+setup) ne cree PAS un doublon (idempotence)
const before = watch.setups.length;
watch = aw.armSetup(watch, baseSetup, now + 60000, { expiryHours: 8 });
eq(watch.setups.length, before, 'pas de doublon (meme symbol+side+setup)');

// un setup DIFFERENT (autre side) s'ajoute
watch = aw.armSetup(watch, longSetup, now, {});
eq(watch.setups.length, 2, 'setup distinct ajoute');

// 5) removeSetup par id
const rid = watch.setups[0].id;
watch = aw.removeSetup(watch, rid);
ok(!watch.setups.find((x) => x.id === rid), 'setup retire par id');
eq(watch.setups.length, 1, 'un seul restant');

// 6) pruneExpired : un setup expire est retire et rapporte
let w2 = aw.emptyWatch(now);
w2 = aw.armSetup(w2, baseSetup, now - 10 * H, { expiryHours: 8 }); // arme il y a 10h, expiry 8h -> perime
w2 = aw.armSetup(w2, { ...longSetup, symbol: 'ETH' }, now, { expiryHours: 8 }); // frais
const pr = aw.pruneExpired(w2, now);
eq(pr.watch.setups.length, 1, 'un setup restant apres prune');
eq(pr.dropped.length, 1, 'un setup droppe (expire)');
eq(pr.dropped[0].symbol, 'BTC', 'le BTC perime est droppe');
ok(aw.isExpired(w2.setups[0], now), 'isExpired vrai pour le perime');
ok(!aw.isExpired(w2.setups[1], now), 'isExpired faux pour le frais');

// 7) findActive : setups non expires d'un symbole
const act = aw.findActive(w2, 'ETH', now);
eq(act.length, 1, 'ETH actif trouve');
eq(aw.findActive(w2, 'BTC', now).length, 0, 'BTC perime non actif');

// 8) round-trip serialisation (le radar lit ce que la routine ecrit)
const json = JSON.stringify(watch);
const back = JSON.parse(json);
eq(back.setups.length, watch.setups.length, 'round-trip JSON preserve');

console.log(`test-armed-watch OK (${n} assertions)`);
