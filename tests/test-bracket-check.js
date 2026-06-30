#!/usr/bin/env node
"use strict";
// Tests offline deterministes de bracket-check.js. Zero reseau.
// Run: node tests/test-bracket-check.js
const { verifyBracket, classifyStops, findOrphanOrders } = require("../trade-journal/bracket-check.js");
let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log("  PASS  " + name); } else { failed++; console.log("  FAIL  " + name); } }

const intended = { side: "short", size: 0.01, stop_loss: 64500, take_profits: [{ px: 60500 }, { px: 58500 }, { px: 56500 }] };

// Cas SAIN : position pleine + SL pleine taille + 3 TP
const sain = verifyBracket(intended, {
  position: { size: 0.01, side: "short" },
  slOrders: [{ amount: 0.01 }],
  tpOrders: [{ amount: 0.004 }, { amount: 0.003 }, { amount: 0.003 }],
});
ok("sain: ok=true, pas de critique", sain.ok === true && sain.critical === false);

// Cas CRITIQUE : position ouverte SANS SL (position nue)
const nu = verifyBracket(intended, { position: { size: 0.01, side: "short" }, slOrders: [], tpOrders: [] });
ok("nu: critical=true (pas de SL)", nu.critical === true && nu.issues.some((i) => /AUCUN stop-loss/.test(i.msg)));

// Cas FILL PARTIEL : position 0.006 vs visée 0.01 + SL oversize 0.01
const partiel = verifyBracket(intended, {
  position: { size: 0.006, side: "short" },
  slOrders: [{ amount: 0.01 }],
  tpOrders: [{ amount: 0.004 }, { amount: 0.003 }, { amount: 0.003 }],
});
ok("partiel: warn taille reelle != visee", partiel.issues.some((i) => /fill partiel/.test(i.msg)));
ok("partiel: critical SL oversize (0.01 vs 0.006)", partiel.critical === true && partiel.issues.some((i) => /OVERSIZE/.test(i.msg)));

// Cas SENS INVERSE : position long alors qu'on voulait short
const inverse = verifyBracket(intended, { position: { size: 0.01, side: "long" }, slOrders: [{ amount: 0.01 }], tpOrders: [{ amount: 0.01 }] });
ok("inverse: critical sens", inverse.critical === true && inverse.issues.some((i) => /sens position/.test(i.msg)));

// Cas PENDING (pas de position) : warn doux, pas critique
const pending = verifyBracket(intended, { position: null, slOrders: [], tpOrders: [] });
ok("pending: pas critique (entrée non remplie)", pending.critical === false && pending.issues.some((i) => /entrée non remplie/.test(i.msg)));

// Cas TP MANQUANTS : 1 TP au lieu de 3
const tpManque = verifyBracket(intended, { position: { size: 0.01, side: "short" }, slOrders: [{ amount: 0.01 }], tpOrders: [{ amount: 0.01 }] });
ok("TP manquants: warn scale-out incomplet", tpManque.issues.some((i) => /TP posés vs/.test(i.msg)) && tpManque.critical === false);

// ── LADDERED-AWARE : un ladder partiellement rempli ne doit PAS flagger "SL oversize" ──
// (faux positif XRP/SUI audit 13.06 : SL = ladder complet, position = rungs remplis seulement,
//  les SL des rungs pending sont pre-poses reduceOnly).
const ladIntended = { side: "short", size: 24000, entry_mode: "laddered", stop_loss: 1.19, take_profits: [{ px: 1.10 }, { px: 1.05 }] };

// 1 rung sur 3 rempli (8000) mais SL couvre le ladder complet (24000) -> INFO, pas critique
const ladPartial = verifyBracket(ladIntended, {
  position: { size: 8000, side: "short" },
  slOrders: [{ amount: 24000 }],
  tpOrders: [{ amount: 12000 }, { amount: 12000 }],
});
ok("laddered partiel: ok=true (pas de faux oversize)", ladPartial.ok === true && ladPartial.critical === false);
ok("laddered partiel: note info pre-couverture", ladPartial.issues.some((i) => i.level === "info" && /pre-couvert|pending/.test(i.msg)));

// SL > ladder complet (30000 > 24000) -> VRAI oversize critique
const ladOver = verifyBracket(ladIntended, {
  position: { size: 8000, side: "short" },
  slOrders: [{ amount: 30000 }],
  tpOrders: [{ amount: 12000 }],
});
ok("laddered VRAI oversize (SL > ladder complet): critique", ladOver.critical === true && /OVERSIZE reel/.test(ladOver.issues.find((i) => i.level === "critical").msg));

// SL < position remplie (4000 < 8000 rempli) -> UNDERSIZE critique (portion exposee)
const ladUnder = verifyBracket(ladIntended, {
  position: { size: 8000, side: "short" },
  slOrders: [{ amount: 4000 }],
  tpOrders: [{ amount: 12000 }],
});
ok("laddered SL < position remplie: UNDERSIZE critique", ladUnder.critical === true && /UNDERSIZE/.test(ladUnder.issues.find((i) => i.level === "critical").msg));

// ladder PLEINEMENT rempli (24000) + SL plein -> sain
const ladFull = verifyBracket(ladIntended, {
  position: { size: 24000, side: "short" },
  slOrders: [{ amount: 24000 }],
  tpOrders: [{ amount: 12000 }, { amount: 12000 }],
});
ok("laddered plein rempli: sain", ladFull.ok === true && ladFull.critical === false);

// non-laddered : le comportement strict est PRESERVE (SL oversize reste critique)
const strictOver = verifyBracket({ side: "short", size: 0.01, stop_loss: 64500, take_profits: [{ px: 60500 }] }, {
  position: { size: 0.006, side: "short" }, slOrders: [{ amount: 0.01 }], tpOrders: [{ amount: 0.006 }],
});
ok("non-laddered: SL oversize reste critique (comportement strict preserve)", strictOver.critical === true);

// ── classifyStops : classification SL/TP ROBUSTE au trailing (bug audit 18:07) ──
// BUG : un SL trailé SOUS l'entrée (short en profit) était classé TP (trigger vs entrée) -> faux "position nue".
// FIX : triggerDirection (1=hausse/2=baisse) en 1er, sinon trigger vs PRIX COURANT (pas l'entrée).

// (1) LE BUG : short, SL trailé 62000 < entrée 63200, mark 61063. triggerDirection 1 (déclenche à la hausse) = SL.
const trailed = classifyStops(
  [{ trigger: 62000, amount: 0.006, triggerDirection: 1 }, { trigger: 60500, amount: 0.004, triggerDirection: 2 }],
  { side: "short", entry: 63200, market: 61063 }
);
ok("trailed SL sous entrée (dir): classé SL (pas TP)", trailed.slOrders.length === 1 && trailed.slOrders[0].trigger === 62000);
ok("trailed: le TP reste TP", trailed.tpOrders.length === 1 && trailed.tpOrders[0].trigger === 60500);
// end-to-end : plus de faux "position nue" sur un SL trailé en profit
const e2e = verifyBracket({ side: "short", size: 0.006, stop_loss: 62000, take_profits: [{ px: 60500 }] },
  { position: { size: 0.006, side: "short" }, slOrders: trailed.slOrders, tpOrders: trailed.tpOrders });
ok("trailed e2e: PAS de faux critical 'position nue'", !e2e.issues.some((i) => /AUCUN stop-loss/.test(i.msg)));

// (2) FALLBACK sans triggerDirection -> trigger vs PRIX COURANT (survit au trailing sous l'entrée)
const trailedNoDir = classifyStops(
  [{ trigger: 62000, amount: 0.006 }, { trigger: 60500, amount: 0.004 }],
  { side: "short", entry: 63200, market: 61063 }
);
ok("fallback marché: SL 62000 > mark = SL (pas l'entrée)", trailedNoDir.slOrders.length === 1 && trailedNoDir.slOrders[0].trigger === 62000);

// (3) LONG avec triggerDirection : SL déclenche à la BAISSE (2), TP à la hausse (1)
const lng = classifyStops(
  [{ trigger: 58000, amount: 1, triggerDirection: 2 }, { trigger: 65000, amount: 1, triggerDirection: 1 }],
  { side: "long", entry: 60000, market: 61000 }
);
ok("long (dir): SL=58000 (baisse), TP=65000 (hausse)", lng.slOrders[0].trigger === 58000 && lng.tpOrders[0].trigger === 65000);

// (4) LONG fallback marché : SL sous le prix courant
const lngMkt = classifyStops([{ trigger: 59000, amount: 1 }, { trigger: 65000, amount: 1 }], { side: "long", entry: 60000, market: 61000 });
ok("long fallback marché: SL=59000 (<mark), TP=65000", lngMkt.slOrders[0].trigger === 59000 && lngMkt.tpOrders[0].trigger === 65000);

// (5) dernier recours (ni dir ni marché) -> trigger vs entrée (ancien comportement conservé)
const lastResort = classifyStops([{ trigger: 64500, amount: 0.01 }], { side: "short", entry: 63200, market: 0 });
ok("dernier recours (entrée): short SL > entrée", lastResort.slOrders.length === 1 && lastResort.tpOrders.length === 0);

// (6) ordre sans trigger -> ignoré (pas de NaN)
const noTrig = classifyStops([{ trigger: 0, amount: 1 }, { amount: 1 }], { side: "short", entry: 63200, market: 61000 });
ok("ordre sans trigger ignoré", noTrig.slOrders.length === 0 && noTrig.tpOrders.length === 0);

// ── findOrphanOrders : conditionnels sur symbole flat SANS trade actif (bug BNB) ──
// Orphelin = ordres MAIS pas de position ET pas de trade open/pending au journal.
// (un pending legitime a des ordres sans position -> EXCLU via activeSymbols).
const orders = [
  { symbol: "BNB/USDT:USDT" }, { symbol: "BNB/USDT:USDT" }, { symbol: "BNB/USDT:USDT" }, // orphelins (trade closed)
  { symbol: "BTC/USDT:USDT" }, { symbol: "BTC/USDT:USDT" }, // position vivante
  { symbol: "SOL/USDT:USDT" }, // pending legitime (limit au repos)
];
const orph = findOrphanOrders(orders, ["BTC/USDT:USDT"], ["BTC", "SOL"]);
ok("BNB détecté orphelin (flat + pas de trade actif)", orph.some((o) => o.symbol === "BNB" && o.count === 3));
ok("BTC PAS orphelin (position ouverte)", !orph.some((o) => o.symbol === "BTC"));
ok("SOL PAS orphelin (pending légitime au journal)", !orph.some((o) => o.symbol === "SOL"));
ok("orphans = uniquement BNB", orph.length === 1);
// normalisation du symbole (BNB/USDT:USDT -> BNB), tolère activeSymbols en raw
const orph2 = findOrphanOrders([{ symbol: "BNBUSDT" }], [], ["ETH/USDT:USDT"]);
ok("normalise symbole + active raw", orph2.length === 1 && orph2[0].symbol === "BNB");
// aucun orphelin si tout couvert / entrées vides
ok("aucun ordre -> aucun orphelin", findOrphanOrders([], [], []).length === 0);
ok("tout en position -> aucun orphelin", findOrphanOrders([{ symbol: "BTC/USDT:USDT" }], ["BTC/USDT:USDT"], []).length === 0);

// ── ORPHELIN reduce-only sans entree vivante (fix 27.06, parite scalp, bug DOGE/SOL/SUI) ──
// SL/TP reduce-only sur un symbole flat dont l'ENTREE a disparu, MAIS un pending stale subsiste -> orphelin.
const orphReduce = findOrphanOrders([
  { symbol: "DOGE/USDT:USDT", reduceOnly: true, triggerPrice: 0.0746 },
  { symbol: "DOGE/USDT:USDT", reduceOnly: true, triggerPrice: 0.0733 },
], [], ["DOGE"]); // DOGE est "actif" au journal (pending stale) mais SANS ordre d'entree vivant
ok("reduce-only sans entree vivante -> orphelin malgre le pending stale", orphReduce.some((o) => o.symbol === "DOGE" && o.count === 2));
// entree vivante (non-reduce) presente -> bracket legitime, 0 orphelin
const legit = findOrphanOrders([
  { symbol: "DOGE/USDT:USDT", reduceOnly: false, price: 0.07389 },
  { symbol: "DOGE/USDT:USDT", reduceOnly: true, triggerPrice: 0.0746 },
], [], ["DOGE"]);
ok("entree vivante -> bracket legitime, 0 orphelin", legit.length === 0);

// ── checkSlPlacement : SL anti-sweep (10.06, finding Hugo — cas HYPE 55.50 vs low 55.455) ──
const { checkSlPlacement } = require("../trade-journal/bracket-check.js");
const lows30 = Array(28).fill(58).concat([55.455, 57.3]);   // swing low 55.455
const highs30 = Array(28).fill(60).concat([62.5, 61]);      // swing high 62.5
// long : SL AU-DESSUS du swing low = dans la poche (le cas HYPE réel)
const bad = checkSlPlacement({ side: "long", stop_loss: 55.5, highs: highs30, lows: lows30, atr: 2.33 });
ok("long SL au-dessus du swing = ko + msg poche", bad.ok === false && /poche/i.test(bad.msg));
ok("long ko propose un suggested_sl sous le swing - 0.3xATR", Math.abs(bad.suggested_sl - (55.455 - 0.699)) < 0.01);
// long : SL pile sur le swing = ko (buffer 0)
ok("long SL pile sur le swing = ko", checkSlPlacement({ side: "long", stop_loss: 55.455, highs: highs30, lows: lows30, atr: 2.33 }).ok === false);
// long : buffer 0.1xATR = encore trop proche
ok("long buffer 0.1xATR = ko", checkSlPlacement({ side: "long", stop_loss: 55.455 - 0.233, highs: highs30, lows: lows30, atr: 2.33 }).ok === false);
// long : buffer >=0.3xATR = ok (le SL repositionné 54.75 du cas réel)
const good = checkSlPlacement({ side: "long", stop_loss: 54.75, highs: highs30, lows: lows30, atr: 2.33 });
ok("long buffer >=0.3xATR = ok (cas 54.75 réel)", good.ok === true && good.buffer_atr >= 0.3);
// short miroir : SL SOUS le swing high = poche ; au-delà + buffer = ok
ok("short SL sous le swing high = ko", checkSlPlacement({ side: "short", stop_loss: 62.4, highs: highs30, lows: lows30, atr: 2.33 }).ok === false);
ok("short SL au-dela + buffer = ok", checkSlPlacement({ side: "short", stop_loss: 63.3, highs: highs30, lows: lows30, atr: 2.33 }).ok === true);
// dégradé gracieux
ok("atr manquant -> ok:null (pas de blocage aveugle)", checkSlPlacement({ side: "long", stop_loss: 55, highs: [], lows: [], atr: null }).ok === null);

// ── checkSlGeometry : plancher de géométrie validée (10.06, post flash-sweep HYPE) ──
// TOUTES les géométries validées OOS ont un SL >= 1xATR (MR8 2.5x, S5 2x, S1 1.5x).
// Un SL < 1xATR = variante NON validée (comprimé pour le R:R) -> ÉCHEC DUR, plus un warn.
// Cas réel : HYPE entry 56.75 / SL 54.75 / ATR 2.35 -> dist 0.85xATR -> aurait dû bloquer.
const { checkSlGeometry } = require("../trade-journal/bracket-check.js");
const geoBad = checkSlGeometry({ entry: 56.75, stop_loss: 54.75, atr: 2.35 });
ok("dist 0.85xATR < 1xATR = ko (cas HYPE réel)", geoBad.ok === false && geoBad.dist_atr === 0.85);
ok("geo ko porte un msg géométrie", /1xATR|géométrie|geometrie/i.test(geoBad.msg));
const geoGood = checkSlGeometry({ entry: 44.05, stop_loss: 45.73, atr: 0.936 });
ok("dist 1.79xATR >= 1xATR = ok (cas LTC repositionné)", geoGood.ok === true && geoGood.dist_atr === 1.79);
ok("seuil personnalisable (min 2x -> 1.79 = ko)", checkSlGeometry({ entry: 44.05, stop_loss: 45.73, atr: 0.936, min_dist_atr: 2 }).ok === false);
ok("atr manquant -> ok:null", checkSlGeometry({ entry: 10, stop_loss: 9, atr: 0 }).ok === null);
ok("entry manquant -> ok:null", checkSlGeometry({ entry: undefined, stop_loss: 9, atr: 1 }).ok === null);

// ── validatedSlFloor : floor de géométrie PAR FAMILLE (GO Hugo 10.06, option A) ──
// L'exemption R:R≥2 des MR est CONDITIONNELLE à la géométrie validée → le floor passé à
// checkSlGeometry devient celui de la famille (×0.85 tolérance ATR live) au lieu de 1×ATR.
const { validatedSlFloor } = require("../trade-journal/bracket-check.js");
ok("MR8 -> floor 2.12 (2.5x0.85)", Math.abs(validatedSlFloor("MR8_MTF") - 2.125) < 0.01);
ok("S5 -> floor 1.7 (2x0.85)", Math.abs(validatedSlFloor("S5_fade_range") - 1.7) < 0.01);
ok("MR4 -> floor 1.7", Math.abs(validatedSlFloor("MR4_bb_trendfilt") - 1.7) < 0.01);
ok("S1 -> floor 1.275 (1.5x0.85)", Math.abs(validatedSlFloor("S1_short_bounce_rejection") - 1.275) < 0.01);
ok("setup inconnu -> floor universel 1", validatedSlFloor("S99_unknown") === 1);
ok("setup absent -> floor universel 1", validatedSlFloor(undefined) === 1);
// cas HYPE complet avec famille : SL 0.85xATR vs floor MR8 2.12 -> ko (encore plus net qu'au floor 1)
ok("HYPE MR8 0.85xATR < floor famille 2.12 = ko",
  checkSlGeometry({ entry: 56.75, stop_loss: 54.75, atr: 2.35, min_dist_atr: validatedSlFloor("MR8_MTF") }).ok === false);

// ── DEFENSIF : args manquants ne crashent pas (bug 21.06 : verify-bracket appele sans payload
//    -> 'Cannot read properties of undefined (reading symbol)'). verifyBracket/classifyStops
//    doivent degrader proprement (jamais throw) sur intended/actual/stops/ctx absents. ──
ok("verifyBracket(undefined, actual) ne throw pas", (() => {
  try { const r = verifyBracket(undefined, { position: null, slOrders: [], tpOrders: [] }); return r && typeof r.ok === "boolean"; } catch (e) { return false; }
})());
ok("verifyBracket({}, undefined) ne throw pas", (() => {
  try { const r = verifyBracket({}, undefined); return r && typeof r.ok === "boolean"; } catch (e) { return false; }
})());
ok("verifyBracket(undefined, undefined) ne throw pas", (() => {
  try { const r = verifyBracket(undefined, undefined); return r && Array.isArray(r.issues); } catch (e) { return false; }
})());
ok("classifyStops(undefined, undefined) ne throw pas", (() => {
  try { const r = classifyStops(undefined, undefined); return r && Array.isArray(r.slOrders) && Array.isArray(r.tpOrders); } catch (e) { return false; }
})());

console.log(`\n  bracket-check.js: ${passed} pass, ${failed} fail`);
process.exit(failed ? 1 : 0);
