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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
