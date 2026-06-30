#!/usr/bin/env node
"use strict";
// Tests offline deterministes du guard pipeline pre-bracket (guards.js). Zero reseau.
// Run: node tests/test-guards.js
const { runGuards, setupFamily, rrToTp2 } = require("../trade-journal/guards.js");
let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log("  PASS  " + name); } else { failed++; console.log("  FAIL  " + name); } }

// Determinisme : les cas non-demo (1-11) supposent DEMO_ACTIVE NON defini. On le retire de l'env
// ambiant (sinon un shell avec DEMO_ACTIVE=1 fait passer les BLOCK en warn -> faux echecs). Les cas
// DEMO (12-13) le posent explicitement.
delete process.env.DEMO_ACTIVE;

// ── setupFamily : parse STRICT par segment (ne confond pas S1 et S12) ──
ok("famille MR8_MTF -> MR8", setupFamily("MR8_MTF") === "MR8");
ok("famille S12_squeeze_break -> S12 (pas S1)", setupFamily("S12_squeeze_break") === "S12");
ok("famille S1_MTF -> S1", setupFamily("S1_MTF") === "S1");
ok("famille S2_laddered -> S2", setupFamily("S2_laddered") === "S2");

// ── rrToTp2 : R:R jusqu'a TP2, short et long ──
ok("rr short = 2.0 (entry100 sl105 tp290)", rrToTp2({ side: "short", entry: 100, stop_loss: 105, take_profits: [{ px: 97 }, { px: 90 }] }) === 2);
ok("rr long = 3.0 (entry100 sl95 tp1.. tp2 115)", rrToTp2({ side: "long", entry: 100, stop_loss: 95, take_profits: [{ px: 108 }, { px: 115 }] }) === 3);
ok("rr null si TP manquant", rrToTp2({ side: "long", entry: 100, stop_loss: 95, take_profits: [] }) === null);

// Contexte de base SAIN (rien ne bloque)
const ctxSain = {
  atr: 2,
  equityState: { halt: false, day_pnl_pct: 0.5, drawdown_pct: 0.1 },
  todayCount: 0,
  exposure: { can_add_long: true, can_add_short: true, open_pending: 1, max_active: 8, max_side_risk_pct: 12, max_total_risk_pct: 18, total_risk_pct: 3, long: { risk_pct: 3 }, short: { risk_pct: 0 } },
};

// ── 1) Trade de tendance conforme -> ALLOW ──
const trendOk = runGuards(
  { symbol: "BTC", side: "long", setup: "S1_MTF", entry: 100, stop_loss: 97, take_profits: [{ px: 104 }, { px: 106.5 }] }, // dist SL 3 = 1.5xATR, R:R TP2 = 6.5/3=2.17
  ctxSain,
);
ok("tendance conforme: ALLOW", trendOk.ok === true && trendOk.verdict === "ALLOW");
ok("tendance conforme: 0 block", trendOk.blocks.length === 0);

// ── 2) SL manquant -> BLOCK sl-mandatory ──
const noSl = runGuards({ symbol: "BTC", side: "long", setup: "S1_MTF", entry: 100, take_profits: [{ px: 106 }] }, ctxSain);
ok("SL manquant: BLOCK", noSl.ok === false && noSl.blocks.some((b) => /sl-mandatory/.test(b)));

// ── 3) Geometrie SL trop serree (MR8 dist 0.85xATR < floor 2.5x) -> BLOCK sl-geometry ──
const tightMr = runGuards(
  { symbol: "HYPE", side: "long", setup: "MR8_MTF", entry: 56.75, stop_loss: 55.0, take_profits: [{ px: 60 }, { px: 62 }] }, // dist 1.75, atr 2 -> 0.875xATR < 2.125 floor
  { ...ctxSain, atr: 2 },
);
ok("MR8 SL comprime: BLOCK sl-geometry", tightMr.ok === false && tightMr.blocks.some((b) => /sl-geometry/.test(b)));

// ── 4) MR exemptee de R:R (R:R brut < 2 mais geometrie OK) -> pas de block risk-reward ──
const mrLowRr = runGuards(
  { symbol: "NEAR", side: "long", setup: "MR8_MTF", entry: 100, stop_loss: 95, take_profits: [{ px: 102 }, { px: 104 }] }, // dist SL 5 = 2.5xATR (atr2), R:R TP2 = 4/5 = 0.8
  { ...ctxSain, atr: 2 },
);
ok("MR R:R 0.8 exemptee: pas de block risk-reward", !mrLowRr.blocks.some((b) => /risk-reward/.test(b)));
ok("MR low R:R: ALLOW global (geometrie ok)", mrLowRr.ok === true);

// ── 5) Tendance avec R:R < 2 -> BLOCK risk-reward ──
const trendLowRr = runGuards(
  { symbol: "ETH", side: "short", setup: "S2_laddered", entry: 100, stop_loss: 103, take_profits: [{ px: 99 }, { px: 95.5 }] }, // dist SL 3 = 1.5xATR, R:R TP2 = 4.5/3 = 1.5 < 2
  { ...ctxSain, atr: 2 },
);
ok("tendance R:R 1.5: BLOCK risk-reward", trendLowRr.ok === false && trendLowRr.blocks.some((b) => /risk-reward/.test(b)));

// ── 6) Circuit breaker actif -> BLOCK breaker ──
const halted = runGuards(
  { symbol: "BTC", side: "long", setup: "S1_MTF", entry: 100, stop_loss: 97, take_profits: [{ px: 104 }, { px: 106.5 }] },
  { ...ctxSain, equityState: { halt: true, reasons: ["Perte jour -6.20% > seuil -5%"], day_pnl_pct: -6.2, drawdown_pct: 2 } },
);
ok("breaker halt: BLOCK breaker", halted.ok === false && halted.blocks.some((b) => /breaker/.test(b)));

// ── 7) Quota journalier atteint -> BLOCK daily-limit ──
const quota = runGuards(
  { symbol: "BTC", side: "long", setup: "S1_MTF", entry: 100, stop_loss: 97, take_profits: [{ px: 104 }, { px: 106.5 }] },
  { ...ctxSain, todayCount: 3 },
);
ok("quota 3/3: BLOCK daily-limit", quota.ok === false && quota.blocks.some((b) => /daily-limit/.test(b)));

// ── 8) Exposition pleine du sens -> BLOCK exposure ──
const expFull = runGuards(
  { symbol: "LINK", side: "short", setup: "S2_laddered", entry: 100, stop_loss: 103, take_profits: [{ px: 97 }, { px: 94 }] }, // R:R TP2 = 6/3 = 2 ok
  { ...ctxSain, exposure: { ...ctxSain.exposure, can_add_short: false, short: { risk_pct: 13 }, risk_warning: "SHORT risque agrege 13% > 12%" } },
);
ok("exposition short pleine: BLOCK exposure", expFull.ok === false && expFull.blocks.some((b) => /exposure/.test(b)));
ok("exposition short pleine: long resterait OK", expFull.checks.find((c) => c.guard === "exposure").reason.includes("short"));

// ── 9) Geometrie sautee si atr absent (skip, pas block) ──
const noAtr = runGuards(
  { symbol: "BTC", side: "long", setup: "S1_MTF", entry: 100, stop_loss: 97, take_profits: [{ px: 104 }, { px: 106.5 }] },
  { ...ctxSain, atr: null },
);
ok("atr absent: sl-geometry SKIP (pas block)", noAtr.checks.find((c) => c.guard === "sl-geometry").status === "skip" && noAtr.ok === true);

// ── 10) Multi-block : SL manquant + breaker + quota = 3 blocks ──
const multi = runGuards(
  { symbol: "BTC", side: "long", setup: "S1_MTF", entry: 100, take_profits: [{ px: 106 }] },
  { ...ctxSain, equityState: { halt: true, reasons: ["dd"], day_pnl_pct: -1, drawdown_pct: 11 }, todayCount: 5 },
);
ok("multi: BLOCK avec >=3 blocks", multi.ok === false && multi.blocks.length >= 3);

// ── 11) opts.only : ne lance qu'un sous-ensemble ──
const onlyExp = runGuards(
  { symbol: "BTC", side: "long", setup: "S1_MTF" }, // pas de SL mais on ne lance QUE exposure
  ctxSain,
  { only: ["exposure"] },
);
ok("opts.only exposure: 1 seul check, ALLOW", onlyExp.checks.length === 1 && onlyExp.ok === true);

// ── 12) DEMO_ACTIVE : gates BLOQUANTS (breaker/quota) degrades en warn -> ok:true (le LLM tranche) ──
const demoOrder = { symbol: "BTC", side: "long", setup: "S1_MTF", entry: 100, stop_loss: 96, take_profits: [{ px: 104 }, { px: 108 }] };
const demoCtx = { atr: 3, equityState: { halt: true, reasons: ["dd 11%"], drawdown_pct: 11 }, todayCount: 9, exposure: { can_add_long: true, can_add_short: true } };
const demoOn = runGuards(demoOrder, demoCtx, { demo: true });
ok("DEMO: breaker+quota degrades -> ok:true", demoOn.ok === true && demoOn.demo_active === true);
ok("DEMO: breaker en warning (pas block)", demoOn.warnings.some((w) => /breaker/.test(w)) && !demoOn.blocks.some((b) => /breaker/.test(b)));
ok("DEMO: quota en warning", demoOn.warnings.some((w) => /daily-limit/.test(w)));
// relaxed_guards : tracabilite des gates degrades en demo (separe metriques strict/relache, G10)
ok("DEMO: relaxed_guards liste breaker+daily-limit", Array.isArray(demoOn.relaxed_guards) && demoOn.relaxed_guards.includes("breaker") && demoOn.relaxed_guards.includes("daily-limit"));
const demoOff = runGuards(demoOrder, demoCtx, { demo: false });
ok("hors DEMO: meme ctx -> BLOCK", demoOff.ok === false && demoOff.blocks.length >= 1);
ok("hors DEMO: relaxed_guards vide", demoOff.relaxed_guards.length === 0);

// ── 13) DEMO_ACTIVE ne leve PAS l'integrite : SL manquant / geometrie bloquent TOUJOURS ──
const demoNoSl = runGuards({ symbol: "BTC", side: "long", setup: "S1_MTF", entry: 100, take_profits: [{ px: 106 }] }, demoCtx, { demo: true });
ok("DEMO: SL manquant bloque TOUJOURS (integrite)", demoNoSl.ok === false && demoNoSl.blocks.some((b) => /sl-mandatory/.test(b)));
const demoBadGeo = runGuards({ symbol: "BTC", side: "long", setup: "S1_MTF", entry: 100, stop_loss: 99.5, take_profits: [{ px: 104 }, { px: 108 }] }, demoCtx, { demo: true });
ok("DEMO: geometrie SL trop serree bloque TOUJOURS", demoBadGeo.ok === false && demoBadGeo.blocks.some((b) => /sl-geometry/.test(b)));

// ── RAIL DE SESSION (D051, porte du scalp) : perp TradFi decroche du cash hors-session ──
{
  const eq = { symbol: "SPY", side: "long", setup: "S1_MTF", entry: 100, stop_loss: 98, take_profits: [{ px: 102 }, { px: 104 }] };
  const onlySess = { only: ["session"] };
  ok("session us_equity FERME -> BLOCK", runGuards(eq, { session: { session: "us_equity", open: false, reason: "outside_RTH" } }, onlySess).blocks.some((b) => /session/.test(b)));
  ok("session us_equity OUVERT -> pas de block", runGuards(eq, { session: { session: "us_equity", open: true, reason: "RTH" } }, onlySess).ok === true);
  ok("session metals FERME -> WARN (pas BLOCK)", (() => { const m = runGuards({ ...eq, symbol: "XAUT" }, { session: { session: "metals", open: false, reason: "weekend" } }, onlySess); return m.ok === true && m.warnings.some((w) => /session/.test(w)); })());
  ok("session 24x7 -> pass", runGuards({ ...eq, symbol: "BTC" }, { session: { session: "24x7", open: true, reason: "24x7" } }, onlySess).ok === true);
  ok("session absente -> skip (retro-compat)", runGuards(eq, {}, onlySess).ok === true);
  ok("session us_equity ferme reste DUR en DEMO", runGuards(eq, { session: { session: "us_equity", open: false, reason: "outside_RTH" } }, { only: ["session"], demo: true }).blocks.some((b) => /session/.test(b)));
}

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
