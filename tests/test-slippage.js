#!/usr/bin/env node
"use strict";
// Tests offline deterministes du slippage / cout reel (piste 1). Zero reseau.
// FEE fige a 0.055% (defaut). Run: node tests/test-slippage.js
process.env.OPT_FEE_PCT = "0.055";
const { analyzeSlippage, perTrade } = require("../trade-journal/slippage.js");
let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log("  PASS  " + name); } else { failed++; console.log("  FAIL  " + name); } }

// ── perTrade : metriques unitaires ─────────────────────────────────────────
// Maker ideal (post-B1) : entree au prix prevu -> slip 0, friction = frais seuls
const maker = perTrade({ id: "maker", status: "closed", strategy: "S5_fade_range", side: "short", entry_planned: 100, entry_actual: 100, stop_loss: 102, size: 10, fees: 0.2 });
ok("maker: slip 0 (entree au prix prevu)", maker.entry_slip_R === 0);
ok("maker: realized_cost_R = 0.01 (0.2/20)", maker.realized_cost_R === 0.01);
ok("maker: modeled_cost_R = 0.055", maker.modeled_cost_R === 0.055);
ok("maker: friction = frais seuls", maker.total_friction_R === maker.realized_cost_R);

// Market two-phase (Strat A reelle) : short rempli PLUS BAS que prevu = slip adverse ~0.53R
const a = perTrade({ id: "stratA", status: "closed", strategy: "A_short_rebound", side: "short", entry_planned: 74100, entry_actual: 73836.6, stop_loss: 74330, size: 0.01, fees: 0.8071 });
ok("stratA: slip adverse 0.534R (le drag REEL)", a.entry_slip_R === 0.534);
ok("stratA: realized 0.164 ≈ modeled 0.165 (frais bien modelises)", a.realized_cost_R === 0.164 && a.modeled_cost_R === 0.165);
ok("stratA: friction totale 0.698R (slip + frais)", a.total_friction_R === 0.698);
ok("stratA: friction >> frais seuls (slip domine)", a.total_friction_R > a.realized_cost_R * 3);

// Long avec slip adverse (paye plus cher que prevu)
const l = perTrade({ id: "longadv", status: "closed", strategy: "S3_long_oversold", side: "long", entry_planned: 100, entry_actual: 100.5, stop_loss: 98, size: 10, fees: 0.3 });
ok("longadv: slip adverse 0.2R (paye + cher)", l.entry_slip_R === 0.2);
ok("longadv: friction 0.212R", l.total_friction_R === 0.212);

// entry_planned absent : slip null, cout reel quand meme calcule
const np = perTrade({ id: "noplanned", status: "closed", strategy: "S2_short_continuation", side: "short", entry_actual: 1685, stop_loss: 1720, size: 0.4, fees: 0.5099 });
ok("noplanned: slip null (pas de prix prevu)", np.entry_slip_R === null);
ok("noplanned: realized_cost_R = 0.036 calcule sans planned", np.realized_cost_R === 0.036);
ok("noplanned: friction = realized (slip null -> 0)", np.total_friction_R === 0.036);

// Slip FAVORABLE (mieux que prevu) : reporte negatif mais ne reduit PAS la friction (drag >= 0)
const f = perTrade({ id: "favor", status: "closed", strategy: "S5_fade_range", side: "short", entry_planned: 100, entry_actual: 101, stop_loss: 103, size: 10, fees: 0.2 });
ok("favor: slip favorable reporte negatif (-0.5R)", f.entry_slip_R === -0.5);
ok("favor: friction = frais (le slip favorable est un bonus, pas un drag negatif)", f.total_friction_R === f.realized_cost_R && f.total_friction_R === 0.01);

// Garde-fou : SL == entry -> null (pas de division par zero / NaN)
ok("SL==entry: perTrade null (pas de NaN)", perTrade({ id: "z", status: "closed", strategy: "S1", side: "long", entry_actual: 100, stop_loss: 100, size: 1, fees: 0.1 }) === null);

// ── analyzeSlippage : agregat + exclusions ─────────────────────────────────
const trades = [
  { id: "maker", status: "closed", strategy: "S5_fade_range", side: "short", entry_planned: 100, entry_actual: 100, stop_loss: 102, size: 10, fees: 0.2 },
  { id: "stratA", status: "closed", strategy: "A_short_rebound", side: "short", entry_planned: 74100, entry_actual: 73836.6, stop_loss: 74330, size: 0.01, fees: 0.8071 },
  { id: "longadv", status: "closed", strategy: "S3_long_oversold", side: "long", entry_planned: 100, entry_actual: 100.5, stop_loss: 98, size: 10, fees: 0.3 },
  { id: "noplanned", status: "closed", strategy: "S2_short_continuation", side: "short", entry_actual: 1685, stop_loss: 1720, size: 0.4, fees: 0.5099 },
  { id: "manualtest", status: "closed", strategy: "MANUAL_TEST_long", side: "long", entry_planned: 1.69, entry_actual: 1.69, stop_loss: 1.648, size: 24999, fees: 46.5 },
  { id: "stillopen", status: "open", strategy: "S5_fade_range", side: "short", entry_actual: 50, stop_loss: 51, size: 1 },
];
const agg = analyzeSlippage(trades);
ok("agg: n=4 (MANUAL_TEST + open exclus)", agg.n === 4);
ok("agg: MANUAL_TEST absent des details", !agg.details.some((r) => /MANUAL_TEST/.test(r.setup || "")));
ok("agg: open exclu (closed seulement)", !agg.details.some((r) => r.id === "stillopen"));
ok("agg: cost_ratio numerique > 0 (realized vs modeled)", typeof agg.cost_ratio === "number" && agg.cost_ratio > 0);
ok("agg: avg_total_friction_R renseigne", typeof agg.avg_total_friction_R === "number");
ok("agg: by_setup couvre les 4 setups", agg.by_setup.length === 4);
ok("agg: by_setup porte n + avg_friction_R", agg.by_setup.every((s) => typeof s.n === "number" && "avg_friction_R" in s));

// n=0 : pas d'exception, moyennes null
const empty = analyzeSlippage([]);
ok("n=0: pas d'exception, n=0", empty.n === 0);
ok("n=0: moyennes null", empty.avg_total_friction_R === null && empty.cost_ratio === null);

console.log(`\n  slippage.js: ${passed} pass, ${failed} fail`);
process.exit(failed ? 1 : 0);
