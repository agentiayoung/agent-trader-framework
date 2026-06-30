"use strict";
// monitor-exec.js — EXECUTION RISK-REDUCING du plan de monitoring (Phase A, 25.06).
//
// BUT : le moteur de jugement (thesis.js -> planMonitoring, monitor.js) produit DEJA, par position,
// un verdict + une action (cut / prise de profit / continuation / tighten). Jusqu'ici ces actions
// etaient ALERTEES mais jamais EXECUTEES (gate "auto-exec = GO Hugo"). Ce module traduit un item de
// plan en INTENTIONS d'execution CONCRETES, derriere une WHITELIST stricte : SEULES les actions qui
// REDUISENT le risque sont permises (prendre un partiel, resserrer un SL, poser un SL manquant, poser
// un trailing). JAMAIS ouvrir, flipper, scale-in, ni ELARGIR un SL. Le LLM n'est PAS dans la boucle :
// le jugement est deterministe (thesis), ce module ne fait que MAPPER -> ordre Bybit, de facon
// idempotente et bornee. Pur + offline -> teste (tests/test-monitor-exec.js).
//
// Mapping verdict -> action (monitor.js actionForVerdict) -> intention :
//   flipped   -> take_partial_be   = CUT : banque un partiel + SL au point mort (si en profit) / resserre (si en perte)
//   mature    -> take_partial_lock = PRISE DE PROFIT : banque un partiel + resserre le SL
//   running   -> set_trailing      = CONTINUATION : trailing sur le gain (>=1R)
//   weakening -> tighten_sl        = resserre le SL vers le point mort / vers le prix
//   (place_sl = position NUE : pose le SL prevu -- protection)
//   keep / keep_trail_watch / hold_to_sl_or_reduce -> noop (alerte seule)

// Actions de plan que l'on accepte d'EXECUTER (toutes risk-reducing).
const EXECUTABLE = new Set(["place_sl", "take_partial_be", "take_partial_lock", "set_trailing", "tighten_sl", "time_stop_close"]);

const num = (x) => (x == null || x === "" ? null : Number(x));

// Un SL est-il PLUS SERRE que l'actuel (cote correct du prix) ? long: plus haut ; short: plus bas.
function isTighter(side, currentSl, newSl) {
  if (newSl == null || !isFinite(newSl)) return false;
  if (currentSl == null || !isFinite(currentSl)) return true; // pas de SL -> tout SL valide est "plus serre"
  return side === "long" ? newSl > currentSl : newSl < currentSl;
}

// Cible de resserrement SURE : (a) du bon cote du prix (long: SL < px ; short: SL > px) sinon le SL
// se declenche au marche immediatement (pire qu'attendre), (b) plus serre que l'actuel. Prefere le
// point mort (entry +/- buffer) s'il est en profit ; sinon resserre VERS le prix sans le croiser.
// Retourne null si aucun resserrement sur n'est possible (noop).
// FIX 26.06 (parite scalp, bug XAUT short SL bete -0.72R) : on ne resserre le SL d'une position EN
// PERTE/FLAT JAMAIS vers le prix (l'ancien code collait le SL a px+/-0.5xATR -> anéantissait l'anti-sweep
// et convertissait du bruit en stop). Le SL = ligne d'INVALIDATION ; on ne le bouge qu'a BREAKEVEN quand
// le trade est EN PROFIT. En perte -> NOOP. opts.allowTowardPrice (env MONITOR_TIGHTEN_TOWARD_PRICE=1) = legacy.
function safeTightenSl({ side, px, entry, currentSl, atr, beBufferPct = 0.001, minGapAtr = 0.5, allowTowardPrice = false }) {
  px = num(px); entry = num(entry); currentSl = num(currentSl); atr = num(atr);
  if (px == null) return null;
  const gap = atr != null && atr > 0 ? atr * minGapAtr : px * 0.003; // distance mini SL<->px (anti-bruit)
  if (side === "long") {
    const inProfit = entry != null && px > entry;
    const be = entry != null ? entry * (1 + beBufferPct) : null;
    let target;
    if (inProfit && be != null && be < px) target = be; // EN PROFIT -> breakeven
    else if (allowTowardPrice) target = px - gap;       // legacy
    else return null;                                   // EN PERTE/FLAT -> NOOP (garde anti-sweep)
    if (target >= px) target = px - gap;
    return isTighter("long", currentSl, target) ? +target : null;
  } else {
    const inProfit = entry != null && px < entry;
    const be = entry != null ? entry * (1 - beBufferPct) : null;
    let target;
    if (inProfit && be != null && be > px) target = be; // EN PROFIT -> breakeven
    else if (allowTowardPrice) target = px + gap;       // legacy
    else return null;                                   // EN PERTE/FLAT -> NOOP
    if (target <= px) target = px + gap;
    return isTighter("short", currentSl, target) ? +target : null;
  }
}

// Trailing distance (prix absolu) = trailAtrMult * ATR ; active a partir du prix courant.
function trailingParams({ px, atr, trailAtrMult = 1.5 }) {
  px = num(px); atr = num(atr);
  if (px == null || atr == null || !(atr > 0)) return null;
  return { distance: +(atr * trailAtrMult).toFixed(8), active_price: +px };
}

// manageIntents : item de plan + position -> { do, intents:[], tag, skip }
// pos : { symbol, side, entry, px, stop_loss, size, atr, managed:[] }
// managed : tags d'actions one-shot deja faites pour cette position (anti re-cut a chaque tick).
function manageIntents(plan, pos, opts = {}) {
  const action = plan && plan.action;
  if (!EXECUTABLE.has(action)) return { do: false, intents: [], skip: `action non executable (${action})` };

  const side = pos.side === "short" ? "short" : "long";
  const px = num(pos.px), entry = num(pos.entry), currentSl = num(pos.stop_loss), atr = num(pos.atr);
  const size = num(pos.size);
  const managed = Array.isArray(pos.managed) ? pos.managed : [];
  const partialFrac = opts.partialFrac != null ? Number(opts.partialFrac) : 0.5;
  const trailAtrMult = opts.trailAtrMult != null ? Number(opts.trailAtrMult) : 1.5;
  const beBufferPct = opts.beBufferPct != null ? Number(opts.beBufferPct) : 0.001;
  const minGapAtr = opts.minGapAtr != null ? Number(opts.minGapAtr) : 0.5;
  const allowTowardPrice = opts.allowTowardPrice != null ? !!opts.allowTowardPrice : (process.env.MONITOR_TIGHTEN_TOWARD_PRICE === "1");

  const symbol = pos.symbol;
  const intents = [];

  if (action === "place_sl") {
    if (currentSl == null) return { do: false, intents: [], skip: "place_sl mais aucun SL prevu (pos.stop_loss absent) -> alerte manuelle" };
    return { do: true, tag: "place_sl", intents: [{ kind: "move_sl", params: { symbol, new_sl: currentSl }, rationale: "position NUE -> pose le SL prevu (protection)" }] };
  }

  // TIME-STOP (29.06) : clore la position (flat = risk-reducing). Traite AVANT le gate winner-only :
  // un time-stop clot QUEL QUE SOIT le P&L (un hold qui drague est souvent flat/petite perte ; c'est
  // justement ce qu'on coupe). ONE-SHOT (tag time_stop) -> idempotent. reduce-only full size.
  if (action === "time_stop_close") {
    if (managed.includes("time_stop")) return { do: false, intents: [], skip: "time_stop deja execute" };
    if (!(size > 0)) return { do: false, intents: [], skip: "time_stop_close : taille inconnue" };
    return { do: true, tag: "time_stop", intents: [{ kind: "close_position", params: { symbol, fraction: 1.0 }, rationale: plan.reason || "TIME-STOP mean-rev -> clore la position (flat = risk-reducing)" }] };
  }

  // ── GATE "WINNER ONLY" (FIX 26.06, parite scalp) : la gestion auto (cut/tighten/BE/trail) ne touche QUE
  // les positions REELLEMENT en profit (>= minProfitAtr d'ATR). Perdants/flats/barely-winners -> gouvernes
  // par le SL anti-sweep + routine LLM -> le monitor ne SABOTE jamais un trade frais sur du bruit.
  // place_sl (nu) deja traite au-dessus. Reversible MONITOR_MIN_PROFIT_ATR=0.
  const minProfitAtr = opts.minProfitAtr != null ? Number(opts.minProfitAtr) : Number(process.env.MONITOR_MIN_PROFIT_ATR != null ? process.env.MONITOR_MIN_PROFIT_ATR : 0.5);
  const profitAtr = (entry != null && px != null && atr != null && atr > 0)
    ? (side === "long" ? (px - entry) : (entry - px)) / atr : null;
  const winnerEnough = profitAtr != null
    ? profitAtr >= minProfitAtr
    : (entry != null && px != null && (side === "long" ? px > entry : px < entry));
  if (minProfitAtr > 0 && !winnerEnough) {
    return { do: false, intents: [], skip: `monitor noop : pas assez en profit (${profitAtr != null ? profitAtr.toFixed(2) + "xATR" : "perte/flat"} < ${minProfitAtr}) -> on GARDE le SL anti-sweep (la gestion auto ne protege QUE les winners)` };
  }

  if (action === "set_trailing") {
    const tp = trailingParams({ px, atr, trailAtrMult });
    if (!tp) return { do: false, intents: [], skip: "set_trailing impossible (px/atr manquant)" };
    return { do: true, tag: "trail", intents: [{ kind: "set_trailing", params: { symbol, ...tp }, rationale: `continuation (>=1R) -> trailing ${trailAtrMult}xATR (protege le gain)` }] };
  }

  if (action === "tighten_sl") {
    const ns = safeTightenSl({ side, px, entry, currentSl, atr, beBufferPct, minGapAtr, allowTowardPrice });
    if (ns == null) return { do: false, intents: [], skip: "tighten_sl : noop (en perte/flat -> garde le SL anti-sweep ; BE seulement en profit)" };
    return { do: true, tag: "tighten", intents: [{ kind: "move_sl", params: { symbol, new_sl: ns }, rationale: "these affaiblie -> resserre le SL (reduit le risque)" }] };
  }

  // take_partial_be (CUT, these cassee) / take_partial_lock (PRISE DE PROFIT, gain qui s'essouffle)
  // = ONE-SHOT (sinon on banque un partiel a CHAQUE tick jusqu'a vider la position). Idempotence par tag.
  const tag = action === "take_partial_be" ? "be" : "lock";
  if (managed.includes(tag)) return { do: false, intents: [], skip: `${action} deja execute (tag ${tag})` };
  if (!(size > 0)) return { do: false, intents: [], skip: "take_partial : taille inconnue" };
  if (!(partialFrac > 0 && partialFrac < 1)) return { do: false, intents: [], skip: "partialFrac invalide" };

  intents.push({ kind: "take_partial", params: { symbol, fraction: partialFrac }, rationale: action === "take_partial_be" ? "these CASSEE -> banque un partiel (cut)" : "gain qui s'essouffle -> securise un partiel (prise de profit)" });
  // puis protege le reste : BE si en profit (sinon resserrement sur), trailing serre pour le lock.
  const ns = safeTightenSl({ side, px, entry, currentSl, atr, beBufferPct, minGapAtr, allowTowardPrice });
  if (ns != null) intents.push({ kind: "move_sl", params: { symbol, new_sl: ns }, rationale: action === "take_partial_be" ? "+ SL au point mort / resserre" : "+ resserre le SL sur le reste" });
  if (action === "take_partial_lock") {
    const tp = trailingParams({ px, atr, trailAtrMult });
    if (tp) intents.push({ kind: "set_trailing", params: { symbol, ...tp }, rationale: "+ trailing sur le reste (laisse courir le runner)" });
  }
  return { do: true, tag, intents };
}

// ── A.2 : FRAICHEUR — verdict de structure FRAIS par position (donnees actuelles, 15 min) ──
// Le verdict thesis vient de scan-latest (<=1h). Sur l'OHLCV FRAIS deja fetche par le monitor, on
// calcule marketStructure (structure.js) et on ESCALADE le verdict si la structure a casse CONTRE la
// position RECEMMENT (juste avant maintenant) : MSS contre = these cassee (flipped=cut) ; CHoCH contre
// = structure se fissure (weakening=tighten). Pur -> teste. N'escalade QUE vers plus protecteur.
const VERDICT_RANK = { no_scan: 0, hold: 1, running: 2, weakening: 3, mature: 4, flipped: 5 };
function moreProtectiveVerdict(a, b) {
  const ra = VERDICT_RANK[a] != null ? VERDICT_RANK[a] : 1;
  const rb = VERDICT_RANK[b] != null ? VERDICT_RANK[b] : 1;
  return ra >= rb ? a : b;
}
// structure = sortie marketStructure({last_mss,last_choch:{dir,level,j}}). nBars = nb de barres OHLCV.
// recencyBars : un break ne compte que s'il s'est produit dans les N dernieres barres (= "maintenant").
function freshStructureVerdict({ side, structure, nBars = null, recencyBars = 3 } = {}) {
  if (!structure) return null;
  const against = side === "short" ? "up" : "down"; // ce qui casse la these
  const recent = (sig) => sig && sig.dir === against && sig.j != null && (nBars == null || (nBars - 1 - sig.j) <= recencyBars);
  if (recent(structure.last_mss)) return "flipped";    // MSS contre = retournement confirme -> CUT
  if (recent(structure.last_choch)) return "weakening"; // CHoCH contre = 1er craquement -> TIGHTEN
  return null;
}

module.exports = { manageIntents, safeTightenSl, trailingParams, isTighter, EXECUTABLE, moreProtectiveVerdict, freshStructureVerdict, VERDICT_RANK };
