"use strict";
// candles.js — reconnaissance de bougies CONTEXTUELLE PURE (Phase 4, master plan 2026-06-18).
// Produit le bloc `candles` du contrat docs/SCHEMA-market-state.md.
// INVARIANT DUR (spec Hugo) : un pattern n'a de valeur QUE dans une zone pertinente + aligne au biais HTF.
//   -> un doji SEUL n'est JAMAIS une confirmation ; une bougie HORS zone -> location_quality ~0.
// Remplace le score `candle` auto-declare par le LLM (score.js) par une valeur CALCULEE.
// 100% deterministe, zero reseau. bars = [[ts,o,h,l,c,v],...].

function bar(b) { return { o: +b[1], h: +b[2], l: +b[3], c: +b[4] }; }
function parts(x) {
  const body = Math.abs(x.c - x.o); const range = x.h - x.l || 1e-9;
  const upper = x.h - Math.max(x.o, x.c); const lower = Math.min(x.o, x.c) - x.l;
  return { body, range, upper, lower, bull: x.c > x.o, bear: x.c < x.o, bodyPct: body / range };
}

// detectPattern(bars) -> {pattern, dir, strength} sur la/les dernieres bougies. PUR.
function detectPattern(bars) {
  const n = Array.isArray(bars) ? bars.length : 0;
  if (n < 1) return { pattern: "none", dir: "neutral", strength: 0 };
  const c0 = bar(bars[n - 1]); const p0 = parts(c0);
  const c1 = n >= 2 ? bar(bars[n - 2]) : null; const p1 = c1 ? parts(c1) : null;
  const c2 = n >= 3 ? bar(bars[n - 3]) : null;

  // Doji : corps tres petit vs range = INDECISION (jamais une entree seule).
  if (p0.bodyPct < 0.1) return { pattern: "doji", dir: "neutral", strength: 0.2 };

  // Marteau / hammer : longue meche basse, petit corps en haut (rejet du bas).
  if (p0.lower >= 2 * p0.body && p0.upper <= p0.body && p0.bodyPct < 0.5)
    return { pattern: "hammer", dir: "long", strength: 0.6 };
  // Etoile filante / shooting star : longue meche haute (rejet du haut).
  if (p0.upper >= 2 * p0.body && p0.lower <= p0.body && p0.bodyPct < 0.5)
    return { pattern: "shooting_star", dir: "short", strength: 0.6 };

  // Engulfing (2 bougies) : corps qui englobe le precedent, sens oppose.
  if (c1) {
    const eng = p0.body > p1.body && Math.max(c0.o, c0.c) >= Math.max(c1.o, c1.c) && Math.min(c0.o, c0.c) <= Math.min(c1.o, c1.c);
    if (eng && p0.bull && p1.bear) return { pattern: "bullish_engulfing", dir: "long", strength: 0.7 };
    if (eng && p0.bear && p1.bull) return { pattern: "bearish_engulfing", dir: "short", strength: 0.7 };
  }

  // Morning / evening star (3 bougies) : grande bougie -> petit corps -> grande bougie opposee.
  if (c1 && c2) {
    const pp2 = parts(c2);
    const smallMid = p1.bodyPct < 0.4;
    if (pp2.bear && smallMid && p0.bull && c0.c > (c2.o + c2.c) / 2) return { pattern: "morning_star", dir: "long", strength: 0.75 };
    if (pp2.bull && smallMid && p0.bear && c0.c < (c2.o + c2.c) / 2) return { pattern: "evening_star", dir: "short", strength: 0.75 };
  }

  // Marubozu / forte cloture pres de l'extreme (momentum).
  if (p0.bodyPct >= 0.8) return { pattern: p0.bull ? "strong_bull" : "strong_bear", dir: p0.bull ? "long" : "short", strength: 0.55 };

  // Rejet generique : meche dominante.
  if (p0.lower >= 1.5 * p0.body) return { pattern: "lower_wick_rejection", dir: "long", strength: 0.45 };
  if (p0.upper >= 1.5 * p0.body) return { pattern: "upper_wick_rejection", dir: "short", strength: 0.45 };

  return { pattern: "none", dir: "neutral", strength: 0 };
}

// Zones pertinentes pour une direction : long -> support/demande sous le prix ; short -> resistance/offre.
const BULL_ZONES = new Set(["support", "flip", "order_block", "fvg", "eql", "pdl", "pwl", "hvn", "lvn", "vwap"]);
const BEAR_ZONES = new Set(["resistance", "flip", "order_block", "fvg", "eqh", "pdh", "pwh", "hvn", "lvn", "vwap"]);

// locationQuality(lastBar, zones, dir, atr) -> 0-1. Une bougie DANS une zone alignee = 1.
function locationQuality(lastBar, zones, dir, atr) {
  if (dir === "neutral" || !Array.isArray(zones) || !zones.length) return 0;
  const x = bar(lastBar); const a = atr > 0 ? atr : (x.h - x.l) || 1;
  const set = dir === "long" ? BULL_ZONES : BEAR_ZONES;
  let best = 0;
  for (const z of zones) {
    if (!z || z.lo == null) continue;
    const sideOk = z.side ? (dir === "long" ? z.side === "bull" : z.side === "bear") : true;
    if (!set.has(z.type) || !sideOk) continue;
    // le point d'interet : low de la bougie pour un long, high pour un short.
    const probe = dir === "long" ? x.l : x.h;
    let q = 0;
    if (probe >= z.lo && probe <= z.hi) q = 1;                              // dans la zone
    else { const d = Math.min(Math.abs(probe - z.lo), Math.abs(probe - z.hi)) / a; q = d <= 0.5 ? +(1 - d / 0.5).toFixed(2) : 0; }
    if (z.confluence && z.confluence.length) q = Math.min(1, q + 0.1 * z.confluence.length); // bonus confluence
    if (q > best) best = q;
  }
  return +best.toFixed(2);
}

// confirmation(bars, zones, htfBias, opts) -> bloc `candles` complet du contrat.
function confirmation(bars, zones, htfBias, opts) {
  const o = opts || {}; const thr = o.threshold != null ? o.threshold : 0.5;
  const det = detectPattern(bars);
  const n = Array.isArray(bars) ? bars.length : 0;
  if (!n) return { pattern: "none", strength: 0, location_quality: 0, confirmation_valid: false, side: null };
  const lq = locationQuality(bars[n - 1], zones, det.dir, o.atr);
  // Aligne au biais HTF : un long demande un biais non-baissier ; un short, non-haussier. neutral tolere.
  const aligned = det.dir === "long" ? htfBias !== "bearish"
                : det.dir === "short" ? htfBias !== "bullish" : false;
  // INVARIANT : doji/indecision (dir neutral) ne confirme JAMAIS ; pattern hors zone (lq<thr) non plus.
  const valid = det.pattern !== "none" && det.dir !== "neutral" && lq >= thr && aligned;
  return {
    pattern: det.pattern,
    strength: det.strength,
    location_quality: lq,
    confirmation_valid: valid,
    side: det.dir === "neutral" ? null : det.dir,
    aligned_htf: aligned,
  };
}

module.exports = { detectPattern, locationQuality, confirmation, parts, bar };

// CLI : node trade-journal/candles.js BTC 4h
if (require.main === module) {
  (async () => {
    const sym = process.argv[2] || "BTC"; const tf = process.argv[3] || "4h";
    try {
      const path = require("path"); const bybitDir = path.join(__dirname, "..", "skills", "bybit");
      const ccxt = require(require.resolve("ccxt", { paths: [bybitDir] }));
      const cl = new ccxt.bybit({ enableRateLimit: true, options: { defaultType: "swap" } });
      const pair = /\/.*:/.test(sym) ? sym : `${sym.replace(/USDT.*/, "").toUpperCase()}/USDT:USDT`;
      const bars = await cl.fetchOHLCV(pair, tf, undefined, 220);
      const { cols } = require("./structure.js"); const { H, L, C } = cols(bars);
      let tr = 0, m = 14; for (let i = H.length - m; i < H.length; i++) tr += Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1]));
      const atr = tr / m;
      const zones = require("./zones.js").buildZones(bars, atr, { tf }).zones;
      const struct = require("./structure.js").marketStructure(bars, atr);
      const htf = struct.trend === "up" ? "bullish" : struct.trend === "down" ? "bearish" : "neutral";
      console.log(JSON.stringify({ htf_bias: htf, candles: confirmation(bars, zones, htf, { atr }) }, null, 1));
    } catch (e) { console.error("candles err:", e && e.message); }
  })();
}
