"use strict";

// ═══════════════════════════════════════════════════════════════════
// Bybit V5 perpetuals skill (ccxt) — scaled bracket execution.
// Demo trading by default (BYBIT_DEMO=1). Mirrors the Hyperliquid skill:
// same dispatcher pattern, same bracket shape + guard-rails + dry_run.
// ═══════════════════════════════════════════════════════════════════

const ccxt = require("ccxt");
const fs = require("fs");
const path = require("path");

// ── .env auto-load (zero-dep, never overrides set vars) ─────────────
function loadEnvFile() {
  const candidates = [
    path.join(__dirname, "..", "..", "config", ".env"),
    path.join(__dirname, "..", "..", ".env"),
    path.join(__dirname, ".env"),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf-8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (k && process.env[k] === undefined) process.env[k] = v;
    }
  }
}
loadEnvFile();

// ── Configuration ───────────────────────────────────────────────────
const IS_DEMO = process.env.BYBIT_DEMO !== "0";        // demo trading by default
const IS_TESTNET = process.env.BYBIT_TESTNET === "1";  // optional: classic testnet

let _client = null;
function getClient() {
  if (_client) return _client;
  const apiKey = process.env.BYBIT_API_KEY;
  const secret = process.env.BYBIT_API_SECRET;
  if (!apiKey || !secret) {
    throw new Error("Missing BYBIT_API_KEY / BYBIT_API_SECRET. Set them before any signed Bybit operation.");
  }
  _client = new ccxt.bybit({
    apiKey,
    secret,
    enableRateLimit: true,
    options: { defaultType: "swap", recvWindow: 10000, adjustForTimeDifference: true },
  });
  if (IS_TESTNET) _client.setSandboxMode(true);
  else if (IS_DEMO) _client.enableDemoTrading(true);
  return _client;
}

// Resolve the local↔server clock skew once before any signed request
// (Windows clocks often drift > Bybit's 1000 ms ahead-tolerance → retCode 10002).
async function ensureReady() {
  const c = getClient();
  if (!c._timeSynced) {
    await c.loadTimeDifference();
    c._timeSynced = true;
  }
  return c;
}

// Public client for read-only market data that needs no keys.
let _pub = null;
function getPublic() {
  if (!_pub) {
    _pub = new ccxt.bybit({ enableRateLimit: true, options: { defaultType: "swap" } });
    if (IS_TESTNET) _pub.setSandboxMode(true);
  }
  return _pub;
}

// ── Helpers ─────────────────────────────────────────────────────────
// Normalize a ticker to a ccxt linear-perp symbol: BTC | BTCUSDT | BTCUSDT.P → BTC/USDT:USDT
function normalizeSymbol(sym) {
  if (!sym) throw new Error("symbol is required");
  let s = String(sym).toUpperCase().trim();
  if (s.includes("/")) return s;
  s = s.replace(/\.P$/, "").replace(/PERP$/, "");
  const m = s.match(/^([A-Z0-9]+?)(USDT|USDC|USD)$/);
  if (m) return `${m[1]}/${m[2]}:${m[2]}`;
  return `${s}/USDT:USDT`;
}

function normalizeSide(side) {
  const s = String(side).toLowerCase();
  if (s === "buy" || s === "long") return "buy";
  if (s === "sell" || s === "short") return "sell";
  throw new Error(`Invalid side "${side}" (expected long/short/buy/sell)`);
}

function round(n, d = 8) {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

// ── Marge ISOLEE par position (au lieu de cross) : risque cloisonne par symbole.
// Pure : construit l'intention ; isBenign avale l'erreur idempotente Bybit (110026 deja isole).
function _isolatedMarginCall(symbol, leverage) {
  return { marginMode: "isolated", symbol, leverage };
}
_isolatedMarginCall.isBenign = (e) =>
  /not modified|110026|leverage not modified|110043/i.test(String((e && e.message) || e));

// Applique la marge isolee de facon idempotente (best-effort, ne casse pas le bracket si deja set).
// Levier defaut 10 (env RM_ISO_LEVERAGE) = headroom de marge ; n'affecte PAS le R:R (geometrie TP/SL),
// le SL (au plus 2xATR) saute TOUJOURS bien avant la liquidation (~10% a 10x).
async function ensureIsolatedMargin(c, sym, leverage = +(process.env.RM_ISO_LEVERAGE || 10)) {
  try {
    await c.setMarginMode("isolated", sym, { leverage });
  } catch (e) {
    if (!_isolatedMarginCall.isBenign(e)) throw e; // vraie erreur -> remonte ; idempotent -> ignore
  }
}

// ═══════════════════════════════════════════════════════════════════
// TOOLS — read-only
// ═══════════════════════════════════════════════════════════════════
async function bybit_healthcheck() {
  const result = {
    mode: IS_TESTNET ? "TESTNET" : IS_DEMO ? "DEMO" : "MAINNET",
    has_api_key: Boolean(process.env.BYBIT_API_KEY),
    has_api_secret: Boolean(process.env.BYBIT_API_SECRET),
    ccxt_version: ccxt.version,
  };
  try {
    const t = await getPublic().fetchTime();
    result.api_reachable = true;
    result.server_time = t;
  } catch (e) {
    result.api_reachable = false;
    result.error = e.message;
  }
  return result;
}

async function bybit_get_ticker({ symbol }) {
  return getPublic().fetchTicker(normalizeSymbol(symbol));
}

async function bybit_get_balance() {
  return (await ensureReady()).fetchBalance();
}

async function bybit_get_positions({ symbol } = {}) {
  const c = await ensureReady();
  return symbol ? c.fetchPositions([normalizeSymbol(symbol)]) : c.fetchPositions();
}

// ═══════════════════════════════════════════════════════════════════
// TOOLS — scaled bracket
// ═══════════════════════════════════════════════════════════════════
/**
 * Place a full bracket on Bybit (demo by default):
 *   limit entry + stop-loss (full size, reduce-only) + N scaled take-profits.
 *
 * Guard-rails (anti fat-finger), identical to the Hyperliquid wrapper:
 *   long  : stop_loss_px < entry_px < every TP
 *   short : stop_loss_px > entry_px > every TP
 *
 * @param {string} symbol         e.g. "BTC", "BTCUSDT", "BTC/USDT:USDT"
 * @param {string} side           long|short (or buy|sell)
 * @param {number} amount         total position size (base asset)
 * @param {number} entry_px       limit entry price
 * @param {number} stop_loss_px   REQUIRED stop-loss trigger price
 * @param {Array<{px:number,frac:number}>} take_profits  scale-out ladder (fracs sum ~1.0)
 * @param {boolean} [dry_run]     true = build the order plan WITHOUT sending
 */
async function bybit_place_bracket_scaled({ symbol, side, amount, entry_px, stop_loss_px, take_profits, dry_run = false }) {
  if (stop_loss_px === undefined || stop_loss_px === null) {
    throw new Error("stop_loss_px is required -- every bracket must have a stop-loss");
  }
  if (!Array.isArray(take_profits) || take_profits.length === 0) {
    throw new Error("take_profits must be a non-empty array of { px, frac }");
  }

  const sym = normalizeSymbol(symbol);
  const entrySide = normalizeSide(side);
  const exitSide = entrySide === "buy" ? "sell" : "buy";
  const isLong = entrySide === "buy";
  const entry = Number(entry_px);
  const sl = Number(stop_loss_px);
  const tpPxs = take_profits.map((t) => Number(t.px));

  // ── Guard-rails ──
  if (isLong) {
    if (!(sl < entry)) throw new Error(`Long bracket: stop_loss_px (${sl}) must be < entry_px (${entry})`);
    if (!tpPxs.every((p) => p > entry)) throw new Error(`Long bracket: every take-profit must be > entry_px (${entry})`);
  } else {
    if (!(sl > entry)) throw new Error(`Short bracket: stop_loss_px (${sl}) must be > entry_px (${entry})`);
    if (!tpPxs.every((p) => p < entry)) throw new Error(`Short bracket: every take-profit must be < entry_px (${entry})`);
  }
  const fracSum = take_profits.reduce((s, t) => s + Number(t.frac), 0);
  if (Math.abs(fracSum - 1) > 0.02) throw new Error(`take_profits fractions must sum to ~1.0 (got ${fracSum.toFixed(3)})`);

  // ── Size split (last TP absorbs rounding remainder) ──
  const total = round(Number(amount));
  let allocated = 0;
  const tpAlloc = take_profits.map((t, i) => {
    const a = i === take_profits.length - 1 ? round(total - allocated) : round(total * Number(t.frac));
    if (i !== take_profits.length - 1) allocated = round(allocated + a);
    return { px: Number(t.px), amount: a };
  }).filter((t) => t.amount > 0);

  // ── Intended ccxt calls (the plan) ──
  // Bybit V5 rejects plain reduce-only orders while the position is zero
  // (retCode 110017). CONDITIONAL reduce-only orders (with triggerPrice) ARE
  // accepted pre-fill and activate once price hits the trigger. So, like the
  // Hyperliquid wrapper, every exit is a conditional market reduce-only order:
  //   SL  → triggers in the loss direction   (long: below entry, short: above)
  //   TPn → triggers in the profit direction  (long: above entry, short: below)
  // Live model is TWO-PHASE: market entry opens the position, then SL + TP
  // conditionals are attached (Bybit rejects pre-fill reduce-only / wrong-side
  // triggers). The plan mirrors that order.
  const plan = [
    { tool: "createOrder", symbol: sym, type: "market", side: entrySide, amount: total, price: undefined, params: {}, phase: "entry" },
    { tool: "createOrder", symbol: sym, type: "market", side: exitSide, amount: total, price: undefined, phase: "exit",
      params: { reduceOnly: true, triggerPrice: sl, triggerDirection: isLong ? "below" : "above" } },
    ...tpAlloc.map((t) => ({
      tool: "createOrder", symbol: sym, type: "market", side: exitSide, amount: t.amount, price: undefined, phase: "exit",
      params: { reduceOnly: true, triggerPrice: t.px, triggerDirection: isLong ? "above" : "below" },
    })),
  ];

  const summary = {
    symbol: sym, side: isLong ? "long" : "short", mode: IS_TESTNET ? "TESTNET" : IS_DEMO ? "DEMO" : "MAINNET",
    execution_model: "two-phase: market entry -> attach SL + scale-out TPs",
    entry_px: entry, stop_loss_px: sl, take_profits: tpAlloc, total_amount: total, order_count: plan.length,
  };

  if (dry_run) return { dry_run: true, plan_summary: summary, plan };

  // ── Live submission (two-phase) ──
  // Bybit validates conditional trigger direction against the CURRENT price and
  // rejects plain reduce-only orders while flat (retCode 110017 / 110092). So we
  // open the position FIRST (market entry), then attach SL + scale-out TPs once
  // the position exists and current price ≈ entry. SL/TP levels must therefore be
  // realistic vs the live market (long: SL below / TPs above current, and vice-versa).
  const c = await ensureReady();
  await c.loadMarkets();
  await ensureIsolatedMargin(c, sym); // marge ISOLEE par position (idempotent), avant tout ordre
  const amt = (x) => c.amountToPrecision(sym, x);
  const pxp = (x) => c.priceToPrecision(sym, x);

  // 1. Market entry → opens the position
  const entryOrder = await c.createOrder(sym, "market", entrySide, amt(total), undefined, {});

  // 2. Wait for the fill (demo fills fast; poll up to ~5s)
  let pos = null;
  for (let i = 0; i < 10; i++) {
    const ps = await c.fetchPositions([sym]);
    pos = ps.find((p) => Math.abs(Number(p.contracts || 0)) > 0);
    if (pos) break;
    await c.sleep(500);
  }
  if (!pos) {
    return { submitted: true, partial: true, mode: summary.mode, entry_id: entryOrder.id,
      warning: "Entry placed but position not detected yet — attach SL/TP via bybit_set_exits once filled." };
  }

  // 3. Attach SL (full) + scale-out TPs (conditional reduce-only market)
  const exits = [];
  exits.push({ role: "sl", ...(await c.createOrder(sym, "market", exitSide, amt(total), undefined,
    { reduceOnly: true, triggerPrice: pxp(sl), triggerDirection: isLong ? "below" : "above" })) });
  for (const t of tpAlloc) {
    exits.push({ role: "tp", px: t.px, ...(await c.createOrder(sym, "market", exitSide, amt(t.amount), undefined,
      { reduceOnly: true, triggerPrice: pxp(t.px), triggerDirection: isLong ? "above" : "below" })) });
  }

  return {
    submitted: true, mode: summary.mode,
    position: { contracts: pos.contracts, entryPrice: pos.entryPrice },
    entry_id: entryOrder.id,
    exits: exits.map((e) => ({ role: e.role, px: e.px, id: e.id })),
    plan_summary: summary,
  };
}

/**
 * Place a RESTING limit-entry bracket: limit entry (waits at entry_px) +
 * conditional reduce-only SL + scale-out TP ladder. Unlike bybit_place_bracket_scaled
 * (market entry), the entry rests until price reaches entry_px.
 *
 * Conditional exits are accepted pre-fill ONLY if their trigger sits on the
 * correct side of the CURRENT price:
 *   short-the-bounce (entry above price): SL above (rising) + TPs below (falling) ✓
 *   long-the-dip     (entry below price): SL below (falling) + TPs above (rising) ✓
 *
 * @param {boolean} [hedge]  true → hedge mode (positionIdx 1=long / 2=short) so
 *                           an opposite-direction bracket can coexist on the same symbol.
 */
async function bybit_place_limit_bracket({ symbol, side, amount, entry_px, stop_loss_px, take_profits, hedge = false, dry_run = false }) {
  if (stop_loss_px === undefined || stop_loss_px === null) throw new Error("stop_loss_px is required");
  if (!Array.isArray(take_profits) || take_profits.length === 0) throw new Error("take_profits must be a non-empty array of { px, frac }");

  const sym = normalizeSymbol(symbol);
  const entrySide = normalizeSide(side);
  const exitSide = entrySide === "buy" ? "sell" : "buy";
  const isLong = entrySide === "buy";
  const entry = Number(entry_px), sl = Number(stop_loss_px);
  const tpPxs = take_profits.map((t) => Number(t.px));

  if (isLong) {
    if (!(sl < entry)) throw new Error(`Long bracket: stop_loss_px (${sl}) must be < entry_px (${entry})`);
    if (!tpPxs.every((p) => p > entry)) throw new Error(`Long bracket: every take-profit must be > entry_px (${entry})`);
  } else {
    if (!(sl > entry)) throw new Error(`Short bracket: stop_loss_px (${sl}) must be > entry_px (${entry})`);
    if (!tpPxs.every((p) => p < entry)) throw new Error(`Short bracket: every take-profit must be < entry_px (${entry})`);
  }
  const fracSum = take_profits.reduce((s, t) => s + Number(t.frac), 0);
  if (Math.abs(fracSum - 1) > 0.02) throw new Error(`take_profits fractions must sum to ~1.0 (got ${fracSum.toFixed(3)})`);

  const total = round(Number(amount));
  let allocated = 0;
  const tpAlloc = take_profits.map((t, i) => {
    const a = i === take_profits.length - 1 ? round(total - allocated) : round(total * Number(t.frac));
    if (i !== take_profits.length - 1) allocated = round(allocated + a);
    return { px: Number(t.px), amount: a };
  }).filter((t) => t.amount > 0);

  const posIdx = hedge ? (isLong ? 1 : 2) : 0;
  const ep = hedge ? { positionIdx: posIdx } : {};
  const xp = (trig, dir) => ({ reduceOnly: true, triggerPrice: trig, triggerDirection: dir, ...(hedge ? { positionIdx: posIdx } : {}) });

  const plan = [
    { type: "limit", side: entrySide, amount: total, price: entry, params: ep, role: "entry" },
    { type: "market", side: exitSide, amount: total, price: undefined, params: xp(sl, isLong ? "below" : "above"), role: "sl" },
    ...tpAlloc.map((t) => ({ type: "market", side: exitSide, amount: t.amount, price: undefined, params: xp(t.px, isLong ? "above" : "below"), role: "tp", px: t.px })),
  ];
  const summary = {
    symbol: sym, side: isLong ? "long" : "short", mode: IS_TESTNET ? "TESTNET" : IS_DEMO ? "DEMO" : "MAINNET",
    hedge, entry_px: entry, stop_loss_px: sl, take_profits: tpAlloc, total_amount: total, order_count: plan.length,
  };
  if (dry_run) return { dry_run: true, plan_summary: summary, plan };

  const c = await ensureReady();
  await c.loadMarkets();
  await ensureIsolatedMargin(c, sym); // marge ISOLEE par position (idempotent), avant tout ordre
  const results = [], deferred_tps = [];
  for (const o of plan) {
    const amt = c.amountToPrecision(sym, o.amount);
    const px = o.price !== undefined ? c.priceToPrecision(sym, o.price) : undefined;
    const params = { ...o.params };
    if (params.triggerPrice !== undefined) params.triggerPrice = c.priceToPrecision(sym, params.triggerPrice);
    try {
      const r = await c.createOrder(sym, o.type, o.side, amt, px, params);
      results.push({ role: o.role, px: o.px, id: r.id });
    } catch (e) {
      // ENTREE + SL = OBLIGATOIRES : on propage (jamais de position nue). Mais un TP refuse par Bybit
      // AVANT le fill (110093 : trigger du mauvais cote du prix courant, cas d'un fade limit ou le TP
      // est au-dela du prix actuel) est DIFFERE au fill (la position reste protegee par le SL ; la
      // detection missing_tp re-posera le TP une fois la position remplie). Evite le bracket partiel
      // orphelin (entree+SL sans TP qui throw) = racine des "trades sans TP" cote radar/auto.
      const msg = (e && e.message) || String(e);
      const deferrable = o.role === "tp" && /110093|trigger|Falling|Rising|expect/i.test(msg);
      if (deferrable) { deferred_tps.push({ px: o.px, amount: o.amount, reason: msg.slice(0, 140) }); continue; }
      throw e;
    }
  }
  return { submitted: true, ...summary, results, deferred_tps };
}

// ═══════════════════════════════════════════════════════════════════
// GESTION DE POSITION ACTIVE — trailing SL, accumulation, prise de profit
// ═══════════════════════════════════════════════════════════════════

// Identifie l'ordre SL conditionnel d'une position (côté perte de l'entrée).
async function _findSlOrders(c, sym, pos) {
  let st = []; try { st = await c.fetchOpenOrders(sym, undefined, undefined, { orderFilter: "StopOrder" }); } catch (e) {}
  const entry = Number(pos.entryPrice);
  const trig = (o) => Number(o.triggerPrice || (o.info && o.info.triggerPrice) || 0);
  return pos.side === "long" ? st.filter((o) => trig(o) > 0 && trig(o) < entry) : st.filter((o) => trig(o) > 0 && trig(o) > entry);
}

/**
 * Déplacer le stop-loss d'une position ouverte (trailing / montée du SL pour
 * protéger ou soutenir une position qu'on garde). Annule l'ancien SL + repose au new_sl.
 */
async function bybit_move_sl({ symbol, new_sl }) {
  const c = await ensureReady(); await c.loadMarkets();
  const sym = normalizeSymbol(symbol);
  const ps = (await c.fetchPositions([sym])).filter((p) => Math.abs(Number(p.contracts || 0)) > 0);
  if (!ps.length) throw new Error(`Aucune position ouverte sur ${sym}`);
  const pos = ps[0]; const isLong = pos.side === "long";
  const px = (await c.fetchTicker(sym)).last; const entry = Number(pos.entryPrice);
  if (isLong && Number(new_sl) >= px) throw new Error(`Long: new_sl (${new_sl}) doit etre < prix courant (${px})`);
  if (!isLong && Number(new_sl) <= px) throw new Error(`Short: new_sl (${new_sl}) doit etre > prix courant (${px})`);
  const sl = await _findSlOrders(c, sym, pos);
  for (const o of sl) { try { await c.cancelOrder(o.id, sym, { trigger: true }); } catch (e) {} }
  const size = Math.abs(Number(pos.contracts)); const exitSide = isLong ? "sell" : "buy";
  const r = await c.createOrder(sym, "market", exitSide, c.amountToPrecision(sym, size), undefined,
    { reduceOnly: true, triggerPrice: c.priceToPrecision(sym, new_sl), triggerDirection: isLong ? "below" : "above" });
  return { moved: true, symbol: sym, side: pos.side, size, entry, old_sl_cancelled: sl.length, new_sl: Number(new_sl),
    locks_profit: isLong ? Number(new_sl) > entry : Number(new_sl) < entry, sl_order_id: r.id };
}

/**
 * Accumuler (scale-in) : ajoute à une position gagnante. Optionnellement
 * remonte le SL (new_sl) pour couvrir la taille totale et soutenir la position.
 * ⚠️ N'accumuler qu'un GAGNANT avec thèse renforcée + SL déplacé au breakeven.
 */
async function bybit_scale_in({ symbol, add_size, new_sl }) {
  const c = await ensureReady(); await c.loadMarkets();
  const sym = normalizeSymbol(symbol);
  const ps = (await c.fetchPositions([sym])).filter((p) => Math.abs(Number(p.contracts || 0)) > 0);
  if (!ps.length) throw new Error(`Aucune position a accumuler sur ${sym}`);
  const side = ps[0].side === "long" ? "buy" : "sell";
  const add = await c.createOrder(sym, "market", side, c.amountToPrecision(sym, add_size), undefined, {});
  let slResult = null;
  if (new_sl !== undefined && new_sl !== null) { await c.sleep(900); slResult = await bybit_move_sl({ symbol, new_sl }); }
  const np = (await c.fetchPositions([sym])).filter((p) => Math.abs(Number(p.contracts || 0)) > 0)[0];
  return { scaled_in: true, symbol: sym, added: Number(add_size), entry_order: add.id,
    new_total: np ? Number(np.contracts) : null, new_avg_entry: np ? Number(np.entryPrice) : null, sl: slResult };
}

/**
 * Prendre une partie des bénéfices (scale-out dynamique) : ferme `fraction`
 * de la position au marché (reduce-only). Le reste continue de courir.
 */
async function bybit_take_partial({ symbol, fraction }) {
  const c = await ensureReady(); await c.loadMarkets();
  const sym = normalizeSymbol(symbol);
  const ps = (await c.fetchPositions([sym])).filter((p) => Math.abs(Number(p.contracts || 0)) > 0);
  if (!ps.length) throw new Error(`Aucune position sur ${sym}`);
  const pos = ps[0]; const f = Math.min(1, Math.max(0.01, Number(fraction)));
  const qty = Math.abs(Number(pos.contracts)) * f; const side = pos.side === "long" ? "sell" : "buy";
  const r = await c.createOrder(sym, "market", side, c.amountToPrecision(sym, qty), undefined, { reduceOnly: true });
  return { took_partial: true, symbol: sym, fraction: f, closed_qty: +c.amountToPrecision(sym, qty),
    remaining: +(Math.abs(Number(pos.contracts)) - qty).toFixed(6), order_id: r.id };
}

/**
 * Trailing stop NATIF Bybit : le SL suit le prix en continu (côté serveur),
 * protège un gagnant même entre les sessions de la routine. Remplace le SL
 * statique (conditionnel) par défaut pour éviter le double stop.
 * @param distance  écart de trailing en PRIX (ex. 500 pour BTC = 500 USDT)
 * @param active_price  prix d'activation optionnel (le trailing démarre quand atteint)
 */
async function bybit_set_trailing_stop({ symbol, distance, active_price, replace_static_sl = true }) {
  const c = await ensureReady(); await c.loadMarkets();
  const sym = normalizeSymbol(symbol);
  const ps = (await c.fetchPositions([sym])).filter((p) => Math.abs(Number(p.contracts || 0)) > 0);
  if (!ps.length) throw new Error(`Aucune position sur ${sym}`);
  if (replace_static_sl) {
    const sl = await _findSlOrders(c, sym, ps[0]);
    for (const o of sl) { try { await c.cancelOrder(o.id, sym, { trigger: true }); } catch (e) {} }
  }
  const market = c.market(sym);
  const params = { category: "linear", symbol: market.id, trailingStop: String(c.priceToPrecision(sym, distance)), positionIdx: 0 };
  if (active_price) params.activePrice = String(c.priceToPrecision(sym, active_price));
  const r = await c.privatePostV5PositionTradingStop(params);
  return { trailing_set: r.retCode === 0 || r.retCode === "0", symbol: sym, side: ps[0].side, distance: Number(distance), active_price: active_price || null, static_sl_remplace: replace_static_sl, retMsg: r.retMsg };
}

async function bybit_set_position_mode({ symbol, hedge }) {
  const c = await ensureReady();
  await c.loadMarkets();
  return c.setPositionMode(Boolean(hedge), normalizeSymbol(symbol));
}

async function bybit_cancel_all({ symbol }) {
  // Bybit keeps conditional (SL/TP trigger) orders in a separate list that a
  // default cancel-all misses — cancel both regular AND stop orders.
  const c = await ensureReady();
  const sym = symbol ? normalizeSymbol(symbol) : undefined;
  const out = { regular: null, conditional: null };
  try { out.regular = await c.cancelAllOrders(sym); } catch (e) { out.regular = { error: e.message }; }
  try { out.conditional = await c.cancelAllOrders(sym, { orderFilter: "StopOrder" }); } catch (e) { out.conditional = { error: e.message }; }
  return out;
}

async function bybit_close_position({ symbol }) {
  const c = await ensureReady();
  const sym = normalizeSymbol(symbol);
  const positions = await c.fetchPositions([sym]);
  const pos = positions.find((p) => Math.abs(Number(p.contracts || 0)) > 0);
  if (!pos) return { status: "ok", msg: `No open position for ${sym}` };
  const closeSide = pos.side === "long" ? "sell" : "buy";
  return c.createOrder(sym, "market", closeSide, Math.abs(Number(pos.contracts)), undefined, { reduceOnly: true });
}

// ── Dispatcher ──────────────────────────────────────────────────────
const TOOLS = {
  bybit_healthcheck,
  bybit_get_ticker,
  bybit_get_balance,
  bybit_get_positions,
  bybit_place_bracket_scaled,
  bybit_place_limit_bracket,
  bybit_move_sl,
  bybit_scale_in,
  bybit_take_partial,
  bybit_set_trailing_stop,
  bybit_set_position_mode,
  bybit_cancel_all,
  bybit_close_position,
};

if (require.main === module) {
  const [, , toolName, rawParams] = process.argv;
  if (!toolName || !TOOLS[toolName]) {
    console.error("Usage: node index.js <toolName> '<json>'");
    console.error("Available: " + Object.keys(TOOLS).join(", "));
    process.exit(1);
  }
  const params = rawParams ? JSON.parse(rawParams) : {};
  TOOLS[toolName](params)
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = async (toolName, params) => {
  if (!TOOLS[toolName]) throw new Error(`Unknown tool: ${toolName}`);
  return TOOLS[toolName](params);
};
// Helper pur expose pour les tests offline (marge isolee).
module.exports._isolatedMarginCall = _isolatedMarginCall;
