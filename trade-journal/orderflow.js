"use strict";
// orderflow.js — METRIQUES de microstructure derivees PUR (Phase 5, master plan 2026-06-18).
// Produit le bloc `orderflow` (derive) du contrat docs/SCHEMA-market-state.md, en complement
// du brut fourni par skills/bybit/feed.js (book/OI/funding/flow). 100% deterministe, zero reseau.
//
// Honnetete des donnees (stage REST, D-B) : CVD/delta = sur la FENETRE de trades recents (snapshot) ;
// la SERIE CVD par barre (pour divergence fine) arrivera avec le WS (Phase 7) -> les fonctions
// generiques (divergence) prennent des series en argument pour etre deja pretes/testables.
// Le SWEEP de liquidite se calcule depuis l'OHLCV (sans tick) = le signal le plus exploitable ici.

// ── cumulativeDelta(trades) : CVD sur la fenetre de trades (ccxt fetchTrades) ──
function cumulativeDelta(trades) {
  const t = Array.isArray(trades) ? trades : [];
  let buy = 0, sell = 0;
  for (const x of t) { const a = Number(x && x.amount) || 0; if (x && x.side === "buy") buy += a; else if (x && x.side === "sell") sell += a; }
  const cvd = +(buy - sell).toFixed(4); const tot = buy + sell;
  return { cvd, buy: +buy.toFixed(4), sell: +sell.toFixed(4), ratio: tot > 0 ? +((buy - sell) / tot).toFixed(3) : 0 };
}

// ── divergence(prices, cvds) : prix vs CVD. PUR, generique (series). ─────────
// prix monte mais CVD baisse = divergence BAISSIERE (acheteurs s'essoufflent) ; inverse = haussiere.
function divergence(prices, cvds) {
  if (!Array.isArray(prices) || !Array.isArray(cvds) || prices.length < 2 || cvds.length < 2) return null;
  const pUp = prices[prices.length - 1] > prices[0];
  const pDn = prices[prices.length - 1] < prices[0];
  const cUp = cvds[cvds.length - 1] > cvds[0];
  const cDn = cvds[cvds.length - 1] < cvds[0];
  if (pUp && cDn) return "bear";
  if (pDn && cUp) return "bull";
  return null;
}

// ── oiPriceSignal(priceChangePct, oiChangePct, eps) : interpretation OI+prix ──
// prix+ OI+ = nouveaux longs ; prix+ OI- = short covering ; prix- OI+ = nouveaux shorts ; prix- OI- = long covering.
function oiPriceSignal(priceChangePct, oiChangePct, eps) {
  const e = eps != null ? eps : 0.1;
  if (priceChangePct == null || oiChangePct == null) return "unknown";
  const pUp = priceChangePct > e, pDn = priceChangePct < -e;
  const oUp = oiChangePct > e, oDn = oiChangePct < -e;
  if (pUp && oUp) return "new_longs";
  if (pUp && oDn) return "short_covering";
  if (pDn && oUp) return "new_shorts";
  if (pDn && oDn) return "long_covering";
  return "neutral";
}

// ── detectSweep(bars, atr, opts) : balayage de liquidite depuis l'OHLCV ──────
// La derniere bougie perce un swing recent (meche au-dela) PUIS recloture en deca = stop-hunt.
// side='sell_side' (sweep des lows = piege baissier -> rebond) / 'buy_side' (sweep des highs).
function detectSweep(bars, atr, opts) {
  const o = opts || {}; const LB = o.lookback || 30; const pierce = o.pierceAtr != null ? o.pierceAtr : 0.1;
  const n = Array.isArray(bars) ? bars.length : 0; if (n < 5) return { detected: false };
  const H = [], L = [], C = []; for (const b of bars) { H.push(+b[2]); L.push(+b[3]); C.push(+b[4]); }
  const a = atr > 0 ? atr : (Math.max(...H.slice(-LB)) - Math.min(...L.slice(-LB))) / LB || 1;
  const i = n - 1;
  const priorHi = Math.max(...H.slice(Math.max(0, i - LB), i));
  const priorLo = Math.min(...L.slice(Math.max(0, i - LB), i));
  // sweep des lows : meche sous le low recent d'au moins pierce*ATR, mais cloture AU-DESSUS = rejet.
  if (L[i] < priorLo - pierce * a && C[i] > priorLo) return { detected: true, side: "sell_side", level: +priorLo, reclaimed: true, bias: "long" };
  // sweep des highs : meche au-dessus du high recent, cloture EN DESSOUS = rejet.
  if (H[i] > priorHi + pierce * a && C[i] < priorHi) return { detected: true, side: "buy_side", level: +priorHi, reclaimed: true, bias: "short" };
  return { detected: false };
}

// ── absorption(delta, priceMovePct, opts) : gros volume net, prix qui ne bouge pas ──
// |delta| eleve mais |move| faible = un gros acteur ABSORBE -> retournement probable contre le delta.
function absorption(delta, priceMovePct, opts) {
  const o = opts || {}; const minAbsDelta = o.minAbsDelta != null ? o.minAbsDelta : 0; const maxMove = o.maxMovePct != null ? o.maxMovePct : 0.1;
  if (delta == null || priceMovePct == null) return { detected: false };
  if (Math.abs(delta) > minAbsDelta && Math.abs(priceMovePct) < maxMove) {
    return { detected: true, side: delta > 0 ? "bid_absorbed" : "ask_absorbed", against: delta > 0 ? "short" : "long" };
  }
  return { detected: false };
}

// ── buildOrderflow(inputs) : agrege le bloc orderflow du contrat ────────────
// inputs = { trades, bars, atr, oiChangePct, priceChangePct, cvdSeries, priceSeries }
function buildOrderflow(inputs) {
  const i = inputs || {};
  const cd = cumulativeDelta(i.trades);
  const sweep = detectSweep(i.bars, i.atr, i.sweepOpts);
  const div = divergence(i.priceSeries, i.cvdSeries);
  const oiSig = oiPriceSignal(i.priceChangePct, i.oiChangePct);
  const absorp = absorption(cd.cvd, i.priceChangePct, i.absorptionOpts);
  return {
    delta: cd.cvd,
    cvd: cd.cvd,
    buy_vol: cd.buy, sell_vol: cd.sell,
    aggression: cd.ratio > 0.15 ? "buy" : cd.ratio < -0.15 ? "sell" : "neutral",
    cvd_divergence: div,
    oi_signal: oiSig,
    sweep,
    absorption: absorp,
    note: "stage REST (snapshot). delta/CVD par-barre + footprint -> WS Phase 7.",
  };
}

module.exports = { cumulativeDelta, divergence, oiPriceSignal, detectSweep, absorption, buildOrderflow };

// CLI : node trade-journal/orderflow.js BTC 4h
if (require.main === module) {
  (async () => {
    const sym = process.argv[2] || "BTC"; const tf = process.argv[3] || "4h";
    try {
      const path = require("path"); const bybitDir = path.join(__dirname, "..", "skills", "bybit");
      const ccxt = require(require.resolve("ccxt", { paths: [bybitDir] }));
      const cl = new ccxt.bybit({ enableRateLimit: true, options: { defaultType: "swap" } });
      const pair = /\/.*:/.test(sym) ? sym : `${sym.replace(/USDT.*/, "").toUpperCase()}/USDT:USDT`;
      const bars = await cl.fetchOHLCV(pair, tf, undefined, 60);
      const trades = await cl.fetchTrades(pair, undefined, 100).catch(() => null);
      const { cols } = require("./structure.js"); const { H, L, C } = cols(bars);
      let tr = 0, m = 14; for (let k = H.length - m; k < H.length; k++) tr += Math.max(H[k] - L[k], Math.abs(H[k] - C[k - 1]), Math.abs(L[k] - C[k - 1]));
      const atr = tr / m;
      const priceChangePct = ((C[C.length - 1] - C[C.length - 2]) / C[C.length - 2]) * 100;
      console.log(JSON.stringify(buildOrderflow({ trades, bars, atr, priceChangePct }), null, 1));
    } catch (e) { console.error("orderflow err:", e && e.message); }
  })();
}
