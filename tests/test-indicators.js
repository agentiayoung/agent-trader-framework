// test-indicators.js — indicateurs enrichis de scan.js (audit lecture 11.06) :
// divergence (signal de retournement), OBV (flux/accumulation), beta/corr vs BTC, pivots.
const assert = require("assert");
const { divergence, obvState, betaCorr, pivots } = require("../trade-journal/scan.js");

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); };
const eq = (a, b, m) => { n++; assert.strictEqual(a, b, m); };

// ── 1. PIVOTS : detecte les swing lows/highs stricts ──
const w = [10, 9, 8, 7, 6, 5, 6, 7, 8, 7, 6, 4, 5, 6, 7, 8];
const lows = pivots(w, 3, "low");
ok(lows.includes(5) && lows.includes(11), "pivots low detecte les 2 creux (idx 5 et 11)");
ok(!pivots(w, 3, "high").includes(5), "un creux n'est pas un sommet");

// ── 2. DIVERGENCE HAUSSIERE : prix lower-low MAIS oscillateur higher-low (bottom) ──
// prix : 2 creux, le 2e (idx11=4) plus BAS que le 1er (idx5=5).
const price = [10, 9, 8, 7, 6, 5, 6, 7, 8, 7, 6, 4, 5, 6, 7, 8];
const oscBull = price.slice(); oscBull[5] = 25; oscBull[11] = 35; // RSI : 2e creux PLUS HAUT (35>25)
eq(divergence(price, oscBull), "bull", "divergence haussiere : prix lower-low + RSI higher-low");

// ── 3. DIVERGENCE BAISSIERE : prix higher-high MAIS oscillateur lower-high (top) ──
const priceUp = [2, 3, 4, 5, 6, 7, 6, 5, 4, 5, 6, 8, 7, 6, 5, 4]; // 2 sommets : idx5=7, idx11=8 (plus HAUT)
const oscBear = priceUp.slice(); oscBear[5] = 75; oscBear[11] = 65;  // RSI : 2e sommet PLUS BAS (65<75)
eq(divergence(priceUp, oscBear), "bear", "divergence baissiere : prix higher-high + RSI lower-high");

// ── 4. PAS de divergence : prix ET oscillateur font tous deux un lower-low ──
const oscNone = price.slice(); oscNone[5] = 30; oscNone[11] = 20; // RSI suit le prix (lower-low) -> pas de divergence
eq(divergence(price, oscNone), null, "pas de divergence quand RSI confirme le prix");
eq(divergence([1, 2, 3], [1, 2, 3]), null, "trop court -> null (pas de crash)");

// ── 5. OBV : tendance + divergence ──
const closesUp = [...Array(40)].map((_, i) => 10 + i * 0.3);   // uptrend
const volsFlat = [...Array(40)].map(() => 100);
const obvUp = obvState(closesUp, volsFlat);
eq(obvUp.trend, "up", "OBV en hausse sur un uptrend a volume constant");
eq(obvState([1, 2], [1, 1]), null, "OBV : donnee trop courte -> null");

// ── 6. BETA / CORRELATION vs BTC ──
const btc = [...Array(60)].map((_, i) => 100 + Math.sin(i / 3) * 5 + i * 0.2);
const clone = btc.map((x) => x * 2);                 // PRIX x2 -> rendements IDENTIQUES (scale-invariant) -> corr~1, beta~1
const bc = betaCorr(clone, btc);
ok(bc.corr >= 0.99, "correlation ~1 pour une serie parfaitement alignee (got " + bc.corr + ")");
ok(Math.abs(bc.vs_btc - 1) < 0.05, "beta ~1 : les rendements d'une serie scalee sont identiques (got " + bc.vs_btc + ")");
// beta ~2 = rendements AMPLIFIES x2 (et non le prix x2)
const amp = [100]; for (let i = 1; i < btc.length; i++) { const r = (btc[i] - btc[i - 1]) / btc[i - 1]; amp.push(amp[i - 1] * (1 + 2 * r)); }
ok(Math.abs(betaCorr(amp, btc).vs_btc - 2) < 0.1, "beta ~2 quand les rendements sont 2x ceux de BTC (got " + betaCorr(amp, btc).vs_btc + ")");
const anti = [100]; for (let i = 1; i < btc.length; i++) { const r = (btc[i] - btc[i - 1]) / btc[i - 1]; anti.push(anti[i - 1] * (1 - r)); } // rendements opposes
ok(betaCorr(anti, btc).corr < 0, "correlation negative pour une serie anti-correlee");
eq(betaCorr([1, 2, 3], [1, 2, 3]), null, "beta : donnee trop courte -> null");

console.log(`test-indicators: ${n}/${n} assertions OK`);
