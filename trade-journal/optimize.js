"use strict";

// Optimiseur d'exits : pour chaque setup du catalogue, détecte les signaux (entrées)
// UNE fois, puis balaie les combinaisons SL × TP × trailing × breakeven pour trouver
// la config qui maximise l'expectancy (R moyen). But : transformer des setups perdants
// en gagnants via de meilleures sorties, et affiner les edges prouvés.
//
// Méthode : entrée = signal du setup (mêmes conditions que scan.js). Exit = simulé pour
// chaque config. R mesuré vs risque initial. Cooldown 8 bougies (anti-clustering).
//
// Usage : node trade-journal/optimize.js
//   OPT_WATCHLIST=BTC,ETH,...   (paires)
//   OPT_MINN=25                 (n minimum pour retenir une config)

const path = require("path");
const bybitDir = path.join(__dirname, "..", "skills", "bybit");
require(path.join(bybitDir, "index.js"));
const ccxt = require(require.resolve("ccxt", { paths: [bybitDir] }));
const { regimeBucket, macroAlign } = require("./edge-watch.js"); // buckets régime (22/35) + alignement macro, partagés
const Vd = require("./validation.js"); // #1 fondation : CPCV-light + Deflated Sharpe + null bootstrap (opt-in OPT_CPCV=1)
const U = require("./universe.js"); // registre asset-class -> /edge-sprint sur XAUT/SPY/QQQ (16.06)

// Defaut = univers du registre (crypto + commodity/ETF perps). OPT_WATCHLIST=XAUT,SPY,... cible un sous-ensemble.
const PAIRS = (process.env.OPT_WATCHLIST
  ? process.env.OPT_WATCHLIST.split(",").map((s) => s.trim()).filter(Boolean)
  : U.enabledSymbols());
const MIN_N = +(process.env.OPT_MINN || 25);
const MIN_N_BUCKET = +(process.env.OPT_MINN_BUCKET || 12); // n min par bucket de régime (sinon "n faible")
const TF = process.env.OPT_TF || "4h";   // timeframe de base testable : 4h (defaut), 1h, 2h...
// OPT_DEEP_DAYS (10.06, skill edge-sprint) : pagine le fetch pour couvrir N jours au lieu du cap
// 1000 bougies (1h: 41j -> 6+ mois validables ; 15m: 10j -> 3+ mois). Sans la variable : inchangé.
const DEEP_DAYS = +(process.env.OPT_DEEP_DAYS || 0);
const TF_MS = { "1m": 60e3, "5m": 300e3, "15m": 900e3, "30m": 1800e3, "1h": 3600e3, "2h": 7200e3, "4h": 14400e3, "1d": 86400e3 };

// Fetch paginé par `since` (dedup par timestamp, garde-fou 40k bougies).
async function fetchDeep(c, sym, tf, days) {
  const ms = TF_MS[tf] || 14400e3;
  let since = Date.now() - days * 86400e3;
  const seen = new Set(); const out = [];
  while (out.length < 40000) {
    let batch; try { batch = await c.fetchOHLCV(sym, tf, since, 1000); } catch (e) { break; }
    if (!batch || !batch.length) break;
    for (const b of batch) { if (!seen.has(b[0])) { seen.add(b[0]); out.push(b); } }
    if (batch.length < 1000) break;
    since = batch[batch.length - 1][0] + ms;
  }
  out.sort((a, b) => a[0] - b[0]);
  return out;
}
const MAX_HOLD = 60, COOLDOWN = 8;
// ── RANDOM-CONTROL (pattern Vibe-Trading run_bench_strict, verdict scraping 10.06) ──
// Baseline d'entrées ALÉATOIRES même-univers / mêmes exits / mêmes frais : un candidat doit
// BATTRE le random, pas juste être >0 (le drift du marché + l'optimisation d'exits peuvent
// produire une expectancy positive depuis du bruit pur). PRNG SEEDÉ par paire+TF -> runs
// reproductibles (lineage edge-revalidation). OPT_RND_P=0 pour désactiver.
const RND_P = process.env.OPT_RND_P === undefined ? 0.10 : +process.env.OPT_RND_P; // proba d'entrée random par barre (avant cooldown)
function mulberry32(seed) { let t0 = seed >>> 0; return function () { let t = (t0 += 0x6D2B79F5); t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function strSeed(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
// Baseline appariée au MIX DE SENS du candidat (un setup short-only se compare au random
// short-only, pas au random both-sides — sinon le beta directionnel fausse la comparaison).
// evalFn(set) -> { exp } sur les MÊMES exits (bestCfg du candidat). Pur, testable offline.
function sideMatchedBaseline(candSet, rndSet, evalFn, minN = 12) {
  if (!rndSet || rndSet.length < minN || !candSet || !candSet.length) return null;
  const wL = candSet.filter((s) => s.side === "long").length / candSet.length;
  const rL = rndSet.filter((s) => s.side === "long"), rS = rndSet.filter((s) => s.side === "short");
  let exp = 0;
  if (wL > 0) { if (!rL.length) return { note: "random sans n long" }; exp += wL * evalFn(rL).exp; }
  if (wL < 1) { if (!rS.length) return { note: "random sans n short" }; exp += (1 - wL) * evalFn(rS).exp; }
  return { exp_matched: +exp.toFixed(3), n_random: rndSet.length, side_mix_long: +wL.toFixed(2) };
}
const FEE = parseFloat(process.env.OPT_FEE_PCT || "0.055") / 100; // frais/fill -> edge NET (round-trip ~0.11%)
// SPRINT hold-vs-cut (15.06) : politiques d'EXIT pilotees env, comparees vs baseline (tenir au SL).
//   OPT_CUT_R   = cut anticipe a -R d'excursion adverse (ex. 0.3 = couper a -0.3R). 0 = desactive.
//   OPT_CUT_FLIP= 1 -> exit quand le close reclaim l'EMA20 (proxy du flip thesis-check). Zero impact live.
const CUT_R = parseFloat(process.env.OPT_CUT_R || "0");
const CUT_FLIP = process.env.OPT_CUT_FLIP === "1";
const CPCV = process.env.OPT_CPCV === "1"; // validation robuste (CPCV-light + DSR + null bootstrap) — recherche, lineage research/

// #1 PRUNING DE N (leçon re-qual 16.06) : le Deflated Sharpe deflate par le NOMBRE d'essais. Le
// labo garde ~70 setups (ablations/controls/variantes/rejets) -> N gonfle -> SR0 explose -> DSR
// ecrase TOUT. Le multiple-testing pertinent = seulement les VRAIS candidats qui pourraient passer
// (ou rester) LIVE, pas les diagnostics. nTrials du DSR = ce sous-ensemble. Les autres restent
// calcules (preuve/controle) mais NE comptent PAS dans la deflation. Allowlist = playbook + sprint courant.
const CANDIDATE = /^(S1_short_bounce|S2_short_continuation|S2_long_continuation|S3_long_oversold|S5_fade_range|S12_squeeze_break|MR8_MTF|MR4_bb_trendfilt|MR8_laddered|S1_MTF_laddered|S2_laddered|FVG_cont|FVG_cont_short|FVG_react|FVG_disp)$/;

// Grille de sorties (multiples d'ATR). tp=99 = pas de TP fixe (trailing seul).
const SLs = [1.0, 1.5, 2.0, 2.5];
const TPs = [2.0, 3.0, 4.0, 5.0, 99];
const TRAILs = [0, 1.5, 2.5];      // 0 = off
const BEs = [false, true];          // breakeven après +1R

// ---- indicateurs ----
function emaS(v, p) { const k = 2 / (p + 1); const o = [v[0]]; for (let i = 1; i < v.length; i++) o.push(v[i] * k + o[i - 1] * (1 - k)); return o; }
function rsiS(c, p = 14) {
  const out = new Array(c.length).fill(50); if (c.length < p + 2) return out;
  let g = 0, l = 0; for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= p; l /= p; out[p] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = p + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g = (g * (p - 1) + (d > 0 ? d : 0)) / p; l = (l * (p - 1) + (d < 0 ? -d : 0)) / p; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } return out;
}
function atrS(h, lo, c, p = 14) {
  const tr = [h[0] - lo[0]]; for (let i = 1; i < c.length; i++) tr.push(Math.max(h[i] - lo[i], Math.abs(h[i] - c[i - 1]), Math.abs(lo[i] - c[i - 1])));
  const out = new Array(c.length).fill(0); let a = 0; for (let i = 0; i < p; i++) a += tr[i]; a /= p; out[p - 1] = a;
  for (let i = p; i < tr.length; i++) { a = (a * (p - 1) + tr[i]) / p; out[i] = a; } return out;
}
function macdS(c) { const e12 = emaS(c, 12), e26 = emaS(c, 26); const line = c.map((_, i) => e12[i] - e26[i]); const sig = emaS(line, 9); return { line, sig }; }
function bbAt(c, i, p = 20, k = 2) { let m = 0; for (let j = i - p + 1; j <= i; j++) m += c[j]; m /= p; let s = 0; for (let j = i - p + 1; j <= i; j++) s += (c[j] - m) ** 2; const sd = Math.sqrt(s / p); return { u: m + k * sd, l: m - k * sd }; }
function stochAt(h, l, c, i, p = 14) { let hh = -Infinity, ll = Infinity; for (let j = i - p + 1; j <= i; j++) { if (h[j] > hh) hh = h[j]; if (l[j] < ll) ll = l[j]; } return hh === ll ? 50 : (c[i] - ll) / (hh - ll) * 100; }
// StochRSI(p) = stochastique du RSI (0..1) a l'indice i
function stochRsiAt(rsiArr, i, p = 14) { let mn = Infinity, mx = -Infinity; for (let j = i - p + 1; j <= i; j++) { if (rsiArr[j] < mn) mn = rsiArr[j]; if (rsiArr[j] > mx) mx = rsiArr[j]; } return mx === mn ? 0.5 : (rsiArr[i] - mn) / (mx - mn); }
// ADX/DI (Wilder) -> { adx, pdi, mdi } : force de tendance + direction dominante.
// Sert à GATER les mean-reversions : ne pas fader une impulsion contraire FORTE
// (ADX élevé + -DI>>+DI = couteau qui tombe). Proxy computable du "STRONG regime
// opposé" du gating Desktop (marche SANS TradingView Desktop).
function adxS(H, L, C, p = 14) {
  const len = C.length;
  const pDM = new Array(len).fill(0), mDM = new Array(len).fill(0), tr = new Array(len).fill(0);
  for (let i = 1; i < len; i++) {
    const up = H[i] - H[i - 1], dn = L[i - 1] - L[i];
    pDM[i] = (up > dn && up > 0) ? up : 0;
    mDM[i] = (dn > up && dn > 0) ? dn : 0;
    tr[i] = Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1]));
  }
  const pdi = new Array(len).fill(0), mdi = new Array(len).fill(0), adx = new Array(len).fill(0), dx = new Array(len).fill(0);
  let trS = 0, pS = 0, mS = 0;
  for (let i = 1; i <= p && i < len; i++) { trS += tr[i]; pS += pDM[i]; mS += mDM[i]; }
  for (let i = p; i < len; i++) {
    if (i > p) { trS = trS - trS / p + tr[i]; pS = pS - pS / p + pDM[i]; mS = mS - mS / p + mDM[i]; }
    const pD = trS ? 100 * pS / trS : 0, mD = trS ? 100 * mS / trS : 0;
    pdi[i] = pD; mdi[i] = mD;
    dx[i] = (pD + mD) ? 100 * Math.abs(pD - mD) / (pD + mD) : 0;
  }
  let a = 0; for (let i = p + 1; i <= 2 * p && i < len; i++) a += dx[i]; a /= p;
  for (let i = 2 * p; i < len; i++) { a = i > 2 * p ? (a * (p - 1) + dx[i]) / p : a; adx[i] = a; }
  return { adx, pdi, mdi };
}

// Supertrend(p,mult) -> tableau de direction (1=haussier, -1=baissier)
function supertrend(H, L, C, p = 10, mult = 3) {
  const atr = atrS(H, L, C, p); const dir = new Array(C.length).fill(1); const fu = new Array(C.length).fill(0), fl = new Array(C.length).fill(0);
  for (let i = 0; i < C.length; i++) {
    const hl2 = (H[i] + L[i]) / 2, bu = hl2 + mult * atr[i], bl = hl2 - mult * atr[i];
    fu[i] = i === 0 ? bu : (bu < fu[i - 1] || C[i - 1] > fu[i - 1]) ? bu : fu[i - 1];
    fl[i] = i === 0 ? bl : (bl > fl[i - 1] || C[i - 1] < fl[i - 1]) ? bl : fl[i - 1];
    if (i === 0) continue;
    dir[i] = dir[i - 1] === 1 ? (C[i] < fl[i] ? -1 : 1) : (C[i] > fu[i] ? 1 : -1);
  }
  return dir;
}

// détecte les signaux (entrées) de chaque setup sur une paire
// dAdx (optionnel) = ADX DAILY de la paire mappé sur les barres 4H -> taggue le RÉGIME
// de chaque signal (range/trending/strong) pour le split d'expectancy par régime (piste 5a).
function detect(O, H, L, C, V, dBull, wBull, dAdx, mAdx, mBull, rng, dBull50) {
  const rsi = rsiS(C), e20 = emaS(C, 20), e50 = emaS(C, 50), e200 = emaS(C, 200), atr = atrS(H, L, C), md = macdS(C), st = supertrend(H, L, C, 10, 3);
  const adxObj = adxS(H, L, C, 14), adx = adxObj.adx, pdi = adxObj.pdi, mdi = adxObj.mdi;
  const sigs = {}; const lastBar = {};
  // État S10 (sprint #2, 10.06) : dernier breakout/breakdown Don20 + niveau cassé (gelé au moment
  // de la cassure) — pour détecter le RETEST du niveau dans les 1-5 bougies suivantes.
  let s10BkdnI = -99, s10BkdnLvl = null, s10BkupI = -99, s10BkupLvl = null;
  const push = (setup, i, side, entryPx) => {
    if (lastBar[setup] !== undefined && i - lastBar[setup] < COOLDOWN) return;
    const phase = i < 0.62 * C.length ? "train" : "test"; // split temporel out-of-sample
    const regime = regimeBucket(dAdx ? dAdx[i] : null);    // régime DAILY de la paire au signal
    // Régime MACRO (BTC daily) au signal + alignement du side vs la direction macro (H2) :
    // "strong_opposed" = fade contre une tendance macro forte (le cas que le gating bloque).
    const macroB = regimeBucket(mAdx ? mAdx[i] : null);
    const malign = macroAlign(side, macroB, mBull ? mBull[i] : null);
    // entryPx (sprint #6) : variantes d'entrée LIMIT — entrée au niveau touché, pas au close.
    (sigs[setup] = sigs[setup] || []).push({ i, side, entry: entryPx ?? C[i], atr: atr[i], phase, regime, malign, pos: C.length ? i / C.length : 0 }); lastBar[setup] = i; // pos = position temporelle normalisee (0-1) -> blocs CPCV
  };
  // ==== SPRINT #6 (10.06, post-mortem flash-sweep HYPE) : placement d'entrée MR8 ====
  // Même signal MR8_MTF, 3 mécanismes d'entrée différents (design committé AVANT run) :
  // e_retrace = limit signal∓0.5×ATR (6 bars) · e_reclaim = sweep extrême 30b puis reclaim
  // (12 bars) · e_confirm = retournement StochRSI (6 bars). Pendings par variante.
  let s6Pend = []; // {kind, side, i0, level(retrace), expiry}
  let srsiPrev = null;
  // ==== SPRINT #7 (10.06 soir, brainstorm the maintainer) : entrée échelonnée + qualité des plus bas ====
  // laddered = 3 tranches T1/T2/T3 (signal / −0.5 / −1.0×ATR, fenêtre 6 bars, entrée = moyenne
  // des remplies) · lvl_fresh = swing 30b peu testé (touches ≤2 sur 60b) · lvl_wick = swing
  // marqué par une mèche de rejet ≥50% · lvl_worn (diagnostic) = swing usé (touches ≥4).
  let s7Pend = []; // {side, i0, t2, t3, expiry, fills:[t1] (+t2,t3 quand touchés)}
  // SPRINT #8 (test 10.06, demande the maintainer) : laddered sur setups de TENDANCE (S1/S2), pas seulement MR.
  // Meme mecanique que MR8_laddered (T1 signal / T2 +0.5xATR / T3 +1.0xATR, fenetre 6 bars,
  // entree = moyenne des tranches remplies). MEME signal que la baseline -> SEULE l'entree change.
  let trendLad = []; // {name, side, t2, t3, expiry, fills:[t1]}
  // TEST A2 (10.06, brainstorm the maintainer : market/limit pour rejoindre les limites) : comparer
  // 3 politiques d'entree sur S1/S2 — laddered (T1 au signal, deja teste sprint #8) vs
  // bounceonly (TOUS les rungs au-DESSUS du prix = style ASTER live, RIEN si pas de rebond)
  // vs bounce_cont (bounceonly + entree de CONTINUATION au close de fenetre si 0 fill = idee A2).
  let trendBounce = []; // {base('S1'|'S2'), side, t1, t2, t3, expiry, fills:[]}
  // ==== SPRINT FVG (16.06, demande the maintainer) : Fair Value Gaps (design committe AVANT run) ====
  // pendings limit FVG : {name, side, level, expiry}. Filles a j>i quand le niveau est touche.
  let fvgPend = [];
  for (let i = 205; i < C.length - 1; i++) {
    if (!atr[i]) continue;
    const px = C[i];
    const bear = e50[i] < e200[i] && px < e20[i] && e20[i] < e50[i];
    const bull = px > e200[i] && e50[i] > e200[i];
    const sep = Math.abs(e20[i] - e50[i]) / px, range = sep < 0.004;
    const rising = (md.line[i] - md.sig[i]) > (md.line[i - 1] - md.sig[i - 1]);
    const bbv = bbAt(C, i), stochK = stochAt(H, L, C, i);
    let donHi = -Infinity, donLo = Infinity; for (let j = i - 20; j < i; j++) { if (H[j] > donHi) donHi = H[j]; if (L[j] < donLo) donLo = L[j]; }
    let vAvg = 0; for (let j = i - 20; j < i; j++) vAvg += V[j]; vAvg /= 20; const volR = vAvg > 0 ? V[i] / vAvg : 1;
    if (rsi[i] < 25 && rsi[i] > rsi[i - 1]) push("S3_long_oversold", i, "long");
    if (bear && px < e20[i] && (e20[i] - px) / px < 0.035 && rsi[i] > 35) push("S1_short_bounce", i, "short");
    if (bear && rsi[i] >= 40 && rsi[i] <= 58) push("S2_short_continuation", i, "short");
    if (bull && rsi[i] >= 30 && rsi[i] <= 50) push("S4_long_relstrength", i, "long");
    if (bull && rsi[i] >= 38 && rsi[i] <= 52 && rising && Math.abs(px - e20[i]) / px < 0.025) push("S7_pullback_bull", i, "long");
    if (range && px >= bbv.u && rsi[i] > 60 && stochK > 75) push("S5_fade_range", i, "short");
    if (range && px <= bbv.l && rsi[i] < 40 && stochK < 25) push("S5_fade_range", i, "long");
    if (px > donHi && volR > 1.3) push("S8_breakout", i, "long");
    if (px < donLo && volR > 1.3) push("S8_breakout", i, "short");
    // RANDOM_CONTROL : entrée aléatoire seedée (même univers/exits/frais) = plancher de bruit.
    if (rng && RND_P > 0 && rng() < RND_P) push("RANDOM_CONTROL", i, rng() < 0.5 ? "long" : "short");
    // ---- CANDIDATS HAUTE FREQUENCE (mean-reversion + trend-pullback) : viser plusieurs trades/sem ----
    // MR1 reversion bande BB (tout regime)
    if (px <= bbv.l) push("MR1_bb_revert", i, "long");
    if (px >= bbv.u) push("MR1_bb_revert", i, "short");
    // MR2 RSI extreme avec retournement amorce
    if (rsi[i] < 32 && rsi[i] > rsi[i - 1]) push("MR2_rsi_revert", i, "long");
    if (rsi[i] > 68 && rsi[i] < rsi[i - 1]) push("MR2_rsi_revert", i, "short");
    // MR3 stochastique extreme
    if (stochK < 20) push("MR3_stoch", i, "long");
    if (stochK > 80) push("MR3_stoch", i, "short");
    // MR4 reversion BB MAIS alignee a la tendance HTF (filtre anti-couteau)
    if (px <= bbv.l && px > e200[i]) push("MR4_bb_trendfilt", i, "long");   // bande basse en uptrend
    if (px >= bbv.u && px < e200[i]) push("MR4_bb_trendfilt", i, "short");  // bande haute en downtrend
    // TR1 pullback EMA20 dans le sens de la tendance (la meche touche EMA20, close repart)
    if (bull && L[i] <= e20[i] && px > e20[i]) push("TR1_ema_bounce", i, "long");
    if (bear && H[i] >= e20[i] && px < e20[i]) push("TR1_ema_bounce", i, "short");
    // ---- CANDIDATS WEB (trend-following, ce qui manque au book) ----
    const macdBull = md.line[i] > md.sig[i] && md.line[i - 1] <= md.sig[i - 1]; // cross up
    const macdBear = md.line[i] < md.sig[i] && md.line[i - 1] >= md.sig[i - 1];
    // WEB1 MACD cross + filtre RSI + tendance EMA200 (StratBase: ~58% WR BTC 4H)
    if (macdBull && rsi[i] < 60 && px > e200[i]) push("WEB1_macd_trend", i, "long");
    if (macdBear && rsi[i] > 40 && px < e200[i]) push("WEB1_macd_trend", i, "short");
    // WEB2 flip Supertrend(10,3) aligne EMA200 (trend-following)
    if (st[i] === 1 && st[i - 1] === -1 && px > e200[i]) push("WEB2_supertrend", i, "long");
    if (st[i] === -1 && st[i - 1] === 1 && px < e200[i]) push("WEB2_supertrend", i, "short");
    // ---- MEAN-REVERSION + FILTRE TENDANCE (pattern qui valide chez nous : S5/MR4) ----
    const srsi = stochRsiAt(rsi, i);
    // MR5 StochRSI extreme + filtre EMA200 (web: ~57% WR BTC 4H avec filtre tendance)
    if (srsi < 0.2 && px > e200[i]) push("MR5_stochrsi_trend", i, "long");
    if (srsi > 0.8 && px < e200[i]) push("MR5_stochrsi_trend", i, "short");
    // MR7 reversion bande KELTNER (EMA20 +/- 2*ATR) + filtre tendance EMA200
    const ku = e20[i] + 2 * atr[i], kl = e20[i] - 2 * atr[i];
    if (px <= kl && px > e200[i]) push("MR7_keltner_trend", i, "long");
    if (px >= ku && px < e200[i]) push("MR7_keltner_trend", i, "short");
    // MR8 StochRSI extreme SANS filtre (controle, pour mesurer l'apport du filtre)
    if (srsi < 0.15) push("MR8_stochrsi_naked", i, "long");
    if (srsi > 0.85) push("MR8_stochrsi_naked", i, "short");
    // ==== VARIANTES FILTREES a tester sur S5/MR4/MR8 : A=volume(>1.2x), B=confirmation bougie (proxy LTF) ====
    const confL = C[i] > O[i], confS = C[i] < O[i]; // bougie verte/rouge = confirme le sens
    // S5
    if (range && px >= bbv.u && rsi[i] > 60 && stochK > 75) { if (volR > 1.2) push("S5_A_vol", i, "short"); if (confS) push("S5_B_conf", i, "short"); if (volR > 1.2 && confS) push("S5_AB", i, "short"); }
    if (range && px <= bbv.l && rsi[i] < 40 && stochK < 25) { if (volR > 1.2) push("S5_A_vol", i, "long"); if (confL) push("S5_B_conf", i, "long"); if (volR > 1.2 && confL) push("S5_AB", i, "long"); }
    // MR4
    if (px <= bbv.l && px > e200[i]) { if (volR > 1.2) push("MR4_A_vol", i, "long"); if (confL) push("MR4_B_conf", i, "long"); if (volR > 1.2 && confL) push("MR4_AB", i, "long"); }
    if (px >= bbv.u && px < e200[i]) { if (volR > 1.2) push("MR4_A_vol", i, "short"); if (confS) push("MR4_B_conf", i, "short"); if (volR > 1.2 && confS) push("MR4_AB", i, "short"); }
    // MR8
    if (srsi < 0.15) { if (volR > 1.2) push("MR8_A_vol", i, "long"); if (confL) push("MR8_B_conf", i, "long"); if (volR > 1.2 && confL) push("MR8_AB", i, "long"); }
    if (srsi > 0.85) { if (volR > 1.2) push("MR8_A_vol", i, "short"); if (confS) push("MR8_B_conf", i, "short"); if (volR > 1.2 && confS) push("MR8_AB", i, "short"); }
    // ==== MTF : alignement au DAILY (timeframe superieur) — la vraie demande ====
    const db = dBull ? dBull[i] : null;
    // MR8 + daily : ne short que si daily baissier, ne long que si daily haussier
    if (srsi < 0.15 && db === true) push("MR8_MTF", i, "long");
    if (srsi > 0.85 && db === false) push("MR8_MTF", i, "short");
    // ==== SPRINT 15.06 (the maintainer : gate directionnel + rapide) : MEME signal MR8 (srsi<0.15), gate LONG
    // assoupli de EMA200d (db) vers EMA50d (db50). Design committe AVANT run. Zero impact live. ====
    const db50 = dBull50 ? dBull50[i] : null;
    if (srsi < 0.15 && db50 === true) push("MR8_long_d50", i, "long");                  // gate rapide (px>EMA50d)
    if (srsi < 0.15 && db50 === true && db === false) push("MR8_long_recov", i, "long"); // zone de reprise que l'EMA200 bloque
    // ==== SPRINT 15.06 #2 (the maintainer : famille MOMENTUM bidirectionnelle) — design committe AVANT run ====
    const rngHL = H[i] - L[i];
    if (atr[i] > 0 && rngHL > 1.8 * atr[i]) {               // MOM_thrust : poussee de volatilite, close en quartile extreme
      const posC = rngHL > 0 ? (C[i] - L[i]) / rngHL : 0.5;
      if (posC > 0.75) push("MOM_thrust", i, "long");
      if (posC < 0.25) push("MOM_thrust", i, "short");
    }
    const bullNow = px > e200[i] && e50[i] > e200[i], bullPrev = C[i - 1] > e200[i - 1] && e50[i - 1] > e200[i - 1];
    const bearNow = px < e200[i] && e50[i] < e200[i], bearPrev = C[i - 1] < e200[i - 1] && e50[i - 1] < e200[i - 1];
    if (bullNow && !bullPrev) push("MOM_stack_flip", i, "long");   // bascule FRAICHE de la structure EMA -> long
    if (bearNow && !bearPrev) push("MOM_stack_flip", i, "short");  // bascule fraiche bear -> short
    // ==== SPRINT FVG (16.06, demande the maintainer) — design committe AVANT run (docs/plans/2026-06-16-edge-sprint-fvg-design.md) ====
    // FVG 3-bougies = gap d'imbalance laisse par une bougie de displacement (i-1) :
    //   bull : L[i] > H[i-2] (gap up) ; bear : H[i] < L[i-2] (gap down). displacement = range(i-1)>1.2*ATR + corps directionnel.
    // C1 FVG_cont  : continuation, LIMIT retrace au 50% du gap, aligne daily, sens du displacement (LE modele).
    // C2 FVG_disp  : controle, entree AU close (chase, market) -> isole l'apport du retrace.
    // C3 FVG_react : range-only, fade le displacement (gap-fill reversion), LIMIT au retest de l'extreme de l'impulsion.
    // 1) traiter les pendings FVG (un pending cree au bar i ne fille qu'a j>i)
    if (fvgPend.length) {
      const kept = [];
      for (const p of fvgPend) {
        if (i > p.expiry) continue; // expire sans fill
        let filled = false;
        if (p.side === "long" && L[i] <= p.level) { push(p.name, i, "long", p.level); filled = true; }
        else if (p.side === "short" && H[i] >= p.level) { push(p.name, i, "short", p.level); filled = true; }
        if (!filled) kept.push(p);
      }
      fvgPend = kept;
    }
    // 2) detecter le FVG au bar i + enregistrer les entrees
    const dispBig = atr[i - 1] > 0 && (H[i - 1] - L[i - 1]) > 1.2 * atr[i - 1];
    const bullFvg = L[i] > H[i - 2] && dispBig && C[i - 1] > O[i - 1];
    const bearFvg = H[i] < L[i - 2] && dispBig && C[i - 1] < O[i - 1];
    if (bullFvg) {
      const mid = (H[i - 2] + L[i]) / 2;                                   // 50% du gap = fair value
      const gap = L[i] - H[i - 2];
      const shallow = L[i] - 0.25 * gap;                                   // retrace COURT (25% dans le gap depuis le haut) = pres du momentum
      if (db === true) {
        fvgPend.push({ name: "FVG_cont", side: "long", level: mid, expiry: i + 6 });
        // FVG_cont_short (16.06, pre-enregistre pour RE-TEST futur, demande the maintainer) : retrace COURT
        // 25% + fenetre serree (4 barres) = tenter de capter le momentum de deplacement (l'edge
        // trouve dans FVG_disp) en restant LIMIT-compatible (B1), la ou le retrace 50% l'a rate.
        fvgPend.push({ name: "FVG_cont_short", side: "long", level: shallow, expiry: i + 4 });
        push("FVG_disp", i, "long");
      }
      if (range) fvgPend.push({ name: "FVG_react", side: "short", level: H[i], expiry: i + 6 }); // fade : short au retest du haut, vise le gap-fill
    }
    if (bearFvg) {
      const mid = (H[i] + L[i - 2]) / 2;
      const gap = L[i - 2] - H[i];
      const shallow = H[i] + 0.25 * gap;
      if (db === false) {
        fvgPend.push({ name: "FVG_cont", side: "short", level: mid, expiry: i + 6 });
        fvgPend.push({ name: "FVG_cont_short", side: "short", level: shallow, expiry: i + 4 });
        push("FVG_disp", i, "short");
      }
      if (range) fvgPend.push({ name: "FVG_react", side: "long", level: L[i], expiry: i + 6 });  // fade : long au retest du bas
    }
    // ==== SPRINT #6 : variantes d'entrée du MÊME signal MR8_MTF (design pré-committé) ====
    // 1) traiter les pendings au bar courant (un pending créé au bar i ne fille qu'à j>i)
    if (s6Pend.length) {
      const kept = [];
      for (const p of s6Pend) {
        if (i > p.expiry) continue; // expiré sans fill -> abandon
        let filled = false;
        if (p.kind === "retrace") {
          if (p.side === "long" && L[i] <= p.level) { push("MR8_e_retrace", i, "long", p.level); filled = true; }
          if (p.side === "short" && H[i] >= p.level) { push("MR8_e_retrace", i, "short", p.level); filled = true; }
        } else if (p.kind === "reclaim") {
          // sweep de l'extrême 30b PUIS reclaim dans la même bougie (cas HYPE 02:41)
          if (p.side === "long") {
            let lo30 = Infinity; for (let k = i - 30; k < i; k++) if (L[k] < lo30) lo30 = L[k];
            if (L[i] < lo30 && C[i] > lo30) { push("MR8_e_reclaim", i, "long"); filled = true; }
          } else {
            let hi30 = -Infinity; for (let k = i - 30; k < i; k++) if (H[k] > hi30) hi30 = H[k];
            if (H[i] > hi30 && C[i] < hi30) { push("MR8_e_reclaim", i, "short"); filled = true; }
          }
        } else if (p.kind === "confirm" && srsiPrev != null) {
          if (p.side === "long" && srsi > srsiPrev && srsi > 0.15) { push("MR8_e_confirm", i, "long"); filled = true; }
          if (p.side === "short" && srsi < srsiPrev && srsi < 0.85) { push("MR8_e_confirm", i, "short"); filled = true; }
        }
        if (!filled) kept.push(p);
      }
      s6Pend = kept;
    }
    // 2) enregistrer les pendings sur signal MR8_MTF (mêmes conditions que la baseline)
    if (srsi < 0.15 && db === true) {
      s6Pend.push({ kind: "retrace", side: "long", level: px - 0.5 * atr[i], expiry: i + 6 });
      s6Pend.push({ kind: "reclaim", side: "long", expiry: i + 12 });
      s6Pend.push({ kind: "confirm", side: "long", expiry: i + 6 });
    }
    if (srsi > 0.85 && db === false) {
      s6Pend.push({ kind: "retrace", side: "short", level: px + 0.5 * atr[i], expiry: i + 6 });
      s6Pend.push({ kind: "reclaim", side: "short", expiry: i + 12 });
      s6Pend.push({ kind: "confirm", side: "short", expiry: i + 6 });
    }
    srsiPrev = srsi;
    // ==== SPRINT #7 : (1) traiter les ladders en cours, (2) en ouvrir + filtres niveau au signal ====
    if (s7Pend.length) {
      const kept7 = [];
      for (const p of s7Pend) {
        if (p.side === "long") {
          if (p.fills.length < 2 && L[i] <= p.t2) p.fills.push(p.t2);
          if (p.fills.length < 3 && L[i] <= p.t3) p.fills.push(p.t3);
        } else {
          if (p.fills.length < 2 && H[i] >= p.t2) p.fills.push(p.t2);
          if (p.fills.length < 3 && H[i] >= p.t3) p.fills.push(p.t3);
        }
        // push à la fin de fenêtre OU dès que T3 est remplie (la position est complète)
        if (p.fills.length === 3 || i >= p.expiry) {
          const avg = p.fills.reduce((a, b) => a + b, 0) / p.fills.length;
          push("MR8_laddered", i, p.side, avg);
        } else kept7.push(p);
      }
      s7Pend = kept7;
    }
    {
      const s7Long = srsi < 0.15 && db === true, s7Short = srsi > 0.85 && db === false;
      if (s7Long || s7Short) {
        const sgn = s7Long ? -1 : 1, side7 = s7Long ? "long" : "short";
        s7Pend.push({ side: side7, t2: px + sgn * 0.5 * atr[i], t3: px + sgn * 1.0 * atr[i], expiry: i + 6, fills: [px] });
        // ── filtres niveau : qualité du swing 30b fadé (calculés AU SIGNAL, sans lookahead) ──
        let extI = i - 1, extV = s7Long ? Infinity : -Infinity;
        for (let k = i - 30; k < i; k++) {
          if (s7Long ? L[k] < extV : H[k] > extV) { extV = s7Long ? L[k] : H[k]; extI = k; }
        }
        const tol = 0.25 * atr[i];
        let touches = 0;
        for (let k = Math.max(0, i - 60); k < i; k++) {
          if (s7Long ? L[k] <= extV + tol : H[k] >= extV - tol) touches++;
        }
        const rng = H[extI] - L[extI];
        const wick = rng > 0 ? (s7Long ? (Math.min(O[extI], C[extI]) - L[extI]) / rng : (H[extI] - Math.max(O[extI], C[extI])) / rng) : 0;
        if (touches <= 2) push("MR8_lvl_fresh", i, side7);
        if (touches >= 4) push("MR8_lvl_worn", i, side7); // diagnostic (pas un candidat)
        if (wick >= 0.5) push("MR8_lvl_wick", i, side7);
      }
    }
    // ==== SPRINT #8 : laddered sur TENDANCE (S1/S2) — processing (pendings anterieurs) puis creation ====
    if (trendLad.length) {
      const keptT = [];
      for (const p of trendLad) {
        if (p.side === "long") {
          if (p.fills.length < 2 && L[i] <= p.t2) p.fills.push(p.t2);
          if (p.fills.length < 3 && L[i] <= p.t3) p.fills.push(p.t3);
        } else {
          if (p.fills.length < 2 && H[i] >= p.t2) p.fills.push(p.t2);
          if (p.fills.length < 3 && H[i] >= p.t3) p.fills.push(p.t3);
        }
        if (p.fills.length === 3 || i >= p.expiry) {
          const avg = p.fills.reduce((a, b) => a + b, 0) / p.fills.length;
          push(p.name, i, p.side, avg);
        } else keptT.push(p);
      }
      trendLad = keptT;
    }
    if (bear && px < e20[i] && (e20[i] - px) / px < 0.035 && rsi[i] > 35 && db === false)
      trendLad.push({ name: "S1_MTF_laddered", side: "short", t2: px + 0.5 * atr[i], t3: px + 1.0 * atr[i], expiry: i + 6, fills: [px] });
    if (bear && rsi[i] >= 40 && rsi[i] <= 58)
      trendLad.push({ name: "S2_laddered", side: "short", t2: px + 0.5 * atr[i], t3: px + 1.0 * atr[i], expiry: i + 6, fills: [px] });
    // ==== TEST A2 : bounceonly (tous rungs au-dessus, RIEN si pas de rebond) + continuation ====
    if (trendBounce.length) {
      const keptB = [];
      for (const p of trendBounce) {
        // short uniquement (S1/S2 = shorts ici) : rungs au-DESSUS, fillent si le prix rebondit
        if (p.fills.length < 1 && H[i] >= p.t1) p.fills.push(p.t1);
        if (p.fills.length < 2 && H[i] >= p.t2) p.fills.push(p.t2);
        if (p.fills.length < 3 && H[i] >= p.t3) p.fills.push(p.t3);
        if (p.fills.length === 3 || i >= p.expiry) {
          if (p.fills.length > 0) {
            const avg = p.fills.reduce((a, b) => a + b, 0) / p.fills.length;
            push(p.base + "_bounceonly", i, p.side, avg);     // style ASTER : capture le rebond, RIEN sinon
            push(p.base + "_bounce_cont", i, p.side, avg);     // identique quand il y a eu fill
          } else {
            // A2 : 0 fill (pas de rebond) -> bounceonly = pas de trade ; bounce_cont = entree continuation au close
            push(p.base + "_bounce_cont", i, p.side, C[i]);    // entree maker de continuation (close de fenetre)
          }
        } else keptB.push(p);
      }
      trendBounce = keptB;
    }
    if (bear && px < e20[i] && (e20[i] - px) / px < 0.035 && rsi[i] > 35 && db === false)
      trendBounce.push({ base: "S1", side: "short", t1: px + 0.33 * atr[i], t2: px + 0.66 * atr[i], t3: px + 1.0 * atr[i], expiry: i + 6, fills: [] });
    if (bear && rsi[i] >= 40 && rsi[i] <= 58)
      trendBounce.push({ base: "S2", side: "short", t1: px + 0.33 * atr[i], t2: px + 0.66 * atr[i], t3: px + 1.0 * atr[i], expiry: i + 6, fills: [] });
    // S5 fade + daily
    if (range && px >= bbv.u && rsi[i] > 60 && stochK > 75 && db === false) push("S5_MTF", i, "short");
    if (range && px <= bbv.l && rsi[i] < 40 && stochK < 25 && db === true) push("S5_MTF", i, "long");
    // S1 short-bounce + daily baissier (deja htfBear 4H, on ajoute la confirmation daily)
    if (bear && px < e20[i] && (e20[i] - px) / px < 0.035 && rsi[i] > 35 && db === false) push("S1_MTF", i, "short");
    // MR4 + MTF daily (en plus du filtre 4H EMA200)
    if (px <= bbv.l && px > e200[i] && db === true) push("MR4_MTF", i, "long");
    if (px >= bbv.u && px < e200[i] && db === false) push("MR4_MTF", i, "short");
    // ==== TEST FREQUENCE D'ENTREE (recherche, n'affecte PAS scan.js/live) ====
    // But : +d'entrees VALIDES si l'edge NET OOS TIENT a un seuil plus large. Garder uniquement si train≈test.
    // MR8 : balaie la bande StochRSI (baseline MR8_MTF = 0.15/0.85). t10/t12 = plus STRICT, t18/t20 = plus LARGE.
    for (const th of [0.10, 0.12, 0.18, 0.20]) {
      const tag = "MR8_MTF_t" + Math.round(th * 100);
      if (srsi < th && db === true) push(tag, i, "long");
      if (srsi > (1 - th) && db === false) push(tag, i, "short");
    }
    // S5 : seuils RSI/Stoch elargis (baseline 60/40 + 75/25) -> plus de fades de range
    if (range && px >= bbv.u && rsi[i] > 55 && stochK > 70 && db === false) push("S5_MTF_loose", i, "short");
    if (range && px <= bbv.l && rsi[i] < 45 && stochK < 30 && db === true) push("S5_MTF_loose", i, "long");
    // S5 : definition de RANGE elargie (sep<0.006 au lieu de 0.004) -> plus d'occurrences de range
    const range6 = sep < 0.006;
    if (range6 && px >= bbv.u && rsi[i] > 60 && stochK > 75 && db === false) push("S5_MTF_range6", i, "short");
    if (range6 && px <= bbv.l && rsi[i] < 40 && stochK < 25 && db === true) push("S5_MTF_range6", i, "long");
    // MR4 : near-touch de bande (dans 0.3% de la bande) au lieu du touch strict -> plus de signaux
    if (px <= bbv.l * 1.003 && px > e200[i] && db === true) push("MR4_MTF_near", i, "long");
    if (px >= bbv.u * 0.997 && px < e200[i] && db === false) push("MR4_MTF_near", i, "short");
    // ==== GATE ADX/DI : sur les setups VALIDES (MR8/S5/MR4 alignes Daily), skip si
    // l'impulsion 4H CONTRE le fade est forte (ADX>seuil + DI dominant du mauvais cote).
    // = proxy computable du "STRONG regime oppose" du gating Desktop. Seuils testes 30 & 40.
    // >>> RESULTAT (09.06) : REJETE OOS. MR8 test 0.152->0.158 (= bruit, -44 signaux) ;
    //     S5 test 0.302->0.197 a TH30 (DETRUIT l'expectancy, monte le WR = arbitrage) ;
    //     MR4_MTF deja overfit. Le train de MR8_adx30 bondit 0.109->0.177 mais NE survit
    //     PAS a l'OOS = overfit. Conclusion : le filtre Daily EMA200 capture deja le contexte
    //     tendance ; un gate d'impulsion ADX par-dessus est redondant. NON integre a scan.js.
    //     Variantes conservees ici comme PREUVE du rejet (cf. MR1/MR5/WEB1/volume rejetes).
    const impLong30 = adx[i] > 30 && mdi[i] > pdi[i];   // forte impulsion BAISSIERE -> mauvais pour un long fade
    const impShort30 = adx[i] > 30 && pdi[i] > mdi[i];  // forte impulsion HAUSSIERE -> mauvais pour un short fade
    const impLong40 = adx[i] > 40 && mdi[i] > pdi[i];
    const impShort40 = adx[i] > 40 && pdi[i] > mdi[i];
    // MR8_MTF gate
    if (srsi < 0.15 && db === true && !impLong30) push("MR8_MTF_adx30", i, "long");
    if (srsi > 0.85 && db === false && !impShort30) push("MR8_MTF_adx30", i, "short");
    if (srsi < 0.15 && db === true && !impLong40) push("MR8_MTF_adx40", i, "long");
    if (srsi > 0.85 && db === false && !impShort40) push("MR8_MTF_adx40", i, "short");
    // S5_MTF gate
    if (range && px >= bbv.u && rsi[i] > 60 && stochK > 75 && db === false && !impShort30) push("S5_MTF_adx30", i, "short");
    if (range && px <= bbv.l && rsi[i] < 40 && stochK < 25 && db === true && !impLong30) push("S5_MTF_adx30", i, "long");
    if (range && px >= bbv.u && rsi[i] > 60 && stochK > 75 && db === false && !impShort40) push("S5_MTF_adx40", i, "short");
    if (range && px <= bbv.l && rsi[i] < 40 && stochK < 25 && db === true && !impLong40) push("S5_MTF_adx40", i, "long");
    // MR4_MTF gate
    if (px <= bbv.l && px > e200[i] && db === true && !impLong30) push("MR4_MTF_adx30", i, "long");
    if (px >= bbv.u && px < e200[i] && db === false && !impShort30) push("MR4_MTF_adx30", i, "short");
    if (px <= bbv.l && px > e200[i] && db === true && !impLong40) push("MR4_MTF_adx40", i, "long");
    if (px >= bbv.u && px < e200[i] && db === false && !impShort40) push("MR4_MTF_adx40", i, "short");
    // S3 long survente + daily haussier (teste si le filtre daily sauve ce contra-trend)
    if (rsi[i] < 25 && rsi[i] > rsi[i - 1] && db === true) push("S3_MTF", i, "long");
    // Losers + daily : MTF sauve-t-il S2/S4/S7/S8 ?
    if (bear && rsi[i] >= 40 && rsi[i] <= 58 && db === false) push("S2_MTF", i, "short");
    if (bull && rsi[i] >= 30 && rsi[i] <= 50 && db === true) push("S4_MTF", i, "long");
    if (bull && rsi[i] >= 38 && rsi[i] <= 52 && rising && Math.abs(px - e20[i]) / px < 0.025 && db === true) push("S7_MTF", i, "long");
    if (px > donHi && volR > 1.3 && db === true) push("S8_MTF", i, "long");
    if (px < donLo && volR > 1.3 && db === false) push("S8_MTF", i, "short");
    // ==== SPRINT #2 (10.06, idées the maintainer) : S/R & breakout PAR TENDANCE — recherche, pas live ====
    // S10 breakdown-RETEST : on ne court PAS après la cassure (S8 market = artefact + taker) ;
    // on attend le RETEST du niveau cassé (support devenu résistance) = entrée LIMIT/maker.
    if (px < donLo) { s10BkdnI = i; s10BkdnLvl = donLo; }
    if (px > donHi) { s10BkupI = i; s10BkupLvl = donHi; }
    if (db === false && s10BkdnLvl != null && i - s10BkdnI >= 1 && i - s10BkdnI <= 5 &&
        Math.abs(H[i] - s10BkdnLvl) <= 0.5 * atr[i] && px < s10BkdnLvl && C[i] < O[i])
      push("S10_breakdown_retest", i, "short");
    if (db === true && s10BkupLvl != null && i - s10BkupI >= 1 && i - s10BkupI <= 5 &&
        Math.abs(L[i] - s10BkupLvl) <= 0.5 * atr[i] && px > s10BkupLvl && C[i] > O[i])
      push("S10_breakdown_retest", i, "long");
    // S1_deep : short du rebond PROFOND à l'EMA50 4H (résistance majeure) — l'ancre EMA20 = S1,
    // le touch superficiel = TR1 (toxique) ; ici rallye fort (RSI>45) à la grosse résistance.
    if (bear && db === false && Math.abs(px - e50[i]) / px < 0.02 && rsi[i] > 45)
      push("S1_deep_ema50", i, "short");
    // S2_long : miroir de S2 (validé 10.06 en trending) — pullback en tendance HAUSSIÈRE alignée.
    if (bull && db === true && rsi[i] >= 42 && rsi[i] <= 60)
      push("S2_long_continuation", i, "long");
    // ==== SPRINT #4 (10.06 ~02h15, mécanismes générés par /edge-sprint Phase 2) ====
    // S11 sweep-trap : mèche qui balaie le swing 12 barres puis close qui RETOMBE de l'autre
    // côté du niveau = fakeout piégé. Aligné daily (short en bear sur sweep du high, miroir long).
    let swHi = -Infinity, swLo = Infinity;
    for (let j = i - 12; j < i; j++) { if (H[j] > swHi) swHi = H[j]; if (L[j] < swLo) swLo = L[j]; }
    if (db === false && H[i] > swHi && C[i] < swHi && C[i] < O[i]) push("S11_sweep_trap", i, "short");
    if (db === true && L[i] < swLo && C[i] > swLo && C[i] > O[i]) push("S11_sweep_trap", i, "long");
    // S12 squeeze->expansion : largeur BB (à i-1) dans le quintile BAS des 40 barres précédentes,
    // puis cassure du micro-range 10 barres dans le sens daily (résolution de compression).
    const bPrev = bbAt(C, i - 1);
    if (bPrev) {
      const wPrev = (bPrev.u - bPrev.l) / C[i - 1];
      let narrower = 0, totW = 0;
      for (let j = i - 41; j < i - 1; j++) {
        const b = bbAt(C, j); if (!b) continue;
        totW++; if ((b.u - b.l) / C[j] < wPrev) narrower++;
      }
      const squeezed = totW >= 30 && narrower / totW <= 0.2;
      let m10Hi = -Infinity, m10Lo = Infinity;
      for (let j = i - 10; j < i; j++) { if (H[j] > m10Hi) m10Hi = H[j]; if (L[j] < m10Lo) m10Lo = L[j]; }
      if (squeezed && db === false && C[i] < m10Lo) push("S12_squeeze_break", i, "short");
      if (squeezed && db === true && C[i] > m10Hi) push("S12_squeeze_break", i, "long");
    }
    // S13 vwap-band-fade : VWAP roulant 24 barres ±2σ (pondéré volume), fade ALIGNÉ daily
    // (en bear : touch bande haute -> short limit ; miroir bull bande basse). Mécanisme du /14
    // live (Desktop) jamais transposé au backtest.
    let pv = 0, vv = 0;
    for (let j = i - 23; j <= i; j++) { const tp = (H[j] + L[j] + C[j]) / 3; pv += tp * (V[j] || 0); vv += V[j] || 0; }
    if (vv > 0) {
      const vw = pv / vv;
      let s2 = 0; for (let j = i - 23; j <= i; j++) { const tp = (H[j] + L[j] + C[j]) / 3; s2 += (tp - vw) * (tp - vw) * (V[j] || 0); }
      const sd = Math.sqrt(s2 / vv);
      if (sd > 0) {
        if (db === false && H[i] >= vw + 2 * sd && C[i] < vw + 2 * sd) push("S13_vwap_band_fade", i, "short");
        if (db === true && L[i] <= vw - 2 * sd && C[i] > vw - 2 * sd) push("S13_vwap_band_fade", i, "long");
      }
    }
    // ==== 1W (Weekly macro) : seul, et triple-screen Daily+Weekly ====
    const wb = wBull ? wBull[i] : null;
    if (srsi < 0.15 && wb === true) push("MR8_W", i, "long");
    if (srsi > 0.85 && wb === false) push("MR8_W", i, "short");
    if (srsi < 0.15 && db === true && wb === true) push("MR8_DW", i, "long");
    if (srsi > 0.85 && db === false && wb === false) push("MR8_DW", i, "short");
    if (range && px >= bbv.u && rsi[i] > 60 && stochK > 75 && wb === false) push("S5_W", i, "short");
    if (range && px <= bbv.l && rsi[i] < 40 && stochK < 25 && wb === true) push("S5_W", i, "long");
    if (range && px >= bbv.u && rsi[i] > 60 && stochK > 75 && db === false && wb === false) push("S5_DW", i, "short");
    if (range && px <= bbv.l && rsi[i] < 40 && stochK < 25 && db === true && wb === true) push("S5_DW", i, "long");
  }
  return { sigs, H, L, C };
}

// simule une sortie pour une config donnée -> R (vs risque initial)
function sim(side, entry, atr, H, L, C, i, cfg, e20) {
  let stop = side === "long" ? entry - cfg.sl * atr : entry + cfg.sl * atr;
  const tp = cfg.tp >= 99 ? null : (side === "long" ? entry + cfg.tp * atr : entry - cfg.tp * atr);
  const risk = Math.abs(entry - stop); if (!risk) return 0;
  const feeR = (2 * FEE * entry) / risk; // frais round-trip en R -> soustraits du resultat (edge NET)
  let be = false, rawR = null; const end = Math.min(C.length - 1, i + MAX_HOLD);
  for (let j = i + 1; j <= end; j++) {
    const hi = H[j], lo = L[j];
    // CUT ANTICIPE (sprint hold-vs-cut 15.06) : adverse-first, AVANT le SL (meme convention).
    if (CUT_R > 0) {
      const adv = side === "long" ? (entry - lo) : (hi - entry);  // excursion adverse en prix
      if (adv >= CUT_R * risk) { rawR = -CUT_R; break; }
    }
    if (CUT_FLIP && e20 && e20[j] != null) {                       // reclaim/perte de l'EMA20 (flip)
      if (side === "short" && C[j] > e20[j]) { rawR = (entry - C[j]) / risk; break; }
      if (side === "long" && C[j] < e20[j]) { rawR = (C[j] - entry) / risk; break; }
    }
    if (side === "long") {
      if (lo <= stop) { rawR = (stop - entry) / risk; break; }
      if (tp && hi >= tp) { rawR = (tp - entry) / risk; break; }
      if (cfg.be && !be && hi >= entry + risk) { if (entry > stop) stop = entry; be = true; }
      if (cfg.trail > 0) { const t = hi - cfg.trail * atr; if (t > stop) stop = t; }
    } else {
      if (hi >= stop) { rawR = (entry - stop) / risk; break; }
      if (tp && lo <= tp) { rawR = (entry - tp) / risk; break; }
      if (cfg.be && !be && lo <= entry - risk) { if (entry < stop) stop = entry; be = true; }
      if (cfg.trail > 0) { const t = lo + cfg.trail * atr; if (t < stop) stop = t; }
    }
  }
  if (rawR === null) { const exit = C[end]; rawR = (side === "long" ? exit - entry : entry - exit) / risk; }
  return rawR - feeR; // edge NET de frais
}

async function run() {
  const c = new ccxt.bybit({ enableRateLimit: true, options: { defaultType: "swap" } });
  await c.loadMarkets();
  // MACRO (H2) : ADX + biais EMA200 DAILY de BTC, fetchés UNE fois — chaque signal de chaque
  // paire sera taggé par le régime macro au moment du signal (sans lookahead, dernier jour clos).
  let btcTs = null, btcAdxArr = null, btcBullArr = null;
  try {
    const bOh = await c.fetchOHLCV("BTC/USDT:USDT", "1d", undefined, 400);
    if (bOh && bOh.length > 50) {
      const bC = bOh.map((x) => x[4]), bE = emaS(bC, 200);
      btcTs = bOh.map((x) => x[0]);
      btcAdxArr = adxS(bOh.map((x) => x[2]), bOh.map((x) => x[3]), bC, 14).adx;
      btcBullArr = bC.map((v, i) => v > bE[i]);
    }
  } catch (e) { btcTs = null; }
  const macroIdxAt = (t) => { if (!btcTs) return -1; let k = -1; for (let j = 0; j < btcTs.length; j++) { if (btcTs[j] < t) k = j; else break; } return k; };
  const allSigs = {}; let pairsOk = 0;
  for (const s of PAIRS) {
    let oh; try { oh = DEEP_DAYS > 0 ? await fetchDeep(c, s + "/USDT:USDT", TF, DEEP_DAYS) : await c.fetchOHLCV(s + "/USDT:USDT", TF, undefined, 1000); } catch (e) { continue; }
    if (!oh || oh.length < 260) continue; pairsOk++;
    const O = oh.map((x) => x[1]), H = oh.map((x) => x[2]), L = oh.map((x) => x[3]), C = oh.map((x) => x[4]), V = oh.map((x) => x[5]);
    // DAILY (timeframe superieur) pour l'alignement MTF — biais = close > EMA200 daily, sans lookahead
    // + ADX DAILY mappé sur les barres 4H -> régime de chaque signal (split par régime, piste 5a).
    let dBull = null, dAdx = null, dBull50 = null;
    try {
      const dOh = await c.fetchOHLCV(s + "/USDT:USDT", "1d", undefined, 400);
      if (dOh && dOh.length > 50) {
        const dC = dOh.map((x) => x[4]), dTs = dOh.map((x) => x[0]), dE = emaS(dC, 200), dE50 = emaS(dC, 50);
        const dAdxArr = adxS(dOh.map((x) => x[2]), dOh.map((x) => x[3]), dC, 14).adx;
        const idxAt = (t) => { let k = -1; for (let j = 0; j < dTs.length; j++) { if (dTs[j] < t) k = j; else break; } return k; }; // dernier jour CLOS avant la barre (sans lookahead)
        dBull = oh.map((bar) => { const k = idxAt(bar[0]); return k >= 0 ? dC[k] > dE[k] : null; });
        dBull50 = oh.map((bar) => { const k = idxAt(bar[0]); return k >= 0 ? dC[k] > dE50[k] : null; }); // gate daily RAPIDE (EMA50d) — sprint 15.06
        dAdx = oh.map((bar) => { const k = idxAt(bar[0]); return k >= 0 ? dAdxArr[k] : null; });
      }
    } catch (e) { dBull = null; dAdx = null; dBull50 = null; }
    // WEEKLY (macro) : biais = close > EMA20 weekly, sans lookahead
    let wBull = null;
    try {
      const wOh = await c.fetchOHLCV(s + "/USDT:USDT", "1w", undefined, 300);
      if (wOh && wOh.length > 25) {
        const wC = wOh.map((x) => x[4]), wTs = wOh.map((x) => x[0]), wE = emaS(wC, 20);
        wBull = oh.map((bar) => { const t = bar[0]; let k = -1; for (let j = 0; j < wTs.length; j++) { if (wTs[j] < t) k = j; else break; } return k >= 0 ? wC[k] > wE[k] : null; });
      }
    } catch (e) { wBull = null; }
    // Mapping macro BTC -> barres 4H de CETTE paire (même pattern sans-lookahead que dBull/wBull).
    const mAdx = btcTs ? oh.map((bar) => { const k = macroIdxAt(bar[0]); return k >= 0 ? btcAdxArr[k] : null; }) : null;
    const mBull = btcTs ? oh.map((bar) => { const k = macroIdxAt(bar[0]); return k >= 0 ? btcBullArr[k] : null; }) : null;
    const { sigs } = detect(O, H, L, C, V, dBull, wBull, dAdx, mAdx, mBull, mulberry32(strSeed(s + "|" + TF)), dBull50);
    const e20arr = emaS(C, 20);   // EMA20 4H pour la politique cut_flip (sprint hold-vs-cut)
    for (const [setup, list] of Object.entries(sigs)) {
      allSigs[setup] = allSigs[setup] || [];
      for (const sg of list) allSigs[setup].push({ ...sg, H, L, C, e20: e20arr });
    }
  }
  const WR_FLOOR = process.env.OPT_WR_FLOOR != null ? +process.env.OPT_WR_FLOOR : 45; // sprint hold-vs-cut: =0 pour comparer l'exp pure des politiques (le cut baisse le WR)
  const evalSet = (cfg, set) => { if (!set.length) return { exp: 0, wr: 0, n: 0 }; let R = 0, w = 0; for (const sg of set) { const r = sim(sg.side, sg.entry, sg.atr, sg.H, sg.L, sg.C, sg.i, cfg, sg.e20); R += r; if (r > 0) w++; } return { exp: R / set.length, wr: w / set.length * 100, n: set.length }; };
  // evalR : meme sim mais retourne la SERIE de R (pour Sharpe/DSR/bootstrap, #1). optimizeCfg : le
  // sweep SL×TP×trail×be extrait (reutilise par CPCV qui RE-optimise par fold = anti-leakage rigoureux).
  const evalR = (cfg, set) => { const rs = []; for (const sg of set) rs.push(sim(sg.side, sg.entry, sg.atr, sg.H, sg.L, sg.C, sg.i, cfg, sg.e20)); return rs; };
  const optimizeCfg = (set) => { let best = null, bestCfg = null; for (const sl of SLs) for (const tp of TPs) for (const trail of TRAILs) for (const be of BEs) { const cfg = { sl, tp, trail, be }; const r = evalSet(cfg, set); if (r.wr >= WR_FLOOR && (!best || r.exp > best.exp)) { best = r; bestCfg = cfg; } } return { best, bestCfg }; };
  const out = [];
  for (const [setup, sigs] of Object.entries(allSigs)) {
    const train = sigs.filter((s) => s.phase === "train"), test = sigs.filter((s) => s.phase === "test");
    if (train.length < 20 || test.length < 10) { out.push({ setup, signals: sigs.length, note: `n insuffisant (train ${train.length}/test ${test.length})` }); continue; }
    // optimise sur TRAIN : maximise expectancy PARMI les configs a WR>=45% (= gagnantes)
    let best = null, bestCfg = null;
    for (const sl of SLs) for (const tp of TPs) for (const trail of TRAILs) for (const be of BEs) {
      const cfg = { sl, tp, trail, be }; const r = evalSet(cfg, train);
      if (r.wr >= WR_FLOOR && (!best || r.exp > best.exp)) { best = r; bestCfg = cfg; }
    }
    if (!bestCfg) { out.push({ setup, signals: sigs.length, note: `aucune config WR>=${WR_FLOOR}% sur le train -> setup non gagnant (faible R:R intrinseque)` }); continue; }
    const oos = evalSet(bestCfg, test); // out-of-sample
    // ── RANDOM-CONTROL (10.06) : baseline random évaluée avec le bestCfg DU CANDIDAT, appariée
    // à son mix de sens. Un edge doit battre le random — sinon c'est le drift/les exits qui
    // gagnent, pas le timing d'entrée du setup.
    const rndTest = setup === "RANDOM_CONTROL" ? null : (allSigs.RANDOM_CONTROL || []).filter((x) => x.phase === "test");
    const randomControl = rndTest ? sideMatchedBaseline(test, rndTest, (set) => evalSet(bestCfg, set), MIN_N_BUCKET) : null;
    const beatsRandom = randomControl && randomControl.exp_matched != null ? oos.exp > randomControl.exp_matched : null;
    // robust exige AUSSI train>0 (fix 10.06 : S10 affichait "ROBUSTE" avec train -0.056R —
    // un setup négatif in-sample qui gagne out-of-sample = chance, pas un edge)
    // ET de battre le random-control quand il est mesurable (beats_random !== false).
    const robustBase = best.exp > 0 && oos.exp > 0.1 && oos.wr >= 40;
    const robust = robustBase && beatsRandom !== false;
    // ── Split par RÉGIME (piste 5a) : expectancy NET OOS du MÊME bestCfg, par bucket de
    // régime DAILY de la paire au signal. MESURE (on n'impose pas) : nos edges sont tous du
    // mean-reversion -> bleed-ils en STRONG_TREND ? Buckets sous MIN_N_BUCKET = "n faible".
    const byRegime = {};
    for (const bucket of ["range", "trending", "strong"]) {
      const set = test.filter((s) => s.regime === bucket);
      if (set.length >= MIN_N_BUCKET) { const r = evalSet(bestCfg, set); byRegime[bucket] = { n: r.n, exp: +r.exp.toFixed(3), wr: +r.wr.toFixed(1) }; }
      else if (set.length > 0) byRegime[bucket] = { n: set.length, note: "n faible" };
    }
    // Cohérence de bucket : même split sur le TRAIN (un bucket "edge" doit tenir des 2 côtés,
    // sinon c'est du cherry-pick de bucket sur le test).
    const byRegimeTrain = {};
    for (const bucket of ["range", "trending", "strong"]) {
      const set = train.filter((s) => s.regime === bucket);
      if (set.length >= MIN_N_BUCKET) { const r = evalSet(bestCfg, set); byRegimeTrain[bucket] = { n: r.n, exp: +r.exp.toFixed(3), wr: +r.wr.toFixed(1) }; }
      else if (set.length > 0) byRegimeTrain[bucket] = { n: set.length, note: "n faible" };
    }
    // H2 : split par ALIGNEMENT MACRO (BTC daily) sur les signaux pair-favorables (régime
    // paire != strong) — le gating macro bloque-t-il des trades qui gagnent, ou protège-t-il ?
    const byMacro = {};
    for (const bucket of ["strong_opposed", "strong_aligned", "calm"]) {
      const set = test.filter((s) => s.regime !== "strong" && s.malign === bucket);
      if (set.length >= MIN_N_BUCKET) { const r = evalSet(bestCfg, set); byMacro[bucket] = { n: r.n, exp: +r.exp.toFixed(3), wr: +r.wr.toFixed(1) }; }
      else if (set.length > 0) byMacro[bucket] = { n: set.length, note: "n faible" };
    }
    // ── #1 VALIDATION ROBUSTE (opt-in OPT_CPCV) : CPCV-light (re-optim par fold + embargo) +
    // Sharpe OOS + null block-bootstrap. La 2e passe (apres la boucle) ajoutera le Deflated Sharpe
    // (qui a besoin du nombre d'essais N et de la variance des Sharpes cross-setups).
    let cpcv = null;
    if (CPCV) {
      const NB = 6, blockOf = (s) => Math.min(NB - 1, Math.floor(NB * (s.pos || 0)));
      const testR = evalR(bestCfg, test);
      const folds = Vd.cpcvFolds(NB, 2, 1);
      const foldExp = [], foldSharpe = [];
      for (const f of folds) {
        const trSet = sigs.filter((s) => f.train.includes(blockOf(s)));
        const teSet = sigs.filter((s) => f.test.includes(blockOf(s)));
        if (trSet.length < 20 || teSet.length < 10) continue;
        const oc = optimizeCfg(trSet); if (!oc.bestCfg) continue;
        const rr = evalR(oc.bestCfg, teSet); if (rr.length < 10) continue;
        foldExp.push(Vd.mean(rr)); const sh = Vd.sharpe(rr); if (sh != null) foldSharpe.push(sh);
      }
      const med = (arr) => { if (!arr.length) return null; const a = arr.slice().sort((x, y) => x - y); const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
      const shOos = Vd.sharpe(testR);
      const bootP = testR.length >= 10 ? Vd.blockBootstrapPValue(testR, { blockLen: 5, draws: 1000, seed: setup }) : null;
      cpcv = {
        oos_sharpe: shOos != null ? +shOos.toFixed(3) : null,
        folds_evaluated: foldExp.length,
        folds_pos_frac: foldExp.length ? +(foldExp.filter((e) => e > 0).length / foldExp.length).toFixed(2) : null,
        cpcv_median_sharpe: med(foldSharpe) != null ? +med(foldSharpe).toFixed(3) : null,
        boot_p: bootP != null ? +bootP.toFixed(3) : null,
        _testR: testR, _skew: Vd.skewness(testR), _kurt: Vd.kurtosisRaw(testR),
      };
    }
    out.push({
      setup, signals: sigs.length,
      config_optimale: { sl: bestCfg.sl, tp: bestCfg.tp >= 99 ? "trail-only" : bestCfg.tp, trail: bestCfg.trail || "off", be: bestCfg.be },
      train: { n: best.n, exp: +best.exp.toFixed(3), wr: +best.wr.toFixed(1) },
      test_OOS: { n: oos.n, exp: +oos.exp.toFixed(3), wr: +oos.wr.toFixed(1) },
      test_by_regime: byRegime,
      train_by_regime: byRegimeTrain,
      test_by_macro_pairfav: byMacro,
      random_control: randomControl,
      beats_random: beatsRandom,
      ...(cpcv ? { cpcv } : {}),
      verdict: setup === "RANDOM_CONTROL" ? "🎲 baseline random (plancher de bruit du pipeline — si 'ROBUSTE', le harnais sur-fitte)"
        : robust ? "✅ ROBUSTE (gagnant in & out-of-sample, bat le random)"
        : robustBase && beatsRandom === false ? "⚠️ NE BAT PAS LE RANDOM (drift marché/exits, pas un edge de timing d'entrée)"
        : "⚠️ overfit (bon en train, échoue en test)"
    });
  }
  // ── #1 DEFLATED SHARPE (2e passe) : a besoin de N (nb de candidats testes) + var des Sharpes
  // cross-setups pour deflater le multiple-testing. Verdict_v2 durci = CPCV + DSR + bootstrap.
  if (CPCV) {
    // N HONNETE = vrais candidats (allowlist), pas les ~70 diagnostics (sinon DSR ecrase tout, leçon 16.06).
    const cands = out.filter((o) => o.cpcv && CANDIDATE.test(o.setup) && o.cpcv.oos_sharpe != null);
    const shs = cands.map((o) => o.cpcv.oos_sharpe);
    const nTrials = shs.length || 1, varTrials = shs.length > 1 ? Vd.std(shs) ** 2 : 0;
    for (const o of out) {
      if (!o.cpcv || o.cpcv.oos_sharpe == null) { if (o.cpcv) { delete o.cpcv._testR; delete o.cpcv._skew; delete o.cpcv._kurt; } continue; }
      o.cpcv.candidate = CANDIDATE.test(o.setup);
      const dsr = Vd.deflatedSharpe(o.cpcv.oos_sharpe, { nTrials, varTrials, skew: o.cpcv._skew, kurt: o.cpcv._kurt, n: o.cpcv._testR.length });
      o.cpcv.dsr = dsr != null ? +dsr.toFixed(3) : null;
      o.cpcv.dsr_nTrials = nTrials;
      o.cpcv.verdict_v2 = o.setup === "RANDOM_CONTROL" ? "baseline"
        : (o.cpcv.folds_pos_frac != null && o.cpcv.folds_pos_frac >= 0.5 && o.cpcv.dsr != null && o.cpcv.dsr >= 0.6 && o.cpcv.boot_p != null && o.cpcv.boot_p < 0.05)
          ? "✅ ROBUSTE_V2 (CPCV folds>=50% + DSR>=0.6 + bootstrap p<0.05)"
          : "⚠️ FRAGILE_V2 (echoue CPCV/DSR/bootstrap — possible bruit, cf. O6)";
      delete o.cpcv._testR; delete o.cpcv._skew; delete o.cpcv._kurt;
    }
  }
  out.sort((a, b) => (b.test_OOS ? b.test_OOS.exp : -9) - (a.test_OOS ? a.test_OOS.exp : -9));
  return { pairs: pairsOk, periode: `${DEEP_DAYS > 0 ? "~" + DEEP_DAYS + "j (OPT_DEEP)" : "~1000 bougies"} ${TF} (train 62% / test 38% OOS)${CPCV ? " + CPCV/DSR/bootstrap (#1)" : ""}`, objectif: `WR>=${WR_FLOOR}% + expectancy>0, valide hors-echantillon`, setups: out };
}

if (require.main === module) {
  run().then((r) => console.log(JSON.stringify(r, null, 2))).catch((e) => { console.error(e.message, e.stack); process.exit(1); });
}
module.exports = run;
// Helpers purs exposés pour les tests offline (random-control)
module.exports.mulberry32 = mulberry32;
module.exports.strSeed = strSeed;
module.exports.sideMatchedBaseline = sideMatchedBaseline;
