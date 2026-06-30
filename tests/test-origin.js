// test-origin.js — dimension ORIGIN (contexte d'execution) orthogonale au TRACK.
// Verifie : inference retroactive (conv vs routine_auto), priorite de l'explicite,
// orthogonalite track x origin, et que la dimension n'EXCLUT jamais une cohorte de production.
const assert = require("assert");
const { tradeTrack, tradeOrigin, isTestTrade } = require("../trade-journal/journal.js");

let n = 0;
function ok(cond, msg) { n++; assert.ok(cond, msg); }
function eq(a, b, msg) { n++; assert.strictEqual(a, b, msg); }

// ── 1. Inference retroactive (avant le champ origin) ──
eq(tradeOrigin({ source: "manual", strategy: "S1_short_bounce" }), "conv",
  "source:manual sans origin -> conv (historique = sessions conv avec Claude)");
eq(tradeOrigin({ strategy: "S1_short_bounce" }), "routine_auto",
  "pas de source -> routine_auto (le gros des trades = routines autonomes)");
eq(tradeOrigin({ source: "manual", strategy: "DEEP_ACCUM_long" }), "conv",
  "un experiment manuel est AUSSI une session conv (origin orthogonal au track)");

// ── 2. L'explicite l'emporte sur l'inference ──
eq(tradeOrigin({ origin: "routine_auto", source: "manual" }), "routine_auto",
  "origin explicite > inference (une routine peut logger source:manual en mode -Manual)");
eq(tradeOrigin({ origin: "routine_manual" }), "routine_manual",
  "routine declenchee par Hugo = routine_manual");
eq(tradeOrigin({ origin: "conv" }), "conv", "origin:conv explicite preserve");

// ── 3. Orthogonalite track x origin : un trade a les DEUX, independamment ──
const dogeConv = { strategy: "S1_short_bounce", source: "manual", origin: "conv", status: "pending" };
eq(tradeTrack(dogeConv), "production", "DOGE conv a setup catalogue = production (COMPTE dans la perf)");
eq(tradeOrigin(dogeConv), "conv", "DOGE = origin conv");
const routineProd = { strategy: "MR8_stochrsi_revert", status: "pending" }; // routine, pas de source
eq(tradeTrack(routineProd), "production", "routine a setup catalogue = production");
eq(tradeOrigin(routineProd), "routine_auto", "routine = origin routine_auto");

// ── 4. COMPLEMENTARITE : conv ET routine a setup catalogue tombent dans LE MEME track production ──
ok(tradeTrack(dogeConv) === "production" && tradeTrack(routineProd) === "production",
  "conv + routine_auto partagent production = LE MEME forward-test (jamais exclus l'un de l'autre)");

// ── 5. Les tests de plomberie restent exclus (track:test), quelle que soit l'origine ──
const plumbing = { strategy: "MANUAL_TEST_ping", source: "manual", origin: "conv" };
ok(isTestTrade(plumbing), "MANUAL_TEST_* = test");
eq(tradeTrack(plumbing), "test", "un MANUAL_TEST reste track:test meme en origin:conv (exclu de la perf)");

// ── 6. by_origin de cmd_stats : split sans exclusion (verifie via fixture en memoire) ──
// (cmd_stats lit le fichier reel ; ici on valide la LOGIQUE de split sur une cohorte synthetique)
const cohort = [
  { status: "closed", net_pnl: 10, r_multiple: 1.2, source: "manual", strategy: "S1_short_bounce" }, // conv win
  { status: "closed", net_pnl: -5, r_multiple: -1, source: "manual", strategy: "S2_short_continuation" }, // conv loss
  { status: "closed", net_pnl: 8, r_multiple: 0.9, strategy: "MR8_stochrsi_revert" }, // routine_auto win
  { status: "closed", net_pnl: 4, r_multiple: 0.5, strategy: "MANUAL_TEST_x" }, // exclu (test)
];
const byOrigin = {};
for (const t of cohort.filter((x) => !isTestTrade(x))) {
  const k = tradeOrigin(t); const b = (byOrigin[k] = byOrigin[k] || { closed: 0, wins: 0 });
  if (t.status === "closed") { b.closed++; if (t.net_pnl > 0) b.wins++; }
}
eq(byOrigin.conv.closed, 2, "2 trades conv comptes");
eq(byOrigin.conv.wins, 1, "1 win conv");
eq(byOrigin.routine_auto.closed, 1, "1 trade routine_auto compte");
ok(!("test" in byOrigin), "le trade MANUAL_TEST n'apparait dans AUCUNE origine (exclu en amont)");

console.log(`test-origin: ${n}/${n} assertions OK`);
