"use strict";

// Scanner multi-paires : analyse une watchlist de perps Bybit, calcule RSI/EMA
// multi-TF + funding en local (depuis les bougies), détecte les setups du
// catalogue v2 et CLASSE les opportunités. La routine l'utilise pour élargir
// l'univers (plus de paires -> plus de trades) avant l'analyse fine + la gate.
//
// Usage : node trade-journal/scan.js            (top opportunités)
//         SCAN_WATCHLIST=BTC,ETH,... node ...    (watchlist custom)

const path = require("path");
const bybitDir = path.join(__dirname, "..", "skills", "bybit");
require(path.join(bybitDir, "index.js")); // charge .env
const ccxt = require(require.resolve("ccxt", { paths: [bybitDir] }));
const { regimeBucket, regimeFit } = require("./edge-watch.js"); // bucket régime + routage setup↔régime (finding 5a)

const WATCHLIST = (process.env.SCAN_WATCHLIST ||
  "BTC,ETH,SOL,BNB,XRP,DOGE,AVAX,LINK,ADA,SUI,LTC,DOT,TON,NEAR,HYPE,HBAR,ONDO,ASTER,TAO").split(",").map((s) => s.trim());

// Multiplicateur d'edge. >1 = boosté, <1 = pénalisé/à éviter. Source : backtest.js + optimize.js (walk-forward OOS).
// EDGES VALIDÉS : S1 (+0.20R baseline), S3 (+0.32R baseline, n faible), S5 (+0.10R, WR 54% — exits 1:1 SL2/TP2,
//   SEUL setup robuste out-of-sample : train 0.099 ≈ test 0.096, cf. optimize.js 08.06). S6/S9 funding = forward-test.
// PERDANTS / OVERFIT OOS -> dé-priorisés (détectés mais filtrés par /14 + gating Desktop) : S4, S7, S8.
// ⚠️ Ne PAS sur-optimiser S1/S3 : les exits trail-only les rendent OVERFIT (bons en train, perdants en test).
// EDGE pondéré par l'edge NET DE FRAIS (OOS, optimize.js avec FEE 0.055% taker, 09.06) :
// S5_MTF +0.223R NET (le meilleur) > MR8_MTF +0.117R NET > S1 +0.045R / MR4 +0.033R (MARGINAUX :
// frais ont mangé l'edge brut -> tradables surtout en LIMIT/maker) > S3 net négatif (overfit).
// S6/S9 funding = non validés (forward-test, signal-only). S4/S7/S8 = perdants.
// ⚠️ Les edges minces (MR4/S1) exigent une entrée LIMIT (maker) ; le market two-phase (taker) les tue.
// MAJ 10.06 (sprint régime fort, critères pré-fixés ≥+0.10R/n≥30/cohérence train-test) :
// S2 0.5→0.8 = edge de TENDANCE validé (trending +0.30R test n53 / +0.212R train n68 — le
// regime_fit route : good UNIQUEMENT en trending, avoid en range). MR4 0.8→0.6 (MR4_MTF ≤0
// sur 2 fenêtres consécutives). S8 strong = artefact (train -0.16 vs test +0.59, signe inversé).
const EDGE = { S5_fade_range: 1.4, MR8_stochrsi_revert: 1.2, S1_short_bounce: 1.0, MR4_bb_trendfilt: 0.6, S3_long_oversold: 0.6, S6_funding_squeeze_long: 0.4, S9_funding_squeeze_short: 0.4,
  S2_short_continuation: 0.8, S12_squeeze_break: 0.8, S7_pullback_bull: 0.5, S8_breakout: 0.3, S4_long_relstrength: 0.3 };

function ema(vals, p) { const k = 2 / (p + 1); let e = vals[0]; for (let i = 1; i < vals.length; i++) e = vals[i] * k + e * (1 - k); return e; }
function rsi(closes, p = 14) {
  if (closes.length < p + 2) return 50;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= p; l /= p;
  for (let i = p + 1; i < closes.length; i++) { const d = closes[i] - closes[i - 1]; g = (g * (p - 1) + (d > 0 ? d : 0)) / p; l = (l * (p - 1) + (d < 0 ? -d : 0)) / p; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
function emaArr(v, p) { const k = 2 / (p + 1); const o = [v[0]]; for (let i = 1; i < v.length; i++) o.push(v[i] * k + o[i - 1] * (1 - k)); return o; }
function macd(c) { const e12 = emaArr(c, 12), e26 = emaArr(c, 26); const line = c.map((_, i) => e12[i] - e26[i]); const sig = emaArr(line, 9); const i = c.length - 1; return { hist: +(line[i] - sig[i]).toFixed(4), cross: line[i] > sig[i] ? "bull" : "bear", rising: (line[i] - sig[i]) > (line[i - 1] - sig[i - 1]) }; }
function stoch(h, l, c, p = 14) { const i = c.length - 1; const hh = Math.max(...h.slice(i - p + 1, i + 1)); const ll = Math.min(...l.slice(i - p + 1, i + 1)); return hh === ll ? 50 : +((c[i] - ll) / (hh - ll) * 100).toFixed(1); }
function rsiSeries(c, p = 14) { const out = new Array(c.length).fill(50); if (c.length < p + 2) return out; let g = 0, l = 0; for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; } g /= p; l /= p; out[p] = l === 0 ? 100 : 100 - 100 / (1 + g / l); for (let i = p + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g = (g * (p - 1) + (d > 0 ? d : 0)) / p; l = (l * (p - 1) + (d < 0 ? -d : 0)) / p; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } return out; }
function stochRsi(c, p = 14) { const r = rsiSeries(c, p); const i = r.length - 1; let mn = Infinity, mx = -Infinity; for (let j = i - p + 1; j <= i; j++) { if (r[j] < mn) mn = r[j]; if (r[j] > mx) mx = r[j]; } return mx === mn ? 0.5 : (r[i] - mn) / (mx - mn); }
function sma(v, p) { let s = 0; for (let i = v.length - p; i < v.length; i++) s += v[i]; return s / p; }
function bb(c, p = 20, k = 2) { const m = sma(c, p); let s = 0; for (let i = c.length - p; i < c.length; i++) s += (c[i] - m) ** 2; const sd = Math.sqrt(s / p); return { upper: m + k * sd, mid: m, lower: m - k * sd, width: (2 * k * sd) / m }; }
function donchian(h, l, p = 20) { const i = h.length - 1; return { hi: Math.max(...h.slice(i - p, i)), lo: Math.min(...l.slice(i - p, i)) }; } // exclut la bougie courante
// ADX (Wilder) — force de tendance. Sert au flag de REGIME marche (BTC daily) : ADX eleve = tendance
// forte = mean-reversion RISQUE (tous nos edges sont MR). OBSERVABILITE (le LLM juge), pas une regle dure.
function adxLast(H, L, C, p = 14) {
  const len = C.length; if (len < 2 * p + 2) return null;
  const pDM = new Array(len).fill(0), mDM = new Array(len).fill(0), tr = new Array(len).fill(0);
  for (let i = 1; i < len; i++) { const up = H[i] - H[i - 1], dn = L[i - 1] - L[i]; pDM[i] = (up > dn && up > 0) ? up : 0; mDM[i] = (dn > up && dn > 0) ? dn : 0; tr[i] = Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1])); }
  const dx = new Array(len).fill(0); let trS = 0, pS = 0, mS = 0;
  for (let i = 1; i <= p; i++) { trS += tr[i]; pS += pDM[i]; mS += mDM[i]; }
  for (let i = p; i < len; i++) { if (i > p) { trS = trS - trS / p + tr[i]; pS = pS - pS / p + pDM[i]; mS = mS - mS / p + mDM[i]; } const pD = trS ? 100 * pS / trS : 0, mD = trS ? 100 * mS / trS : 0; dx[i] = (pD + mD) ? 100 * Math.abs(pD - mD) / (pD + mD) : 0; }
  let a = 0; for (let i = p + 1; i <= 2 * p; i++) a += dx[i]; a /= p;
  for (let i = 2 * p; i < len; i++) a = i > 2 * p ? (a * (p - 1) + dx[i]) / p : a;
  return a;
}

// Fear & Greed (alternative.me, gratuit) — OBSERVABILITE seulement (verdict scraping GitHub 10.06 :
// jamais un gate sans validation OOS). Sentiment extreme = contexte pour le jugement LLM (un fade
// long en Extreme Fear ≠ un fade long en Greed). Degrade en null (timeout/HS) sans casser le scan.
async function fetchFearGreed() {
  try {
    const res = await fetch("https://api.alternative.me/fng/?limit=2", { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const j = await res.json();
    const [today, prev] = j.data || [];
    if (!today) return null;
    return {
      value: Number(today.value),
      label: today.value_classification, // Extreme Fear / Fear / Neutral / Greed / Extreme Greed
      yesterday: prev ? Number(prev.value) : null,
      note: "observabilite (jamais un gate sans OOS)",
    };
  } catch { return null; }
}

async function scan() {
  const fngP = fetchFearGreed(); // parallele au scan, attendu a la fin
  const c = new ccxt.bybit({ enableRateLimit: true, options: { defaultType: "swap" } });
  await c.loadMarkets();
  const rows = [];
  let marketAdx = null; // BTC daily ADX -> flag de regime marche
  for (const s of WATCHLIST) {
    const sym = s + "/USDT:USDT";
    try {
      // Fetches en PARALLELE (5 round-trips -> 1 batch par paire) : ~3-5x plus rapide que sequentiel.
      const [d1, h4, h1raw, fundingObj, ticker] = await Promise.all([
        c.fetchOHLCV(sym, "1d", undefined, 220),
        c.fetchOHLCV(sym, "4h", undefined, 220),
        c.fetchOHLCV(sym, "1h", undefined, 200).catch(() => []),
        c.fetchFundingRate(sym).catch(() => null),
        c.fetchTicker(sym).catch(() => null),
      ]);
      if (d1.length < 60 || h4.length < 60) continue;
      const dC = d1.map((x) => x[4]), hC = h4.map((x) => x[4]);
      // ADX DAILY de CHAQUE paire -> regime_d (range/trending/strong) : opérationnalise le finding
      // 5a (les fades MR bleed en STRONG_TREND : MR8 -0.05R). OBSERVABILITÉ par candidat (le LLM juge).
      let dAdx = null; try { dAdx = adxLast(d1.map((x) => x[2]), d1.map((x) => x[3]), dC, 14); } catch (e) {}
      if (s === "BTC") marketAdx = dAdx;
      const hH = h4.map((x) => x[2]), hL = h4.map((x) => x[3]);
      const px = hC[hC.length - 1];
      const dRsi = rsi(dC), hRsi = rsi(hC), hRsiPrev = rsi(hC.slice(0, -1));
      const dEma50 = ema(dC, 50), dEma200 = ema(dC, 200);
      const hEma20 = ema(hC, 20), hEma50 = ema(hC, 50), hEma200 = ema(hC, 200);
      // Contexte 1H = TIMING d'entree pour l'analyse live (PAS un trigger de setup : fenetre trop courte pour valider en backtest).
      let h1 = null;
      if (h1raw.length >= 60) { const h1C = h1raw.map((x) => x[4]); const r1 = rsi(h1C), r1p = rsi(h1C.slice(0, -1)), e1a = ema(h1C, 20), e1b = ema(h1C, 50), m1 = macd(h1C), s1 = stochRsi(h1C); h1 = { rsi: +r1.toFixed(1), dir: r1 > r1p ? "rising" : "falling", trend: px > e1a && e1a > e1b ? "bull" : px < e1a && e1a < e1b ? "bear" : "mixed", macd: m1.cross, stochrsi: +s1.toFixed(2) }; }
      const hMacd = macd(hC), hStoch = stoch(hH, hL, hC), hSrsi = stochRsi(hC); // MACD + Stoch + StochRSI 4H
      const hV = h4.map((x) => x[5]);
      const bbv = bb(hC, 20, 2), don = donchian(hH, hL, 20);
      const volAvg = sma(hV, 20), volRatio = volAvg > 0 ? hV[hV.length - 1] / volAvg : 1;
      const sep = Math.abs(hEma20 - hEma50) / px;
      const regime = sep > 0.012 ? "trend" : sep < 0.004 ? "range" : "mixte";
      let funding = null; if (fundingObj) funding = (fundingObj.fundingRate || 0) * 100;
      const chg24 = ticker ? ticker.percentage : null;

      const htfBear = px < dEma200 && dEma50 < dEma200;
      const htfBull = px > dEma200 && dEma50 > dEma200;
      const hRising = hRsi > hRsiPrev;

      const setups = [];
      // S3 long survente : RSI extrême rising + MACD bull cross (confluence) + Stoch survendu (bonus)
      if (dRsi < 25 && hRsi < 42 && hRising && hMacd.cross === "bull") setups.push({ type: "S3_long_oversold", side: "long", score: (30 - dRsi) + 10 + (hStoch < 25 ? 5 : 0) });
      // S1 short du rebond : baissier + proche EMA20 + RSI ok + (MACD bear OU Stoch haut) confirme le rejet
      if (htfBear && px < hEma20 && (hEma20 - px) / px < 0.035 && hRsi > 35 && (hMacd.cross === "bear" || hStoch > 65)) setups.push({ type: "S1_short_bounce", side: "short", score: 12 + (hStoch > 70 ? 5 : 0) + (hMacd.cross === "bear" ? 3 : 0) });
      // S2 (de-prioritise par edge) : seulement si confluence forte
      if (htfBear && hRsi >= 40 && hRsi <= 58 && px < hEma50 && Math.abs(px - hEma20) / px < 0.025 && hMacd.cross === "bear") setups.push({ type: "S2_short_continuation", side: "short", score: 15 + (58 - hRsi) });
      // S4 (eviter) : seulement avec MACD bull + RSI sain
      if (htfBull && hRsi < 50 && hRsi > 30 && hMacd.cross === "bull") setups.push({ type: "S4_long_relstrength", side: "long", score: 16 });
      // S6 funding squeeze
      if (funding !== null && funding < -0.03 && dRsi < 32 && hMacd.rising) setups.push({ type: "S6_funding_squeeze_long", side: "long", score: 10 + Math.abs(funding) * 100 });
      // S7 pullback haussier : tendance up + repli vers EMA20 (<2.5%) + RSI sain + MACD se recourbe up
      if (htfBull && hRsi >= 38 && hRsi <= 52 && hMacd.rising && Math.abs(px - hEma20) / px < 0.025) setups.push({ type: "S7_pullback_bull", side: "long", score: 13 + (hMacd.cross === "bull" ? 3 : 0) });
      // S5 fade de range : pas de tendance + prix sur une bande BB + RSI/Stoch extreme -> retour au milieu
      // MTF: aligne au DAILY (px vs dEma200) -> edge x3 OOS (0.096->0.302R). Fade only avec la tendance daily.
      if (regime === "range" && px >= bbv.upper && hRsi > 60 && hStoch > 75 && px < dEma200) setups.push({ type: "S5_fade_range", side: "short", score: 10 + (hStoch > 85 ? 4 : 0) });
      if (regime === "range" && px <= bbv.lower && hRsi < 40 && hStoch < 25 && px > dEma200) setups.push({ type: "S5_fade_range", side: "long", score: 10 + (hStoch < 15 ? 4 : 0) });
      // S8 breakout : cassure du Donchian 20 (close au-dela du plus haut/bas des 20 bougies) + volume en expansion
      if (px > don.hi && volRatio > 1.3) setups.push({ type: "S8_breakout", side: "long", score: 12 + (volRatio > 1.8 ? 4 : 0) });
      if (px < don.lo && volRatio > 1.3) setups.push({ type: "S8_breakout", side: "short", score: 12 + (volRatio > 1.8 ? 4 : 0) });
      // S9 funding squeeze SHORT : funding tres positif (longs surcharges) + surachat -> fade
      if (funding !== null && funding > 0.05 && dRsi > 68 && hStoch > 80) setups.push({ type: "S9_funding_squeeze_short", side: "short", score: 10 + Math.min(funding * 100, 6) });
      // MR4 reversion BB ALIGNEE tendance (anti-couteau) : creux en uptrend / pic en downtrend.
      // Validé OOS (+0.089R, WR 49%, 183 sig) — setup FREQUENT pour saisir plus d'opportunites. Exits 1:1 + trailing.
      if (px <= bbv.lower && px > hEma200) setups.push({ type: "MR4_bb_trendfilt", side: "long", score: 12 + (hRsi < 40 ? 3 : 0) });
      if (px >= bbv.upper && px < hEma200) setups.push({ type: "MR4_bb_trendfilt", side: "short", score: 12 + (hRsi > 60 ? 3 : 0) });
      // MR8 reversion StochRSI extreme + MTF (aligne tendance DAILY px vs dEma200) -> +0.109R WR 59% OOS (vs 48% nu).
      // Le filtre HTF doit etre sur un TF SUPERIEUR (daily), pas 4H. Frequent (947 sig). Exits larges (SL~2.5/TP~4 ATR).
      if (hSrsi < 0.15 && px > dEma200) setups.push({ type: "MR8_stochrsi_revert", side: "long", score: 10 + (0.15 - hSrsi) * 40 });   // survente + daily haussier
      if (hSrsi > 0.85 && px < dEma200) setups.push({ type: "MR8_stochrsi_revert", side: "short", score: 10 + (hSrsi - 0.85) * 40 }); // surachat + daily baissier
      // S12 squeeze->expansion ALIGNE daily (valide 10.06 cross-TF : 4H trending +0.19R, 1H
      // trending/strong +0.118/+0.286R, sprint #4 /edge-sprint) : largeur BB de la bougie
      // precedente dans le QUINTILE BAS des 40 dernieres, puis cassure du micro-range 10 barres
      // dans le sens daily. Le routage (regime_fit) le restreint a trending ; range = avoid.
      {
        const n4 = hC.length;
        const bbWidthAt = (end) => { if (end + 1 < 21) return null; return bb(hC.slice(0, end + 1), 20, 2).width; };
        const wPrev = bbWidthAt(n4 - 2);
        let narrower = 0, totW = 0;
        for (let j = n4 - 42; j < n4 - 2; j++) { const w = bbWidthAt(j); if (w == null) continue; totW++; if (w < wPrev) narrower++; }
        const squeezed = wPrev != null && totW >= 30 && narrower / totW <= 0.2;
        if (squeezed) {
          let m10Hi = -Infinity, m10Lo = Infinity;
          for (let j = n4 - 11; j < n4 - 1; j++) { if (hH[j] > m10Hi) m10Hi = hH[j]; if (hL[j] < m10Lo) m10Lo = hL[j]; }
          if (px < dEma200 && px < m10Lo) setups.push({ type: "S12_squeeze_break", side: "short", score: 14 + (volRatio > 1.3 ? 3 : 0) });
          if (px > dEma200 && px > m10Hi) setups.push({ type: "S12_squeeze_break", side: "long", score: 14 + (volRatio > 1.3 ? 3 : 0) });
        }
      }
      setups.forEach((x) => { x.score *= (EDGE[x.type] || 1); });
      const best = setups.sort((a, b) => b.score - a.score)[0] || null;
      rows.push({ pair: s, px, chg24: +(chg24 || 0).toFixed(1), dRsi: +dRsi.toFixed(1), hRsi: +hRsi.toFixed(1), macd: hMacd.cross, stoch: hStoch, trend: htfBull ? "bull" : htfBear ? "bear" : "range", regime, regime_d: regimeBucket(dAdx), dAdx: dAdx != null ? +dAdx.toFixed(1) : null, funding: funding != null ? +funding.toFixed(4) : null, h1, setup: best });
    } catch (e) { rows.push({ pair: s, error: e.message.slice(0, 40) }); }
  }
  const opportunities = rows.filter((r) => r.setup).sort((a, b) => b.setup.score - a.setup.score)
    .map((r) => ({ pair: r.pair, setup: r.setup.type, side: r.setup.side, score: +r.setup.score.toFixed(1), px: r.px, dRsi: r.dRsi, hRsi: r.hRsi, macd: r.macd, stoch: r.stoch, trend: r.trend, regime: r.regime, regime_d: r.regime_d, dAdx: r.dAdx, regime_fit: regimeFit(r.setup.type, r.regime_d), funding: r.funding, h1: r.h1 }));
  // Regime marche (BTC daily ADX) — OBSERVABILITE : ADX>35 = tendance forte = mean-reversion
  // RISQUE (tous nos edges fadent). Le LLM PREND EN COMPTE (prudence/demi-taille/abstention sur les
  // fades contre la tendance forte), ce N'EST PAS une regle dure (non valide OOS). NULL = indispo.
  const btcAdx = marketAdx != null ? +marketAdx.toFixed(1) : null;
  const market = {
    btc_daily_adx: btcAdx,
    regime: btcAdx == null ? "?" : btcAdx > 35 ? "STRONG_TREND (mean-reversion RISQUE - prudence/reduire les fades contre-tendance)" : btcAdx > 22 ? "trending (MR ok si aligne Daily)" : "range (MR favorable)",
    fear_greed: await fngP, // null si HS — observabilite, jamais un gate
  };
  return { scanned: rows.filter((r) => !r.error).length, market, opportunities, all: rows };
}

if (require.main === module) {
  scan().then((r) => console.log(JSON.stringify({ scanned: r.scanned, market: r.market, opportunities: r.opportunities }, null, 2)))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
module.exports = scan;
