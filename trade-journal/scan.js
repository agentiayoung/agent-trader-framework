"use strict";

// Scanner multi-paires : analyse une watchlist de perps Bybit, calcule RSI/EMA
// multi-TF + funding en local (depuis les bougies), détecte les setups du
// catalogue v2 et CLASSE les opportunités. La routine l'utilise pour élargir
// l'univers (plus de paires -> plus de trades) avant l'analyse fine + la gate.
//
// Usage : node trade-journal/scan.js            (top opportunités)
//         SCAN_WATCHLIST=BTC,ETH,... node ...    (watchlist custom)

const path = require("path");
const fs = require("fs");
const bybitDir = path.join(__dirname, "..", "skills", "bybit");
require(path.join(bybitDir, "index.js")); // charge .env
const ccxt = require(require.resolve("ccxt", { paths: [bybitDir] }));
const { regimeBucket, regimeFit } = require("./edge-watch.js"); // bucket régime + routage setup↔régime (finding 5a)
const U = require("./universe.js"); // registre asset-class (crypto inchange + commodity/ETF, spike demo 16.06)
const PERC = require("./perception.js"); // couche perception (structure/zones/bougies/confluence), OBSERVABILITE (Phase 9, 18.06)
const { combinedScore, perceptionScore } = require("./score.js"); // tri combine edge x perception /14 (F1, 18.06)

// Univers depuis le registre asset-class (crypto inchange + commodity/ETF perps).
// SCAN_WATCHLIST (env) filtre par symbole si fourni (retro-compatible).
const _override = (process.env.SCAN_WATCHLIST || "").split(",").map((s) => s.trim()).filter(Boolean);
const UNIVERSE = _override.length
  ? U.enabledEntries().filter((e) => _override.includes(e.symbol))
  : U.enabledEntries();

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

// ── PRICE-ACTION (histo court, DEMO_ACTIVE) ──────────────────────────────────────────────
// ATR simple (true range moyen) calculable sur peu de barres (>=2). Pour les actifs a histo court
// (SPCX ~2j, equities recentes) ou les indicateurs longs (EMA200d/ADX) ne sont PAS fiables.
function atrFrom(ohlc, p) {
  if (!ohlc || ohlc.length < 2) return null;
  const n = Math.min(p || 14, ohlc.length - 1);
  let sum = 0;
  for (let i = ohlc.length - n; i < ohlc.length; i++) {
    const h = ohlc[i][2], l = ohlc[i][3], pc = ohlc[i - 1][4];
    sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return +(sum / n).toFixed(8);
}
// priceActionRow : rend un actif a HISTORIQUE COURT tradable sur PRICE ACTION PURE en DEMO_ACTIVE
// (GO Hugo 16.06 : toutes les paires tradables en demo, SPCX inclus). Pas de setup a edge valide ->
// le LLM lit la STRUCTURE (swing hi/lo, ATR, EMA20, momentum) et construit un bracket price-action.
// L'integrite (SL/geometrie/sizing) protege chaque trade. 100% pur.
function priceActionRow(entry, h4, h1, ticker, sessOpen) {
  const bars = (h4 && h4.length >= 6) ? h4 : (h1 && h1.length >= 6 ? h1 : null);
  if (!bars) return null;
  const tf = (h4 && h4.length >= 6) ? "4h" : "1h";
  const C = bars.map((x) => x[4]), H = bars.map((x) => x[2]), L = bars.map((x) => x[3]);
  const px = (ticker && ticker.last) || C[C.length - 1];
  const look = Math.min(20, bars.length);
  const swingHi = Math.max(...H.slice(-look)), swingLo = Math.min(...L.slice(-look));
  const atr = atrFrom(bars, 14);
  const e20 = bars.length >= 5 ? +ema(C, 20).toFixed(8) : null;
  const chg = C.length >= 2 ? +(((px - C[0]) / C[0]) * 100).toFixed(1) : null;
  const trend = e20 != null ? (px > e20 ? "up" : "down") : "flat";
  return {
    pair: entry.symbol, asset_class: entry.class, session: entry.session, session_open: sessOpen,
    tradable: true, low_history: true, mode: "price_action", pa_tf: tf, bars: bars.length,
    px: +px, atr, swing_hi: +swingHi, swing_lo: +swingLo, ema20: e20, chg_pa: chg, pa_trend: trend,
    note: "price-action only (histo court) : pas d'indicateur long fiable -> lire la STRUCTURE (swing hi/lo, ATR, EMA20). SL au-dela du swing oppose (>=1xATR). track:experiment.",
  };
}
function bb(c, p = 20, k = 2) { const m = sma(c, p); let s = 0; for (let i = c.length - p; i < c.length; i++) s += (c[i] - m) ** 2; const sd = Math.sqrt(s / p); return { upper: m + k * sd, mid: m, lower: m - k * sd, width: (2 * k * sd) / m }; }
function donchian(h, l, p = 20) { const i = h.length - 1; return { hi: Math.max(...h.slice(i - p, i)), lo: Math.min(...l.slice(i - p, i)) }; } // exclut la bougie courante
// CONTEXTE CYCLE (lentille MACRO, pure + OBSERVABILITE) : ou est le prix dans son range pluriannuel ?
// L'angle mort du bot = il lit le 4H/Daily mais ignore la position dans le cycle. Repond au risque
// "short de fin de tendance" (Hugo 11.06) : shorter a range_pos bas + low FRAIS = fader dans une zone
// d'accumulation generationnelle (mesure 11.06 : DOT/AVAX/ADA au plus bas ~2.7 ans, imprime il y a 5j,
// SOUS leurs lows 2022 ; BTC encore a 37% du range). ohlc = OHLCV daily long (~1000 barres dispo Bybit).
function cycleContext(ohlc) {
  if (!Array.isArray(ohlc) || ohlc.length < 60) return null;
  const highs = ohlc.map((x) => x[2]), lows = ohlc.map((x) => x[3]), closes = ohlc.map((x) => x[4]);
  const px = closes[closes.length - 1];
  const lo = Math.min(...lows), hi = Math.max(...highs);
  const daysSinceLow = ohlc.length - 1 - lows.indexOf(lo);
  const span = hi - lo;
  const rangePos = span > 0 ? +(((px - lo) / span) * 100).toFixed(1) : 50;   // 0 = au plus bas, 100 = au plus haut
  const distLowPct = lo > 0 ? +(((px - lo) / lo) * 100).toFixed(1) : null;     // % au-dessus du plus bas de cycle
  const lo30 = Math.min(...lows.slice(-30));
  const nearNewLowPct = lo30 > 0 ? +(((px - lo30) / lo30) * 100).toFixed(1) : null; // % au-dessus du plus bas 30j
  // Zone DANGEREUSE pour un NOUVEAU short : bas du range pluriannuel ET low recent = accumulation.
  const atCycleLow = rangePos <= 10 && daysSinceLow <= 15;
  const dec = lo < 1 ? 5 : 2;
  return { cycle_low: +lo.toFixed(dec), range_pos: rangePos, dist_low_pct: distLowPct, days_since_low: daysSinceLow, lo30: +lo30.toFixed(dec), near_new_low_pct: nearNewLowPct, at_cycle_low: atCycleLow, hist_days: ohlc.length };
}
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

// adxDir : direction de l'ADX (rising/falling/flat) = la tendance se RENFORCE ou s'essouffle.
// Compare l'ADX courant a celui de la barre precedente (meme algo, fenetre -1). Sert au trail
// trend-adaptatif (chantier B 15.06) : ADX qui MONTE sur une tendance gagnante -> desserrer le
// trail (laisser courir) ; qui BAISSE -> resserrer (verrouiller). PUR, testable. eps anti-bruit.
function adxDir(H, L, C, p = 14, eps = 0.5) {
  if (!H || H.length < 2 * p + 3) return null;
  const a1 = adxLast(H, L, C, p);
  const a0 = adxLast(H.slice(0, -1), L.slice(0, -1), C.slice(0, -1), p);
  if (a1 == null || a0 == null) return null;
  if (a1 - a0 > eps) return "rising";
  if (a0 - a1 > eps) return "falling";
  return "flat";
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

// ── Indicateurs ENRICHIS (11.06, audit lecture indicateurs — observabilite, jamais un gate) ──
// PIVOTS : un indice i est un swing low/high s'il est l'extreme strict sur [i-k, i+k]. Sert a la
// detection de divergence ET a la divergence OBV (memes points de prix).
function pivots(arr, k, kind) {
  const out = [];
  for (let i = k; i < arr.length - k; i++) {
    let ext = true;
    for (let j = i - k; j <= i + k && ext; j++) {
      if (j === i) continue;
      if (kind === "low" ? arr[j] <= arr[i] : arr[j] >= arr[i]) ext = false;
    }
    if (ext) out.push(i);
  }
  return out;
}
// DIVERGENCE REGULIERE (signal de RETOURNEMENT) : compare les 2 derniers swings de PRIX a l'oscillateur.
//  bull = prix lower-low MAIS oscillateur higher-low (vendeurs s'essoufflent au plus bas -> retournement haussier).
//  bear = prix higher-high MAIS oscillateur lower-high (acheteurs s'essoufflent au plus haut -> retournement baissier).
// C'est LE signal de bottom/top manquant (audit 11.06). osc = RSI ou OBV. k=swing, maxAge=fenetre de fraicheur.
function divergence(price, osc, k = 3, maxAge = 45) {
  const n = price.length;
  if (n < 2 * k + 4) return null;
  const recent = (i) => i >= n - maxAge;
  const lows = pivots(price, k, "low").filter(recent);
  const highs = pivots(price, k, "high").filter(recent);
  if (lows.length >= 2) { const a = lows[lows.length - 2], b = lows[lows.length - 1]; if (price[b] < price[a] && osc[b] > osc[a]) return "bull"; }
  if (highs.length >= 2) { const a = highs[highs.length - 2], b = highs[highs.length - 1]; if (price[b] > price[a] && osc[b] < osc[a]) return "bear"; }
  return null;
}
// OBV (On-Balance Volume) : flux cumule signe par le sens de la cloture. Tendance = OBV vs son EMA20
// (accumulation/distribution). Divergence OBV/prix = confirmation de retournement (volume ne suit plus).
function obvSeries(closes, vols) {
  const o = [0];
  for (let i = 1; i < closes.length; i++) o.push(o[i - 1] + (closes[i] > closes[i - 1] ? vols[i] : closes[i] < closes[i - 1] ? -vols[i] : 0));
  return o;
}
function obvState(closes, vols) {
  if (closes.length < 25) return null;
  const o = obvSeries(closes, vols);
  const e = emaArr(o, 20); const i = o.length - 1;
  const trend = o[i] > e[i] ? "up" : o[i] < e[i] ? "down" : "flat";
  return { trend, divergence: divergence(closes, o) };
}
// BETA + CORRELATION vs BTC (cross-sectionnel, live) : sur les rendements des N dernieres barres.
// Aux retournements, un alt qui DECOUPLE de BTC (corr basse / surperforme) = tell n1 (cf. bottom_watch).
function betaCorr(a, b, n = 60) {
  const m = Math.min(a.length, b.length, n + 1);
  if (m < 12) return null;
  const ra = [], rb = []; const ai = a.length - m, bi = b.length - m;
  for (let i = 1; i < m; i++) { ra.push((a[ai + i] - a[ai + i - 1]) / a[ai + i - 1]); rb.push((b[bi + i] - b[bi + i - 1]) / b[bi + i - 1]); }
  const mean = (x) => x.reduce((s, v) => s + v, 0) / x.length;
  const mA = mean(ra), mB = mean(rb);
  let cov = 0, vA = 0, vB = 0;
  for (let i = 0; i < ra.length; i++) { cov += (ra[i] - mA) * (rb[i] - mB); vA += (ra[i] - mA) ** 2; vB += (rb[i] - mB) ** 2; }
  return { vs_btc: vB > 0 ? +(cov / vB).toFixed(2) : null, corr: (vA > 0 && vB > 0) ? +(cov / Math.sqrt(vA * vB)).toFixed(2) : null };
}

// Carte de gravite des OPTIONS (Deribit BTC/ETH) -> contexte price-action (16.06). Best-effort :
// Deribit injoignable -> null, le scan continue. 1 appel/devise (book_summary), gamma calcule local.
const OPT = require("./options-context.js");
async function fetchOptionsContext() {
  try {
    const d = new ccxt.deribit({ enableRateLimit: true });
    const now = Date.now();
    const one = async (cur) => {
      try {
        const r = await d.publicGetGetBookSummaryByCurrency({ currency: cur, kind: "option" });
        const raw = (r && r.result) || r || [];
        return OPT.buildOptionsContext(OPT.normalizeChain(raw, { nowMs: now, maxExpiries: 2 }), null, now);
      } catch (e) { return null; }
    };
    const [btc, eth] = await Promise.all([one("BTC"), one("ETH")]);
    return (btc || eth) ? { btc, eth } : null;
  } catch (e) { return null; }
}

async function scan() {
  const fngP = fetchFearGreed(); // parallele au scan, attendu a la fin
  const optP = fetchOptionsContext(); // options Deribit en parallele (best-effort, attendu a la fin)
  const c = new ccxt.bybit({ enableRateLimit: true, options: { defaultType: "swap" } });
  await c.loadMarkets();
  const rows = [];
  let marketAdx = null; // BTC daily ADX -> flag de regime marche
  let btcClose4h = null; // closes 4H de BTC (capturees au 1er tour, BTC en tete de WATCHLIST) -> beta des alts
  for (const entry of UNIVERSE) {
    const s = entry.symbol;
    const sym = entry.ccxt;
    try {
      // Fetches en PARALLELE (5 round-trips -> 1 batch par paire) : ~3-5x plus rapide que sequentiel.
      const [d1, h4, h1raw, fundingObj, ticker, d1long] = await Promise.all([
        c.fetchOHLCV(sym, "1d", undefined, 220),
        c.fetchOHLCV(sym, "4h", undefined, 220),
        c.fetchOHLCV(sym, "1h", undefined, 200).catch(() => []),
        c.fetchFundingRate(sym).catch(() => null),
        c.fetchTicker(sym).catch(() => null),
        c.fetchOHLCV(sym, "1d", undefined, 1000).catch(() => []), // historique long -> contexte cycle (range_pos). Additif, n'affecte PAS les indicateurs daily existants (calcules sur d1=220).
      ]);
      // Histo insuffisant pour des indicateurs fiables (perp recemment liste : SPY/QQQ ~34-41d au 16.06).
      // On NE calcule pas (eviterait des indicateurs faux) mais on rend une row VISIBLE (pas un vanish
      // silencieux) -> Hugo voit "pending history" ; s'active tout seul quand l'histo grossit (~>=60d).
      if (d1.length < 60 || h4.length < 60) {
        // DEMO_ACTIVE (GO Hugo 16.06 : TOUTES les paires tradables en demo, SPCX inclus) -> au lieu de
        // dropper, on rend une ROW PRICE-ACTION (structure recente + ATR) : l'actif est tradable sur
        // price action pure (le LLM lit le mouvement). Hors demo -> row "pending history" (observabilite).
        if (process.env.DEMO_ACTIVE) {
          const sessPA = U.sessionOpen(entry.session);
          const par = priceActionRow(entry, h4, h1raw, ticker, sessPA.open);
          if (par) { rows.push(par); continue; }
        }
        rows.push({ pair: s, asset_class: entry.class, session: entry.session, tradable: U.isTradable(s), error: `insufficient_history ${d1.length}d` });
        continue;
      }
      const dC = d1.map((x) => x[4]), hC = h4.map((x) => x[4]);
      // ADX DAILY de CHAQUE paire -> regime_d (range/trending/strong) : opérationnalise le finding
      // 5a (les fades MR bleed en STRONG_TREND : MR8 -0.05R). OBSERVABILITÉ par candidat (le LLM juge).
      let dAdx = null; try { dAdx = adxLast(d1.map((x) => x[2]), d1.map((x) => x[3]), dC, 14); } catch (e) {}
      let dAdxDir = null; try { dAdxDir = adxDir(d1.map((x) => x[2]), d1.map((x) => x[3]), dC, 14); } catch (e) {} // direction ADX -> trail trend-adaptatif (chantier B)
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
      const cycle = cycleContext(d1long);            // lentille macro : position dans le range pluriannuel
      const reclaimD50 = px > dEma50;                 // reclaim EMA50 daily = breadth de retournement (signe de bottom collectif)
      const reclaim200 = reclaimEma200d(dC, px);     // reclaim EMA200 daily (cross RECENT) = bascule DURABLE de tendance (rail bilateral)
      // INDICATEURS ENRICHIS (audit 11.06) : divergence (LE signal de retournement) + OBV (flux/accumulation) + beta vs BTC.
      if (s === "BTC") btcClose4h = hC;
      const hRsiArr = rsiSeries(hC, 14);
      const diverg = divergence(hC, hRsiArr);          // divergence prix vs RSI 4H : bull (bottom) / bear (top) / null
      const obv = obvState(hC, hV);                    // { trend up/down, divergence bull/bear/null }
      const beta = s === "BTC" ? { vs_btc: 1, corr: 1 } : (btcClose4h ? betaCorr(hC, btcClose4h) : null);
      const sess = U.sessionOpen(entry.session, new Date());
      const carryW = U.carryWarn(funding);
      // PERCEPTION (Phase 9, OBSERVABILITE) : structure/zones/bougies/confluence depuis les barres 4H
      // DEJA fetchees (CPU pur, ZERO fetch reseau de plus ; orderflow=null ici, ajoute en profond par
      // journal.js perception <sym> sur le candidat retenu). Best-effort : ne casse JAMAIS le scan.
      let perception = null;
      try { perception = PERC.compactPerception(PERC.buildPerception({ bars: h4, daily: d1, px, tf: "4h" })); } catch (e) { /* best-effort */ }
      rows.push({ pair: s, asset_class: entry.class, tradable: U.isTradable(s), session: entry.session, session_open: sess.open, carry_warn: carryW, px, chg24: +(chg24 || 0).toFixed(1), dRsi: +dRsi.toFixed(1), hRsi: +hRsi.toFixed(1), macd: hMacd.cross, stoch: hStoch, trend: htfBull ? "bull" : htfBear ? "bear" : "range", regime, regime_d: regimeBucket(dAdx), dAdx: dAdx != null ? +dAdx.toFixed(1) : null, adx_dir: dAdxDir, funding: funding != null ? +funding.toFixed(4) : null, h1, cycle, reclaim_d50: reclaimD50, reclaim_ema200d: reclaim200, divergence: diverg, obv, beta, perception, setup: best });
    } catch (e) { rows.push({ pair: s, error: e.message.slice(0, 40) }); }
  }
  // Tri par score COMBINE edge x perception /14 (F1) : l'orchestrateur voit en TETE les setups a edge
  // ET a confluence deterministe alignee. L'edge OOS reste le socle ; la perception ne fait qu'inflechir
  // (facteur [0.5,1.5], neutre si perception absente). combined_score + perception_score14 exposes = transparence.
  const opportunities = rows.filter((r) => r.setup)
    .map((r) => {
      const cf = r.perception && r.perception.confluence;
      const ps = perceptionScore(cf, r.setup.side); // /14 perception ALIGNE au sens du setup
      return { pair: r.pair, asset_class: r.asset_class, tradable: r.tradable, session: r.session, session_open: r.session_open, carry_warn: r.carry_warn, setup: r.setup.type, side: r.setup.side, score: +r.setup.score.toFixed(1), combined_score: combinedScore(r.setup.score, cf, r.setup.side), perception_score14: ps ? ps.score14 : null, perception_aligned: ps ? ps.aligned : null, px: r.px, dRsi: r.dRsi, hRsi: r.hRsi, macd: r.macd, stoch: r.stoch, trend: r.trend, regime: r.regime, regime_d: r.regime_d, dAdx: r.dAdx, adx_dir: r.adx_dir, regime_fit: regimeFit(r.setup.type, r.regime_d), funding: r.funding, h1: r.h1, cycle: r.cycle, reclaim_d50: r.reclaim_d50, reclaim_ema200d: r.reclaim_ema200d, divergence: r.divergence, obv: r.obv, beta: r.beta, perception: r.perception };
    })
    .sort((a, b) => b.combined_score - a.combined_score);
  // Regime marche (BTC daily ADX) — OBSERVABILITE : ADX>35 = tendance forte = mean-reversion
  // RISQUE (tous nos edges fadent). Le LLM PREND EN COMPTE (prudence/demi-taille/abstention sur les
  // fades contre la tendance forte), ce N'EST PAS une regle dure (non valide OOS). NULL = indispo.
  const btcAdx = marketAdx != null ? +marketAdx.toFixed(1) : null;
  const fearGreed = await fngP; // null si HS — observabilite, jamais un gate
  // BOTTOM_WATCH (lentille MACRO/cycle, OBSERVABILITE — jamais un gate) : detecter qu'on approche d'un
  // bottom AVANT que le bot ne continue de shorter en zone d'accumulation (risque "short de fin de
  // tendance", Hugo 11.06). Agrege la position-cycle des 19 paires. NE force AUCUNE decision : informe.
  const valid = rows.filter((r) => !r.error && r.cycle);
  const atLow = valid.filter((r) => r.cycle.at_cycle_low);              // bas du range pluriannuel + low frais = accumulation
  const reclaim = valid.filter((r) => r.reclaim_d50);                   // breadth de reclaim EMA50 daily = thrust de retournement
  const btcRow = valid.find((r) => r.pair === "BTC");
  const btcRangePos = btcRow && btcRow.cycle ? btcRow.cycle.range_pos : null;
  // Signature de FIN DE BEAR : les alts high-beta capitulent jusqu'au plus bas de cycle PENDANT que BTC
  // est encore haut dans son range (mesure 11.06 : 4 alts a 1-2% du range, BTC a 37%). C'est la que les
  // shorts d'alts deviennent des "shorts de fin de tendance" (downside structurel quasi nul, squeeze max).
  const altCapitulation = !!(btcRangePos != null && btcRangePos > 25 && atLow.length >= 3);
  // DIVERGENCE HAUSSIERE aux lows = LA confirmation de bottom (audit 11.06) : un alt au plus bas de cycle
  // QUI imprime une divergence RSI haussiere 4H = vendeurs epuises -> candidat de retournement le plus fort.
  const bullDivAtLow = atLow.filter((r) => r.divergence === "bull");
  const bullDivAny = valid.filter((r) => r.divergence === "bull");
  // DECOUPLAGE de BTC : alts a correlation BASSE (<0.4) = ils ne suivent plus le dump BTC (tell de bottom alt).
  const decoupled = valid.filter((r) => r.pair !== "BTC" && r.beta && r.beta.corr != null && r.beta.corr < 0.4);
  // RECLAIM EMA200 DAILY (cross recent) = bascule DURABLE de tendance (rail bilateral 15.06). 3e maillon de
  // la sequence de bottom : capitulation -> bull_div_at_low -> decoupled -> reclaim EMA200d. Cf. bottom_confirmed.
  const reclaim200Pairs = valid.filter((r) => r.reclaim_ema200d);
  const bottom_watch = {
    pairs_at_cycle_low: atLow.length,
    at_cycle_low_pairs: atLow.map((r) => r.pair),
    bull_div_at_low: bullDivAtLow.map((r) => r.pair),          // plus bas de cycle + divergence haussiere = bottom probable
    bull_div_any: bullDivAny.map((r) => r.pair),               // divergence haussiere 4H (toutes paires)
    reclaim_ema50d: reclaim.length,
    reclaim_pairs: reclaim.map((r) => r.pair),
    reclaim_ema200d: reclaim200Pairs.length,                   // cross RECENT au-dessus de l'EMA200d = bascule durable (rail bilateral)
    reclaim_ema200d_pairs: reclaim200Pairs.map((r) => r.pair),
    decoupled_from_btc: decoupled.map((r) => r.pair),          // corr<0.4 = ne suit plus BTC (tell de bottom alt)
    btc_range_pos: btcRangePos,
    fear_extreme: !!(fearGreed && /extreme fear/i.test(fearGreed.label || "")),
    alt_capitulation: altCapitulation,
    note: "OBSERVABILITE, jamais un gate. (1) NE PAS armer de NOUVEAU short sur une paire at_cycle_low (range_pos<=10% + low frais = fader une zone d'accumulation = short de fin de tendance) -- ENCORE PLUS si bull_div_at_low la contient (divergence RSI haussiere au plus bas = vendeurs epuises = bottom probable). (2) SEQUENCE DE BOTTOM a surveiller routine-apres-routine : alt_capitulation -> bull_div_at_low apparait (divergence) -> decoupled_from_btc grandit (les alts ne suivent plus le dump) -> reclaim_ema50d grimpe (breadth) -> reclaim EMA200 daily. (3) Au reclaim EMA200 daily, MR8/MR4 basculent LONG automatiquement (deja cable). Le saut long de TENDANCE reste a valider OOS (/edge-sprint long) sur la donnee du bull a venir. (4) RAIL BILATERAL : SI bottom_confirmed=true (bull_div_at_low>=1 ET decoupled>=1 ET reclaim_ema200d>=1) ET une paire bottomante porte un signal MR8/MR4 LONG -> PRENDRE ce long en track:experiment + tier D (taille reduite) = forward-test pour collecter la donnee long LIVE. Le bounce-long contre-tendance (relief_rally SANS bottom_confirmed) reste INTERDIT (dead-cat, REJET OOS).",
  };
  // RELIEF-RALLY (detecteur MARCHE-LARGE, audit 12-15.06) : "grosse chute qui bottom et rebondit"
  // = le regime ou fader des shorts est un piege (DOGE -1021 / TAO -829 / LINK -853 / XRP -1251 /
  // SUI = 5x -1R en jours). Complement MARCHE-LARGE de la lentille cycle (qui, elle, est PAR NOM).
  // Quand actif -> SKIP DUR des NOUVEAUX fade-shorts (MR8/S1/S5 short). cf. SOP + run-routine.ps1.
  bottom_watch.relief_rally = reliefRally(bottom_watch);
  // BOTTOM CONFIRME (rail bilateral 15.06, GO Hugo) : la sequence de bottom est-elle COMPLETE
  // (bull_div_at_low>=1 ET decoupled>=1 ET reclaim_ema200d>=1) ? = le SEUL contexte ou l'agent prend
  // un LONG en track:experiment + tier D (taille reduite) pour collecter la donnee long LIVE que le
  // backtest ne peut pas fournir. ANTI-DEAD-CAT : un relief_rally seul ne suffit PAS. Cf. SOP Etape 5.
  bottom_watch.bottom_confirmed = bottomConfirmed(bottom_watch);
  const market = {
    btc_daily_adx: btcAdx,
    regime: btcAdx == null ? "?" : btcAdx > 35 ? "STRONG_TREND (mean-reversion RISQUE - prudence/reduire les fades contre-tendance)" : btcAdx > 22 ? "trending (MR ok si aligne Daily)" : "range (MR favorable)",
    posture: marketPosture(btcAdx, bottom_watch),   // stance regime-adaptative d'entree (live-first 15.06)
    dispersion: dispersion(rows),                   // regime de correlation -> hedge L+S pertinent ? (bilateral 16.06)
    fear_greed: fearGreed,
    bottom_watch,
    options: await optP,                            // carte de gravite options Deribit BTC/ETH (contexte price-action, best-effort)
  };
  // price_action_tradable = paires a histo court rendues tradables sur PRICE ACTION PURE en DEMO_ACTIVE.
  // CLE CANONIQUE UNIQUE (stdout + scan-latest.json + SOP + proposeurs) -> les longs ET shorts non-crypto
  // (equities/ETF bullish=long, bearish=short) sont enfin CONSOMMES (avant : cle `price_action` cote fichier
  // vs `price_action_tradable` cote stdout = mismatch -> candidats calcules mais jamais lus depuis le fichier).
  const price_action_tradable = rows.filter((r) => r.mode === "price_action");
  // F4 : candidats LONG/SHORT issus de la PERCEPTION que le catalogue d'edges rate (track:experiment).
  const perception_candidates = perceptionCandidates(rows);
  return { scanned: rows.filter((r) => !r.error).length, market, opportunities, perception_candidates, price_action_tradable, all: rows };
}

if (require.main === module) {
  scan().then((r) => {
    // Persiste le scan COMPLET (incl. `all` = toutes les paires) pour que d'autres
    // outils (journal.js manage-check) croisent les positions tenues avec la
    // divergence/cycle par paire sans relancer un scan reseau. STDOUT inchange.
    try { fs.writeFileSync(path.join(__dirname, "scan-latest.json"), JSON.stringify({ ts: new Date().toISOString(), ...r })); } catch (e) { /* best-effort */ }
    console.log(JSON.stringify({ scanned: r.scanned, market: r.market, opportunities: r.opportunities, perception_candidates: r.perception_candidates, price_action_tradable: r.price_action_tradable }, null, 2));
  }).catch((e) => { console.error(e.message); process.exit(1); });
}
// reliefRally : detecteur PUR "grosse chute qui bottom/rebondit" (audit 12-15.06, GO Hugo).
// Shorter APRES une grosse chute en train de bottomer = mauvaise approche (5x -1R prouves).
// ACTIF = Extreme Fear + alt_capitulation + breadth de reclaim EMA50d >= seuil (le marche a
// chute fort ET rebondit largement). Quand actif -> la SOP SKIP DUR les NOUVEAUX fade-shorts.
// Complement MARCHE-LARGE de la lentille cycle (PAR NOM). Env: RELIEF_RECLAIM_MIN (defaut 3).
function reliefRally(bw, opts) {
  if (!bw) return { active: false, reasons: [] };
  const minReclaim = (opts && opts.minReclaim != null) ? opts.minReclaim
    : (process.env.RELIEF_RECLAIM_MIN ? +process.env.RELIEF_RECLAIM_MIN : 3);
  const reclaim = bw.reclaim_ema50d || 0;
  const reasons = [];
  if (bw.fear_extreme) reasons.push("Extreme Fear");
  if (bw.alt_capitulation) reasons.push("alt_capitulation");
  if (reclaim >= minReclaim) reasons.push("reclaim_ema50d " + reclaim + ">=" + minReclaim + " (rebond large)");
  const active = !!(bw.fear_extreme && bw.alt_capitulation && reclaim >= minReclaim);
  return {
    active, reclaim_ema50d: reclaim, min_reclaim: minReclaim, reasons,
    note: active
      ? "RELIEF-RALLY actif (grosse chute qui bottom/rebondit) -> NE PAS armer de NOUVEAU fade-short (MR8/S1/S5 short) ; gerer les shorts existants par leur SL. Guetter bull_div_at_low + decoupled + reclaim EMA200d -> bascule LONG."
      : "pas de relief-rally marche-large (fade-shorts non bloques par ce gate ; la lentille cycle PAR NOM s'applique toujours).",
  };
}

// reclaimEma200d : le px vient de repasser AU-DESSUS de l'EMA200 daily (CROISEMENT RECENT, <= lookback
// barres) = la condition DURABLE du retournement de tendance (!= reclaim_d50 = EMA50, trop precoce).
// Rail bilateral 15.06 (GO Hugo). PUR, testable offline. ACTIF seulement si : px AU-DESSUS de l'EMA200d
// maintenant ET une close daily etait SOUS l'EMA200d dans les N dernieres barres (reclaim FRAIS, pas une
// tendance up etablie depuis longtemps). Env: RECLAIM200_LOOKBACK (defaut 10). EMA200 fiable >= 210 barres.
function reclaimEma200d(dailyCloses, px, lookback) {
  if (!dailyCloses || dailyCloses.length < 210) return false;
  const N = lookback != null ? lookback : (process.env.RECLAIM200_LOOKBACK ? +process.env.RECLAIM200_LOOKBACK : 10);
  const e200 = emaArr(dailyCloses, 200);
  const last = dailyCloses.length - 1;
  if (!(px > e200[last])) return false;                 // doit etre AU-DESSUS maintenant
  for (let j = Math.max(1, last - N + 1); j <= last; j++) {
    if (dailyCloses[j] < e200[j]) return true;          // etait SOUS l'EMA200d dans la fenetre -> reclaim recent
  }
  return false;                                          // au-dessus depuis trop longtemps -> pas un reclaim frais
}

// bottomConfirmed : la SEQUENCE DE BOTTOM est-elle COMPLETE ? (rail bilateral 15.06, GO Hugo).
// = bull_div_at_low>=1 (alts au plus bas QUI impriment une divergence haussiere = vendeurs epuises)
//   ET decoupled_from_btc>=1 (des alts cessent de suivre le dump BTC) ET reclaim_ema200d>=1 (la tendance
//   bascule). Les 3 = le SEUL contexte ou le rail prend un LONG (track:experiment, tier D, taille reduite).
// ANTI-DEAD-CAT : un simple relief_rally (rebond court) ne suffit PAS (prouve OOS : longs de bear = REJET).
// PUR, testable. Seuils conservateurs, ajustables via opts (minDiv/minDecoupled/minReclaim200).
function bottomConfirmed(bw, opts) {
  if (!bw) return false;
  const o = opts || {};
  const minDiv = o.minDiv != null ? o.minDiv : 1;
  const minDecoupled = o.minDecoupled != null ? o.minDecoupled : 1;
  const minReclaim200 = o.minReclaim200 != null ? o.minReclaim200 : 1;
  const div = Array.isArray(bw.bull_div_at_low) ? bw.bull_div_at_low.length : 0;
  const dec = Array.isArray(bw.decoupled_from_btc) ? bw.decoupled_from_btc.length : 0;
  const rec = bw.reclaim_ema200d || 0;
  return !!(div >= minDiv && dec >= minDecoupled && rec >= minReclaim200);
}

// dispersion : detecteur de REGIME DE CORRELATION (bilateral L+S, GO Hugo 16.06). Le hedge L+S
// simultane est un WASH quand les paires sont correlees (corr 0.82, mesure 15.06) et devient un EDGE
// quand elles se DECOUPLENT (dispersion). Calcule depuis les beta.corr deja presents. PUR, testable.
// OBSERVABILITE (jamais un gate dur) : informe quand un hedge L+S est pertinent. Seuils vetoables (env).
function dispersion(rows) {
  const corrs = (rows || [])
    .filter((r) => r && !r.error && r.pair !== "BTC" && r.beta && r.beta.corr != null)
    .map((r) => r.beta.corr);
  const n = corrs.length;
  if (n < 3) return { mean_corr: null, n_decoupled: 0, n_pairs: n, regime: "unknown", hedge_enabled: false, note: "trop peu de paires correlees pour juger la dispersion" };
  const mean = corrs.reduce((a, b) => a + b, 0) / n;
  const dispCorr = process.env.DISP_DISPERSED_CORR ? +process.env.DISP_DISPERSED_CORR : 0.5;
  const concCorr = process.env.DISP_CONCENTRATED_CORR ? +process.env.DISP_CONCENTRATED_CORR : 0.7;
  const minDec = process.env.DISP_MIN_DECOUPLED ? +process.env.DISP_MIN_DECOUPLED : 3;
  const nDecoupled = corrs.filter((c) => c < 0.4).length;
  let regime;
  if (mean < dispCorr && nDecoupled >= minDec) regime = "dispersed";
  else if (mean >= concCorr) regime = "concentrated";
  else regime = "mixed";
  return {
    mean_corr: +mean.toFixed(3), n_decoupled: nDecoupled, n_pairs: n, regime,
    hedge_enabled: regime === "dispersed",
    note: regime === "dispersed"
      ? "DISPERSED : les paires se decouplent -> un HEDGE L+S simultane (long un alt fort decouple a setup valide + short un faible) a de l'edge. Caps inchanges."
      : regime === "concentrated"
        ? "CONCENTRATED : paires correlees -> L+S simultane = WASH (prouve 15.06), NE PAS hedger ; jouer le sens dominant."
        : "MIXED : ni franchement correle ni disperse -> hedge non prioritaire, jugement.",
  };
}

// marketPosture : stance REGIME-ADAPTATIVE d'ENTREE (directive live-first 15.06, GO Hugo).
// Operationnalise "rampe l'agressivite quand favorable / discipline quand hostile" en un
// signal de premiere classe. PUR. btcAdx = ADX daily BTC ; bw = bottom_watch.
//   defensive  = relief_rally actif OU capitulation (fear_extreme + alt_capitulation)
//                -> minimiser le NOUVEAU risque, gerer l'existant, pas de fade-short.
//   aggressive = regime range (MR favorable) SANS trigger defensif
//                -> chercher activement les setups, prendre les BONS trades (max de trades).
//   normal     = sinon (trending : continuation alignee S1/S2, discipline).
// NE baisse aucun garde-fou : calibre la PROACTIVITE d'entree, pas les seuils.
function marketPosture(btcAdx, bw) {
  const relief = !!(bw && bw.relief_rally && bw.relief_rally.active);
  const capit = !!(bw && bw.fear_extreme && bw.alt_capitulation);
  const reasons = [];
  if (relief) reasons.push("relief_rally actif");
  if (capit) reasons.push("capitulation (fear_extreme + alt_capitulation)");
  if (relief || capit) {
    return { stance: "defensive", reasons, note: "DEFENSIVE : gerer l'existant (thesis-check), NE PAS armer de nouveau fade-short, taille reduite si entree exceptionnelle a edge fort. Le no-trade est legitime ici." };
  }
  const regime = btcAdx == null ? "?" : btcAdx > 35 ? "strong" : btcAdx > 22 ? "trending" : "range";
  if (regime === "range") {
    return { stance: "aggressive", reasons: ["regime range (MR favorable) sans trigger defensif"], note: "AGGRESSIVE : chercher ACTIVEMENT les setups a edge valide (S5/MR8 fades de range), prendre les bons trades -> c'est ici que le MAX de trades se realise. Proactivite d'entree haute, garde-fous intacts." };
  }
  return { stance: "normal", reasons: [`regime ${regime}`], note: "NORMAL : discipline standard. En trending, privilegier les continuations alignees (S1/S2 trending/strong). En strong, prudence sur les fades." };
}

// perceptionCandidates : F4 (18.06) — CANDIDATS directionnels issus de la PERCEPTION que le CATALOGUE
// d'edges RATE. Le catalogue est short-biaise (fades MR/S1/S2 valides OOS) -> en bear il surface peu
// de LONGS, alors que la couche perception (structure CHoCH/MSS + zone fraiche + bougie confirmee) peut
// voir un setup directionnel propre. On le SURFACE en `track:experiment` (donnee LIVE non backtestable)
// -> l'agent peut prendre des LONGS bilateraux que le catalogue ne propose pas. OBSERVABILITE PURE :
// jamais un edge valide, jamais un gate ; le LLM arbitre (et la price action decide). PUR, testable.
//   Criteres (ET) : confluence tier >= B (score14>=6) + STRUCTURE alignee (MSS/CHoCH/trend du bon sens)
//   + appui CONCRET (zone fraiche proche <=1xATR OU bougie de confirmation dans le sens)
//   + le catalogue ne couvre PAS deja ce sens (sinon c'est deja dans `opportunities`).
function perceptionCandidates(rows) {
  const out = [];
  for (const r of (rows || [])) {
    if (!r || r.error) continue;
    const pc = r.perception, cf = pc && pc.confluence;
    if (!cf || !cf.side || cf.score14 == null || cf.score14 < 6) continue; // tier >= B
    const side = cf.side, wantUp = side === "long";
    const structOk = wantUp ? (pc.mss === "up" || pc.choch === "up" || pc.trend === "bull")
                            : (pc.mss === "down" || pc.choch === "down" || pc.trend === "bear");
    if (!structOk) continue;
    if (r.setup && r.setup.side === side) continue; // le catalogue couvre deja ce sens -> deja classe
    const candleOk = typeof pc.candle === "string" && pc.candle.endsWith(":" + side); // bougie confirmee (pas "?")
    const zoneOk = !!(pc.nearest_zone && pc.nearest_zone.dist_atr != null && pc.nearest_zone.dist_atr <= 1.0);
    if (!candleOk && !zoneOk) continue; // besoin d'un appui concret (sinon = score seul = trop faible)
    const why = [pc.mss ? "MSS " + pc.mss : pc.choch ? "CHoCH " + pc.choch : "trend " + pc.trend,
      candleOk ? "bougie " + pc.candle : null,
      zoneOk ? "zone " + pc.nearest_zone.type + "@" + pc.nearest_zone.dist_atr + "xATR (" + pc.nearest_zone.status + ")" : null,
    ].filter(Boolean).join(", ");
    out.push({
      pair: r.pair, side, source: "perception", track: "experiment",
      perception_score14: cf.score14, tier: cf.tier, px: r.px,
      structure: { trend: pc.trend, choch: pc.choch, mss: pc.mss },
      nearest_zone: pc.nearest_zone, candle: pc.candle,
      regime_d: r.regime_d, divergence: r.divergence,
      reason: "perception " + side + " " + cf.tier + " (" + cf.score14 + "/14) : " + why + " -- catalogue " + (r.setup ? "= " + r.setup.side : "vide") + " -> track:experiment (non backteste, OOS via /edge-sprint avant durcissement)",
    });
  }
  return out.sort((a, b) => b.perception_score14 - a.perception_score14);
}

module.exports = scan;
module.exports.perceptionCandidates = perceptionCandidates; // tests offline (F4 longs bilateraux via perception)
module.exports.cycleContext = cycleContext;   // tests offline (lentille cycle pure)
module.exports.reliefRally = reliefRally;      // tests offline (detecteur relief-rally pur)
module.exports.adxDir = adxDir;                // tests offline (direction ADX = trail trend-adaptatif)
module.exports.reclaimEma200d = reclaimEma200d;// tests offline (reclaim EMA200 daily = bascule durable)
module.exports.bottomConfirmed = bottomConfirmed; // tests offline (sequence de bottom complete -> rail long)
module.exports.marketPosture = marketPosture;  // tests offline (stance regime-adaptative pure)
module.exports.dispersion = dispersion;        // tests offline (regime de correlation -> hedge L+S)
module.exports.divergence = divergence;        // tests offline (signal de retournement)
module.exports.obvState = obvState;            // tests offline (flux/accumulation)
module.exports.betaCorr = betaCorr;            // tests offline (decouplage vs BTC)
module.exports.pivots = pivots;                // tests offline (swing detection)
module.exports.priceActionRow = priceActionRow; // tests offline (row price-action histo court, DEMO)
module.exports.atrFrom = atrFrom;               // tests offline (ATR sur peu de barres)
