"use strict";

// ════════════════════════════════════════════════════════════════════
// Registre d'univers multi-actifs (PUR, additif). Chaque symbole porte
// sa classe d'actif + son symbole ccxt + sa session. La crypto (19 paires)
// reste BYTE-IDENTIQUE a l'ancienne string scan.js (regression testee).
// Decouverte 16.06 (spike demo GREEN) : XAUT/SPY/QQQ = perps Bybit tradables
// sur le compte demo via la couche ccxt existante (drop-in). Voir
// docs/plans/2026-06-16-multi-asset-integration-design.md.
//   class      : crypto | commodity | etf | equity
//   marketType : swap | spot
//   session    : 24x7 | us_equity | metals   (pilote l'observabilite gaps)
//   tradable   : true => la routine PEUT prendre une position. false => OBSERVABILITE
//                seulement (scanne, expose, compte dans l'exposition) MAIS jamais trade
//                tant qu'un edge n'est pas valide OOS+DSR (GO Hugo) -> universe.edges[] rempli.
//                Les non-crypto sont tradable:false par defaut (aucun edge valide au 16.06).
// ════════════════════════════════════════════════════════════════════

const CRYPTO = "BTC,ETH,SOL,BNB,XRP,DOGE,AVAX,LINK,ADA,SUI,LTC,DOT,TON,NEAR,HYPE,HBAR,ONDO,ASTER,TAO".split(",");

// "Meilleurs stocks" = Magnificent 7 (les + liquides, perps Bybit drop-in, decorreles crypto).
// Spike demo 16.06 : les 7 perps place/cancel OK sur demo. Histo perp ~42-57j (recent) ->
// forward-test (PENDING <60j, s'activent seuls). Le token SPOT xStock (NVDAX ~350j) pourra
// servir de PROXY d'historique pour /edge-sprint (meme sous-jacent). class:equity.
const MAG7 = [
  ["AAPL", "APPLE"], ["MSFT", "MICROSOFT"], ["NVDA", "NVIDIA"], ["AMZN", "AMAZON"],
  ["GOOGL", "ALPHABET"], ["META", "META"], ["TSLA", "TESLA"],
];

const REGISTRY = [
  // --- crypto (inchange : meme ccxt, swap, 24x7) — SEULE classe tradable au 16.06 ---
  ...CRYPTO.map((s) => ({
    symbol: s, ccxt: `${s}/USDT:USDT`, class: "crypto", venue: "bybit",
    marketType: "swap", quote: "USDT", session: "24x7", underlying: s, edges: [], enabled: true, tradable: true,
  })),
  // --- commodity perp (or) ---
  { symbol: "XAUT", ccxt: "XAUT/USDT:USDT", class: "commodity", venue: "bybit",
    marketType: "swap", quote: "USDT", session: "metals", underlying: "GOLD", edges: [], enabled: true, tradable: false },
  // --- ETF indiciels (perp) ---
  { symbol: "SPY", ccxt: "SPY/USDT:USDT", class: "etf", venue: "bybit",
    marketType: "swap", quote: "USDT", session: "us_equity", underlying: "SP500", edges: [], enabled: true, tradable: false },
  { symbol: "QQQ", ccxt: "QQQ/USDT:USDT", class: "etf", venue: "bybit",
    marketType: "swap", quote: "USDT", session: "us_equity", underlying: "NASDAQ100", edges: [], enabled: true, tradable: false },
  // --- actions individuelles (Magnificent 7, perps) ---
  ...MAG7.map(([s, u]) => ({
    symbol: s, ccxt: `${s}/USDT:USDT`, class: "equity", venue: "bybit",
    marketType: "swap", quote: "USDT", session: "us_equity", underlying: u, edges: [], enabled: true, tradable: false,
  })),
  // --- SpaceX (perp SPCX, tokenise pre-IPO / prive : pas de marche cash -> session 24x7).
  //     Spike demo 16.06 : SPCX/USDT:USDT place/cancel OK. Tres recent (~2j histo) -> PENDING jusqu'a >=60j. ---
  { symbol: "SPCX", ccxt: "SPCX/USDT:USDT", class: "equity", venue: "bybit",
    marketType: "swap", quote: "USDT", session: "24x7", underlying: "SPACEX_PRIVATE", edges: [], enabled: true, tradable: false },
];

const _bySym = new Map(REGISTRY.map((e) => [e.symbol, e]));

function all() { return REGISTRY.slice(); }
function bySymbol(sym) { return _bySym.get(sym) || null; }
function byClass(cls) { return REGISTRY.filter((e) => e.class === cls); }
function classOf(sym) { const e = _bySym.get(sym); return e ? e.class : null; }
function sessionOf(sym) { const e = _bySym.get(sym); return e ? e.session : null; }
function enabledEntries() { return REGISTRY.filter((e) => e.enabled !== false); }
function enabledSymbols() { return enabledEntries().map((e) => e.symbol); }
function enabledCcxt() { return enabledEntries().map((e) => e.ccxt); }
// isTradable : la routine PEUT-elle armer cet actif ? En DEMO_ACTIVE (16.06, GO Hugo) on teste l'infra
// sur TOUTES les classes (non-crypto inclus) -> un actif enabled est tradable meme sans edge valide OOS.
// L'historique suffisant reste gate par le scan (rows insufficient_history -> pas de setup) et la session
// reste de l'observabilite (gap warn). Hors DEMO_ACTIVE -> seuls les actifs tradable:true (crypto).
function isTradable(sym, opts) {
  const e = _bySym.get(sym);
  if (!e) return false;
  if (e.tradable) return true;
  const demo = (opts && opts.demo != null) ? !!opts.demo : !!process.env.DEMO_ACTIVE;
  return demo && e.enabled !== false;
}
function tradableSymbols(opts) { return REGISTRY.filter((e) => isTradable(e.symbol, opts)).map((e) => e.symbol); }

// sessionOpen(session, date) : le marche cash sous-jacent est-il ouvert ?
// OBSERVABILITE pour les perps qui trackent un actif a heures (SPY/QQQ/or) :
// le perp tourne 24/7 mais le sous-jacent gappe au close/open (vendredi soir,
// lundi matin, earnings). On NE bloque pas — on DRAPEAUTE le risque de gap.
// NB DST : juin = EDT (ET=UTC-4). Repasser ET_OFFSET a 5 en heure d'hiver
// (meme note que routines/register-tasks.ps1).
const ET_OFFSET = 4; // EDT
function sessionOpen(session, date) {
  const d = date || new Date();
  if (session === "24x7") return { open: true, reason: "24x7" };
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const weekend = dow === 0 || dow === 6;
  if (session === "metals") {
    // or cash ~ ferme le week-end (approx) ; ouvert en semaine
    return { open: !weekend, reason: weekend ? "weekend" : "weekday" };
  }
  if (session === "us_equity") {
    if (weekend) return { open: false, reason: "weekend" };
    // RTH 09:30-16:00 ET -> en UTC = +ET_OFFSET
    const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
    const openMin = (9 * 60 + 30) + ET_OFFSET * 60;
    const closeMin = (16 * 60) + ET_OFFSET * 60;
    const isOpen = mins >= openMin && mins < closeMin;
    return { open: isOpen, reason: isOpen ? "RTH" : "outside_RTH" };
  }
  return { open: true, reason: "unknown_session" };
}

// carryWarn : funding du perp anormalement eleve (%/8h). Cost-of-carry des
// perps equity/commodity peut etre grand -> drapeau (jamais un blocage).
function carryWarn(fundingPct, threshold) {
  if (fundingPct == null || !isFinite(fundingPct)) return false;
  const thr = threshold == null ? 0.1 : threshold;
  return Math.abs(fundingPct) >= thr;
}

// classBreakdown : agrege n + risque% par classe d'actif. PUR. getClass/getRisk
// = accesseurs (le trade peut nommer son symbole differemment selon le contexte).
function classBreakdown(trades, getClass, getRisk) {
  const out = {};
  for (const t of trades || []) {
    const cls = (getClass ? getClass(t) : null) || "unknown";
    const risk = Number(getRisk ? getRisk(t) : 0) || 0;
    if (!out[cls]) out[cls] = { n: 0, risk_pct: 0 };
    out[cls].n += 1;
    out[cls].risk_pct += risk;
  }
  return out;
}

module.exports = {
  all, bySymbol, byClass, classOf, sessionOf, enabledEntries, enabledSymbols, enabledCcxt,
  isTradable, tradableSymbols, sessionOpen, carryWarn, classBreakdown, REGISTRY,
};
