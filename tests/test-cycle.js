// test-cycle.js — lentille MACRO/cycle de scan.js (range_pos, at_cycle_low).
// Repond au risque "short de fin de tendance" : detecter qu'une paire est au bas de son
// range pluriannuel avec un low FRAIS (= zone d'accumulation, short dangereux).
const assert = require("assert");
const { cycleContext } = require("../trade-journal/scan.js");

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); };
const eq = (a, b, m) => { n++; assert.strictEqual(a, b, m); };
const near = (a, b, m, tol = 0.5) => { n++; assert.ok(Math.abs(a - b) <= tol, `${m} (got ${a}, want ~${b})`); };

// Helper : fabrique des barres OHLCV [ts,o,h,l,c,v] a partir d'une serie de close (h=l=c pour simplifier).
const bars = (closes) => closes.map((c, i) => [i * 86400000, c, c, c, c, 1]);

// ── 1. Paire AU PLUS BAS DE CYCLE, low FRAIS (cas DOT/AVAX/ADA le 11.06) ──
// 100 barres qui descendent de 100 a 10, le plus bas (10) est l'avant-derniere -> tout frais.
const down = bars([...Array(98)].map((_, i) => 100 - i * 0.9).concat([10, 10.2]));
const cDown = cycleContext(down);
ok(cDown.range_pos <= 10, "range_pos bas quand le prix est juste au-dessus du plus bas de cycle");
ok(cDown.days_since_low <= 15, "low recent");
eq(cDown.at_cycle_low, true, "at_cycle_low=true : bas du range + low frais = zone d'accumulation (NE PAS shorter)");

// ── 2. Paire HAUTE dans le range (cas BTC le 11.06 : range_pos 37%) ──
// monte de 10 a 100, prix final haut.
const up = bars([...Array(100)].map((_, i) => 10 + i * 0.9));
const cUp = cycleContext(up);
ok(cUp.range_pos >= 60, "range_pos haut quand le prix est pres du plus haut");
eq(cUp.at_cycle_low, false, "at_cycle_low=false en haut de range (short structurellement ok)");
near(cUp.days_since_low, 99, "le plus bas date du debut de la fenetre", 1);

// ── 3. Bas du range MAIS low ANCIEN (a remonte puis re-stagne) -> PAS at_cycle_low frais ──
// plus bas a l'index 5, puis remonte un peu et reste bas-mid.
const oldLow = bars([20, 18, 15, 12, 11, 10].concat([...Array(94)].map((_, i) => 12 + (i % 5))));
const cOld = cycleContext(oldLow);
ok(cOld.days_since_low > 15, "low ancien (>15 barres)");
eq(cOld.at_cycle_low, false, "low ancien -> pas flagge at_cycle_low (la zone n'est plus 'fraiche')");

// ── 4. Champs de distance corrects ──
const c1 = cycleContext(bars([...Array(99)].map((_, i) => 50 - i * 0.4).concat([11])));
ok(c1.dist_low_pct >= 0, "dist_low_pct >= 0");
ok(c1.cycle_low <= c1.lo30 + 1e-9, "cycle_low <= lo30 (le plus bas global <= plus bas 30j)");
ok(c1.near_new_low_pct >= 0, "near_new_low_pct calcule");

// ── 5. Robustesse : donnee insuffisante -> null (pas de crash) ──
eq(cycleContext([]), null, "vide -> null");
eq(cycleContext(bars([1, 2, 3])), null, "trop court (<60) -> null");
eq(cycleContext(null), null, "null -> null");

// ── 6. Precision sub-dollar (alts < 1) -> 5 decimales ──
const sub = cycleContext(bars([...Array(99)].map((_, i) => 0.5 - i * 0.004).concat([0.108])));
ok(String(sub.cycle_low).length >= 4, "sub-dollar : plus de decimales sur le cycle_low");

console.log(`test-cycle: ${n}/${n} assertions OK`);
