#!/usr/bin/env node
"use strict";
// Tests offline deterministes de la perception "sante de these" (thesis.js). Zero reseau.
// Raison d'etre : un short tenu dont la donnee live a FLIPPE (XRP qui casse : trend 4H bull
// + le meilleur setup du scan passe LONG + reclaim EMA50d) doit etre CRIE en premiere classe
// au LLM (verdict flipped -> take_partial + SL break-even) au lieu d'etre subi jusqu'au SL
// (-1R x5 dans le relief-rally 12-15.06). Generalise manage.js (tighten-only) en bidirectionnel.
// Run: node tests/test-thesis.js
const { thesisHealth, flipSignals, slDistancePct, unrealR, nextLiquidityTarget } = require("../trade-journal/thesis.js");

let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log("  PASS  " + name); } else { failed++; console.log("  FAIL  " + name); } }

const market = { bottom_watch: { alt_capitulation: true } };
const marketCalm = { bottom_watch: { alt_capitulation: false } };

// ── 1) XRP short FLIPPED : 3 signaux forts (trend bull + setup scan long + reclaim_d50) ──
const xrpRow = { pair: "XRP", px: 1.19, trend: "bull", macd: "bull", divergence: "bull", reclaim_d50: true,
  setup: { type: "S8_breakout", side: "long" }, obv: { trend: "up" }, h1: { dir: "rising", macd: "bull" }, cycle: { at_cycle_low: false } };
const xrpPos = { id: "x1", symbol: "XRP", side: "short", status: "open", stop_loss: 1.193 };
const rX = thesisHealth([xrpPos], [xrpRow], market);
ok("XRP short -> verdict flipped", rX.positions[0].verdict === "flipped");
ok("XRP flipped -> suggested take_partial_tighten_be", rX.positions[0].suggested === "take_partial_tighten_be");
ok("XRP flipped -> >=2 signaux forts", rX.positions[0].signals.strong.length >= 2);
ok("XRP n_flipped = 1", rX.n_flipped === 1);
ok("XRP signaux citent le setup scan long (cas breakout)", rX.positions[0].signals.strong.join(" ").includes("long"));

// ── 2) short WEAKENING : 2 signaux faibles seulement (macd bull + divergence bull, hors altcap) ──
const wkRow = { pair: "SOL", px: 100, trend: "bear", macd: "bull", divergence: "bull", reclaim_d50: false,
  setup: { type: "S1_short_bounce", side: "short" }, obv: { trend: "down" }, h1: { dir: "falling" }, cycle: { at_cycle_low: false } };
const wkPos = { id: "w1", symbol: "SOL", side: "short", status: "open", stop_loss: 110 };
const rW = thesisHealth([wkPos], [wkRow], marketCalm);
ok("SOL short 2 faibles -> weakening", rW.positions[0].verdict === "weakening");
ok("SOL weakening -> tighten_sl", rW.positions[0].suggested === "tighten_sl");

// ── 3) short at_cycle_low (1 signal fort) -> weakening (parite manage-check DOT) ──
const clRow = { pair: "DOT", px: 3, trend: "bear", macd: "bear", divergence: null, reclaim_d50: false,
  setup: { type: "S1_short_bounce", side: "short" }, obv: { trend: "down" }, cycle: { at_cycle_low: true } };
const rC = thesisHealth([{ id: "c1", symbol: "DOT", side: "short", status: "open", stop_loss: 3.2 }], [clRow], marketCalm);
ok("DOT at_cycle_low -> weakening (1 fort)", rC.positions[0].verdict === "weakening");

// ── 4) short HOLD : these intacte (rien contre) ──
const holdRow = { pair: "LINK", px: 7, trend: "bear", macd: "bear", divergence: null, reclaim_d50: false,
  setup: { type: "S2_short_continuation", side: "short" }, obv: { trend: "down" }, h1: { dir: "falling" }, cycle: { at_cycle_low: false } };
const rH = thesisHealth([{ id: "h1", symbol: "LINK", side: "short", status: "open", stop_loss: 7.5 }], [holdRow], marketCalm);
ok("LINK short intacte -> hold", rH.positions[0].verdict === "hold" && rH.positions[0].suggested === "hold");

// ── 5) LONG flipped (miroir baissier : trend bear + setup scan short) ──
const longRow = { pair: "BTC", px: 60000, trend: "bear", macd: "bear", divergence: "bear", reclaim_d50: false,
  setup: { type: "S1_short_bounce", side: "short" }, obv: { trend: "down" }, h1: { dir: "falling", macd: "bear" }, cycle: { at_cycle_low: false } };
const rL = thesisHealth([{ id: "l1", symbol: "BTC", side: "long", status: "open", stop_loss: 58000 }], [longRow], marketCalm);
ok("BTC long flippe (miroir) -> flipped", rL.positions[0].verdict === "flipped");

// ── 6) PARITE manage-check : short divergence:bull pendant alt_capitulation -> au moins weakening ──
const mcRow = { pair: "AVAX", px: 20, trend: "bear", macd: "bear", divergence: "bull", reclaim_d50: false,
  setup: { type: "S1_short_bounce", side: "short" }, obv: { trend: "down" }, cycle: { at_cycle_low: false } };
const rM = thesisHealth([{ id: "m1", symbol: "AVAX", side: "short", status: "open", stop_loss: 22 }], [mcRow], market);
ok("AVAX divergence:bull + altcap -> >= weakening (parite manage-check)", rM.positions[0].verdict !== "hold");

// ── 7) sl_distance_pct calcule ──
ok("sl_distance_pct XRP ~0.25%", Math.abs(slDistancePct(xrpPos, xrpRow) - 0.25) < 0.05);
ok("sl_distance_pct null si SL manquant", slDistancePct({ symbol: "X" }, { px: 1 }) === null);

// ── 8) paire absente du scan -> hold avec note ──
const rAbs = thesisHealth([{ id: "a1", symbol: "ZZZ", side: "short", status: "open", stop_loss: 1 }], [], marketCalm);
ok("paire absente -> hold + note pas d'info", rAbs.positions[0].verdict === "hold" && /absente/.test(rAbs.positions[0].reasons.join(" ")));

// ── 9) pending inclus, status ignore (closed) exclu ──
const rPend = thesisHealth([
  { id: "p1", symbol: "XRP", side: "short", status: "pending", stop_loss: 1.193 },
  { id: "z1", symbol: "XRP", side: "short", status: "closed", stop_loss: 1.193 },
], [xrpRow], market);
ok("pending inclus, closed exclu", rPend.n === 1 && rPend.positions[0].status === "pending");

// ── 11) RELIEF-RALLY-AWARE (finding live 15.06) : short weakening en relief-rally
//        -> NE PAS suggerer tighten_sl (sweep-out dans la resistance testee) mais reduce/hold ──
const reliefMarket = { bottom_watch: { alt_capitulation: false, relief_rally: { active: true } } };
const rReliefShort = thesisHealth([wkPos], [wkRow], reliefMarket);
ok("short weakening + relief-rally -> hold_to_sl_or_reduce (PAS tighten)", rReliefShort.positions[0].verdict === "weakening" && rReliefShort.positions[0].suggested === "hold_to_sl_or_reduce");
ok("relief-rally short -> raison cite sweep-out", /SWEEP-OUT|sweep/i.test(rReliefShort.positions[0].reasons.join(" ")));
// hors relief-rally, meme short weakening -> tighten_sl classique (comportement preserve)
ok("short weakening HORS relief-rally -> tighten_sl (preserve)", thesisHealth([wkPos], [wkRow], marketCalm).positions[0].suggested === "tighten_sl");

// ── 12) MONITORING BIDIRECTIONNEL (directive live-first 15.06) : gagnants running/mature ──
// unrealR pur : short en gain (px sous entry)
ok("unrealR short en gain ~+1R", unrealR({ side: "short", entry_actual: 100, stop_loss: 110 }, { px: 90 }) === 1);
ok("unrealR short en perte ~-0.5R", unrealR({ side: "short", entry_actual: 100, stop_loss: 110 }, { px: 105 }) === -0.5);
ok("unrealR long en gain ~+1R", unrealR({ side: "long", entry_actual: 100, stop_loss: 90 }, { px: 110 }) === 1);

// short GAGNANT + momentum avec nous (trend bear, rien contre) -> running / hold_let_run
const winRow = { pair: "LINK", px: 7.0, trend: "bear", macd: "bear", divergence: null, reclaim_d50: false, setup: { type: "S1_short_bounce", side: "short" }, obv: { trend: "down" }, h1: { dir: "falling" }, cycle: { at_cycle_low: false } };
const rRun = thesisHealth([{ id: "win1", symbol: "LINK", side: "short", status: "open", entry_actual: 8.0, stop_loss: 8.5 }], [winRow], marketCalm);
ok("short gagnant + momentum avec nous -> running", rRun.positions[0].verdict === "running" && rRun.positions[0].suggested === "hold_let_run");
ok("running -> unreal_R > 0", rRun.positions[0].unreal_R > 0);
ok("running compte dans n_running", rRun.n_running === 1);

// short GAGNANT (>=1R) -> trailing OBLIGATOIRE mentionne
const rRun1R = thesisHealth([{ id: "w1r", symbol: "LINK", side: "short", status: "open", entry_actual: 8.0, stop_loss: 8.5 }], [{ ...winRow, px: 7.4 }], marketCalm);
ok("gagnant >=1R -> trailing OBLIGATOIRE", /TRAILING OBLIGATOIRE/.test(rRun1R.positions[0].reasons.join(" ")));

// short GAGNANT mais le MOVE SE RETOURNE (flip haussier) -> mature / take_partial_lock
const matRow = { pair: "SOL", px: 70, trend: "bull", macd: "bull", divergence: "bull", reclaim_d50: true, setup: { type: "S8_breakout", side: "long" }, obv: { trend: "up" }, h1: { dir: "rising", macd: "bull" }, cycle: { at_cycle_low: false } };
const rMat = thesisHealth([{ id: "mat1", symbol: "SOL", side: "short", status: "open", entry_actual: 80, stop_loss: 85 }], [matRow], marketCalm);
ok("short gagnant + move se retourne -> mature", rMat.positions[0].verdict === "mature" && rMat.positions[0].suggested === "take_partial_lock");
ok("mature compte dans n_mature", rMat.n_mature === 1);

// position quasi-flat (rU < 0.3) avec flip -> logique perdant (pas running/mature)
const flatRow = { pair: "XRP", px: 1.19, trend: "bull", macd: "bull", divergence: "bull", reclaim_d50: true, setup: { type: "S8_breakout", side: "long" }, obv: { trend: "up" }, h1: { dir: "rising", macd: "bull" }, cycle: { at_cycle_low: false } };
const rFlat = thesisHealth([{ id: "fl1", symbol: "XRP", side: "short", status: "open", entry_actual: 1.193, stop_loss: 1.25 }], [flatRow], marketCalm);
ok("flat/perdant + flip -> flipped (pas running/mature)", rFlat.positions[0].verdict === "flipped");

// ── 10) flipSignals pur : short voit le flip haussier, pas un short intact ──
ok("flipSignals short intact -> 0 fort", flipSignals({ side: "short" }, holdRow).strong.length === 0);
ok("flipSignals short flippe -> >=2 forts", flipSignals({ side: "short" }, xrpRow).strong.length >= 2);

// ── 12) TRAJECTOIRE (trajById injecte) : gagnante sans flip -> running ; + give-back fort -> mature ──
const tjRow = { pair: "GG", px: 106, trend: "bull", macd: "bull", divergence: null, reclaim_d50: false,
  setup: { type: "S1_long", side: "long" }, obv: { trend: "up" }, h1: { dir: "rising", macd: "bull" }, cycle: { at_cycle_low: false } };
const tjPos = { id: "g1", symbol: "GG", side: "long", status: "open", entry_actual: 100, stop_loss: 90 }; // unrealR = (106-100)/10 = 0.6
const rTjRun = thesisHealth([tjPos], [tjRow], marketCalm); // sans trajById -> running (retro-compatible)
ok("traj: gagnante sans flip, sans traj -> running", rTjRun.positions[0].verdict === "running");
const rTjMat = thesisHealth([tjPos], [tjRow], marketCalm, { g1: { mfe_R: 1.5, unreal_R: 0.6, giveback_pct: 0.6, velocity: "reversing", bars_held: 5 } });
ok("traj: gagnante + give-back 60% -> mature (prendre le TP plus tot)", rTjMat.positions[0].verdict === "mature" && rTjMat.positions[0].suggested === "take_partial_lock");
ok("traj: verdict mature cite le give-back", /give-back/i.test(rTjMat.positions[0].reasons.join(" ")));
ok("traj: trajectory expose dans la sortie", rTjMat.positions[0].trajectory && rTjMat.positions[0].trajectory.mfe_R === 1.5);

// ── 13) "avait besoin d'air" : MAE profond (-1.2R) mais recupere (+0.6R) -> note anti-sur-resserrage ──
const rTjAir = thesisHealth([tjPos], [tjRow], marketCalm, { g1: { mfe_R: 1.5, unreal_R: 0.6, mae_R: -1.2, giveback_pct: 0.1, velocity: "accelerating", bars_held: 8 } });
ok("traj: MAE profond recupere -> note 'besoin d'air'", /besoin d'air/i.test(rTjAir.positions[0].reasons.join(" ")));

// ── 14) PERCEPTION STRUCTURE (F3) : MSS/CHoCH du scan row CONTRE la position = signal FORT ──
// short intact structurellement mais perception.mss = up (structure cassee a la hausse) -> 1 fort.
const mssRow = { pair: "MS", px: 100, trend: "bear", macd: "bear", divergence: null, reclaim_d50: false,
  setup: { type: "S1_short", side: "short" }, obv: { trend: "down" }, h1: { dir: "falling" }, cycle: { at_cycle_low: false },
  perception: { mss: "up", choch: "up" } };
const sMss = flipSignals({ side: "short" }, mssRow);
ok("perception MSS up contre un short -> 1 signal fort", sMss.strong.length === 1 && /MSS up/.test(sMss.strong.join(" ")));
ok("perception MSS prime sur CHoCH (un seul signal de structure)", !/CHoCH/.test(sMss.strong.join(" ")));
// CHoCH seul (pas de MSS) -> fallback CHoCH
const chochRow = { ...mssRow, perception: { mss: null, choch: "up" } };
ok("perception CHoCH up seul -> signal fort CHoCH", /CHoCH up/.test(flipSignals({ side: "short" }, chochRow).strong.join(" ")));
// structure ALIGNEE (mss down sur un short) -> AUCUN signal (pas contre la position)
const alignRow = { ...mssRow, perception: { mss: "down", choch: "down" } };
ok("perception structure alignee au short -> 0 signal de structure", flipSignals({ side: "short" }, alignRow).strong.length === 0);
// long : structure baissiere contre = mss down
const longMss = { pair: "LM", px: 100, trend: "bull", macd: "bull", setup: { type: "S1_long", side: "long" }, perception: { mss: "down", choch: null } };
ok("perception MSS down contre un long -> 1 fort", /MSS down/.test(flipSignals({ side: "long" }, longMss).strong.join(" ")));
// retro-compat : pas de perception -> aucun signal de structure
ok("sans perception -> aucun signal de structure (retro-compat)", flipSignals({ side: "short" }, holdRow).strong.length === 0);

// ── 15) PERCEPTION ORDERFLOW (F3) : sweep injecte (perc) CONTRE la position = signal FORT ──
const sweepPerc = { orderflow: { sweep: { detected: true, bias: "long", side: "sell_side" } } };
const sSweep = flipSignals({ side: "short" }, mssRow, sweepPerc); // mssRow a deja 1 structure -> +1 sweep = 2 forts
ok("sweep long injecte contre un short -> signal sweep present", /sweep .* -> long/.test(sSweep.strong.join(" ")));
ok("perc sweep absent -> pas de signal sweep", !/sweep/.test(flipSignals({ side: "short" }, chochRow).strong.join(" ")));
// sweep ALIGNE au short (bias short) -> pas de signal
ok("sweep aligne (bias short sur un short) -> 0 signal sweep", !/sweep/.test(flipSignals({ side: "short" }, holdRow, { orderflow: { sweep: { detected: true, bias: "short", side: "buy_side" } } }).strong.join(" ")));
// thesisHealth bout-en-bout : percById injecte -> sweep compte dans le verdict
const swPos = { id: "sw1", symbol: "MS", side: "short", status: "open", stop_loss: 101 };
const rSw = thesisHealth([swPos], [mssRow], marketCalm, null, { sw1: sweepPerc });
ok("thesisHealth: MSS + sweep injecte -> 2 forts -> flipped", rSw.positions[0].signals.strong.length >= 2 && rSw.positions[0].verdict === "flipped");

// ── 16) F3.2 nextLiquidityTarget : prochaine liquidite dans le sens du profit ──
// short @100 : cibles SOUS le prix (eql 95, support 90) -> la PLUS PROCHE = eql 95.
const percZones = { px: 100, zones: [
  { type: "eql", lo: 95, hi: 96, dist_atr: 0.8, status: "fresh" },
  { type: "support", lo: 90, hi: 91, dist_atr: 1.6 },
  { type: "resistance", lo: 104, hi: 105, dist_atr: 1.2 }, // au-dessus = pas une cible pour un short
] };
const tgtS = nextLiquidityTarget({ side: "short" }, percZones);
ok("zone-target short -> eql @96 (bord haut, premier contact en descente)", tgtS && tgtS.type === "eql" && tgtS.px === 96);
// long @100 : cibles AU-DESSUS (resistance) -> bord bas (premier contact en montee) = 104
const tgtL = nextLiquidityTarget({ side: "long" }, percZones);
ok("zone-target long -> resistance @104 (bord bas, premier contact en montee)", tgtL && tgtL.type === "resistance" && tgtL.px === 104);
ok("zone-target null sans perception profonde", nextLiquidityTarget({ side: "short" }, null) === null);
ok("zone-target null si aucune zone dans le sens du profit", nextLiquidityTarget({ side: "long" }, { px: 100, zones: [{ type: "support", lo: 90, hi: 91 }] }) === null);
// bout-en-bout : une gagnante RUNNING (sans flip) expose zone_target + le cite dans les reasons
const winZone = { pair: "GG", px: 94, trend: "bear", macd: "bear", setup: { type: "S1_short", side: "short" }, obv: { trend: "down" } };
const winPos = { id: "wz1", symbol: "GG", side: "short", status: "open", entry_actual: 100, stop_loss: 104 }; // short en gain (px 94 < entry 100)
const rWZ = thesisHealth([winPos], [winZone], marketCalm, { wz1: { mfe_R: 1.2, unreal_R: 1.5, giveback_pct: 0.1, velocity: "accelerating", bars_held: 4 } }, { wz1: { px: 94, zones: [{ type: "eql", lo: 90, hi: 91, dist_atr: 0.9, status: "fresh" }] } });
ok("thesisHealth running expose zone_target depuis perc.zones", rWZ.positions[0].zone_target && rWZ.positions[0].zone_target.type === "eql");
ok("running cite la cible de liquidite dans les reasons", /CIBLE DE LIQUIDITE/.test(rWZ.positions[0].reasons.join(" ")));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
