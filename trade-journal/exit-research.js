"use strict";

// ── exit-research.js — Harnais de recherche SORTIE MULTI-PALIERS (29.06) ─────────────────
// RECHERCHE OFFLINE, ZÉRO IMPACT LIVE. Pré-enregistré : docs/plans/2026-06-29-tp1-utile-exit-design.md
//
// optimize.js / backtest.js simulent un exit SINGLE-LEG. L'agent live utilise un scale-out
// 3-paliers (quick/main/runner) + BE. Ce harnais simule fidèlement le multi-leg pour COMPARER
// des POLITIQUES DE SORTIE sur les MÊMES entrées (familles fade qui passent par placement.js).
//
// Réutilise detect() + le chargement MTF + fetchDeep/emaS/adxS d'optimize.js (exposés en additif)
// et regimeBucket d'edge-watch.js. Le juge = cohérence train/test du classement des politiques vs P0.
//
// Usage : OPT_DEEP_DAYS=180 node trade-journal/exit-research.js > optimize-history/research/2026-06-29-agent4h-exit.json
//   OPT_WATCHLIST=BTC,ETH,SOL  (itérer vite)   ·   OPT_TF=4h (défaut)

const path = require("path");
const bybitDir = path.join(__dirname, "..", "skills", "bybit");
require(path.join(bybitDir, "index.js"));
const ccxt = require(require.resolve("ccxt", { paths: [bybitDir] }));
const { regimeBucket } = require("./edge-watch.js");
const U = require("./universe.js");
const opt = require("./optimize.js");
const { detect, fetchDeep, emaS, adxS, MAX_HOLD } = opt;

const PAIRS = process.env.OPT_WATCHLIST
  ? process.env.OPT_WATCHLIST.split(",").map((s) => s.trim()).filter(Boolean)
  : U.enabledSymbols();
const TF = process.env.OPT_TF || "4h";
const DEEP_DAYS = +(process.env.OPT_DEEP_DAYS || 0);
const FEE = parseFloat(process.env.OPT_FEE_PCT || "0.055") / 100; // taker round-trip -> NET
const SL_ATR = parseFloat(process.env.OPT_SL_ATR || "1.5");       // SL FIXE (isole l'effet sortie)
const MINN_BUCKET = +(process.env.OPT_MINN_BUCKET || 30);
const MAXH = +(process.env.OPT_MAXHOLD || MAX_HOLD); // cap de hold par défaut (barres) ; sweepé dans le bloc time-stop

// Familles qui passent par le placement multi-leg. EXIT_SCOPE cible un sous-ensemble
// (ex. "^(MR8|S5)" = mean-reversion pure = les vraies fades de range qui scratchent).
const FADE_RE = new RegExp(process.env.EXIT_SCOPE || "^(MR8|S1_short|S2_short|S5|S3_long_oversold|S12)");

// ── Simulateur d'exit MULTI-LEG ──────────────────────────────────────────────────────────
// policy.legs = [{frac, R?|atr?, trail?}]  (R = distance en R ; atr = distance en xATR ; trail = chandelier xATR)
// policy.be  = 'after_tp1' | 'after_main' | 'partial'   (partial = SL à entrée - 0.3R après TP1)
// Retourne le R NET pondéré par fracs (− frais round-trip), ou null si invalide.
// maxHold (barres) : cap de durée -> clôture forcée (time-stop). Défaut = MAXH (env OPT_MAXHOLD ou 60).
// meta (optionnel) : rempli avec { bars } = durée en barres jusqu'à la sortie (pour le sweep time-stop).
function simMultiLeg(side, entry, atr, H, L, C, i, policy, maxHold, meta) {
  if (!atr || !isFinite(atr) || atr <= 0) return null;
  const dir = side === "long" ? 1 : -1;
  let stop = entry - dir * SL_ATR * atr;
  const risk = Math.abs(entry - stop);
  if (!risk) return null;
  const feeR = (2 * FEE * entry) / risk; // notional tourné = 2× plein (entrée + sorties=1) -> indépendant du nb de legs
  const legs = policy.legs.map((lg) => {
    let dist = lg.R != null ? lg.R * risk : (lg.atr != null ? lg.atr * atr : null);
    return { frac: lg.frac, tp: dist != null ? entry + dir * dist : null, trail: lg.trail || 0, filled: false };
  });
  const QUICK = 0, MAIN = 1, RUN = 2;
  let be = false, remaining = 1, realized = 0;
  const end = Math.min(C.length - 1, i + (maxHold || MAXH));
  let exitBar = end;
  for (let j = i + 1; j <= end; j++) {
    const hi = H[j], lo = L[j];
    // 1) SL sur le reliquat — adverse-first (convention sim() : SL avant TP dans la même barre)
    const slHit = side === "long" ? lo <= stop : hi >= stop;
    if (slHit) { realized += remaining * (dir * (stop - entry) / risk); remaining = 0; exitBar = j; break; }
    // 2) remplissage des paliers dans l'ordre (quick < main < runner par construction)
    for (const leg of legs) {
      if (leg.filled || leg.tp == null) continue;
      const tpHit = side === "long" ? hi >= leg.tp : lo <= leg.tp;
      if (tpHit) { leg.filled = true; realized += leg.frac * (dir * (leg.tp - entry) / risk); remaining -= leg.frac; }
    }
    // 3) politique BE
    if (!be) {
      if (policy.be === "after_tp1" && legs[QUICK] && legs[QUICK].filled) { stop = entry; be = true; }
      else if (policy.be === "after_main" && legs[MAIN] && legs[MAIN].filled) { stop = entry; be = true; }
      else if (policy.be === "partial" && legs[QUICK] && legs[QUICK].filled) { stop = entry - dir * 0.3 * risk; be = true; }
    }
    // 4) trailing chandelier du runner (resserre uniquement)
    const tr = legs[RUN] && legs[RUN].trail > 0 ? legs[RUN].trail : 0;
    if (tr > 0) { const t = side === "long" ? hi - tr * atr : lo + tr * atr; if (side === "long" ? t > stop : t < stop) stop = t; }
    if (remaining <= 1e-9) { exitBar = j; break; }
  }
  if (remaining > 1e-9) { const exit = C[end]; realized += remaining * (dir * (exit - entry) / risk); } // time-stop : clôture au close de la barre cap
  if (meta) meta.bars = exitBar - i;
  return realized - feeR;
}

// ── Politiques pré-enregistrées (cf. design doc §3) ───────────────────────────────────────
const POLICIES = {
  P0_baseline:   { be: "after_tp1",  legs: [{ frac: 0.20, atr: 0.2 }, { frac: 0.50, atr: 2.0 }, { frac: 0.30, atr: 3.0 }] },
  P1_tp1_utile:  { be: "after_tp1",  legs: [{ frac: 0.30, R: 0.3 },   { frac: 0.40, atr: 1.6 }, { frac: 0.30, atr: 3.0 }] },
  P2_laisser_courir: { be: "after_main", legs: [{ frac: 0.30, R: 0.3 }, { frac: 0.40, atr: 1.6 }, { frac: 0.30, trail: 2.5 }] },
  P3_be_partiel: { be: "partial",    legs: [{ frac: 0.30, R: 0.3 },   { frac: 0.40, atr: 1.6 }, { frac: 0.30, atr: 3.0 }] },
  // Sensibilité MIN_R (variantes de P1)
  P1b_minR_0p25: { be: "after_tp1",  legs: [{ frac: 0.30, R: 0.25 },  { frac: 0.40, atr: 1.6 }, { frac: 0.30, atr: 3.0 }] },
  P1c_minR_0p40: { be: "after_tp1",  legs: [{ frac: 0.30, R: 0.40 },  { frac: 0.40, atr: 1.6 }, { frac: 0.30, atr: 3.0 }] },
  // Sprint « moins de paliers » (fragmentation Bybit) : 2 paliers / 1 palier vs P0 (3 paliers).
  A2_drop_quick: { legs_nominal: 2, be: "after_tp1", legs: [{ frac: 0.60, atr: 1.6 }, { frac: 0.40, atr: 3.0 }] },
  A2b_half_1R:   { legs_nominal: 2, be: "after_tp1", legs: [{ frac: 0.50, R: 1.0 },   { frac: 0.50, atr: 3.0 }] },
  A1_single:     { legs_nominal: 1, be: "after_tp1", legs: [{ frac: 1.0,  atr: 2.0 }] },
  // Sprint TP PAR STRATÉGIE : haut-WR (mean-rev) + tendance (laisser courir).
  HW_highwr:     { legs_nominal: 2, be: "after_tp1", legs: [{ frac: 0.70, R: 1.0 },   { frac: 0.30, atr: 2.0 }] },
  TRtrail:       { legs_nominal: 2, be: "after_tp1", legs: [{ frac: 0.40, atr: 1.5 }, { frac: 0.60, trail: 2.5 }] },
  TRfar:         { legs_nominal: 2, be: "after_tp1", legs: [{ frac: 0.40, atr: 1.5 }, { frac: 0.60, atr: 4.0 }] },
};

// Famille de stratégie depuis le nom de setup (pour le breakdown by_setup). MR = mean-reversion.
function familyOf(setup) {
  const s = String(setup || "");
  if (/^MR8/.test(s)) return "MR8";
  if (/^S5/.test(s)) return "S5";
  if (/^S3/.test(s)) return "S3";
  if (/^S12/.test(s)) return "S12";
  if (/^S1_short/.test(s)) return "S1";
  if (/^S2_short/.test(s)) return "S2";
  return "autre";
}

function stats(rs) {
  if (!rs.length) return null;
  const n = rs.length, sum = rs.reduce((a, b) => a + b, 0);
  const wins = rs.filter((r) => r > 0), losses = rs.filter((r) => r <= 0);
  const scratch = rs.filter((r) => r > 0 && r < 0.1); // les "1-3 USDT" à tuer
  return {
    n, exp: +(sum / n).toFixed(4),
    wr: +(wins.length / n * 100).toFixed(1),
    avgWin: wins.length ? +(wins.reduce((a, b) => a + b, 0) / wins.length).toFixed(3) : 0,
    avgLoss: losses.length ? +(losses.reduce((a, b) => a + b, 0) / losses.length).toFixed(3) : 0,
    scratchRate: +(scratch.length / n * 100).toFixed(1),
    worst: +Math.min(...rs).toFixed(2),
  };
}

async function run() {
  const c = new ccxt.bybit({ enableRateLimit: true, options: { defaultType: "swap" } });
  await c.loadMarkets();
  // MACRO BTC daily (ADX + EMA200) — comme optimize.js run()
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

  const sigsAll = []; let pairsOk = 0;
  for (const s of PAIRS) {
    let oh; try { oh = DEEP_DAYS > 0 ? await fetchDeep(c, s + "/USDT:USDT", TF, DEEP_DAYS) : await c.fetchOHLCV(s + "/USDT:USDT", TF, undefined, 1000); } catch (e) { continue; }
    if (!oh || oh.length < 260) continue; pairsOk++;
    const O = oh.map((x) => x[1]), H = oh.map((x) => x[2]), L = oh.map((x) => x[3]), C = oh.map((x) => x[4]), V = oh.map((x) => x[5]);
    const idxBuilder = (TsArr) => (t) => { let k = -1; for (let j = 0; j < TsArr.length; j++) { if (TsArr[j] < t) k = j; else break; } return k; };
    let dBull = null, dAdx = null, dBull50 = null, dGold = null, dAdxUp = null;
    try {
      const dOh = await c.fetchOHLCV(s + "/USDT:USDT", "1d", undefined, 400);
      if (dOh && dOh.length > 50) {
        const dC = dOh.map((x) => x[4]), dTs = dOh.map((x) => x[0]), dE = emaS(dC, 200), dE50 = emaS(dC, 50);
        const dAdxArr = adxS(dOh.map((x) => x[2]), dOh.map((x) => x[3]), dC, 14).adx;
        const at = idxBuilder(dTs);
        dBull = oh.map((b) => { const k = at(b[0]); return k >= 0 ? dC[k] > dE[k] : null; });
        dBull50 = oh.map((b) => { const k = at(b[0]); return k >= 0 ? dC[k] > dE50[k] : null; });
        dAdx = oh.map((b) => { const k = at(b[0]); return k >= 0 ? dAdxArr[k] : null; });
        dGold = oh.map((b) => { const k = at(b[0]); return k >= 0 ? dE50[k] > dE[k] : null; });
        dAdxUp = oh.map((b) => { const k = at(b[0]); return k >= 1 ? dAdxArr[k] > dAdxArr[k - 1] : null; });
      }
    } catch (e) {}
    let wBull = null;
    try {
      const wOh = await c.fetchOHLCV(s + "/USDT:USDT", "1w", undefined, 300);
      if (wOh && wOh.length > 25) { const wC = wOh.map((x) => x[4]), wTs = wOh.map((x) => x[0]), wE = emaS(wC, 20); const at = idxBuilder(wTs); wBull = oh.map((b) => { const k = at(b[0]); return k >= 0 ? wC[k] > wE[k] : null; }); }
    } catch (e) {}
    const mAdx = btcTs ? oh.map((b) => { const k = macroIdxAt(b[0]); return k >= 0 ? btcAdxArr[k] : null; }) : null;
    const mBull = btcTs ? oh.map((b) => { const k = macroIdxAt(b[0]); return k >= 0 ? btcBullArr[k] : null; }) : null;
    const { sigs } = detect(O, H, L, C, V, dBull, wBull, dAdx, mAdx, mBull, opt.mulberry32(opt.strSeed(s + "|" + TF)), dBull50, dGold, dAdxUp);
    // BB20 mid (SMA20 close) = cible de réversion -> place jusqu'à la moyenne (sans lookahead, barre i close)
    const mid20 = C.map((_, i) => { if (i < 19) return null; let s = 0; for (let j = i - 19; j <= i; j++) s += C[j]; return s / 20; });
    for (const [setup, list] of Object.entries(sigs)) {
      if (!FADE_RE.test(setup)) continue; // périmètre : familles fade multi-leg
      for (const sg of list) {
        const mid = mid20[sg.i], risk = SL_ATR * sg.atr;
        // roomR = place vers la moyenne dans le SENS du profit, en R (négatif si la moyenne est déjà dépassée)
        const room = mid != null ? (sg.side === "short" ? sg.entry - mid : mid - sg.entry) : null;
        const roomR = (mid != null && risk > 0) ? room / risk : null;
        sigsAll.push({ ...sg, setup, H, L, C, roomR });
      }
    }
  }

  // Évalue chaque politique sur l'ensemble + par phase + par bucket régime
  const result = { meta: { date: new Date().toISOString().slice(0, 10), tf: TF, deep_days: DEEP_DAYS, pairs_ok: pairsOk, sl_atr: SL_ATR, fee_pct: FEE * 100, n_signals: sigsAll.length, scope: "fade-families " + FADE_RE.source }, policies: {} };
  for (const [name, pol] of Object.entries(POLICIES)) {
    const byTrain = [], byTest = [], buckets = {}, trBuckets = {};
    for (const sg of sigsAll) {
      const r = simMultiLeg(sg.side, sg.entry, sg.atr, sg.H, sg.L, sg.C, sg.i, pol);
      if (r == null) continue;
      const b = sg.regime || "?";
      if (sg.phase === "test") { byTest.push(r); (buckets[b] = buckets[b] || []).push(r); }
      else { byTrain.push(r); (trBuckets[b] = trBuckets[b] || []).push(r); }
    }
    const bs = {}, tbs = {};
    for (const [b, rs] of Object.entries(buckets)) { if (rs.length >= MINN_BUCKET) bs[b] = stats(rs); }
    for (const [b, rs] of Object.entries(trBuckets)) { if (rs.length >= MINN_BUCKET) tbs[b] = stats(rs); }
    result.policies[name] = { train: stats(byTrain), test: stats(byTest), test_buckets: bs, train_buckets: tbs };
  }

  // ── SPRINT ENTRÉE : plancher d'expectancy (gate roomR), exit P0 fixe ──────────────────────
  // Pré-enregistré docs/plans/2026-06-29-entry-ev-floor-design.md. On filtre les signaux par
  // roomR >= θ puis on évalue l'exit P0 sur la cohorte gardée (train/test) + rétention.
  const P0 = POLICIES.P0_baseline;
  const withRoom = sigsAll.filter((sg) => sg.roomR != null);
  const evalGate = (theta, phase) => {
    const set = withRoom.filter((sg) => sg.phase === phase && sg.roomR >= theta);
    const rs = [];
    for (const sg of set) { const r = simMultiLeg(sg.side, sg.entry, sg.atr, sg.H, sg.L, sg.C, sg.i, P0); if (r != null) rs.push(r); }
    return rs;
  };
  const baseN = { train: withRoom.filter((s) => s.phase === "train").length, test: withRoom.filter((s) => s.phase === "test").length };
  result.ev_floor = { meta: { target: "BB20_mid", exit: "P0_baseline", base_n: baseN }, thresholds: {} };
  for (const theta of [0, 0.5, 0.75, 1.0, 1.25]) {
    const tr = evalGate(theta, "train"), te = evalGate(theta, "test");
    result.ev_floor.thresholds["theta_" + theta] = {
      train: stats(tr), test: stats(te),
      retention_test: baseN.test ? +(te.length / baseN.test * 100).toFixed(1) : 0,
      retention_train: baseN.train ? +(tr.length / baseN.train * 100).toFixed(1) : 0,
    };
  }

  // ── TP PAR STRATÉGIE : chaque politique évaluée PAR FAMILLE de setup (train/test) ─────────
  // Pré-enregistré docs/plans/2026-06-29-tp-par-strategie-design.md. Le profil TP optimal diffère
  // par archétype (mean-rev banque tôt / tendance laisse courir).
  const families = {};
  for (const sg of sigsAll) { const f = familyOf(sg.setup); (families[f] = families[f] || []).push(sg); }
  result.by_setup = {};
  for (const [fam, sigs] of Object.entries(families)) {
    const tr0 = sigs.filter((s) => s.phase === "train"), te0 = sigs.filter((s) => s.phase === "test");
    if (te0.length < MINN_BUCKET) continue; // famille trop rare en test
    const perPol = {};
    for (const [name, pol] of Object.entries(POLICIES)) {
      const ev = (set) => { const rs = []; for (const sg of set) { const r = simMultiLeg(sg.side, sg.entry, sg.atr, sg.H, sg.L, sg.C, sg.i, pol); if (r != null) rs.push(r); } return rs; };
      perPol[name] = { train: stats(ev(tr0)), test: stats(ev(te0)) };
    }
    result.by_setup[fam] = { n_train: tr0.length, n_test: te0.length, policies: perPol };
  }

  // ── TIME-STOP : sweep du cap de hold (barres) PAR FAMILLE, sur la politique retenue ───────
  // Pré-enregistré docs/plans/2026-06-29-time-stop-design.md. mean-rev -> A2 ; tendance -> P0.
  // Référence = 60 barres (MAX_HOLD actuel). Reporte exp train/test + duree moyenne (barres).
  const POL_BY_FAM = { MR8: "A2_drop_quick", S5: "A2_drop_quick", S3: "A2_drop_quick", S1: "P0_baseline", S2: "P0_baseline", S12: "P0_baseline" };
  const CAPS = [12, 18, 24, 36, 48, 60];
  result.time_stop = { caps_bars: CAPS, note: "4H : 12/18/24/36/48/60 barres = 2/3/4/6/8/10 jours", by_setup: {} };
  for (const [fam, sigs] of Object.entries(families)) {
    const polName = POL_BY_FAM[fam]; if (!polName) continue;
    const pol = POLICIES[polName];
    const te0 = sigs.filter((s) => s.phase === "test"), tr0 = sigs.filter((s) => s.phase === "train");
    if (te0.length < MINN_BUCKET) continue;
    const evalCap = (set, cap) => {
      const rs = [], durs = [];
      for (const sg of set) { const meta = {}; const r = simMultiLeg(sg.side, sg.entry, sg.atr, sg.H, sg.L, sg.C, sg.i, pol, cap, meta); if (r != null) { rs.push(r); durs.push(meta.bars); } }
      const st = stats(rs); if (st) st.avg_bars = durs.length ? +(durs.reduce((a, b) => a + b, 0) / durs.length).toFixed(1) : null;
      return st;
    };
    const caps = {};
    for (const cap of CAPS) caps["cap_" + cap] = { train: evalCap(tr0, cap), test: evalCap(te0, cap) };
    result.time_stop.by_setup[fam] = { policy: polName, n_test: te0.length, caps };
  }
  return result;
}

if (require.main === module) {
  run().then((r) => console.log(JSON.stringify(r, null, 2))).catch((e) => { console.error(e.message, e.stack); process.exit(1); });
}
module.exports = { simMultiLeg, POLICIES, stats };
