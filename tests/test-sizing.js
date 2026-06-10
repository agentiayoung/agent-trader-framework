#!/usr/bin/env node
"use strict";
// Tests offline deterministes du sizing + clamp de levier. Zero reseau.
// Run: node tests/test-sizing.js
const { computeSize, edgeScale, drawdownScale } = require("../trade-journal/sizing.js");
let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log("  PASS  " + name); } else { failed++; console.log("  FAIL  " + name); } }

// Cas NORMAL (SL large 4%) : pas de clamp, risque = cible 5%
const a = computeSize({ equity: 50000, entry: 100, sl: 96, riskPct: 5, maxLeverage: 5 });
ok("normal: pas de clamp", a.clamped === false);
ok("normal: size = 2500/4 = 625", a.size === 625);
ok("normal: risque effectif = cible 5%", a.risk_pct_effective === 5);
ok("normal: levier 1.25x (62500/50000)", a.leverage === 1.25);

// Cas SL SERRÉ (0.5%) : clamp levier -> taille réduite, risque < cible, levier = 5
const b = computeSize({ equity: 50000, entry: 100, sl: 99.5, riskPct: 5, maxLeverage: 5 });
ok("SL serré: clamped true", b.clamped === true);
ok("SL serré: levier plafonné à 5x", b.leverage === 5);
ok("SL serré: size = 5*50000/100 = 2500", b.size === 2500);
ok("SL serré: risque effectif < cible (2.5% < 5%)", b.risk_pct_effective < 5 && b.risk_pct_effective === 2.5);
ok("SL serré: raison renseignée", b.reasons.length > 0 && /levier/.test(b.reasons[0]));

// Sans cap de levier (maxLeverage 0) : 10x autorisé
const c = computeSize({ equity: 50000, entry: 100, sl: 99.5, riskPct: 5, maxLeverage: 0 });
ok("sans cap: levier 10x autorisé", c.leverage === 10 && c.clamped === false);
ok("sans cap: risque = cible 5%", c.risk_pct_effective === 5);

// Cap notional absolu
const d = computeSize({ equity: 50000, entry: 100, sl: 90, riskPct: 5, maxLeverage: 50, maxNotionalUsd: 20000 });
ok("cap notional: clamped", d.clamped === true && d.notional === 20000);
ok("cap notional: raison notional", d.reasons.some((r) => /notional/.test(r)));

// Garde-fous : SL == entry -> size 0 (pas de division par zero)
const e = computeSize({ equity: 50000, entry: 100, sl: 100, riskPct: 5, maxLeverage: 5 });
ok("SL==entry: size 0 (pas de NaN)", e.size === 0 && isFinite(e.leverage));

// Tier B (2.5%) SL normal : risque effectif 2.5%
const f = computeSize({ equity: 50000, entry: 100, sl: 95, riskPct: 2.5, maxLeverage: 5 });
ok("tier B: risque 2.5% non clampé", f.clamped === false && f.risk_pct_effective === 2.5);

// edgeScale (A2 Kelly-lite) : fort -> plein (1.0), marginal -> réduit, plancher 0.4
ok("edgeScale S5 (1.4) -> 1.0 (capé, garde le 5%)", edgeScale(1.4) === 1);
ok("edgeScale MR8 (1.2 = ref) -> 1.0", edgeScale(1.2) === 1);
ok("edgeScale S1 (1.0) -> 0.833 (réduit)", edgeScale(1.0) === 0.833);
ok("edgeScale MR4 (0.8) -> 0.667 (réduit)", edgeScale(0.8) === 0.667);
ok("edgeScale S3 (0.6) -> 0.5", edgeScale(0.6) === 0.5);
ok("edgeScale très bas (0.3) -> plancher 0.4", edgeScale(0.3) === 0.4);
ok("edgeScale absent -> 1 (pas de scaling)", edgeScale(null) === 1 && edgeScale(undefined) === 1);

// ── drawdownScale (piste 3, anti-martingale) : réduit le risque vers le breaker ──
// défauts : start 4% / breaker 10% / floor 0.4. Linéaire entre start et breaker.
ok("ddScale dd=0 -> 1 (plein)", drawdownScale(0) === 1);
ok("ddScale dd<=start (4%) -> 1", drawdownScale(4) === 1 && drawdownScale(2) === 1);
ok("ddScale dd negatif/abnormal -> 1", drawdownScale(-3) === 1);
ok("ddScale au breaker (10%) -> floor 0.4", drawdownScale(10) === 0.4);
ok("ddScale au-dela du breaker -> floor (clamp)", drawdownScale(13) === 0.4);
ok("ddScale mi-chemin (7%) -> 0.7", drawdownScale(7) === 0.7);
ok("ddScale strictement decroissant entre start et breaker", drawdownScale(5) > drawdownScale(7) && drawdownScale(7) > drawdownScale(9));
ok("ddScale jamais > 1 ni < floor", drawdownScale(0) <= 1 && drawdownScale(100) >= 0.4);
// opts custom
ok("ddScale opts custom (start 2/breaker 8/floor 0.5)", drawdownScale(5, { start: 2, breaker: 8, floor: 0.5 }) === 0.75);
ok("ddScale null -> 1 (pas de scaling)", drawdownScale(null) === 1 && drawdownScale(undefined) === 1);

console.log(`\n  sizing.js: ${passed} pass, ${failed} fail`);
process.exit(failed ? 1 : 0);
