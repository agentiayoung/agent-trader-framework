"use strict";
// test-portfolio.js — portfolio.js (pur, cross-agent). Offline, deterministe.
const assert = require("assert");
const { aggregateAgent, buildPortfolio, renderPortfolio } = require("../trade-journal/portfolio.js");

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); };

// ---- fixtures ----
const agentTrades = [
  { status: "open", symbol: "XAUT", side: "short", entry_actual: 4238, stop_loss: 4373,
    timeline: [{ mark: 4228.5, upnl: 27.4, decision: "keep" }] },
  { status: "pending", symbol: "LINK", side: "short", entry_planned: 8.15, stop_loss: 8.66 },
  { status: "closed", symbol: "NVDA", side: "short", strategy: "price_action", net_pnl: 43.26, r_multiple: 0.32, outcome: "win" },
  { status: "closed", symbol: "META", side: "long", strategy: "price_action", net_pnl: -169.24, r_multiple: -1.01, outcome: "loss" },
  { status: "closed", symbol: "MANUAL_TEST_X", strategy: "MANUAL_TEST_PIPE", net_pnl: 999, r_multiple: 9 }, // exclu
  { status: "cancelled", symbol: "BNB", review: "rebond rate" },
  { status: "no_trade", symbol: "SOL" }, // ignore partout
];
const agentEquity = { high_water: 50008, day: "2026-06-19", day_start: 45572,
  history: [{ ts: "t", equity: 46000 }] };

const scalpTrades = [
  { status: "closed", symbol: "SUI", side: "short", strategy: "LIVE_CONTINUATION", net_pnl: -13.86, r_multiple: -0.06, outcome: "loss" },
  { status: "closed", symbol: "BNB", side: "short", strategy: "LIVE_MOMENTUM", net_pnl: -24.59, r_multiple: -0.2, outcome: "loss" },
  { status: "closed", symbol: "SUI", side: "short", strategy: "LIVE_FVG_CONT", net_pnl: 26.39, r_multiple: 0.13, outcome: "win" },
];
const scalpEquity = { high_water: 50000, day: "2026-06-19", day_start: 48500,
  history: [{ ts: "t", equity: 48447 }] };

// ---- aggregateAgent ----
const a = aggregateAgent(agentTrades, agentEquity, { name: "agent-trader" });
ok(a.equity === 46000, "equity = derniere history");
ok(Math.abs(a.day_pnl_pct - ((46000 - 45572) / 45572) * 100) < 1e-6, "day_pnl_pct calcule");
ok(Math.abs(a.dd_pct - ((50008 - 46000) / 50008) * 100) < 1e-6, "drawdown calcule");
ok(a.active_n === 2 && a.open_n === 1 && a.pending_n === 1, "positions actives = open + pending");
ok(a.closed_n === 2, "closed exclut MANUAL_TEST et no_trade/cancelled");
ok(a.wins === 1 && a.win_rate === 50, "win_rate = 1/2");
ok(Math.abs(a.closed_pnl - (43.26 - 169.24)) < 1e-6, "closed_pnl = somme net_pnl");
ok(a.r_count === 2 && Math.abs(a.avg_r - ((0.32 - 1.01) / 2)) < 0.01, "avg_r pondere sur r_multiple (arrondi 2 dec)");
ok(a.cancelled_n === 1, "cancelled compte a part");
ok(a.halt === false, "halt false (dd ~8% < 10, jour positif)");

// halt si drawdown franchit le seuil (equity bien sous le high_water)
const aHalt = aggregateAgent(agentTrades, { high_water: 50008, day_start: 45572, history: [{ equity: 44000 }] }, {});
ok(aHalt.halt === true, "halt true si dd > 10%");

// reste tradable si on releve le seuil (mode demo)
const a2 = aggregateAgent(agentTrades, { high_water: 50008, day_start: 45572, history: [{ equity: 44000 }] }, { env: { RM_MAX_DRAWDOWN_PCT: "15" } });
ok(a2.halt === false, "halt false si seuil dd releve a 15%");

// ---- buildPortfolio ----
const scalp = aggregateAgent(scalpTrades, scalpEquity, { name: "scalp-trader" });
const p = buildPortfolio([a, scalp]);
ok(p.agents.length === 2, "2 agents");
ok(Math.abs(p.aggregate.total_equity - (46000 + 48447)) < 1e-6, "total_equity = somme");
ok(p.aggregate.total_active === 2, "total_active agrege");
ok(p.aggregate.total_closed === 5, "total_closed = 2 + 3");
ok(p.aggregate.total_wins === 2, "total_wins = 1 + 1");
ok(p.aggregate.combined_win_rate === 40, "combined WR = 2/5 = 40%");
ok(Math.abs(p.aggregate.total_closed_pnl - (a2.closed_pnl + scalp.closed_pnl)) < 1e-6, "total PnL clos agrege");

// ---- renderPortfolio ----
const md = renderPortfolio(p);
ok(/agent-trader/.test(md) && /scalp-trader/.test(md), "rend les 2 agents");
ok(/PORTFOLIO|Portefeuille|Portfolio/i.test(md), "titre portfolio");
ok(/XAUT/.test(md), "positions actives rendues");
ok(md.includes("<!-- PORTFOLIO-START -->") && md.includes("<!-- PORTFOLIO-END -->"), "marqueurs AUTO presents");

// trades vides -> pas de crash
const empty = aggregateAgent([], null, { name: "vide" });
ok(empty.closed_n === 0 && empty.equity === null, "agent vide gracieux");
const pe = buildPortfolio([empty]);
ok(typeof renderPortfolio(pe) === "string", "render agent vide ok");

console.log(`test-portfolio OK (${n} assertions)`);
