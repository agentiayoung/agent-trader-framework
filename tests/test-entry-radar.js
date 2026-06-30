// Test PUR (offline, deterministe) du COEUR du radar d'entree (M002/S03) : planRadar().
// planRadar = la boucle de decision DETERMINISTE du radar, decouplee de tout I/O (fetch/bybit) :
//   pour chaque intention armee -> expiree ? deja active (no-duplicate) ? bougie confirmee ?
//   -> decision { action: 'post' | 'keep' | 'drop', reason, confirm? }.
// Le shell async runRadar() (teste ailleurs via mocks) ne fait que : fetch bougies -> planRadar ->
// preflight + bybit_place_limit_bracket sur les 'post'. AUCUN edge cree : confirm.js par famille.
const assert = require('assert');
const { planRadar, tvTriggerSet } = require('../trade-journal/entry-radar.js');
const aw = require('../trade-journal/armed-watch.js');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };

const now = 1000000000000;
const H = 3600 * 1000;
const bar = (o, h, l, c) => [0, o, h, l, c, 1];

// Construit un watch avec quelques intentions armees.
let watch = aw.emptyWatch(now);
// (A) TREND short BTC @200 : confirme par une bougie de rejet
watch = aw.armSetup(watch, { symbol: 'BTC', side: 'short', setup: 'S2_short_continuation', level: 200, sl: 206, take_profits: [{ px: 188 }], risk_usd: 250, tf: '4h' }, now, { expiryHours: 8 });
// (B) TREND short ETH @200 : PAS de confirmation (close au-dessus)
watch = aw.armSetup(watch, { symbol: 'ETH', side: 'short', setup: 'S2_short_continuation', level: 200, sl: 206, take_profits: [{ px: 188 }], risk_usd: 250, tf: '4h' }, now, { expiryHours: 8 });
// (C) MR long SOL @100 : immediate -> post sans bougie
watch = aw.armSetup(watch, { symbol: 'SOL', side: 'long', setup: 'MR8_x', level: 100, sl: 96, take_profits: [{ px: 108 }], risk_usd: 200, tf: '4h' }, now, { expiryHours: 8 });
// (D) ZONE long XRP @1.0 : sweep+reclaim confirme
watch = aw.armSetup(watch, { symbol: 'XRP', side: 'long', setup: 'zone_reclaim_v1', level: 1.0, sl: 0.94, take_profits: [{ px: 1.1 }], risk_usd: 150, tf: '15m', atr: 0.02 }, now, { expiryHours: 8 });
// (E) TREND short LINK @50 : EXPIRE (arme il y a 10h, expiry 8h)
watch = aw.armSetup(watch, { symbol: 'LINK', side: 'short', setup: 'S1_short_bounce_rejection', level: 50, sl: 53, take_profits: [{ px: 44 }], risk_usd: 200, tf: '4h' }, now - 10 * H, { expiryHours: 8 });
// (F) TREND short SUI @5 : confirme MAIS deja une position active (no-duplicate)
watch = aw.armSetup(watch, { symbol: 'SUI', side: 'short', setup: 'S2_short_continuation', level: 5, sl: 5.3, take_profits: [{ px: 4.4 }], risk_usd: 200, tf: '4h' }, now, { expiryHours: 8 });

const barsBySymbol = {
  BTC: [bar(197, 198, 196, 197.5), bar(198, 200.5, 197.8, 199.2)], // rejet au niveau 200 -> confirme
  ETH: [bar(197, 198, 196, 197.5), bar(199, 201, 198.5, 200.6)],   // close au-dessus -> non confirme
  XRP: [bar(1.02, 1.03, 1.01, 1.015), bar(1.01, 1.015, 0.992, 0.994), bar(0.995, 1.008, 0.993, 1.004)], // sweep+reclaim
  SUI: [bar(4.7, 4.8, 4.6, 4.7), bar(4.8, 5.05, 4.78, 4.92)],      // confirme mais bloque par no-duplicate
};
// openKeys = positions/pendings deja actifs (symbol|side) -> no-duplicate
const openKeys = new Set(['SUI|short']);

const res = planRadar({ watch, barsBySymbol, openKeys, now });
const byId = Object.fromEntries(res.decisions.map((d) => [d.symbol, d]));

// (A) BTC trend confirme -> POST
eq(byId.BTC.action, 'post', 'BTC trend rejet confirme -> post');
eq(byId.BTC.price, 200, 'BTC post au niveau (limit maker)');
ok(byId.BTC.confirm && byId.BTC.confirm.confirmed, 'BTC confirm.confirmed');

// (B) ETH non confirme -> KEEP
eq(byId.ETH.action, 'keep', 'ETH non confirme -> keep (attendre)');

// (C) SOL MR immediate -> POST (sans bougie)
eq(byId.SOL.action, 'post', 'SOL MR immediate -> post');

// (D) XRP zone sweep+reclaim -> POST
eq(byId.XRP.action, 'post', 'XRP zone sweep+reclaim -> post');

// (E) LINK expire -> DROP
eq(byId.LINK.action, 'drop', 'LINK expire -> drop');
ok(/expir/i.test(byId.LINK.reason), 'LINK reason expiry');

// (F) SUI confirme MAIS deja actif -> DROP (no-duplicate)
eq(byId.SUI.action, 'drop', 'SUI deja actif -> drop (no-duplicate)');
ok(/duplicate|actif|active/i.test(byId.SUI.reason), 'SUI reason no-duplicate');

// resume : 3 post (BTC, SOL, XRP), 1 keep (ETH), 2 drop (LINK, SUI)
eq(res.toPost.length, 3, '3 a poser');
eq(res.toDrop.length, 2, '2 a dropper');
eq(res.decisions.filter((d) => d.action === 'keep').length, 1, '1 a garder');

// idempotence : SOL deja actif (long) -> ne re-poste pas
const res2 = planRadar({ watch, barsBySymbol, openKeys: new Set(['SOL|long']), now });
eq(res2.decisions.find((d) => d.symbol === 'SOL').action, 'drop', 'SOL deja actif -> drop');

// MR sans bougies du tout fonctionne (immediate ne depend pas des bougies)
const wMr = aw.armSetup(aw.emptyWatch(now), { symbol: 'DOGE', side: 'long', setup: 'MR4_x', level: 0.1, sl: 0.09, take_profits: [{ px: 0.12 }], risk_usd: 100 }, now, {});
eq(planRadar({ watch: wMr, barsBySymbol: {}, openKeys: new Set(), now }).decisions[0].action, 'post', 'MR sans bougies -> post');

// zone SANS bougies -> keep (pas de confirmation possible, on attend / pas de drop intempestif)
const wZone = aw.armSetup(aw.emptyWatch(now), { symbol: 'AVAX', side: 'long', setup: 'zone_reclaim_v1', level: 10, sl: 9.4, take_profits: [{ px: 11 }], risk_usd: 100, atr: 0.2 }, now, {});
eq(planRadar({ watch: wZone, barsBySymbol: {}, openKeys: new Set(), now }).decisions[0].action, 'keep', 'zone sans bougies -> keep');

// ===================================================================
// COUCHE TV/SELF-SOURCED (30.06) : tvTriggerSet + annotation planRadar
// (alerte = TIMING ; confirm.js reste le gate dur -> jamais de pose sans re-validation node)
// ===================================================================
{
  const tvWatch = { setups: [ { id: 'x1', symbol: 'BTC', side: 'short' }, { id: 'x2', symbol: 'ETH', side: 'long' } ] };
  const alerts = [
    { symbol: 'BTC', side: 'short', kind: 'entry' },
    { symbol: 'ETH', kind: 'entry' },               // side absent -> matche tout sens
    { symbol: 'SOL', side: 'long', kind: 'entry' },  // pas de setup -> ignore
    { symbol: 'ETH', side: 'long', kind: 'exit' },   // exit -> pour le monitor, ignore
  ];
  const tset = tvTriggerSet(alerts, tvWatch);
  ok(tset.has('BTC|short'), 'tvTriggerSet : BTC|short reveille');
  ok(tset.has('ETH|long'), 'tvTriggerSet : ETH|long reveille (side absent matche)');
  ok(!tset.has('SOL|long'), 'tvTriggerSet : SOL ignore (aucun setup arme)');
  eq(tset.size, 2, 'tvTriggerSet : exactement 2 reveilles (exit non compte)');

  // ANTI-MIRAGE : TV trigger + non confirme -> keep (confirm.js gate dur)
  const wTv = aw.armSetup(aw.emptyWatch(now), { symbol: 'ETH', side: 'short', setup: 'S2_short_continuation', level: 200, sl: 206, take_profits: [{ px: 188 }], risk_usd: 250, tf: '4h' }, now, { expiryHours: 8 });
  const dTv = planRadar({ watch: wTv, barsBySymbol: { ETH: [bar(197, 198, 196, 197.5), bar(199, 201, 198.5, 200.6)] }, openKeys: new Set(), now, tvTriggered: new Set(['ETH|short']) });
  eq(dTv.decisions[0].action, 'keep', 'TV trigger + non confirme -> keep');
  eq(dTv.decisions[0].tv_triggered, true, 'decision annotee tv_triggered=true');
  const dNo = planRadar({ watch: wTv, barsBySymbol: { ETH: [bar(197, 198, 196, 197.5), bar(199, 201, 198.5, 200.6)] }, openKeys: new Set(), now });
  eq(dNo.decisions[0].tv_triggered, false, 'pas de TV -> tv_triggered=false (retro-compat)');
}

// ===================================================================
// Shell async runRadar() avec deps MOCKEES + fichier watch temporaire
// (fetch/bybit/preflight injectes ; valide preflight-gate, dry-run, persistance, no-duplicate)
// ===================================================================
const fs = require('fs');
const os = require('os');
const pathMod = require('path');
const { runRadar } = require('../trade-journal/entry-radar.js');

(async () => {
  const tmp = pathMod.join(os.tmpdir(), `armed-watch-test-${now}.json`);
  // watch : BTC trend (confirmable), GOLD trend (preflight KO -> garde), MR SOL immediate
  let w = aw.emptyWatch(now);
  w = aw.armSetup(w, { symbol: 'BTC', side: 'short', setup: 'S2_short_continuation', level: 200, sl: 206, take_profits: [{ px: 188 }], risk_usd: 250, tf: '4h' }, now, { expiryHours: 8 });
  w = aw.armSetup(w, { symbol: 'GOLD', side: 'short', setup: 'S2_short_continuation', level: 100, sl: 104, take_profits: [{ px: 92 }], risk_usd: 200, tf: '4h' }, now, { expiryHours: 8 });
  w = aw.armSetup(w, { symbol: 'SOL', side: 'long', setup: 'MR8_x', level: 50, sl: 48, take_profits: [{ px: 54 }], risk_usd: 200, tf: '4h' }, now, { expiryHours: 8 });
  aw.writeWatch(w, tmp);

  const placed = [];
  const deps = {
    async fetchBars(symbol) {
      if (symbol === 'BTC') return [bar(197, 198, 196, 197.5), bar(198, 200.5, 197.8, 199.2)]; // confirme
      if (symbol === 'GOLD') return [bar(97, 98, 96, 97.5), bar(98, 100.5, 97.8, 99.2)];        // confirme aussi
      return [];
    },
    async getOpenKeys() { return new Set(); },
    preflight(setup) { return setup.symbol === 'GOLD' ? { ok: false, reason: 'sl-geometry' } : { ok: true }; }, // GOLD bloque
    async place(setup, confirm, dryRun) { placed.push({ symbol: setup.symbol, dryRun }); return { ok: true }; },
    log() {},
  };

  const r = await runRadar({ dryRun: true, deps, now, watchPath: tmp });

  // BTC + SOL poses (preflight ok), GOLD garde (preflight KO)
  eq(placed.length, 2, 'runRadar : 2 poses (BTC + SOL)');
  ok(placed.every((p) => p.dryRun === true), 'runRadar : dry-run propage a place');
  ok(placed.find((p) => p.symbol === 'BTC') && placed.find((p) => p.symbol === 'SOL'), 'BTC + SOL poses');
  ok(!placed.find((p) => p.symbol === 'GOLD'), 'GOLD non pose (preflight KO)');
  eq(r.posted.length, 2, 'r.posted = 2');

  // persistance : les 2 poses sont RETIREES du watch ; GOLD reste (re-tente au prochain tick)
  const after = aw.readWatch(tmp);
  eq(after.setups.length, 1, 'watch persiste : 1 restant (GOLD)');
  eq(after.setups[0].symbol, 'GOLD', 'GOLD garde pour re-tenter');

  // 2e run : GOLD maintenant deja actif (no-duplicate) -> drop
  const deps2 = { ...deps, async getOpenKeys() { return new Set(['GOLD|short']); }, preflight() { return { ok: true }; } };
  const r2 = await runRadar({ dryRun: true, deps: deps2, now: now + 60000, watchPath: tmp });
  eq(aw.readWatch(tmp).setups.length, 0, 'GOLD droppe (no-duplicate) -> watch vide');
  eq(r2.dropped.find((d) => d.symbol === 'GOLD') ? true : false, true, 'GOLD dans dropped');

  try { fs.unlinkSync(tmp); } catch (_) {}
  console.log(`test-entry-radar OK (${n} assertions)`);
})();

