"use strict";
// feed.js — ingestion de MICROSTRUCTURE Bybit (Phase 1, master plan 2026-06-18).
// OBSERVABILITE PURE : order book + open interest + funding + recent trades, en LECTURE.
// NE TRADE RIEN, ne touche a aucune decision. Endpoints PUBLICS (aucune cle requise).
//
// Architecture (principe projet) : LOGIQUE PURE testable (normalizers prenant des reponses
// ccxt brutes en argument, zero reseau) + un fetcher MINCE best-effort (try/catch par appel,
// ne throw JAMAIS). Les metriques derivees (delta/CVD/sweep/absorption) = Phase 5 (orderflow.js).

const ccxt = require("ccxt");

function baseSym(s) {
  return String(s || "").replace(/\/.*$/, "").replace(/USDT.*$/, "").toUpperCase();
}
function toPair(sym) {
  // BTC -> BTC/USDT:USDT (perp lineaire), idempotent si deja au format ccxt.
  if (/\/.*:/.test(sym)) return sym;
  return `${baseSym(sym)}/USDT:USDT`;
}

// ── normalizeOrderBook(raw, topN) : PUR. raw = ccxt fetchOrderBook() ────────
// Retourne bids/asks tronques + spread + mid. Robuste aux entrees vides.
function normalizeOrderBook(raw, topN) {
  const n = topN || 10;
  const bids = (raw && Array.isArray(raw.bids) ? raw.bids : []).slice(0, n).map((l) => [Number(l[0]), Number(l[1])]);
  const asks = (raw && Array.isArray(raw.asks) ? raw.asks : []).slice(0, n).map((l) => [Number(l[0]), Number(l[1])]);
  const bestBid = bids.length ? bids[0][0] : null;
  const bestAsk = asks.length ? asks[0][0] : null;
  const spread = bestBid != null && bestAsk != null ? +(bestAsk - bestBid).toFixed(8) : null;
  const mid = bestBid != null && bestAsk != null ? +((bestBid + bestAsk) / 2).toFixed(8) : null;
  return { bids, asks, best_bid: bestBid, best_ask: bestAsk, spread, mid };
}

// ── bookImbalance(book, depth) : PUR. ∈ [-1,1] ; + = pression ACHETEUSE ──────
// (vol_bid - vol_ask) / (vol_bid + vol_ask) sur les `depth` premiers niveaux.
function bookImbalance(book, depth) {
  const d = depth || 10;
  const sum = (arr) => (Array.isArray(arr) ? arr.slice(0, d).reduce((s, l) => s + (Number(l[1]) || 0), 0) : 0);
  const vb = sum(book && book.bids);
  const va = sum(book && book.asks);
  const tot = vb + va;
  if (tot <= 0) return null;
  return +((vb - va) / tot).toFixed(3);
}

// ── wallLevels(book, k) : PUR. Les k plus gros niveaux de liquidite (murs) ───
function wallLevels(book, k) {
  const kk = k || 3;
  const top = (arr) => (Array.isArray(arr) ? arr.slice() : [])
    .map((l) => ({ px: Number(l[0]), qty: Number(l[1]) }))
    .sort((a, b) => b.qty - a.qty).slice(0, kk);
  return { bid_walls: top(book && book.bids), ask_walls: top(book && book.asks) };
}

// ── normalizeOI / normalizeFunding : PUR, null-safe ─────────────────────────
function normalizeOI(raw) {
  if (!raw) return null;
  const v = raw.openInterestAmount != null ? raw.openInterestAmount
          : raw.openInterestValue != null ? raw.openInterestValue
          : raw.openInterest != null ? raw.openInterest : null;
  return v != null ? Number(v) : null;
}
function normalizeFunding(raw) {
  if (!raw) return null;
  const v = raw.fundingRate != null ? raw.fundingRate : (raw.info && raw.info.fundingRate);
  return v != null ? Number(v) : null;
}

// ── aggressionFromTrades(trades) : PUR. agression nette recente (buy/sell) ───
// trades = ccxt fetchTrades() ; renvoie {buy_vol, sell_vol, aggression}.
function aggressionFromTrades(trades) {
  const t = Array.isArray(trades) ? trades : [];
  let buy = 0, sell = 0;
  for (const x of t) {
    const amt = Number(x && x.amount) || 0;
    if (x && x.side === "buy") buy += amt; else if (x && x.side === "sell") sell += amt;
  }
  const tot = buy + sell;
  const ratio = tot > 0 ? (buy - sell) / tot : 0;
  return { buy_vol: +buy.toFixed(4), sell_vol: +sell.toFixed(4), aggression: ratio > 0.15 ? "buy" : ratio < -0.15 ? "sell" : "neutral" };
}

let _pub = null;
function pubClient() {
  if (_pub) return _pub;
  _pub = new ccxt.bybit({ enableRateLimit: true, options: { defaultType: "swap" } });
  return _pub;
}

// ── fetchMicrostructure(symbol, opts) : fetcher MINCE best-effort. NE THROW JAMAIS.
async function fetchMicrostructure(symbol, opts) {
  const o = opts || {};
  const topN = o.topN || 10;
  const pair = toPair(symbol);
  const c = o.client || pubClient();
  const safe = async (fn) => { try { return await fn(); } catch (e) { return null; } };

  const [obRaw, oiRaw, frRaw, trRaw] = await Promise.all([
    safe(() => c.fetchOrderBook(pair, topN)),
    safe(() => (c.has["fetchOpenInterest"] ? c.fetchOpenInterest(pair) : null)),
    safe(() => (c.has["fetchFundingRate"] ? c.fetchFundingRate(pair) : null)),
    safe(() => (c.has["fetchTrades"] ? c.fetchTrades(pair, undefined, 100) : null)),
  ]);

  const book = obRaw ? normalizeOrderBook(obRaw, topN) : null;
  return {
    symbol: baseSym(symbol),
    ts: new Date().toISOString(),
    book,
    imbalance: book ? bookImbalance(book, topN) : null,
    walls: book ? wallLevels(book, 3) : null,
    open_interest: normalizeOI(oiRaw),
    funding: normalizeFunding(frRaw),
    flow: trRaw ? aggressionFromTrades(trRaw) : null,
    note: "observabilite Phase 1 (non trade). delta/CVD/sweep -> Phase 5.",
  };
}

module.exports = {
  baseSym, toPair, normalizeOrderBook, bookImbalance, wallLevels,
  normalizeOI, normalizeFunding, aggressionFromTrades, fetchMicrostructure,
};

// CLI : node skills/bybit/feed.js BTC  (smoke live, best-effort)
if (require.main === module) {
  const sym = process.argv[2] || "BTC";
  fetchMicrostructure(sym).then((r) => console.log(JSON.stringify(r, null, 1))).catch((e) => console.error("feed err:", e && e.message));
}
