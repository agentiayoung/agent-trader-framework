"use strict";
// ═══════════════════════════════════════════════════════════════════
// thesis.js — PERCEPTION live "sante de these" par position tenue.
//
// PUR, deterministe, testable offline. GENERALISE manage.js (qui ne fait que
// "tighten", short-only) en un verdict BIDIRECTIONNEL hold|weakening|flipped,
// consomme a CHAQUE routine APRES le scan.
//
// Raison d'etre (question the maintainer 15.06 + relief-rally 12-15.06) : un short tenu dont
// la donnee live a FLIPPE (ex. XRP qui casse : trend 4H repasse bull + le MEILLEUR
// setup du scan passe LONG + reclaim EMA50 daily) etait SUBI jusqu'au SL (-1R x5)
// faute d'un signal de PREMIERE CLASSE "these cassee -> sortir". Aujourd'hui le LLM
// devait le re-deduire a la main depuis le texte d'invalidation. Ici le code le CRIE.
//
// Tous les signaux sont DEJA calcules par scan.js (champs du scan row : trend, macd,
// divergence, obv, h1, reclaim_d50, cycle, setup) -> zero parsing, retroactif sur
// TOUTES les positions ouvertes, aucune migration de schema.
//
// OBSERVABILITE DURE (deterministe + surface obligatoire), pas un auto-trade : le LLM
// AGIT (le seuil dur de cut total = valide par P1 OOS, design hold-vs-cut).
// ═══════════════════════════════════════════════════════════════════

const { pairKey, slTightenAlerts } = require("./manage.js");

// flipSignals : signaux STRUCTURELS du scan row CONTRE la position.
// short -> on cherche le flip HAUSSIER ; long -> le flip baissier (miroir).
//   FORTS (structurels) : stack EMA 4H, biais du meilleur setup du scan, reclaim EMA50d,
//                         at_cycle_low (short only, leçon DOT).
//   FAIBLES (confirmants) : macd 4H, divergence, obv, h1.
// perc (optionnel) = perception PROFONDE injectee pour CETTE position (deepPerception, avec orderflow)
// -> permet le signal SWEEP. La STRUCTURE (CHoCH/MSS) vient du bloc perception compact du scan row
// (r.perception, zero fetch). Les deux ABSENTS = comportement historique inchange (retro-compatible).
function flipSignals(pos, r, perc) {
  const isShort = pos.side === "short";
  const strong = [], weak = [];
  if (!r) return { strong, weak };

  // stack EMA 4H : pour un short, trend repasse "bull" = reclaim (le breakout XRP) ;
  // pour un long, trend "bear" = stack perdu.
  if (isShort ? r.trend === "bull" : r.trend === "bear")
    strong.push(`trend 4H ${r.trend} (stack EMA ${isShort ? "reclaim" : "perdu"} contre la position)`);

  // LE coeur du "voir le breakout" : le MEILLEUR setup du scan pointe a l'OPPOSE de la
  // position -> le biais directionnel a flippe (S8/S12 long surface quand htfBear tombe).
  if (r.setup && r.setup.side === (isShort ? "long" : "short"))
    strong.push(`meilleur setup du scan = ${r.setup.side} (${r.setup.type}) -> biais flippe`);

  // PERCEPTION STRUCTURE (F3, 18.06) : CHoCH/MSS deterministe (chaine structure.js) CONTRE la position
  // = signal de gestion FORT, lu du bloc perception compact du scan row (zero fetch). MSS (cassure de
  // structure CONFIRMEE) prime sur CHoCH (change of character, plus precoce) -> un SEUL signal de structure.
  const pc = r.perception;
  if (pc) {
    const oppDir = isShort ? "up" : "down"; // structure haussiere CONTRE un short / baissiere CONTRE un long
    if (pc.mss === oppDir) strong.push(`MSS ${pc.mss} (structure cassee contre la position, perception)`);
    else if (pc.choch === oppDir) strong.push(`CHoCH ${pc.choch} (change of character contre la position, perception)`);
  }

  // PERCEPTION ORDERFLOW (F3, 18.06) : SWEEP de liquidite CONTRE la position (injecte via deepPerception).
  // Une meche qui prend la liquidite a l'OPPOSE puis reclaim = retournement FORT (biais = sens du reclaim).
  if (perc && perc.orderflow && perc.orderflow.sweep && perc.orderflow.sweep.detected
      && perc.orderflow.sweep.bias === (isShort ? "long" : "short"))
    strong.push(`sweep ${perc.orderflow.sweep.side} -> ${isShort ? "long" : "short"} (liquidite prise contre la position, orderflow)`);

  // reclaim EMA50 daily = breadth de retournement (signal de bottom -> short only).
  if (isShort && r.reclaim_d50 === true)
    strong.push("reclaim EMA50 daily (breadth de retournement)");

  // at_cycle_low (short only) : shorter une zone d'accumulation = short de fin de tendance
  // (squeeze max, downside quasi nul -- lecon DOT 12.06).
  if (isShort && r.cycle && r.cycle.at_cycle_low)
    strong.push("at_cycle_low (zone d'accumulation, squeeze max -- lecon DOT 12.06)");

  // confirmants faibles
  if (r.macd === (isShort ? "bull" : "bear")) weak.push(`macd 4H ${r.macd}`);
  if (r.divergence === (isShort ? "bull" : "bear")) weak.push(`divergence ${r.divergence}`);
  if (r.obv && r.obv.trend === (isShort ? "up" : "down")) weak.push(`obv ${r.obv.trend}`);
  // h1 : labelliser le(s) trigger(s) REELLEMENT contre la position (eviter "h1 falling"
  // trompeur quand c'est h1.macd:bull qui a flague sur un short au dir mixte).
  if (r.h1) {
    const t = [];
    if (isShort) { if (r.h1.dir === "rising") t.push("dir:rising"); if (r.h1.macd === "bull") t.push("macd:bull"); }
    else { if (r.h1.dir === "falling") t.push("dir:falling"); if (r.h1.macd === "bear") t.push("macd:bear"); }
    if (t.length) weak.push(`h1 ${t.join("+")}`);
  }

  return { strong, weak };
}

// sl_distance_pct : proximite du SL (|px - SL| / px en %). Contexte hold-vs-cut : un flip
// LOIN du SL = cas de cut plus fort (couper tot) ; pres du SL = laisser le SL gerer.
// Observabilite (nourrit P1), pas un seuil dur ici.
function slDistancePct(pos, r) {
  const sl = Number(pos && pos.stop_loss), px = Number(r && r.px);
  if (!Number.isFinite(sl) || !Number.isFinite(px) || px === 0) return null;
  return +(Math.abs(px - sl) / px * 100).toFixed(2);
}

// unrealR : R NON-REALISE en prix (profit parcouru / risque initial), depuis le scan.
// short : (entry - px)/(SL - entry) ; long : (px - entry)/(entry - SL). >0 = en gain.
// Permet de gerer les GAGNANTS (running/mature) en plus des perdants (flipped/weakening).
function unrealR(pos, r) {
  const px = Number(r && r.px);
  const entry = Number(pos && (pos.entry_actual ?? pos.entry_planned ?? pos.entry));
  const sl = Number(pos && pos.stop_loss);
  if (![px, entry, sl].every(Number.isFinite) || entry === sl) return null;
  const risk = Math.abs(entry - sl);
  const profit = pos.side === "short" ? (entry - px) : (px - entry);
  return +(profit / risk).toFixed(2);
}

// seuil "en gain, a gerer activement". En-dessous = position qui se developpe encore
// (logique perdant/flat). RU_WIN_MIN surchargeable par env pour tuning forward-test.
const WIN_MIN = process.env.THESIS_WIN_MIN ? +process.env.THESIS_WIN_MIN : 0.3;
// Seuils TRAJECTOIRE (trajectory.js, injecte via trajById) : give-back fort = on rend le pic ->
// "prendre le TP plus tot" ; MAE profond mais recupere = "avait besoin d'air, ne pas resserrer trop tot".
const GIVEBACK_HI = process.env.THESIS_GIVEBACK_HI ? +process.env.THESIS_GIVEBACK_HI : 0.4;
const MAE_DEEP = process.env.THESIS_MAE_DEEP ? +process.env.THESIS_MAE_DEEP : -0.7;

// ── CHANTIER B (15.06, approved) : MONITORING TREND-ADAPTATIF ──
// Les setups de TENDANCE (S1/S2/S3/S12) ont une these directionnelle qui peut S'ETENDRE -> sur un
// GAGNANT, laisser COURIR (desserrer le trail si la tendance se renforce, viser +3R/+5R). Les
// MEAN-REVERSION (MR8/MR4) ont une cible BORNEE (retour a la moyenne) -> garder le TP FIXE valide
// OOS (les laisser courir n'a pas de sens, ils REVIENNENT). S5 = range-fade (MR) SAUF s'il est pris
// en regime trending/strong (scope "Tous", approved) -> adaptatif dans ce cas seulement.
const TREND_SETUP = /^(S1|S2|S3|S12)(?![A-Za-z0-9])/i;
function isTrendSetup(strategy, r) {
  const key = String(strategy || "");
  if (TREND_SETUP.test(key)) return true;
  if (/^S5(?![A-Za-z0-9])/i.test(key) && r && (r.regime_d === "trending" || r.regime_d === "strong")) return true;
  return false;
}

// trailGuidance : pour un GAGNANT qui COURT (verdict running), COMMENT trailer ?
//   TENDANCE -> trail ADAPTATIF (loose / normal / tighten_to_mature selon le momentum du scan row).
//   MEAN-REVERSION -> fixed_tp (un MR revient ; garder le TP valide OOS, ne PAS laisser courir).
// SUGGESTION (le LLM agit sur bybit_set_trailing_stop), PAS un exit auto. atr_mult INDICATIF
// (forward-test calibre les chiffres ; les exit-tweaks durs sur-fittent -- cf. hold-vs-cut REJET).
function trailGuidance(pos, r) {
  if (!isTrendSetup(pos && pos.strategy, r)) {
    return { mode: "fixed_tp", atr_mult: null, reason: "mean-reversion (retour a la moyenne) -> garder le TP FIXE valide OOS, ne PAS laisser courir" };
  }
  const isShort = pos.side === "short";
  const adxRising = !!(r && r.adx_dir === "rising");
  const adxFalling = !!(r && r.adx_dir === "falling");
  // momentum AVEC la position (renforce) vs CONTRE (s'essouffle), lu du scan row (4H + 1H).
  const momWith = !!(r && ((isShort ? r.macd === "bear" : r.macd === "bull") || (r.h1 && (isShort ? r.h1.macd === "bear" : r.h1.macd === "bull"))));
  const momAgainst = !!(r && ((isShort ? r.macd === "bull" : r.macd === "bear") || (r.divergence === (isShort ? "bull" : "bear")) || (r.obv && r.obv.trend === (isShort ? "up" : "down")) || (r.h1 && (isShort ? r.h1.macd === "bull" : r.h1.macd === "bear"))));
  if (adxRising && momWith && !momAgainst) {
    return { mode: "loose", atr_mult: 3.5, reason: "tendance qui se RENFORCE (ADX rising + momentum avec nous) -> DESSERRER le trail (~3-4xATR), viser +3R/+5R, laisser courir" };
  }
  if (adxFalling || momAgainst) {
    return { mode: "tighten_to_mature", atr_mult: 1.25, reason: "momentum qui s'ESSOUFFLE (ADX falling ou retournement) -> RESSERRER le trail (~1-1.5xATR), verrouiller le gain (pre-mature)" };
  }
  return { mode: "normal", atr_mult: 2.0, reason: "tendance intacte sans acceleration -> trailing standard (~2xATR)" };
}

// ── F3.2 (18.06) : CIBLE DE LIQUIDITE pour le TP/trailing (au lieu d'un ATR fixe) ──
// nextLiquidityTarget(pos, perc) : depuis la perception PROFONDE (perc.zones, injectee), trouve la
// PROCHAINE zone de liquidite DANS LE SENS DU PROFIT (short -> en dessous : EQL/PDL/support/wall ;
// long -> au dessus : EQH/PDH/resistance/wall) = ou poser le TP / jusqu'ou laisser courir le trailing.
// PUR. null si pas de perception profonde (retombe sur le trailing ATR habituel). Observabilite.
const LIQ_LONG = new Set(["eqh", "pdh", "pwh", "resistance", "order_block", "fvg", "hvn"]);
const LIQ_SHORT = new Set(["eql", "pdl", "pwl", "support", "order_block", "fvg", "hvn"]);
function nextLiquidityTarget(pos, perc) {
  if (!perc || !Array.isArray(perc.zones) || perc.px == null) return null;
  const isShort = pos.side === "short";
  const px = Number(perc.px);
  const set = isShort ? LIQ_SHORT : LIQ_LONG;
  let best = null;
  for (const z of perc.zones) {
    if (!z || !set.has(z.type)) continue;
    // bord PROCHE (premier contact du prix qui avance vers la cible) : short (prix qui DESCEND) touche
    // d'abord le HAUT de la zone ; long (prix qui MONTE) touche d'abord le BAS.
    const edge = isShort ? Number(z.hi) : Number(z.lo);
    if (!Number.isFinite(edge)) continue;
    const inProfit = isShort ? edge < px : edge > px; // strictement dans le sens du gain
    if (!inProfit) continue;
    const dist = Math.abs(px - edge);
    if (!best || dist < best.dist) best = { px: +edge.toFixed(8), type: z.type, dist, dist_atr: z.dist_atr != null ? z.dist_atr : null, status: z.status || null };
  }
  return best ? { px: best.px, type: best.type, dist_atr: best.dist_atr, status: best.status } : null;
}

// thesisHealth : verdict par position OPEN/PENDING en croisant avec le scan.
//   positions : trades actifs [{id, symbol, side, status, stop_loss}]
//   scanAll   : scan.all (toutes les paires)
//   market    : scan.market ({bottom_watch:{alt_capitulation}})
// -> { n, n_flipped, n_weakening, positions:[{...verdict}], note }
function thesisHealth(positions, scanAll, market, trajById, percById) {
  const byPair = {};
  for (const x of (scanAll || [])) if (x && x.pair && !x.error) byPair[x.pair] = x;

  // Palier "tighten" HISTORIQUE (manage-check : short-only, divergence:bull+altcap /
  // at_cycle_low) reutilise tel quel -> garantit la parite, rien de perdu.
  const tighten = slTightenAlerts(positions, scanAll, market);
  const tightenById = {};
  for (const a of tighten.alerts) tightenById[a.id] = a;

  const out = [];
  for (const p of (positions || [])) {
    if (p.status !== "open" && p.status !== "pending") continue;
    const r = byPair[pairKey(p.symbol)];
    const perc = (percById && percById[p.id]) || null; // perception PROFONDE injectee (orderflow -> sweep)
    const sig = flipSignals(p, r, perc);
    const slPct = slDistancePct(p, r);
    const rU = unrealR(p, r);
    const traj = (trajById && trajById[p.id]) || null; // metriques de trajectoire injectees (trajectory.js)
    const zoneTarget = nextLiquidityTarget(p, perc); // F3.2 : prochaine liquidite dans le sens du profit (TP/trail)
    let verdict, suggested, trail = null;
    const reasons = [];
    // flip = momentum CONTRE le sens de la position (retournement). Sur un GAGNANT il
    // signale que le move s'essouffle (verrouiller) ; sur un PERDANT que la these casse.
    const anyFlip = sig.strong.length >= 1 || sig.weak.length >= 2;

    if (!r) {
      verdict = "hold"; suggested = "hold";
      reasons.push("paire absente du scan -> pas d'info live (relancer scan.js)");
    } else if (rU != null && rU >= WIN_MIN) {
      // ── POSITION GAGNANTE (rU >= ~0.3R) : rider ou verrouiller (affine par la TRAJECTOIRE) ──
      const givingBack = !!(traj && traj.giveback_pct != null && traj.giveback_pct >= GIVEBACK_HI); // rend le pic
      const velFade = !!(traj && (traj.velocity === "reversing" || traj.velocity === "stalling"));    // le gain s'essouffle
      const trajNote = traj ? ` [traj: pic ${traj.mfe_R}R, courant ${traj.unreal_R}R, give-back ${traj.giveback_pct == null ? "-" : Math.round(traj.giveback_pct * 100) + "%"}, ${traj.velocity || "?"}, ${traj.bars_held} barres]` : "";
      if (anyFlip || givingBack) {
        verdict = "mature"; suggested = "take_partial_lock";
        const why = anyFlip
          ? `le MOVE SE RETOURNE : ${[...sig.strong, ...sig.weak].join(" ; ")}`
          : `GIVE-BACK fort : pic atteint ${traj.mfe_R}R, retombe a ${traj.unreal_R}R (rendu ${Math.round(traj.giveback_pct * 100)}% du pic${traj.velocity ? ", velocite " + traj.velocity : ""})`;
        const zoneNoteM = zoneTarget ? ` (cible de liquidite la plus proche : ${zoneTarget.type} @${zoneTarget.px})` : "";
        reasons.push(`GAGNANTE (${rU}R) mais ${why}. SECURISER une partie (bybit_take_partial)${zoneNoteM} + RESSERRER le trailing -> "prendre le TP plus tot / cut le gain qui s'essouffle".${trajNote}`);
      } else {
        verdict = "running"; suggested = "hold_let_run";
        trail = trailGuidance(p, r);
        const oblig = rU >= 1.0 ? " TRAILING OBLIGATOIRE (rU>=1R : bybit_set_trailing_stop pour proteger le gain ENTRE les routines)." : " (poser/resserrer le trailing des >=1R)";
        // TREND-ADAPTATIF (chantier B) : ne pas couper les tendances au meme multiple que les fades.
        const tg = trail.mode === "loose" ? ` TREND-ADAPTATIF -> DESSERRER le trail (${trail.reason}).`
          : trail.mode === "tighten_to_mature" ? ` TREND-ADAPTATIF -> RESSERRER le trail (${trail.reason}).`
          : trail.mode === "fixed_tp" ? ` MR -> TP FIXE (${trail.reason}).`
          : ` trail standard (${trail.reason}).`;
        const velNote = velFade ? ` VELOCITE ${traj.velocity} -> envisager RESSERRER le trail (le gain s'essouffle), TP plus tot possible.` : "";
        const zoneNote = zoneTarget ? ` CIBLE DE LIQUIDITE (F3.2) -> prochaine zone ${zoneTarget.type} @${zoneTarget.px} (${zoneTarget.dist_atr != null ? zoneTarget.dist_atr + "xATR" : "?"}) dans le sens du profit = ou viser le TP / jusqu'ou laisser courir le trail (au lieu d'un ATR fixe).` : "";
        reasons.push(`GAGNANTE (${rU}R) + momentum AVEC nous (aucun signal de retournement) -> TENIR, LAISSER COURIR.${oblig}${tg}${velNote}${zoneNote}${trajNote} "tenir si dans le bon sens".`);
      }
    } else if (sig.strong.length >= 2) {
      verdict = "flipped"; suggested = "take_partial_tighten_be";
      reasons.push(`THESE CASSEE : ${sig.strong.length} signaux structurels CONTRE la position (${sig.strong.join(" ; ")}). SECURISER une partie (bybit_take_partial) + remonter le SL au break-even+ sur le reste. Ne pas subir jusqu'au SL (relief-rally 12-15.06 : -1R x5 a tenir un short flippe). Le cut TOTAL reste au jugement du LLM (seuil dur = P1 OOS).`);
    } else if (sig.strong.length === 1 || sig.weak.length >= 2 || tightenById[p.id]) {
      verdict = "weakening";
      const all = [...sig.strong, ...sig.weak];
      if (tightenById[p.id]) all.push(...tightenById[p.id].reasons);
      // RELIEF-RALLY-AWARE (finding live 15.06) : pour un SHORT qui s'affaiblit PENDANT un
      // relief-rally actif, RESSERRER le SL = le poser dans la resistance TESTEE = sweep-out
      // (guidance relief-rally : "shorts existants geres par leur SL, ne pas resserrer dans la
      // resistance testee"). La bonne action = REDUIRE (take_partial, surtout pres du halt) ou
      // tenir au SL anti-sweep (= le checkpoint), PAS comprimer le SL dans la poche de liquidite.
      const relief = !!(market && market.bottom_watch && market.bottom_watch.relief_rally && market.bottom_watch.relief_rally.active);
      if (relief && p.side === "short") {
        suggested = "hold_to_sl_or_reduce";
        reasons.push(`THESE qui s'affaiblit EN RELIEF-RALLY : ${all.join(" ; ")}. NE PAS resserrer le SL (le poser dans la resistance testee = SWEEP-OUT) -> REDUIRE la position (bybit_take_partial, surtout si proche du halt drawdown) OU tenir au SL anti-sweep (= le checkpoint). Le relief-rally est le regime ou les fade-shorts saignent (-1R x5, 12-15.06).`);
      } else {
        suggested = "tighten_sl";
        reasons.push(`THESE qui s'affaiblit : ${all.join(" ; ")}. RESSERRER le SL (trailing serre / break-even) au lieu de subir. Lecon DOGE 12.06 (-0.96R, short garde malgre divergence:bull).`);
      }
    } else {
      verdict = "hold"; suggested = "hold";
      reasons.push("these intacte (aucun signal structurel contre la position)");
    }

    // "AVAIT BESOIN D'AIR" (anti-sur-resserrage) : un trade qui a plonge profond (MAE) puis recupere
    // a besoin de marge -> NE PAS resserrer trop tot (sinon sweep-out). Contexte, surtout si on suggere tighten.
    if (traj && traj.mae_R != null && traj.mae_R < MAE_DEEP && rU != null && rU > 0) {
      reasons.push(`AVAIT BESOIN D'AIR : plonge a ${traj.mae_R}R (MAE) puis recupere a ${rU}R -> ce trade respire, NE PAS resserrer le SL trop pres (risque de sweep-out ; laisser la marge anti-sweep).`);
    }
    out.push({ id: p.id, symbol: p.symbol, side: p.side, status: p.status, verdict, suggested, unreal_R: rU, trail, zone_target: zoneTarget, trajectory: traj, signals: sig, sl_distance_pct: slPct, reasons });
  }

  const count = (v) => out.filter((x) => x.verdict === v).length;
  const n_flipped = count("flipped"), n_weakening = count("weakening");
  const n_running = count("running"), n_mature = count("mature");
  const actionable = n_flipped || n_weakening || n_mature;
  return {
    n: out.length, n_running, n_mature, n_flipped, n_weakening, positions: out,
    note: actionable
      ? "MONITORING PROACTIF (cut le gain / tenir si bon sens). RUNNING -> tenir, laisser courir ; suivre trail.mode (TENDANCE : loose=desserrer pour viser +3R/+5R, tighten_to_mature=verrouiller ; MR : fixed_tp=garder le TP fixe, ne pas laisser courir). MATURE -> take_partial + resserrer le trail (le gain s'essouffle). FLIPPED -> take_partial + SL break-even (these cassee). WEAKENING -> resserrer le SL (ou reduire en relief-rally). Citer les signaux dans la timeline. OBSERVABILITE DURE, le LLM agit ; seuil dur de cut = P1 OOS."
      : (n_running
        ? "Positions gagnantes qui COURENT (momentum avec nous) -> tenir + trail.mode (tendance : desserrer/normal/resserrer ; MR : TP fixe). Rien a couper."
        : "Toutes les positions tenues sont intactes (aucun signal de retournement)."),
  };
}

module.exports = { thesisHealth, flipSignals, slDistancePct, unrealR, isTrendSetup, trailGuidance, nextLiquidityTarget };
