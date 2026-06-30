"use strict";
const assert = require("assert");
const U = require("../trade-journal/universe.js");

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

// --- crypto regression: the 19 legacy pairs unchanged ---
const CRYPTO = "BTC,ETH,SOL,BNB,XRP,DOGE,AVAX,LINK,ADA,SUI,LTC,DOT,TON,NEAR,HYPE,HBAR,ONDO,ASTER,TAO".split(",");
for (const s of CRYPTO) {
  const e = U.bySymbol(s);
  ok(e, `crypto ${s} present`);
  ok(e.ccxt === `${s}/USDT:USDT`, `crypto ${s} ccxt unchanged (${e && e.ccxt})`);
  ok(e.class === "crypto", `crypto ${s} class`);
  ok(e.session === "24x7", `crypto ${s} session`);
  ok(e.marketType === "swap", `crypto ${s} marketType`);
}

// --- new instruments ---
const xaut = U.bySymbol("XAUT");
ok(xaut && xaut.ccxt === "XAUT/USDT:USDT", "XAUT ccxt");
ok(xaut.class === "commodity", "XAUT class commodity");
ok(xaut.marketType === "swap", "XAUT swap");
const spy = U.bySymbol("SPY");
ok(spy && spy.class === "etf" && spy.session === "us_equity", "SPY etf/us_equity");
const qqq = U.bySymbol("QQQ");
ok(qqq && qqq.ccxt === "QQQ/USDT:USDT" && qqq.session === "us_equity", "QQQ etf/us_equity");

// --- Magnificent 7 equities (perps, drop-in) ---
const MAG7 = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA"];
for (const s of MAG7) {
  const e = U.bySymbol(s);
  ok(e, `equity ${s} present`);
  ok(e.ccxt === `${s}/USDT:USDT`, `equity ${s} ccxt perp`);
  ok(e.class === "equity", `equity ${s} class`);
  ok(e.session === "us_equity", `equity ${s} session`);
  ok(e.marketType === "swap", `equity ${s} swap`);
}

// --- tradable flag : crypto tradable ; non-crypto observabilite-only HORS demo, tradable EN demo ---
ok(U.isTradable("BTC", { demo: false }) === true, "BTC tradable");
ok(U.isTradable("XAUT", { demo: false }) === false, "XAUT not tradable hors demo (observabilite)");
ok(U.isTradable("NVDA", { demo: false }) === false, "NVDA not tradable hors demo");
ok(U.isTradable("SPY", { demo: false }) === false, "SPY not tradable hors demo");
ok(U.tradableSymbols({ demo: false }).length === 19, "hors demo : exactement 19 tradables (crypto)");
ok(U.tradableSymbols({ demo: false }).every((s) => U.classOf(s) === "crypto"), "hors demo : tradables = crypto only");
// DEMO_ACTIVE (GO Hugo 16.06) : on teste l'infra sur toutes les classes -> non-crypto tradable.
ok(U.isTradable("XAUT", { demo: true }) === true, "XAUT tradable EN demo");
ok(U.isTradable("NVDA", { demo: true }) === true, "NVDA tradable EN demo");
ok(U.isTradable("SPY", { demo: true }) === true, "SPY tradable EN demo");
ok(U.isTradable("BTC", { demo: true }) === true, "BTC tradable EN demo (inchange)");
ok(U.tradableSymbols({ demo: true }).length === U.enabledSymbols().length, "EN demo : tous les actifs enabled tradables");
ok(U.isTradable("UNKNOWN", { demo: true }) === false, "symbole inconnu jamais tradable");

// --- helpers ---
ok(U.classOf("BTC") === "crypto", "classOf crypto");
ok(U.classOf("SPY") === "etf", "classOf etf");
ok(U.classOf("NVDA") === "equity", "classOf equity");
ok(U.classOf("UNKNOWN") === null, "classOf unknown -> null");
ok(U.byClass("commodity").some((e) => e.symbol === "XAUT"), "byClass commodity has XAUT");
ok(U.byClass("equity").length === 8, "byClass equity = 8 (Mag7 + SpaceX)");
// --- SpaceX (perp, tokenise prive : session 24x7, observabilite) ---
ok(U.bySymbol("SPCX") && U.bySymbol("SPCX").ccxt === "SPCX/USDT:USDT", "SPCX ccxt perp");
ok(U.bySymbol("SPCX").class === "equity" && U.bySymbol("SPCX").session === "24x7", "SPCX equity/24x7");
ok(U.isTradable("SPCX", { demo: false }) === false, "SPCX not tradable hors demo (observabilite)");
ok(U.isTradable("SPCX", { demo: true }) === true, "SPCX tradable EN demo");
const enabled = U.enabledCcxt();
ok(enabled.includes("BTC/USDT:USDT"), "enabledCcxt has BTC");
ok(enabled.includes("XAUT/USDT:USDT"), "enabledCcxt has XAUT");
ok(enabled.includes("NVDA/USDT:USDT"), "enabledCcxt has NVDA");
ok(U.all().length >= 30, "universe >= 30 entries (19 crypto + XAUT + SPY + QQQ + 7 equity + SpaceX)");

// disabled entries excluded from enabledCcxt
ok(U.enabledSymbols().every((s) => U.bySymbol(s).enabled !== false), "enabledSymbols all enabled");

// --- sessionOpen (UTC). June = EDT (ET = UTC-4). us_equity regular hours 13:30-20:00 UTC Mon-Fri ---
const open  = new Date(Date.UTC(2026, 5, 16, 15, 0)); // Tue 15:00 UTC -> NYSE open
const closed= new Date(Date.UTC(2026, 5, 16, 2, 0));  // Tue 02:00 UTC -> NYSE closed
const sat   = new Date(Date.UTC(2026, 5, 13, 15, 0)); // Saturday
ok(U.sessionOpen("24x7", open).open === true, "24x7 always open");
ok(U.sessionOpen("us_equity", open).open === true, "us_equity weekday RTH open");
ok(U.sessionOpen("us_equity", closed).open === false, "us_equity overnight closed");
ok(U.sessionOpen("us_equity", sat).open === false, "us_equity weekend closed");
ok(U.sessionOpen("metals", sat).open === false, "metals weekend closed");
ok(U.sessionOpen("metals", open).open === true, "metals weekday open");

// --- carryWarn: extreme perp funding (cost-of-carry) ---
ok(U.carryWarn(0.05) === false, "carryWarn normal funding");
ok(U.carryWarn(0.20) === true, "carryWarn extreme funding");
ok(U.carryWarn(null) === false, "carryWarn null -> false");

// --- classBreakdown: agrege le risque par classe d'actif ---
const trades = [
  { symbol: "BTC", risk_pct_effective: 3 },
  { symbol: "SOL", risk_pct_effective: 2 },
  { symbol: "XAUT", risk_pct_effective: 1.5 },
  { symbol: "SPY", risk_pct_effective: 1 },
];
const cb = U.classBreakdown(trades, (t) => U.classOf(t.symbol), (t) => t.risk_pct_effective);
ok(cb.crypto && Math.abs(cb.crypto.risk_pct - 5) < 1e-9, "classBreakdown crypto risk=5");
ok(cb.commodity && cb.commodity.n === 1, "classBreakdown commodity n=1");
ok(cb.etf && Math.abs(cb.etf.risk_pct - 1) < 1e-9, "classBreakdown etf risk=1");

console.log(`test-universe: ${n} assertions OK`);
process.exit(0);
