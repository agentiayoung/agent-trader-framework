"use strict";

// Backtester mécanique : rejoue les setups du catalogue (S1-S4) sur l'historique
// 4H de la watchlist, avec SL/TP standardisés (ATR) pour comparer l'EDGE de chaque
// setup. Sortie : win rate, R moyen, expectancy (en R) par setup → quels setups ont
// un edge prouvé AVANT de risquer du réel.
//
// Usage : node trade-journal/backtest.js   (BT_WATCHLIST pour custom)
// NB : approximation (signal-quality avec exits ATR standard ; les setups réels
//      utilisent des niveaux de structure). À valider/affiner ensuite.

const path = require("path");
const bybitDir = path.join(__dirname, "..", "skills", "bybit");
require(path.join(bybitDir, "index.js"));
const ccxt = require(require.resolve("ccxt", { paths: [bybitDir] }));

const PAIRS = (process.env.BT_WATCHLIST || "BTC,ETH,SOL,BNB,XRP,DOGE,AVAX,LINK,ADA,LTC").split(",").map((s) => s.trim());
const ATR_SL = 1.5, ATR_TP = 3.0, MAX_HOLD = 60; // 60 bougies 4H = 10 jours
// FRAIS : Bybit perp taker ~0.055%/fill. Round-trip (entrée + sortie) ~0.11% du notional.
// En R : feeR = (fee_in + fee_out) * prix / distance_SL. Les edges BRUTS ne sont pas tradables ;
// seul l'edge NET (après frais) compte. BT_FEE_PCT configurable (0.055 taker / 0.02 maker).
const FEE = parseFloat(process.env.BT_FEE_PCT || "0.055") / 100;

function emaSeries(v, p) { const k = 2 / (p + 1); const o = [v[0]]; for (let i = 1; i < v.length; i++) o.push(v[i] * k + o[i - 1] * (1 - k)); return o; }
function rsiSeries(c, p = 14) {
  const out = new Array(c.length).fill(50); if (c.length < p + 2) return out;
  let g = 0, l = 0; for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= p; l /= p; out[p] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = p + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g = (g * (p - 1) + (d > 0 ? d : 0)) / p; l = (l * (p - 1) + (d < 0 ? -d : 0)) / p; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
  return out;
}
function atrSeries(h, lo, c, p = 14) {
  const tr = [h[0] - lo[0]]; for (let i = 1; i < c.length; i++) tr.push(Math.max(h[i] - lo[i], Math.abs(h[i] - c[i - 1]), Math.abs(lo[i] - c[i - 1])));
  const out = new Array(c.length).fill(0); let a = 0; for (let i = 0; i < p; i++) a += tr[i]; a /= p; out[p - 1] = a;
  for (let i = p; i < tr.length; i++) { a = (a * (p - 1) + tr[i]) / p; out[i] = a; } return out;
}
function macdSeries(c) { const e12 = emaSeries(c, 12), e26 = emaSeries(c, 26); const line = c.map((_, i) => e12[i] - e26[i]); const sig = emaSeries(line, 9); return { line, sig }; }
function bbAt(c, i, p = 20, k = 2) { let m = 0; for (let j = i - p + 1; j <= i; j++) m += c[j]; m /= p; let s = 0; for (let j = i - p + 1; j <= i; j++) s += (c[j] - m) ** 2; const sd = Math.sqrt(s / p); return { u: m + k * sd, l: m - k * sd }; }
function stochAt(h, l, c, i, p = 14) { let hh = -Infinity, ll = Infinity; for (let j = i - p + 1; j <= i; j++) { if (h[j] > hh) hh = h[j]; if (l[j] < ll) ll = l[j]; } return hh === ll ? 50 : (c[i] - ll) / (hh - ll) * 100; }

async function backtest() {
  const c = new ccxt.bybit({ enableRateLimit: true, options: { defaultType: "swap" } });
  await c.loadMarkets();
  const by = {};
  const add = (s, R, win) => { by[s] = by[s] || { n: 0, wins: 0, R: 0 }; by[s].n++; if (win) by[s].wins++; by[s].R += R; };
  let scannedPairs = 0;
  for (const s of PAIRS) {
    const sym = s + "/USDT:USDT";
    let oh; try { oh = await c.fetchOHLCV(sym, "4h", undefined, 1000); } catch (e) { continue; }
    if (!oh || oh.length < 260) continue;
    scannedPairs++;
    const H = oh.map((x) => x[2]), L = oh.map((x) => x[3]), C = oh.map((x) => x[4]), V = oh.map((x) => x[5]);
    const rsi = rsiSeries(C), e20 = emaSeries(C, 20), e50 = emaSeries(C, 50), e200 = emaSeries(C, 200), atr = atrSeries(H, L, C), md = macdSeries(C);
    for (let i = 205; i < C.length - 1; i++) {
      const px = C[i];
      const bear = e50[i] < e200[i] && px < e20[i] && e20[i] < e50[i];
      const bull = px > e200[i] && e50[i] > e200[i];
      const sep = Math.abs(e20[i] - e50[i]) / px, range = sep < 0.004;
      const macdRising = (md.line[i] - md.sig[i]) > (md.line[i - 1] - md.sig[i - 1]);
      const bbv = bbAt(C, i), stochK = stochAt(H, L, C, i);
      let donHi = -Infinity, donLo = Infinity; for (let j = i - 20; j < i; j++) { if (H[j] > donHi) donHi = H[j]; if (L[j] < donLo) donLo = L[j]; }
      let vAvg = 0; for (let j = i - 20; j < i; j++) vAvg += V[j]; vAvg /= 20; const volR = vAvg > 0 ? V[i] / vAvg : 1;
      let setup = null, side = null;
      if (px > donHi && volR > 1.3) { setup = "S8_breakout"; side = "long"; }
      else if (px < donLo && volR > 1.3) { setup = "S8_breakout"; side = "short"; }
      else if (range && px >= bbv.u && rsi[i] > 60 && stochK > 75) { setup = "S5_fade_range"; side = "short"; }
      else if (range && px <= bbv.l && rsi[i] < 40 && stochK < 25) { setup = "S5_fade_range"; side = "long"; }
      else if (rsi[i] < 25 && rsi[i] > rsi[i - 1]) { setup = "S3_long_oversold"; side = "long"; }
      else if (bear && rsi[i] >= 40 && rsi[i] <= 58) { setup = "S2_short_continuation"; side = "short"; }
      else if (bear && px < e20[i] && (e20[i] - px) / px < 0.035 && rsi[i] > 35) { setup = "S1_short_bounce"; side = "short"; }
      else if (bull && rsi[i] >= 38 && rsi[i] <= 52 && macdRising && Math.abs(px - e20[i]) / px < 0.025) { setup = "S7_pullback_bull"; side = "long"; }
      else if (bull && rsi[i] >= 30 && rsi[i] <= 50) { setup = "S4_long_relstrength"; side = "long"; }
      if (!setup || !atr[i]) continue;
      const a = atr[i], entry = px;
      const SL = side === "long" ? entry - ATR_SL * a : entry + ATR_SL * a;
      const TP = side === "long" ? entry + ATR_TP * a : entry - ATR_TP * a;
      const slDist = Math.abs(entry - SL);
      let R = null, resj = Math.min(C.length - 1, i + MAX_HOLD);
      for (let j = i + 1; j <= resj; j++) {
        if (side === "long") { if (L[j] <= SL) { R = -1; resj = j; break; } if (H[j] >= TP) { R = ATR_TP / ATR_SL; resj = j; break; } }
        else { if (H[j] >= SL) { R = -1; resj = j; break; } if (L[j] <= TP) { R = ATR_TP / ATR_SL; resj = j; break; } }
      }
      if (R === null) { const exit = C[resj]; R = (side === "long" ? exit - entry : entry - exit) / slDist; }
      const feeR = slDist > 0 ? (2 * FEE * entry) / slDist : 0; // frais round-trip en R
      R -= feeR; // edge NET (après frais) — le seul qui compte
      add(setup, R, R > 0);
      i = resj; // pas de trade chevauchant : reprendre après la résolution
    }
  }
  const cards = Object.entries(by).map(([k, v]) => {
    const exp = v.R / v.n;
    return { setup: k, trades: v.n, win_rate: +(v.wins / v.n * 100).toFixed(1), avg_R: +exp.toFixed(2), expectancy_R: +exp.toFixed(2), edge: exp > 0.15 ? "✅ EDGE" : exp < -0.05 ? "❌ PERDANT" : "≈ neutre" };
  }).sort((a, b) => b.expectancy_R - a.expectancy_R);
  return { pairs_scannes: scannedPairs, periode: "~6 mois (4H)", exits: `SL ${ATR_SL}xATR / TP ${ATR_TP}xATR`, frais: `${(FEE * 100).toFixed(3)}%/fill (round-trip ~${(FEE * 200).toFixed(2)}%) -> edge NET`, note: "R = NET de frais. Un edge brut positif mais net<=0 n'est PAS tradable.", setups: cards };
}

if (require.main === module) {
  backtest().then((r) => console.log(JSON.stringify(r, null, 2))).catch((e) => { console.error(e.message); process.exit(1); });
}
module.exports = backtest;
