#!/usr/bin/env node
"use strict";
// Tests offline de monitor-exec.js (execution RISK-REDUCING du plan de monitoring). Zero reseau.
// Invariant central : un move_sl ne ELARGIT JAMAIS le risque ; on ne pose pas de SL du mauvais cote
// du prix ; les partiels (cut/profit) sont ONE-SHOT (idempotents). Run: node tests/test-monitor-exec.js
const { manageIntents, safeTightenSl, trailingParams, isTighter, moreProtectiveVerdict, freshStructureVerdict } = require("../trade-journal/monitor-exec.js");
let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log("  PASS  " + name); } else { failed++; console.log("  FAIL  " + name); } }
const slOf = (r) => { const m = (r.intents || []).find((i) => i.kind === "move_sl"); return m ? m.params.new_sl : null; };
const has = (r, kind) => (r.intents || []).some((i) => i.kind === kind);

// ── isTighter ──
ok("isTighter long: SL plus haut = plus serre", isTighter("long", 100, 102) === true);
ok("isTighter long: SL plus bas = PAS plus serre", isTighter("long", 100, 98) === false);
ok("isTighter short: SL plus bas = plus serre", isTighter("short", 100, 98) === true);
ok("isTighter sans SL actuel = tout SL ok", isTighter("long", null, 95) === true);

// ── safeTightenSl ──
// long en profit (px 110 > entry 100) -> BE ~100.1, plus serre que 95 -> 100.1
ok("safeTighten long profit -> BE", Math.abs(safeTightenSl({ side: "long", px: 110, entry: 100, currentSl: 95, atr: 2 }) - 100.1) < 0.001);
// long en perte (px 97 < entry 100) -> BE 100.1 est AU-DESSUS de px -> interdit -> colle sous px (px-0.5atr=96)
ok("safeTighten long PERTE -> null (garde anti-sweep, fix 26.06)", safeTightenSl({ side: "long", px: 97, entry: 100, currentSl: 90, atr: 2 }) === null);
ok("safeTighten long perte + allowTowardPrice -> sous le prix (legacy)", (() => { const s = safeTightenSl({ side: "long", px: 97, entry: 100, currentSl: 90, atr: 2, allowTowardPrice: true }); return s < 97 && s > 90; })());
// long deja serre (currentSl 99 proche) -> aucun resserrement (BE 100.1 > px? px 110 -> BE 100.1 > 99 = plus serre) -> 100.1
ok("safeTighten long: BE bat un SL deja a 99", safeTightenSl({ side: "long", px: 110, entry: 100, currentSl: 99, atr: 2 }) > 99);
// long: si BE PAS plus serre que l'actuel -> null (currentSl deja au-dessus de BE)
ok("safeTighten long: SL deja au-dessus de BE -> null", safeTightenSl({ side: "long", px: 110, entry: 100, currentSl: 105, atr: 2 }) === null);
// short en profit (px 90 < entry 100) -> BE ~99.9 < currentSl 105 -> plus serre -> 99.9
ok("safeTighten short profit -> BE", Math.abs(safeTightenSl({ side: "short", px: 90, entry: 100, currentSl: 105, atr: 2 }) - 99.9) < 0.001);
ok("safeTighten short PERTE -> null (bug XAUT corrige)", safeTightenSl({ side: "short", px: 103, entry: 100, currentSl: 110, atr: 2 }) === null);
ok("safeTighten short perte + allowTowardPrice -> au-dessus (legacy)", (() => { const s = safeTightenSl({ side: "short", px: 103, entry: 100, currentSl: 110, atr: 2, allowTowardPrice: true }); return s > 103 && s < 110; })());

// ── trailingParams ──
ok("trailing: distance = mult*atr", (() => { const t = trailingParams({ px: 100, atr: 2, trailAtrMult: 1.5 }); return t && Math.abs(t.distance - 3) < 1e-6 && t.active_price === 100; })());
ok("trailing: atr manquant -> null", trailingParams({ px: 100, atr: null }) === null);

// ── manageIntents : non-executable ──
ok("action 'keep' -> noop", manageIntents({ action: "keep" }, { side: "long", px: 100 }).do === false);
ok("action inconnue -> noop", manageIntents({ action: "scale_in" }, { side: "long", px: 100 }).do === false);

// ── place_sl (position nue) ──
const ps = manageIntents({ action: "place_sl" }, { symbol: "BTC", side: "long", px: 100, stop_loss: 95 });
ok("place_sl -> pose le SL prevu", ps.do && slOf(ps) === 95);
ok("place_sl sans SL prevu -> noop (alerte manuelle)", manageIntents({ action: "place_sl" }, { symbol: "BTC", side: "long", px: 100, stop_loss: null }).do === false);

// ── set_trailing (continuation) ──
const st = manageIntents({ action: "set_trailing" }, { symbol: "BTC", side: "long", px: 110, entry: 100, atr: 2 });
ok("set_trailing (en profit) -> intent trailing", st.do && has(st, "set_trailing"));
ok("set_trailing flat/perte -> noop (gate winner)", manageIntents({ action: "set_trailing" }, { symbol: "BTC", side: "long", px: 100, entry: 100, atr: 2 }).do === false);

// ── tighten_sl (weakening) ──
const tg = manageIntents({ action: "tighten_sl" }, { symbol: "BTC", side: "long", px: 110, entry: 100, stop_loss: 95, atr: 2 });
ok("tighten_sl long profit -> move_sl vers BE", tg.do && slOf(tg) > 95 && slOf(tg) < 110);
ok("tighten_sl deja serre -> noop", manageIntents({ action: "tighten_sl" }, { symbol: "BTC", side: "long", px: 110, entry: 100, stop_loss: 108, atr: 2 }).do === false);

// ── take_partial_be (CUT, these cassee) ──
const beProfit = manageIntents({ action: "take_partial_be" }, { symbol: "BTC", side: "long", px: 110, entry: 100, stop_loss: 95, size: 10, atr: 2, managed: [] }, { partialFrac: 0.5 });
ok("cut(be) en profit -> partiel + move_sl", beProfit.do && has(beProfit, "take_partial") && has(beProfit, "move_sl"));
ok("cut(be) partiel = fraction 0.5", (beProfit.intents.find((i) => i.kind === "take_partial") || {}).params.fraction === 0.5);
ok("cut(be) tag = 'be'", beProfit.tag === "be");
const beLoss = manageIntents({ action: "take_partial_be" }, { symbol: "BTC", side: "long", px: 97, entry: 100, stop_loss: 90, size: 10, atr: 2, managed: [] });
ok("cut(be) en PERTE -> NOOP (garde anti-sweep, ne sabote pas)", beLoss.do === false);
ok("cut(be) en PROFIT (>=0.5xATR) -> coupe pour proteger le gain", manageIntents({ action: "take_partial_be" }, { symbol: "BTC", side: "long", px: 102, entry: 100, stop_loss: 95, size: 10, atr: 2, managed: [] }).do === true);
ok("cut(be) IDEMPOTENT : tag deja fait -> noop", manageIntents({ action: "take_partial_be" }, { symbol: "BTC", side: "long", px: 110, entry: 100, stop_loss: 95, size: 10, atr: 2, managed: ["be"] }).do === false);
ok("cut(be) taille inconnue -> noop", manageIntents({ action: "take_partial_be" }, { symbol: "BTC", side: "long", px: 110, entry: 100, stop_loss: 95, atr: 2, managed: [] }).do === false);

// ── take_partial_lock (PRISE DE PROFIT) ──
const lock = manageIntents({ action: "take_partial_lock" }, { symbol: "BTC", side: "short", px: 90, entry: 100, stop_loss: 105, size: 10, atr: 2, managed: [] }, { partialFrac: 0.4 });
ok("lock -> partiel + move_sl + trailing", lock.do && has(lock, "take_partial") && has(lock, "move_sl") && has(lock, "set_trailing"));
ok("lock tag = 'lock'", lock.tag === "lock");
ok("lock IDEMPOTENT", manageIntents({ action: "take_partial_lock" }, { symbol: "BTC", side: "short", px: 90, entry: 100, stop_loss: 105, size: 10, atr: 2, managed: ["lock"] }).do === false);

// ── INVARIANT GLOBAL : aucun move_sl ne ELARGIT le risque ──
const cases = [
  manageIntents({ action: "tighten_sl" }, { symbol: "X", side: "long", px: 110, entry: 100, stop_loss: 95, atr: 2 }),
  manageIntents({ action: "tighten_sl" }, { symbol: "X", side: "short", px: 90, entry: 100, stop_loss: 105, atr: 2 }),
  manageIntents({ action: "take_partial_be" }, { symbol: "X", side: "long", px: 110, entry: 100, stop_loss: 95, size: 5, atr: 2, managed: [] }),
];
let allTighter = true;
for (const r of cases) { const s = slOf(r); if (s != null) { const side = r.intents.find((i) => i.kind === "take_partial") ? "long" : (r === cases[1] ? "short" : "long"); } }
// verif explicite par cas
ok("INVARIANT long: SL resserre > ancien", slOf(cases[0]) > 95);
ok("INVARIANT short: SL resserre < ancien", slOf(cases[1]) < 105);
ok("INVARIANT cut long: SL ne ELARGIT pas (>= ancien 95)", slOf(cases[2]) >= 95);

// ── A.2 : moreProtectiveVerdict ──
ok("moreProtective: flipped > hold", moreProtectiveVerdict("hold", "flipped") === "flipped");
ok("moreProtective: weakening > running", moreProtectiveVerdict("running", "weakening") === "weakening");
ok("moreProtective: mature garde si fresh weakening", moreProtectiveVerdict("mature", "weakening") === "mature");
ok("moreProtective: flipped bat mature", moreProtectiveVerdict("mature", "flipped") === "flipped");
ok("moreProtective: inconnu -> hold(1) par defaut", moreProtectiveVerdict("hold", "zzz") === "hold");

// ── A.2 : freshStructureVerdict ──
const mssDownRecent = { last_mss: { dir: "down", j: 98 }, last_choch: { dir: "down", j: 98 } };
ok("fresh: MSS down recent contre LONG -> flipped", freshStructureVerdict({ side: "long", structure: mssDownRecent, nBars: 100, recencyBars: 3 }) === "flipped");
ok("fresh: MSS down VIEUX (j=50) -> null (pas recent)", freshStructureVerdict({ side: "long", structure: { last_mss: { dir: "down", j: 50 } }, nBars: 100, recencyBars: 3 }) === null);
ok("fresh: MSS down contre SHORT (meme sens) -> null", freshStructureVerdict({ side: "short", structure: mssDownRecent, nBars: 100, recencyBars: 3 }) === null);
ok("fresh: MSS up recent contre SHORT -> flipped", freshStructureVerdict({ side: "short", structure: { last_mss: { dir: "up", j: 99 } }, nBars: 100 }) === "flipped");
ok("fresh: CHoCH down recent (pas de MSS) contre LONG -> weakening", freshStructureVerdict({ side: "long", structure: { last_choch: { dir: "down", j: 99 } }, nBars: 100 }) === "weakening");
ok("fresh: aucune structure -> null", freshStructureVerdict({ side: "long", structure: null }) === null);
ok("fresh: pas de break -> null", freshStructureVerdict({ side: "long", structure: { last_mss: null, last_choch: null }, nBars: 100 }) === null);

// ── TIME-STOP (29.06) : time_stop_close -> close_position (flat), QUEL QUE SOIT le P&L ──
const tsLoss = manageIntents({ action: "time_stop_close", reason: "TIME-STOP mean-rev 5j" }, { symbol: "SUI", side: "short", px: 0.71, entry: 0.70, atr: 0.02, size: 1000, managed: [] });
ok("time_stop_close -> do:true meme en PERTE (pas de gate winner)", tsLoss.do === true && tsLoss.intents[0].kind === "close_position");
ok("time_stop_close -> reduce-only full size (fraction 1.0)", tsLoss.intents[0].params.fraction === 1.0 && tsLoss.intents[0].params.symbol === "SUI");
ok("time_stop_close idempotent (tag time_stop deja fait -> noop)", manageIntents({ action: "time_stop_close" }, { symbol: "SUI", side: "short", px: 0.71, size: 1000, managed: ["time_stop"] }).do === false);
ok("time_stop_close sans taille -> noop", manageIntents({ action: "time_stop_close" }, { symbol: "SUI", side: "short", px: 0.71, managed: [] }).do === false);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
