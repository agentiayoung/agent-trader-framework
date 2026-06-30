#!/usr/bin/env node
"use strict";
// Tests offline deterministes de l'attribution laddered-aware (reconcile-match.js).
// Zero reseau. Reproduit les 3 cas reels de fragmentation du 13-15.06 :
//   TAO  : parent laddered clos + 2 groupes closed dans l'enveloppe -> fold
//   XRP  : 1 seul groupe Bybit -> pas d'orphelin (le ghost etait un artefact)
//   SUI  : parent laddered OPEN + 1 groupe closed partiel dans l'enveloppe -> attribue
// Run: node tests/test-reconcile-match.js
const {
  baseSym, isLadder, ladderEnvelope, inEnvelope,
  findLadderParent, aggregateGroups, foldGroupIntoClosedParent, claimLadderFills,
  claimScaleOutFills, foldOrphansIntoParents,
} = require("../trade-journal/reconcile-match.js");

let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log("  PASS  " + name); } else { failed++; console.log("  FAIL  " + name); } }
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ── baseSym / isLadder ──────────────────────────────────────────────
ok("baseSym TAO/USDT:USDT", baseSym("TAO/USDT:USDT") === "TAO");
ok("baseSym SUIUSDT", baseSym("SUIUSDT") === "SUI");
ok("isLadder true", isLadder({ entry_mode: "laddered" }) === true);
ok("isLadder false (single)", isLadder({ entry_mode: "single" }) === false);
ok("isLadder false (undef)", isLadder({}) === false);

// ── ladderEnvelope : short -> rungs entre entry et SL au-dessus ──────
const tao = { entry_mode: "laddered", symbol: "TAO", side: "short", entry_actual: 218.57, stop_loss: 248.57, ts_open: "2026-06-13T06:23:52+02:00", size: 13.511, realized_pnl: 35.5016, fees: 0, risk_usd: 1216, status: "closed" };
const envT = ladderEnvelope(tao);
ok("env TAO lo<entry", envT.lo < 218.57 && envT.lo <= 218.57);
ok("env TAO hi>=SL pad", envT.hi >= 248.57);
ok("env TAO contient rung haut 230.12", inEnvelope(230.1156, envT));
ok("env TAO exclut 260 (au-dela SL)", !inEnvelope(260, envT));
ok("env TAO exclut 200 (sous entree)", !inEnvelope(200, envT));
ok("env null si entry==SL", ladderEnvelope({ entry_actual: 5, stop_loss: 5 }) === null);
ok("env null si SL manquant", ladderEnvelope({ entry_actual: 5 }) === null);

// ── findLadderParent : TAO (rung haut 230.12 attribue au parent) ────
const journalTao = [
  tao,
  { strategy: "S1", symbol: "BTC", side: "short", entry_mode: "single", entry_actual: 60000, stop_loss: 62000 }, // bruit
];
const pT = findLadderParent(journalTao, { entry: 230.1156, symbol: "TAO/USDT:USDT", side: "short", closeTs: new Date("2026-06-13T10:04:16Z").getTime() });
ok("findLadderParent TAO -> parent ladder", pT && pT.symbol === "TAO" && pT.entry_mode === "laddered");
ok("findLadderParent rejette mauvais side", findLadderParent(journalTao, { entry: 230, symbol: "TAO", side: "long", closeTs: Date.now() }) === null);
ok("findLadderParent rejette hors enveloppe", findLadderParent(journalTao, { entry: 300, symbol: "TAO", side: "short", closeTs: Date.now() }) === null);
ok("findLadderParent ignore les single-entry", findLadderParent(journalTao, { entry: 60500, symbol: "BTC", side: "short", closeTs: Date.now() }) === null);

// garde-fou temporel : un fill AVANT l'ouverture de la these n'est pas attribue
const before = findLadderParent(journalTao, { entry: 230, symbol: "TAO", side: "short", closeTs: new Date("2026-06-01T00:00:00Z").getTime() });
ok("findLadderParent rejette fill anterieur a la these", before === null);

// collision : 2 ladders SUI dans le temps -> on prend le plus recent ouvert avant le fill
const suiOld = { entry_mode: "laddered", symbol: "SUI", side: "short", entry_actual: 0.778, stop_loss: 0.821, ts_open: "2026-06-11T22:39:24+02:00", status: "open" };
const suiNew = { entry_mode: "laddered", symbol: "SUI", side: "short", entry_actual: 0.79, stop_loss: 0.83, ts_open: "2026-06-20T10:00:00+02:00", status: "open" };
const pColl = findLadderParent([suiOld, suiNew], { entry: 0.80, symbol: "SUI", side: "short", closeTs: new Date("2026-06-12T00:00:00Z").getTime() });
ok("collision -> these vivante au fill (suiOld, pas suiNew futur)", pColl === suiOld);

// position encore ouverte (closeTs null) -> candidat garde
const pOpen = findLadderParent([suiOld], { entry: 0.78, symbol: "SUI", side: "short", closeTs: null });
ok("findLadderParent position ouverte (closeTs null)", pOpen === suiOld);

// ── aggregateGroups : moy ponderee TAO (R1 + R2/R3) ─────────────────
const grpT = aggregateGroups([
  { entry: 218.57, avgExit: 215.78, qty: 13.51, pnl: 35.5, fees: 0, lastTs: 1 },
  { entry: 230.12, avgExit: 248.64, qty: 43.93, pnl: -821.3, fees: 0, lastTs: 2 },
]);
ok("aggregate qty TAO", near(grpT.qty, 57.44, 1e-3));
ok("aggregate pnl TAO", near(grpT.pnl, -785.8, 1e-1));
ok("aggregate entry ponderee TAO (entre 218 et 230)", grpT.entry > 218.57 && grpT.entry < 230.12);
ok("aggregate lastTs = max", grpT.lastTs === 2);

// ── foldGroupIntoClosedParent : TAO parent (R1) + rung R2/R3 ────────
const fold = foldGroupIntoClosedParent(tao, { entry: 230.1156, avgExit: 248.64, qty: 43.928, pnl: -821.2542, fees: 0 });
ok("fold size = 13.5 + 43.9", near(fold.size, 57.439, 1e-2));
ok("fold realized = 35.5 + (-821.25) ~ -785.75", near(fold.realized_pnl, -785.7526, 1e-2));
ok("fold outcome loss", fold.outcome === "loss");
ok("fold entry ponderee dans la bande", fold.entry_actual > 218.57 && fold.entry_actual < 230.12);
// R via realized/risk_usd (le caller applique computeRMultiple) : -785.75/1216 ~ -0.65
ok("fold R attendu ~ -0.65", near(+(fold.realized_pnl / tao.risk_usd).toFixed(2), -0.65, 0.01));

// ── SUI : parent OPEN + groupe closed partiel attribue (pas orphelin) ──
const sui = { entry_mode: "laddered", symbol: "SUI", side: "short", entry_actual: 0.778, stop_loss: 0.821, ts_open: "2026-06-11T22:39:24+02:00", status: "open" };
const pS = findLadderParent([sui], { entry: 0.78, symbol: "SUI/USDT:USDT", side: "short", closeTs: new Date("2026-06-15T13:15:53Z").getTime() });
ok("SUI partiel -> attribue au parent open (pas d'orphelin)", pS === sui);

// ── claimLadderFills : TAO clos (2 groupes, pas de position) ────────
const glTao = [
  { symbol: "TAO", side: "short", entry: 218.57, avgExit: 215.78, qty: 13.51, pnl: 35.5, fees: 0, lastTs: new Date("2026-06-13T05:31:49Z").getTime() },
  { symbol: "TAO", side: "short", entry: 230.12, avgExit: 248.64, qty: 43.93, pnl: -821.3, fees: 0, lastTs: new Date("2026-06-13T10:04:16Z").getTime() },
  { symbol: "BTC", side: "short", entry: 63000, avgExit: 62000, qty: 0.01, pnl: 6.9, fees: 0, lastTs: 1 }, // bruit
];
const claimT = claimLadderFills(tao, glTao, [], new Set(), new Set());
ok("claim TAO -> 2 groupes (les 2 rungs), 0 position", claimT.groupIdx.length === 2 && claimT.posIdx === -1);
ok("claim TAO ignore BTC (autre symbole)", !claimT.groupIdx.includes(2));

// respecte usedG (un groupe deja consomme n'est pas re-reclame)
const claimT2 = claimLadderFills(tao, glTao, [], new Set([0]), new Set());
ok("claim TAO respecte usedG", claimT2.groupIdx.length === 1 && claimT2.groupIdx[0] === 1);

// non-ladder -> rien
ok("claim single-entry -> rien", claimLadderFills({ entry_mode: "single", symbol: "TAO", side: "short", entry_actual: 218, stop_loss: 248 }, glTao, [], new Set(), new Set()).groupIdx.length === 0);

// ── claimLadderFills : SUI open (position + 1 groupe partiel) ───────
const glSui = [{ symbol: "SUI", side: "short", entry: 0.78, avgExit: 0.82, qty: 7660, pnl: -336.4, fees: 0, lastTs: new Date("2026-06-15T13:15:53Z").getTime() }];
const posSui = [{ symbol: "SUI/USDT:USDT", side: "short", entryPrice: 0.778, contracts: 15320 }];
const claimS = claimLadderFills(sui, glSui, posSui, new Set(), new Set());
ok("claim SUI -> 1 groupe partiel + position ouverte", claimS.groupIdx.length === 1 && claimS.posIdx === 0);

// position hors enveloppe -> pas reclamee
const posFar = [{ symbol: "SUI/USDT:USDT", side: "short", entryPrice: 0.90, contracts: 15320 }];
ok("claim SUI position hors env -> posIdx -1", claimLadderFills(sui, [], posFar, new Set(), new Set()).posIdx === -1);

// ── claimScaleOutFills : scale-out NON-laddered (fix fragmentation 29.06) ──────────────
const linkTrade = { entry_mode: "single", symbol: "LINK", side: "short", entry_actual: 7.99, ts_open: "2026-06-20T10:49:00Z" };
const glLink = [
  { symbol: "LINK", side: "short", entry: 7.99, avgExit: 7.91, qty: 1091.1, pnl: 77.30, fees: 6.49, lastTs: new Date("2026-06-20T20:40:00Z").getTime() },
  { symbol: "LINK", side: "short", entry: 7.995, avgExit: 7.99, qty: 1048.5, pnl: -6.69, fees: 6.28, lastTs: new Date("2026-06-20T22:28:00Z").getTime() }, // 0.06% -> meme trade
  { symbol: "LINK", side: "short", entry: 8.10, avgExit: 8.0, qty: 100, pnl: -10, fees: 0.5, lastTs: new Date("2026-06-20T23:00:00Z").getTime() }, // 1.4% -> autre trade
];
const cl = claimScaleOutFills(linkTrade, glLink, [], new Set(), new Set());
ok("claimScaleOut LINK -> 2 partiels du meme trade (7.99 & 7.995)", cl.groupIdx.length === 2 && cl.groupIdx.includes(0) && cl.groupIdx.includes(1));
ok("claimScaleOut LINK exclut 8.10 (>0.5%, autre trade)", !cl.groupIdx.includes(2));
ok("claimScaleOut ignore les laddered", claimScaleOutFills({ entry_mode: "laddered", symbol: "LINK", side: "short", entry_actual: 7.99 }, glLink, [], new Set(), new Set()).groupIdx.length === 0);
ok("claimScaleOut rejette mauvais side", claimScaleOutFills({ ...linkTrade, side: "long" }, glLink, [], new Set(), new Set()).groupIdx.length === 0);
ok("claimScaleOut respecte usedG", claimScaleOutFills(linkTrade, glLink, [], new Set([0]), new Set()).groupIdx.length === 1);
// anti-collision : un short SUI 0.7056 ne reclame PAS les fills d'un short SUI 0.6995 (0.87% > 0.5%)
const glSuiShort = [{ symbol: "SUI", side: "short", entry: 0.6995, avgExit: 0.71, qty: 1165, pnl: -12.3, fees: 0.6, lastTs: new Date("2026-06-27T08:30:00Z").getTime() }];
ok("claimScaleOut anti-collision SUI 0.7056 vs 0.6995", claimScaleOutFills({ entry_mode: "single", symbol: "SUI", side: "short", entry_actual: 0.7056, ts_open: "2026-06-28T00:00:00Z" }, glSuiShort, [], new Set(), new Set()).groupIdx.length === 0);
// position encore ouverte + 1 partiel -> reclame groupe + posIdx
const glSuiL = [{ symbol: "SUI", side: "long", entry: 0.68, avgExit: 0.69, qty: 580, pnl: 1.73, fees: 0.30, lastTs: new Date("2026-06-28T07:58:00Z").getTime() }];
const posSuiL = [{ symbol: "SUI/USDT:USDT", side: "long", entryPrice: 0.681, contracts: 870 }];
const clO = claimScaleOutFills({ entry_mode: "single", symbol: "SUI", side: "long", entry_actual: 0.682, ts_open: "2026-06-28T06:00:00Z" }, glSuiL, posSuiL, new Set(), new Set());
ok("claimScaleOut SUI long open -> groupe + position", clO.groupIdx.length === 1 && clO.posIdx === 0);

// ── foldOrphansIntoParents : repare la fragmentation historique ───────────────────────
const linkParent = { id: "s2-link", strategy: "S2_short_continuation", status: "closed", symbol: "LINK", side: "short", entry_actual: 7.99, size: 1048.5, realized_pnl: -6.6864, fees: 6.2831, net_pnl: -12.97, ts_open: "2026-06-20T10:49:00Z", ts_close: "2026-06-20T22:28:00Z" };
const linkOrphan = { id: "bybit-link-8-364298", strategy: "reconcile_orphan", status: "closed", symbol: "LINK", side: "short", entry_actual: 7.99, size: 1091.1, realized_pnl: 77.2963, fees: 6.4921, net_pnl: 70.80, avg_exit: 7.91, ts_close: "2026-06-20T20:40:00Z" };
const fLink = foldOrphansIntoParents([linkParent, linkOrphan]);
ok("fold LINK -> 1 merge", fLink.merges.length === 1 && fLink.merges[0].parent === "s2-link");
ok("fold LINK -> orphelin retire", fLink.trades.length === 1 && fLink.trades[0].id === "s2-link");
ok("fold LINK -> net combine ~ +57.83", near(fLink.trades[0].net_pnl, 57.8347, 1e-2));
ok("fold LINK -> outcome win", fLink.trades[0].outcome === "win");

const suiParent = { id: "perc-sui", strategy: "perception_long", status: "closed", symbol: "SUI", side: "long", entry_actual: 0.682, size: 1450, realized_pnl: 4.4846, fees: 0.7445, net_pnl: 3.74, ts_open: "2026-06-28T06:00:00Z", ts_close: "2026-06-28T10:04:00Z" };
const suiOrphan = { id: "bybit-sui-1-517218", strategy: "reconcile_orphan", status: "closed", symbol: "SUI", side: "long", entry_actual: 0.68, size: 580, realized_pnl: 1.7322, fees: 0.2978, net_pnl: 1.43, avg_exit: 0.69, ts_close: "2026-06-28T07:58:00Z" };
const fSui = foldOrphansIntoParents([suiParent, suiOrphan]);
ok("fold SUI long -> net combine ~ +5.17", fSui.merges.length === 1 && near(fSui.trades[0].net_pnl, 5.1745, 1e-2));

// idempotence : un 2e passage ne replie plus rien
ok("fold idempotent (2e passage = 0 merge)", foldOrphansIntoParents(fLink.trades).merges.length === 0);

// AMBIGUITE : 2 parents candidats dans la tolerance -> on NE replie PAS
const p1 = { ...linkParent, id: "p1" }, p2 = { ...linkParent, id: "p2" };
ok("fold ambigu (2 parents) -> 0 merge (conservateur)", foldOrphansIntoParents([p1, p2, linkOrphan]).merges.length === 0);

// anti-collision temporelle : orphelin tres anterieur a la vie du parent -> pas de fold
const oldOrphan = { ...linkOrphan, id: "old-orph", ts_close: "2026-05-01T00:00:00Z" };
ok("fold rejette orphelin hors fenetre temps", foldOrphansIntoParents([linkParent, oldOrphan]).merges.length === 0);

// anti-collision prix : orphelin a entree trop differente -> pas de fold
const farOrphan = { ...linkOrphan, id: "far-orph", entry_actual: 8.5 };
ok("fold rejette orphelin a entree trop loin (>0.5%)", foldOrphansIntoParents([linkParent, farOrphan]).merges.length === 0);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
