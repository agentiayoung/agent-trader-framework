"use strict";
// ═══════════════════════════════════════════════════════════════════
// test-dashboard-grid.js — S02 dashboard API (offline, déterministe).
// Couvre les agrégateurs PURS : grid / routines / edges. Fixtures synthétiques.
// ═══════════════════════════════════════════════════════════════════
const assert = require("assert");
const { buildGrid, buildRow } = require("../dashboard/api/grid.js");
const { buildRoutines, buildRoutine } = require("../dashboard/api/routines.js");
const { aggEdges, buildEdges } = require("../dashboard/api/edges.js");

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const near = (a, b, m) => { assert.ok(Math.abs(a - b) < 1e-6, m + ` (got ${a})`); n++; };

// ─────────────────────────── grid ───────────────────────────
const ROW = {
  pair: "BTC", asset_class: "crypto", tradable: true, session: "24x7", session_open: true,
  px: 59409.3, chg24: -1.6, dRsi: 29.9, hRsi: 31.9, macd: "bear", stoch: 26.3,
  trend: "bear", regime: "trend", regime_d: "strong", dAdx: 35.3, adx_dir: "flat", funding: -0.0016,
  h1: { rsi: 37.1, dir: "falling", trend: "bear", macd: "bear", stochrsi: 0.41 },
  cycle: { cycle_low: 26523, range_pos: 33, dist_low_pct: 124, days_since_low: 988, at_cycle_low: false },
  reclaim_d50: false, reclaim_ema200d: false, divergence: null,
  obv: { trend: "down", divergence: null }, beta: { vs_btc: 1, corr: 1 },
};
const r = buildRow(ROW);
eq(r.pair, "BTC", "pair");
eq(r.px, 59409.3, "px");
eq(r.macd, "bear", "macd");
eq(r.h1.stochrsi, 0.41, "h1.stochrsi aplati");
eq(r.cycle.range_pos, 33, "cycle.range_pos");
eq(r.obv, "down", "obv aplati en trend");
eq(r.beta, 1, "beta = vs_btc");
eq(buildRow(null), null, "buildRow(null) -> null");

const grid = buildGrid({ ts: "T", all: [ROW, { pair: "ETH", px: 1564 }] });
eq(grid.stale, false, "grid non-stale");
eq(grid.rows.length, 2, "2 lignes");
eq(grid.rows[1].pair, "ETH", "2e ligne ETH (row partiel toléré)");
eq(buildGrid(null).stale, true, "grid null -> stale");
eq(buildGrid({}).stale, true, "grid sans all -> stale");

// ─────────────────────────── routines ───────────────────────────
const NOW = Date.parse("2026-06-25T20:00:00+02:00");
const HB = {
  ts: "2026-06-25 19:38", equity: 44957.25, open: 0, pending: 1, day_pnl_pct: -0.13,
  halt: false, stale_count: 0, ts_iso: "2026-06-25T19:38:54+02:00",
  last_complete: true, last_incomplete_reason: null,
};
const rt = buildRoutine(HB, { nowMs: NOW });
eq(rt.stale, false, "routine non-stale");
eq(rt.equity, 44957.25, "equity");
eq(rt.pending, 1, "pending");
eq(rt.halt, false, "halt");
eq(rt.last_complete, true, "last_complete");
eq(rt.age_sec, 21 * 60 + 6, "age 21min06 depuis ts_iso");
eq(rt.heartbeat_stale, false, "21min < 2h -> pas stale");
// heartbeat vieux -> stale
const old = buildRoutine(Object.assign({}, HB, { ts_iso: "2026-06-25T16:00:00+02:00" }), { nowMs: NOW });
eq(old.heartbeat_stale, true, "4h -> heartbeat_stale");
eq(buildRoutine(null, { nowMs: NOW }).stale, true, "routine null -> stale");

const both = buildRoutines(HB, Object.assign({}, HB, { equity: 47576 }), { nowMs: NOW });
eq(both.agent.equity, 44957.25, "routines.agent");
eq(both.scalp.equity, 47576, "routines.scalp");

// seuil de péremption PAR cadence : un heartbeat de ~4h est STALE pour le scalp
// (horaire, seuil 2h) mais PAS pour l'agent 4h (seuil 5h) — fix faux-positif.
const HB_4H = Object.assign({}, HB, { ts_iso: "2026-06-25T16:00:00+02:00" }); // 4h avant NOW
const cad = buildRoutines(HB_4H, HB_4H, { nowMs: NOW });
eq(cad.agent.heartbeat_stale, false, "agent 4h : heartbeat 4h NON stale (seuil 5h)");
eq(cad.scalp.heartbeat_stale, true, "scalp : heartbeat 4h STALE (seuil 2h)");
// override explicite respecté
const ov = buildRoutines(HB_4H, HB_4H, { nowMs: NOW, agentStaleSec: 3600 });
eq(ov.agent.heartbeat_stale, true, "agentStaleSec override -> stale");

// liveness ÉLARGIE : heartbeat vieux MAIS activité externe (scan/trade) récente -> live=true
const HB_OLD = Object.assign({}, HB, { ts_iso: "2026-06-25T10:00:00+02:00" }); // 10h avant NOW
const recentAct = Date.parse("2026-06-25T19:55:00+02:00"); // 5min avant NOW
const liveR = buildRoutine(HB_OLD, { nowMs: NOW, staleSec: 18000, activityMs: recentAct });
eq(liveR.heartbeat_stale, true, "heartbeat 10h -> heartbeat_stale (le HB seul est vieux)");
eq(liveR.last_activity_sec, 300, "activité externe = 5min (la plus récente)");
eq(liveR.live, true, "live=true via activité récente malgré heartbeat vieux");
// sans activité externe -> live retombe sur l'âge du heartbeat
const noAct = buildRoutine(HB_OLD, { nowMs: NOW, staleSec: 18000 });
eq(noAct.live, false, "sans activité externe + heartbeat 10h > 5h -> live=false");
// buildRoutines route activityMs par agent
const r2 = buildRoutines(HB_OLD, HB_OLD, { nowMs: NOW, agentActivityMs: recentAct });
eq(r2.agent.live, true, "agentActivityMs -> agent live");
eq(r2.scalp.live, false, "scalp sans activité -> live false (heartbeat 10h)");

// ─────────────────────────── edges ───────────────────────────
const TRADES = [
  { status: "closed", strategy: "S1_short", side: "short", r_multiple: 1.24, net_pnl: 868, outcome: "win" },
  { status: "closed", strategy: "S1_short", side: "short", r_multiple: -1.0, net_pnl: -300, outcome: "loss" },
  { status: "closed", strategy: "MR8", side: "long", r_multiple: 0.5, net_pnl: 120, outcome: "win" },
  { status: "open", strategy: "MR8", side: "long" }, // ignoré (pas closed)
  { status: "closed", strategy: "MR8", side: "long", net_pnl: 50 }, // pas de r_multiple -> compté en n mais hors expectancy
];
const agg = aggEdges(TRADES);
eq(agg.n, 4, "4 trades closed");
// win/loss = NET (fix 29.06) : les 3 trades à net_pnl>0 sont des wins (868, 120, 50), le -300 = loss.
eq(agg.wins, 3, "3 wins net (S1 868 + MR8 120 + MR8 50, net>0)");
near(agg.wr, 75, "WR 75% (net-based)");
// expectancy = moyenne des r_multiple présents : (1.24 - 1.0 + 0.5)/3 = 0.2466...
near(agg.expectancy, (1.24 - 1.0 + 0.5) / 3, "expectancy = avg r_multiple présents");
eq(agg.sum_net, 868 - 300 + 120 + 50, "sum_net inclut tous les closed");
const s1 = agg.by_strategy.find((x) => x.strategy === "S1_short");
eq(s1.n, 2, "S1 n=2");
near(s1.avg_r, 0.12, "S1 avg_r=(1.24-1)/2");
eq(agg.by_side.short.n, 2, "by_side.short n=2");
eq(agg.by_side.long.n, 2, "by_side.long n=2");
eq(aggEdges([]).n, 0, "vide -> n=0 sans planter");

// ── win/loss = NET, jamais le champ `outcome` brut (régression du bug 29.06 : frais > gain brut) ──
const NETWL = [
  { status: "closed", strategy: "X", side: "long", net_pnl: -3.01, realized_pnl: 1.71, outcome: "win" }, // gross + mais net - -> LOSS
  { status: "closed", strategy: "X", side: "long", net_pnl: 12, realized_pnl: 14, outcome: "loss" },     // étiqueté loss mais net + -> WIN
];
const nw = aggEdges(NETWL);
eq(nw.wins, 1, "win/loss net : le faux-win (net<0) ne compte pas, le faux-loss (net>0) compte");
near(nw.wr, 50, "WR net = 50% (1 net-win sur 2)");

const e = buildEdges(TRADES, [{ status: "closed", strategy: "ZR", side: "long", r_multiple: 0.3, net_pnl: 10, outcome: "win" }]);
eq(e.agent.n, 4, "buildEdges.agent");
eq(e.scalp.n, 1, "buildEdges.scalp");

// ── reconcile_orphan EXCLU des stats d'edge, résumé à part (fix pollution by_strategy) ──
const ORPH = [
  { status: "closed", strategy: "S2_short", side: "short", r_multiple: 1.0, net_pnl: 200, outcome: "win" },
  { status: "closed", strategy: "reconcile_orphan", side: "short", net_pnl: 75, outcome: "win" },
  { status: "closed", strategy: "reconcile_orphan", side: "short", net_pnl: -70, outcome: "loss" },
  { status: "cancelled", strategy: "reconcile_orphan", side: "short" }, // hors n (pas closed)
];
const ao = aggEdges(ORPH);
eq(ao.n, 1, "orphans exclus du n global (seul S2 compte)");
eq(ao.sum_net, 200, "sum_net global = vraies stratégies seulement (orphans hors edge)");
eq(ao.by_strategy.length, 1, "by_strategy ne contient PAS reconcile_orphan");
eq(ao.by_strategy[0].strategy, "S2_short", "seule vraie stratégie listée");
ok(!ao.by_strategy.some((x) => x.strategy === "reconcile_orphan"), "reconcile_orphan absent de by_strategy");
eq(ao.by_side.short.n, 1, "by_side.short exclut les orphelins");
eq(ao.reconcile.n, 2, "reconcile = 2 orphelins closed surfacés à part");
eq(ao.reconcile.sum_net, 5, "reconcile.sum_net = 75-70 (PnL hors-stratégie séparé)");

console.log(`test-dashboard-grid OK (${n} assertions)`);
