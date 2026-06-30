"use strict";
// ═══════════════════════════════════════════════════════════════════
// test-dashboard-history.js — onglet Historique (offline, déterministe).
// Couvre l'agrégateur PUR history.js : normalisation, tri, totaux,
// courbe de PnL cumulé, distribution R, exclusion MANUAL_TEST.
// Aucune I/O, aucun réseau : fixtures synthétiques.
// ═══════════════════════════════════════════════════════════════════
const assert = require("assert");
const { buildHistory, normalizeTrade, equityCurve, rDistribution } = require("../dashboard/api/history.js");

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const near = (a, b, m) => { assert.ok(Math.abs(a - b) < 1e-6, m + ` (${a} vs ${b})`); n++; };

// ─────────────────────────── fixtures ───────────────────────────
const AGENT = [
  { id: "a1", status: "closed", strategy: "MR8", symbol: "SUI", side: "short",
    outcome: "win", r_multiple: 1.5, net_pnl: 100, fees: 1, size: 10,
    entry_actual: 2.1, avg_exit: 2.0, exit_reason: "tp", ts_open: "2026-06-01T10:00:00Z",
    ts_close: "2026-06-01T18:00:00Z", invalidation: "close>2.2", timeline: [{ ts: "x", r: 0.5 }] },
  { id: "a2", status: "closed", strategy: "S1", symbol: "BTC", side: "short",
    outcome: "loss", r_multiple: -1, net_pnl: -50, fees: 1, size: 0.01,
    entry_actual: 63000, avg_exit: 64000, exit_reason: "sl", ts_open: "2026-06-02T10:00:00Z",
    ts_close: "2026-06-02T12:00:00Z" },
  { id: "a3", status: "open", strategy: "MR8", symbol: "ETH", side: "long" }, // ignoré (open)
  { id: "a4", status: "closed", strategy: "MANUAL_TEST_X", symbol: "DOGE", side: "long",
    outcome: "win", r_multiple: 9, net_pnl: 999, ts_close: "2026-06-03T10:00:00Z" }, // exclu (test)
];
const SCALP = [
  { id: "s1", status: "closed", strategy: "zone_reclaim_v1", symbol: "XAUT", side: "long",
    outcome: "win", r_multiple: 0.7, net_pnl: 30, fees: 0.5, size: 1,
    entry_actual: 4000, avg_exit: 4030, exit_reason: "tp", ts_open: "2026-06-05T08:00:00Z",
    ts_close: "2026-06-05T09:30:00Z" },
  { id: "s2", status: "closed", strategy: "reconcile_orphan", symbol: "XAUT", side: "long",
    outcome: "loss", net_pnl: -20, ts_close: "2026-06-06T10:00:00Z" }, // pas de r_multiple
];

const H = buildHistory(AGENT, SCALP);

// ─────────────────────────── normalisation ───────────────────────────
const row = normalizeTrade(AGENT[0], "agent");
eq(row.agent, "agent", "agent tag");
eq(row.symbol, "SUI", "symbol");
eq(row.duration_min, 480, "duree 8h = 480 min");
eq(row.timeline.length, 1, "timeline preservee");
eq(normalizeTrade({ id: "x" }, "scalp").r_multiple, null, "r_multiple absent -> null");
eq(normalizeTrade({ id: "x" }, "scalp").duration_min, null, "duree sans ts -> null");

// DUREE DEPUIS LE FILL (30.06) : si ts_fill present, la duree se compte DEPUIS LE FILL (limit touche),
// PAS depuis ts_open (pose/arm). Fallback ts_open si ts_fill absent (vieux trades / entrees market).
const fillRow = normalizeTrade({ id: "f1", status: "closed", net_pnl: 1, ts_open: "2026-06-30T10:00:00Z", ts_fill: "2026-06-30T11:30:00Z", ts_close: "2026-06-30T12:00:00Z" }, "scalp");
eq(fillRow.duration_min, 30, "duree comptee DEPUIS ts_fill (30 min), pas ts_open (120)");
eq(fillRow.ts_fill, "2026-06-30T11:30:00Z", "ts_fill expose dans la ligne");
eq(normalizeTrade({ id: "f2", status: "closed", net_pnl: 1, ts_open: "2026-06-30T10:00:00Z", ts_close: "2026-06-30T12:00:00Z" }, "scalp").duration_min, 120, "sans ts_fill -> fallback ts_open (120 min)");
// GARDE-FOU ts_fill<ts_open (30.06) : un ts_fill ANTERIEUR a ts_open (mis-attribution reconcile du
// createdTime d'une vieille position Bybit) ne doit PAS produire une duree fantome de jours/semaines.
const staleRow = normalizeTrade({ id: "f3", status: "closed", net_pnl: 1, ts_open: "2026-06-30T10:00:00Z", ts_fill: "2026-06-13T02:44:00Z", ts_close: "2026-06-30T11:00:00Z" }, "scalp");
eq(staleRow.duration_min, 60, "ts_fill stale (avant ts_open) -> fallback ts_open (60 min), PAS 17 jours fantomes");

// ─────────────────────────── filtrage ───────────────────────────
eq(H.trades.length, 4, "4 trades clos (open + MANUAL_TEST exclus)");
ok(!H.trades.find((t) => t.id === "a3"), "open exclu");
ok(!H.trades.find((t) => t.id === "a4"), "MANUAL_TEST exclu");

// ─────────────────────────── tri (ts_close desc) ───────────────────────────
eq(H.trades[0].id, "s2", "le plus recent (s2 06.06) en tete");
eq(H.trades[H.trades.length - 1].id, "a1", "le plus ancien (a1 01.06) en queue");

// ─────────────────────────── totaux ───────────────────────────
eq(H.analytics.totals.agent.n, 2, "agent: 2 clos");
eq(H.analytics.totals.scalp.n, 2, "scalp: 2 clos");
eq(H.analytics.totals.combined.n, 4, "combined: 4 clos");
eq(H.analytics.totals.agent.wins, 1, "agent: 1 win");
eq(H.analytics.totals.combined.wins, 2, "combined: 2 wins (net>0)");
near(H.analytics.totals.combined.sum_net, 60, "sum_net = 100-50+30-20 = 60");
// expectancy combined = moyenne des r_multiple presents (1.5, -1, 0.7) = 0.4
near(H.analytics.totals.combined.expectancy, (1.5 - 1 + 0.7) / 3, "expectancy = moy R presents");
eq(H.analytics.totals.combined.best.id, "a1", "best R = a1 (1.5)");
eq(H.analytics.totals.combined.worst.id, "a2", "worst R = a2 (-1)");

// ─────────────────────────── courbe equity cumulee ───────────────────────────
const ec = H.analytics.equity_curve.combined;
eq(ec.length, 4, "4 points");
near(ec[0].cum, 100, "1er point (a1) = +100");
near(ec[ec.length - 1].cum, 60, "dernier point = total net 60");
// chronologique croissant
ok(Date.parse(ec[0].ts) <= Date.parse(ec[1].ts), "courbe chronologique croissante");

// ─────────────────────────── distribution R ───────────────────────────
const dist = H.analytics.r_distribution;
const bucket = (k) => dist.find((b) => b.key === k).n;
eq(bucket("1..2"), 1, "1 trade en [1,2) (a1=1.5)");
eq(bucket("-1..-0.5"), 1, "1 trade en [-1,-0.5) (a2=-1)");
eq(bucket("0.5..1"), 1, "1 trade en [0.5,1) (s1=0.7)");
eq(dist.reduce((s, b) => s + b.n, 0), 3, "3 trades avec r_multiple (s2 exclu)");

// equityCurve sur liste vide = []
eq(equityCurve([]).length, 0, "equity vide -> []");
eq(rDistribution([]).reduce((s, b) => s + b.n, 0), 0, "distribution vide -> 0");

console.log(`test-dashboard-history: ${n} assertions OK`);
