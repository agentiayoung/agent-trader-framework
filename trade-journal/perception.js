"use strict";
// perception.js — AGREGATEUR de la couche de perception (Phase 9 wiring, master plan 2026-06-18).
// Assemble structure + zones + bougies + orderflow -> market_state{} + confluence 0-100.
// PUR (buildPerception prend les barres/atr en argument) + un fetcher PROFOND best-effort (CLI/cmd).
// OBSERVABILITE : la confluence est un CONTEXTE cite par le LLM, pas un gate dur (D-C).

const { marketStructure, cols } = require("./structure.js");
const { buildZones } = require("./zones.js");
const { confirmation } = require("./candles.js");
const { confluence } = require("./confluence.js");
const { buildOrderflow } = require("./orderflow.js");

function htfFromTrend(trend) { return trend === "up" ? "bullish" : trend === "down" ? "bearish" : "neutral"; }

// atr simple depuis des barres ccxt (si non fourni).
function atrFrom(bars, p) {
  const { H, L, C } = cols(bars); const n = C.length; const m = Math.min(p || 14, n - 1);
  if (m < 1) return null; let tr = 0;
  for (let i = n - m; i < n; i++) tr += Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1]));
  return tr / m;
}

// buildPerception({bars, atr, daily, weekly, px, orderflow, tf}) -> market_state + confluence. PUR.
function buildPerception(o) {
  const opt = o || {};
  const bars = opt.bars || [];
  if (!Array.isArray(bars) || bars.length < 6) return { note: "historique insuffisant", confluence: { score: 0, side: null, decision: "no_trade" } };
  const atr = opt.atr != null && opt.atr > 0 ? opt.atr : atrFrom(bars, 14);
  const { C } = cols(bars); const px = opt.px != null ? opt.px : C[C.length - 1];
  const structure = marketStructure(bars, atr);
  const htf = htfFromTrend(structure.trend);
  const zr = buildZones(bars, atr, { tf: opt.tf || null, daily: opt.daily, weekly: opt.weekly, px });
  const candles = confirmation(bars, zr.zones, htf, { atr });
  const orderflow = opt.orderflow || null;
  const state = { px, atr, structure, zones: zr.zones, candles, orderflow, htf_bias: htf };
  const conf = confluence(state, { threshold: opt.threshold });
  return { px, atr, htf_bias: htf, structure, zones: zr.zones, nearest: zr.nearest, candles, orderflow, confluence: conf };
}

// compactPerception(perc) -> resume leger pour scan-latest.json (evite de gonfler 19 paires). PUR.
function compactPerception(perc) {
  if (!perc || !perc.confluence) return null;
  const st = perc.structure || {}; const nz = perc.nearest; const cd = perc.candles || {}; const cf = perc.confluence;
  return {
    trend: st.trend || null,
    choch: st.last_choch ? st.last_choch.dir : null,
    mss: st.last_mss ? st.last_mss.dir : null,
    nearest_zone: nz ? { type: nz.type, dist_atr: nz.dist_atr, status: nz.status } : null,
    candle: cd.confirmation_valid ? `${cd.pattern}:${cd.side}` : (cd.pattern && cd.pattern !== "none" ? `${cd.pattern}?` : null),
    // opp14 = /14 du sens OPPOSE -> score.perceptionScore peut aligner au sens d'un trade contre-confluence (F1).
    confluence: { score: cf.score, score14: cf.score14, tier: cf.tier, side: cf.side, decision: cf.decision, conviction: cf.conviction, would_gate: cf.would_gate, opp14: cf.opposite ? cf.opposite.score14 : null },
  };
}

// deepPerception(symbol, tf) -> fetch profond (bars+daily+trades) + orderflow. best-effort, async.
async function deepPerception(symbol, tf) {
  const path = require("path"); const bybitDir = path.join(__dirname, "..", "skills", "bybit");
  const ccxt = require(require.resolve("ccxt", { paths: [bybitDir] }));
  const cl = new ccxt.bybit({ enableRateLimit: true, options: { defaultType: "swap" } });
  const pair = /\/.*:/.test(symbol) ? symbol : `${String(symbol).replace(/USDT.*/, "").toUpperCase()}/USDT:USDT`;
  const t = tf || "4h";
  const safe = async (fn) => { try { return await fn(); } catch (e) { return null; } };
  const [bars, daily, trades, oiHist] = await Promise.all([
    safe(() => cl.fetchOHLCV(pair, t, undefined, 220)),
    safe(() => cl.fetchOHLCV(pair, "1d", undefined, 5)),
    safe(() => cl.fetchTrades(pair, undefined, 100)),
    safe(() => (cl.has["fetchOpenInterestHistory"] ? cl.fetchOpenInterestHistory(pair, t, undefined, 2) : null)),
  ]);
  if (!bars || bars.length < 6) return { error: "ohlcv indisponible", symbol };
  const atr = atrFrom(bars, 14);
  const { C } = cols(bars);
  const priceChangePct = C.length >= 2 ? ((C[C.length - 1] - C[C.length - 2]) / C[C.length - 2]) * 100 : null;
  // Variation d'OI sur la derniere periode -> oi_signal exploitable (etait "unknown" sans ca, L3 audit).
  let oiChangePct = null;
  if (Array.isArray(oiHist) && oiHist.length >= 2) {
    const oiVal = (x) => (x && (x.openInterestAmount != null ? x.openInterestAmount : x.openInterestValue)) || null;
    const a = oiVal(oiHist[oiHist.length - 2]), b = oiVal(oiHist[oiHist.length - 1]);
    if (a && b) oiChangePct = ((b - a) / a) * 100;
  }
  const orderflow = buildOrderflow({ trades, bars, atr, priceChangePct, oiChangePct });
  return buildPerception({ bars, atr, daily, px: C[C.length - 1], orderflow, tf: t });
}

module.exports = { buildPerception, compactPerception, deepPerception, atrFrom, htfFromTrend };

// CLI : node trade-journal/perception.js BTC 4h
if (require.main === module) {
  (async () => {
    const sym = process.argv[2] || "BTC"; const tf = process.argv[3] || "4h";
    try { const p = await deepPerception(sym, tf); console.log(JSON.stringify({ symbol: sym, tf, htf_bias: p.htf_bias, structure: p.structure && { trend: p.structure.trend, choch: p.structure.last_choch, mss: p.structure.last_mss }, nearest: p.nearest, candle: p.candles, orderflow: p.orderflow && { cvd: p.orderflow.cvd, sweep: p.orderflow.sweep, oi_signal: p.orderflow.oi_signal }, confluence: p.confluence }, null, 1)); }
    catch (e) { console.error("perception err:", e && e.message); }
  })();
}
