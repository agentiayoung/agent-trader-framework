"use strict";
// structure.js — moteur de STRUCTURE de marche PUR (Phase 2, master plan 2026-06-18).
// Produit le bloc `structure` du contrat docs/SCHEMA-market-state.md :
//   trend (up|down|range), sequence (HH/HL/LH/LL), last_bos, last_choch, last_mss, phase, swings.
// Lecture d'ETAT sur une serie complete (vs smc.js scalp qui evalue a la barre i pour l'OOS).
// 100% deterministe, zero reseau, zero dependance. Entree = bars ccxt [[ts,o,h,l,c,v],...].
//
// Definitions (codees, pas dans le prompt) :
//  - swing = pivot strict confirme (k barres de chaque cote).
//  - BOS (Break Of Structure) = cloture au-dela du dernier swing DANS le sens de la tendance = continuation.
//  - CHoCH (Change of Character) = 1ere cloture qui casse la structure CONTRE la tendance en cours = signal de retournement.
//  - MSS (Market Structure Shift) = CHoCH confirme par momentum (corps >= mssBodyAtr*ATR) = retournement valide.

const DEF = { pivotK: 2, lookback: 120, bosBodyAtr: 0.0, mssBodyAtr: 1.0, impulseAtr: 1.2 };
function cfg(c) { return { ...DEF, ...(c || {}) }; }

function cols(bars) {
  const O = [], H = [], L = [], C = [];
  for (const b of (Array.isArray(bars) ? bars : [])) {
    if (!Array.isArray(b) || b.length < 5) continue;
    O.push(+b[1]); H.push(+b[2]); L.push(+b[3]); C.push(+b[4]);
  }
  return { O, H, L, C };
}

function isPivotHigh(H, j, k) {
  for (let m = j - k; m <= j + k; m++) { if (m === j) continue; if (!(H[j] > H[m])) return false; }
  return true;
}
function isPivotLow(L, j, k) {
  for (let m = j - k; m <= j + k; m++) { if (m === j) continue; if (!(L[j] < L[m])) return false; }
  return true;
}

// swings(H,L,k,lookback) -> liste ORDONNEE de pivots confirmes {type,i,px} (jusqu'a la barre n-k-1).
function swings(H, L, k, lookback) {
  const n = H.length;
  const start = Math.max(k, n - (lookback || DEF.lookback));
  const out = [];
  for (let j = start; j <= n - k - 1; j++) {
    if (isPivotHigh(H, j, k)) out.push({ type: "high", i: j, px: H[j] });
    if (isPivotLow(L, j, k)) out.push({ type: "low", i: j, px: L[j] });
  }
  out.sort((a, b) => a.i - b.i);
  return out;
}

// sequence(sw, n) -> derniers labels HH/HL/LH/LL (compare chaque swing au precedent de MEME type).
function sequence(sw, n) {
  const labels = [];
  const lastHigh = {}, lastLow = {};
  let ph = null, pl = null;
  for (const s of sw) {
    if (s.type === "high") { if (ph != null) labels.push(s.px > ph ? "HH" : "LH"); ph = s.px; }
    else { if (pl != null) labels.push(s.px > pl ? "HL" : "LL"); pl = s.px; }
  }
  void lastHigh; void lastLow;
  return n ? labels.slice(-n) : labels;
}

// trendFromSwings(sw) -> up | down | range (HH+HL = up ; LH+LL = down ; sinon range).
function trendFromSwings(sw) {
  const highs = sw.filter((s) => s.type === "high");
  const lows = sw.filter((s) => s.type === "low");
  if (highs.length < 2 || lows.length < 2) return "range";
  const hh = highs[highs.length - 1].px > highs[highs.length - 2].px;
  const hl = lows[lows.length - 1].px > lows[lows.length - 2].px;
  const lh = highs[highs.length - 1].px < highs[highs.length - 2].px;
  const ll = lows[lows.length - 1].px < lows[lows.length - 2].px;
  if (hh && hl) return "up";
  if (lh && ll) return "down";
  return "range";
}

// marketStructure(bars, atr, opts) -> bloc structure complet.
function marketStructure(bars, atr, opts) {
  const c = cfg(opts);
  const { O, H, L, C } = cols(bars);
  const n = C.length;
  const a = atr != null && atr > 0 ? atr : null;
  if (n < c.pivotK * 2 + 3) {
    return { trend: "range", sequence: [], last_bos: null, last_choch: null, last_mss: null, phase: "range", swings: [], note: "historique insuffisant" };
  }
  const sw = swings(H, L, c.pivotK, c.lookback);
  const seq = sequence(sw, 6);
  const trend = trendFromSwings(sw);

  // Scan des clotures pour BOS (continuation) / CHoCH (1er break contre-tendance) / MSS (CHoCH + momentum).
  // A chaque barre on connait le dernier swing high/low CONFIRME avant elle.
  let lastBos = null, lastChoch = null, lastMss = null;
  const highsSorted = sw.filter((s) => s.type === "high");
  const lowsSorted = sw.filter((s) => s.type === "low");
  const priorSwing = (arr, atI) => { let r = null; for (const s of arr) { if (s.i < atI) r = s; else break; } return r; };

  // tendance "courante" approximee par le dernier label : on suit la bascule au fil des breaks.
  let curTrend = null;
  for (let j = c.pivotK; j < n; j++) {
    const body = a ? Math.abs(C[j] - O[j]) : Infinity;
    const ph = priorSwing(highsSorted, j);
    const pl = priorSwing(lowsSorted, j);
    if (ph && C[j] > ph.px && (!a || body >= c.bosBodyAtr * a)) {
      // cloture au-dessus d'un swing high
      if (curTrend === "down") { // break contre-tendance baissiere -> CHoCH haussier
        lastChoch = { dir: "up", level: ph.px, j };
        if (!a || body >= c.mssBodyAtr * a) lastMss = { dir: "up", level: ph.px, j };
      } else { lastBos = { dir: "up", level: ph.px, j }; }
      curTrend = "up";
    } else if (pl && C[j] < pl.px && (!a || body >= c.bosBodyAtr * a)) {
      if (curTrend === "up") { // break contre-tendance haussiere -> CHoCH baissier
        lastChoch = { dir: "down", level: pl.px, j };
        if (!a || body >= c.mssBodyAtr * a) lastMss = { dir: "down", level: pl.px, j };
      } else { lastBos = { dir: "down", level: pl.px, j }; }
      curTrend = "down";
    }
  }

  // phase : impulse si la derniere barre etend dans le sens du trend avec un corps fort ; sinon correction/range.
  let phase = "range";
  if (trend !== "range" && a) {
    const body = Math.abs(C[n - 1] - O[n - 1]);
    const dirUp = C[n - 1] > O[n - 1];
    const aligned = (trend === "up" && dirUp) || (trend === "down" && !dirUp);
    phase = aligned && body >= c.impulseAtr * a ? "impulse" : "correction";
  }

  return {
    trend,
    sequence: seq,
    last_bos: lastBos ? { dir: lastBos.dir, level: +lastBos.level } : null,
    last_choch: lastChoch ? { dir: lastChoch.dir, level: +lastChoch.level } : null,
    last_mss: lastMss ? { dir: lastMss.dir, level: +lastMss.level } : null,
    phase,
    swings: sw.slice(-8).map((s) => ({ type: s.type, px: +s.px })),
  };
}

module.exports = { marketStructure, swings, sequence, trendFromSwings, cols };

// CLI : node trade-journal/structure.js BTC 4h  (smoke live via ccxt, best-effort)
if (require.main === module) {
  (async () => {
    const sym = process.argv[2] || "BTC";
    const tf = process.argv[3] || "4h";
    try {
      const path = require("path");
      const bybitDir = path.join(__dirname, "..", "skills", "bybit");
      const ccxt = require(require.resolve("ccxt", { paths: [bybitDir] }));
      const c = new ccxt.bybit({ enableRateLimit: true, options: { defaultType: "swap" } });
      const pair = /\/.*:/.test(sym) ? sym : `${sym.replace(/USDT.*/, "").toUpperCase()}/USDT:USDT`;
      const bars = await c.fetchOHLCV(pair, tf, undefined, 220);
      // ATR simple pour la phase
      const { H, L, C } = cols(bars);
      let tr = 0, m = Math.min(14, H.length - 1);
      for (let i = H.length - m; i < H.length; i++) tr += Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1]));
      const atr = tr / m;
      console.log(JSON.stringify(marketStructure(bars, atr), null, 1));
    } catch (e) { console.error("structure err:", e && e.message); }
  })();
}
