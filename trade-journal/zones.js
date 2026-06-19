"use strict";
// zones.js — DETECTEUR de zones techniques PUR depuis l'OHLCV (Phase 3, master plan 2026-06-18).
// Produit le bloc `zones[]` du contrat docs/SCHEMA-market-state.md. 100% deterministe, zero reseau.
// DIFF avec scalp/zones.js (qui CONSOMME des zones Desktop) : ici on les DETECTE depuis les barres,
// car le Desktop est en fallback 43% du temps (audit 18.06). Convergera avec le Desktop en confluence.
//
// Types : support/resistance (swings), flip, fvg, order_block, eqh/eql (liquidite), vwap,
// pdh/pdl/pwh/pwl (periodes precedentes), hvn/lvn (volume profile approx).
// Chaque zone = { type, tf, lo, hi, mid, status, touches, freshness, strength, dist_atr, confluence[] }.

const { swings, cols } = require("./structure.js");

const DEF = { pivotK: 2, lookback: 120, fvgLookback: 60, eqTolAtr: 0.25, srClusterAtr: 0.5, vpBins: 24, maxZones: 14 };
function cfg(c) { return { ...DEF, ...(c || {}) }; }
function band(lo, hi) { lo = +lo; hi = +hi; if (lo > hi) { const t = lo; lo = hi; hi = t; } return { lo, hi, mid: +((lo + hi) / 2) }; }

// touches : nb de barres dont la meche entre dans la bande [lo,hi].
function countTouches(H, L, lo, hi, fromI) {
  let n = 0; for (let j = Math.max(0, fromI || 0); j < H.length; j++) { if (L[j] <= hi && H[j] >= lo) n++; } return n;
}

// ── FVG : imbalance 3 bougies (bull L[k] > H[k-2] ; bear H[k] < L[k-2]) ──────
function fvgZones(H, L, C, atr, lookback) {
  const out = []; const n = C.length; const LB = lookback || DEF.fvgLookback;
  for (let k = n - 1; k >= Math.max(2, n - LB); k--) {
    if (L[k] > H[k - 2]) {
      const b = band(H[k - 2], L[k]); let invalid = false;
      for (let j = k + 1; j < n; j++) { if (C[j] < b.lo) { invalid = true; break; } }
      const mitig = !invalid && L.slice(k + 1).some((x) => x <= b.hi);
      out.push({ type: "fvg", side: "bull", ...b, status: invalid ? "invalidated" : mitig ? "mitigated" : "fresh", k });
    } else if (H[k] < L[k - 2]) {
      const b = band(H[k], L[k - 2]); let invalid = false;
      for (let j = k + 1; j < n; j++) { if (C[j] > b.hi) { invalid = true; break; } }
      const mitig = !invalid && H.slice(k + 1).some((x) => x >= b.lo);
      out.push({ type: "fvg", side: "bear", ...b, status: invalid ? "invalidated" : mitig ? "mitigated" : "fresh", k });
    }
  }
  return out;
}

// ── Order blocks : derniere bougie OPPOSEE avant une impulsion (corps > 1.2*ATR) ──
function orderBlockZones(O, H, L, C, atr) {
  const out = []; const n = C.length; if (!(atr > 0)) return out;
  for (let k = n - 2; k >= Math.max(1, n - DEF.lookback); k--) {
    const move = C[k + 1] - O[k + 1];
    if (Math.abs(move) < 1.2 * atr) continue;
    if (move > 0 && C[k] < O[k]) { out.push({ type: "order_block", side: "bull", ...band(L[k], H[k]), k }); }
    else if (move < 0 && C[k] > O[k]) { out.push({ type: "order_block", side: "bear", ...band(L[k], H[k]), k }); }
    if (out.length >= 6) break;
  }
  return out;
}

// ── Support/Resistance depuis swings, clusterise en bandes ──────────────────
function srZones(bars, atr, px, opts) {
  const c = cfg(opts); const { H, L } = cols(bars); const sw = swings(H, L, c.pivotK, c.lookback);
  const tol = (atr > 0 ? atr : (px || 1) * 0.005) * c.srClusterAtr;
  const cluster = (pts) => {
    const sorted = pts.slice().sort((a, b) => a - b); const groups = [];
    for (const p of sorted) { const g = groups[groups.length - 1]; if (g && p - g.hi <= tol) { g.hi = p; g.n++; } else groups.push({ lo: p, hi: p, n: 1 }); }
    return groups;
  };
  const highs = cluster(sw.filter((s) => s.type === "high").map((s) => s.px));
  const lows = cluster(sw.filter((s) => s.type === "low").map((s) => s.px));
  const out = [];
  for (const g of highs) out.push({ type: px != null && g.mid > px ? "resistance" : "flip", ...band(g.lo, g.hi), n: g.n });
  for (const g of lows) out.push({ type: px != null && g.mid < px ? "support" : "flip", ...band(g.lo, g.hi), n: g.n });
  return out;
}

// ── EQH / EQL : niveaux egaux = pools de liquidite (>=2 swings dans la tolerance) ──
function equalLevels(bars, atr, opts) {
  const c = cfg(opts); const { H, L } = cols(bars); const sw = swings(H, L, c.pivotK, c.lookback);
  const tol = (atr > 0 ? atr : 1) * c.eqTolAtr; const out = [];
  const scan = (pts, type) => {
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
      if (Math.abs(pts[i] - pts[j]) <= tol) { out.push({ type, ...band(Math.min(pts[i], pts[j]), Math.max(pts[i], pts[j])) }); break; }
    }
  };
  scan(sw.filter((s) => s.type === "high").map((s) => s.px), "eqh");
  scan(sw.filter((s) => s.type === "low").map((s) => s.px), "eql");
  return out;
}

// ── VWAP (ancre sur la fenetre fournie) : 1 niveau -> zone fine ±0.1*ATR ─────
function vwapZone(bars, atr) {
  let pv = 0, vv = 0;
  for (const b of bars) { if (!Array.isArray(b) || b.length < 6) continue; const tp = (+b[2] + +b[3] + +b[4]) / 3; const v = +b[5] || 0; pv += tp * v; vv += v; }
  if (vv <= 0) return null;
  const w = vv > 0 ? pv / vv : null; const h = (atr > 0 ? atr : w * 0.002) * 0.1;
  return { type: "vwap", ...band(w - h, w + h) };
}

// ── Volume Profile approx : HVN (plus haut volume) / LVN (plus bas) sur bins de prix ──
function volumeProfile(bars, atr, opts) {
  const c = cfg(opts); const { H, L } = cols(bars); const n = H.length; if (!n) return [];
  let lo = Infinity, hi = -Infinity; for (let i = 0; i < n; i++) { if (L[i] < lo) lo = L[i]; if (H[i] > hi) hi = H[i]; }
  if (!(hi > lo)) return [];
  const bins = c.vpBins; const w = (hi - lo) / bins; const vol = new Array(bins).fill(0);
  for (const b of bars) { if (!Array.isArray(b) || b.length < 6) continue; const mid = (+b[2] + +b[3]) / 2; const v = +b[5] || 0; let idx = Math.floor((mid - lo) / w); if (idx < 0) idx = 0; if (idx >= bins) idx = bins - 1; vol[idx] += v; }
  let hvnI = 0, lvnI = 0; for (let i = 1; i < bins; i++) { if (vol[i] > vol[hvnI]) hvnI = i; if (vol[i] < vol[lvnI]) lvnI = i; }
  const zoneFor = (i, type) => ({ type, ...band(lo + i * w, lo + (i + 1) * w), vol: +vol[i].toFixed(0) });
  return [zoneFor(hvnI, "hvn"), zoneFor(lvnI, "lvn")];
}

// ── Periodes precedentes : PDH/PDL/PWH/PWL depuis barres daily/weekly fournies ──
function prevPeriodZones(daily, weekly, atr) {
  const out = []; const h = (atr > 0 ? atr : 1) * 0.05;
  const lvl = (bars, hiType, loType) => {
    if (!Array.isArray(bars) || bars.length < 2) return; const prev = bars[bars.length - 2];
    if (!Array.isArray(prev) || prev.length < 5) return;
    out.push({ type: hiType, ...band(+prev[2] - h, +prev[2] + h) });
    out.push({ type: loType, ...band(+prev[3] - h, +prev[3] + h) });
  };
  lvl(daily, "pdh", "pdl"); lvl(weekly, "pwh", "pwl");
  return out;
}

// ── Agregateur : toutes les zones, dist_atr, status/touches, tri par proximite ──
function buildZones(bars, atr, opts) {
  const c = cfg(opts); const { O, H, L, C } = cols(bars); const n = C.length;
  if (n < 6) return { zones: [], nearest: null, note: "historique insuffisant" };
  const px = opts && opts.px != null ? opts.px : C[n - 1];
  const a = atr != null && atr > 0 ? atr : null;
  const tf = (opts && opts.tf) || null;

  let raw = [].concat(
    srZones(bars, a, px, c),
    fvgZones(H, L, C, a, c.fvgLookback),
    orderBlockZones(O, H, L, C, a),
    equalLevels(bars, a, c),
    volumeProfile(bars, a, c),
  );
  const vw = vwapZone(bars, a); if (vw) raw.push(vw);
  if (opts && (opts.daily || opts.weekly)) raw = raw.concat(prevPeriodZones(opts.daily, opts.weekly, a));

  const zones = raw.filter(Boolean).map((z) => {
    const touches = countTouches(H, L, z.lo, z.hi, 0);
    const dist = a ? +(Math.abs(px - z.mid) / a).toFixed(2) : null;
    const status = z.status || (touches <= 1 ? "fresh" : touches <= 4 ? "mitigated" : "mitigated");
    const strength = +Math.min(1, ((z.n || 1) * 0.3) + Math.min(touches, 5) * 0.1).toFixed(2);
    return { type: z.type, tf, ...band(z.lo, z.hi), status, touches, freshness: touches <= 1 ? 1 : +(1 / touches).toFixed(2), strength, dist_atr: dist, side: z.side || null, confluence: [] };
  });

  // Confluence : marquer les zones qui se chevauchent (>=2 types au meme niveau).
  for (const z of zones) for (const o of zones) {
    if (z === o) continue; if (o.lo <= z.hi && o.hi >= z.lo && o.type !== z.type && !z.confluence.includes(o.type)) z.confluence.push(o.type);
  }

  zones.sort((x, y) => (x.dist_atr == null ? 1e9 : x.dist_atr) - (y.dist_atr == null ? 1e9 : y.dist_atr));
  const top = zones.slice(0, c.maxZones);
  return { zones: top, nearest: top[0] || null, px, atr: a };
}

module.exports = { buildZones, fvgZones, orderBlockZones, srZones, equalLevels, vwapZone, volumeProfile, prevPeriodZones, countTouches };

// CLI : node trade-journal/zones.js BTC 4h
if (require.main === module) {
  (async () => {
    const sym = process.argv[2] || "BTC"; const tf = process.argv[3] || "4h";
    try {
      const path = require("path"); const bybitDir = path.join(__dirname, "..", "skills", "bybit");
      const ccxt = require(require.resolve("ccxt", { paths: [bybitDir] }));
      const cl = new ccxt.bybit({ enableRateLimit: true, options: { defaultType: "swap" } });
      const pair = /\/.*:/.test(sym) ? sym : `${sym.replace(/USDT.*/, "").toUpperCase()}/USDT:USDT`;
      const bars = await cl.fetchOHLCV(pair, tf, undefined, 220);
      const daily = await cl.fetchOHLCV(pair, "1d", undefined, 5).catch(() => null);
      const { H, L, C } = cols(bars); let tr = 0, m = Math.min(14, H.length - 1);
      for (let i = H.length - m; i < H.length; i++) tr += Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1]));
      const atr = tr / m;
      const r = buildZones(bars, atr, { tf, daily });
      console.log(JSON.stringify({ px: r.px, atr: +r.atr.toFixed(2), nearest: r.nearest, n: r.zones.length, zones: r.zones }, null, 1));
    } catch (e) { console.error("zones err:", e && e.message); }
  })();
}
