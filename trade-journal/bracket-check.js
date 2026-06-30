"use strict";
// ═══════════════════════════════════════════════════════════════════
// bracket-check.js — vérifie qu'un bracket a bien ATTERRI sur l'exchange.
//
// PUR : compare l'INTENTION (entrée + SL + TPs voulus) à l'ÉTAT RÉEL
// (position + ordres stop lus sur Bybit). Détecte la classe de bugs réelle
// déjà rencontrée (LESSONS) : fill partiel -> SL/TP oversized, position sans
// SL, pending qui s'est rempli, TP manquants. `journal.js verify-bracket`
// assemble l'état Bybit et appelle verifyBracket.
//
// Sévérité : un SL absent = CRITIQUE (position nue). Tout écart de taille >5%
// = à corriger (le SL doit couvrir la taille réelle, pas la taille visée).
// ═══════════════════════════════════════════════════════════════════

const TOL = 0.05; // tolérance 5% sur les tailles (frais/arrondis)

// classifyStops(stops, ctx) -> { slOrders, tpOrders }
// Classe les ordres conditionnels en SL vs TP de façon ROBUSTE AU TRAILING.
// BUG (audit routine 18:07) : classer par trigger-vs-ENTRÉE casse dès qu'on traile le SL
// en profit (SL d'un short trailé SOUS l'entrée -> faux "position nue"). FIX, par priorité :
//  1) triggerDirection (Bybit : 1 = déclenche à la HAUSSE, 2 = à la BAISSE) — un SL de short
//     déclenche à la hausse (1), un SL de long à la baisse (2). Indépendant du prix/entrée.
//  2) sinon trigger vs PRIX COURANT (le SL est du côté perdant du marché : au-dessus pour un
//     short, en-dessous pour un long) — survit au SL trailé sous l'entrée.
//  3) dernier recours (ni dir ni marché) : trigger vs entrée (ancien comportement).
// ctx = { side:'long'|'short', entry, market }. Chaque stop : { trigger|triggerPrice, amount, triggerDirection? }.
function classifyStops(stops, ctx) {
  const side = ctx && ctx.side;
  const entry = Number(ctx && ctx.entry) || 0;
  const market = Number(ctx && ctx.market) || 0;
  const slOrders = [], tpOrders = [];
  for (const o of stops || []) {
    const t = Number(o.trigger != null ? o.trigger : o.triggerPrice) || 0;
    if (!t) continue; // pas de prix de déclenchement -> ignoré
    const amount = Number(o.amount) || 0;
    const dir = Number(o.triggerDirection) || 0;
    let isSl;
    if (dir === 1 || dir === 2) isSl = side === "long" ? dir === 2 : dir === 1;
    else if (market) isSl = side === "long" ? t < market : t > market;
    else isSl = side === "long" ? t < entry : t > entry;
    (isSl ? slOrders : tpOrders).push({ amount, trigger: t });
  }
  return { slOrders, tpOrders };
}

// verifyBracket(intended, actual) -> { ok, critical, issues:[{level,msg}] }
//  intended = { side, size, stop_loss, take_profits:[{px,frac}|px] }
//  actual   = { position:{size,side}|null, slOrders:[{amount}], tpOrders:[{amount}] }
function verifyBracket(intended, actual) {
  intended = intended || {}; // defensif : un intended absent ne doit pas throw (cf. guard verify-bracket 21.06)
  const issues = [];
  const add = (level, msg) => issues.push({ level, msg });
  const pos = actual && actual.position;
  const sl = (actual && actual.slOrders) || [];
  const tp = (actual && actual.tpOrders) || [];

  // LADDERED : une entree echelonnee fille ses rungs progressivement. La position
  // OUVERTE = seulement les rungs deja remplis (< taille totale), mais le SL est
  // dimensionne pour le LADDER COMPLET (les SL des rungs encore PENDING sont deja
  // poses, reduceOnly). Un SL > position remplie n'est donc PAS un oversize : c'est
  // la couverture pre-positionnee des rungs a venir. On compare alors le SL a la
  // taille TOTALE visee (intended.size), pas a la position remplie (cf. faux positif
  // "SL oversize" sur XRP/SUI laddered, audit 13.06).
  const laddered = intended.entry_mode === "laddered";

  // 1. Position ouverte avec la bonne taille / le bon sens
  if (!pos || !pos.size) {
    add("warn", "aucune position ouverte (entrée non remplie -> pending, OU bracket non exécuté)");
  } else {
    if (pos.side && intended.side && pos.side !== intended.side) add("critical", `sens position ${pos.side} != intention ${intended.side}`);
    if (intended.size && Math.abs(pos.size - intended.size) / intended.size > TOL) {
      if (laddered && pos.size < intended.size) add("info", `ladder partiellement rempli : ${pos.size}/${intended.size} (rungs restants pending) -> normal`);
      else add("warn", `taille réelle ${pos.size} != visée ${intended.size} (fill partiel) -> recalibrer SL/TP sur ${pos.size}`);
    }
  }

  // 2. Stop-loss : présent, taille = position réelle (sinon nu/oversize)
  // Pour un ladder, la reference HAUTE acceptable est la taille TOTALE (rungs pending
  // pre-couverts) ; la reference BASSE reste la position remplie (en-dessous = expose).
  const slQty = sl.reduce((a, o) => a + (Number(o.amount) || 0), 0);
  const filled = pos && pos.size ? pos.size : 0;
  const refSize = filled || intended.size;
  if (!sl.length || slQty <= 0) {
    if (pos && pos.size) add("critical", "AUCUN stop-loss sur une position OUVERTE (position nue)");
    else add("warn", "pas de SL (normal si pending non rempli)");
  } else if (laddered) {
    const hi = intended.size || filled;
    if (filled && slQty < filled * (1 - TOL)) add("critical", `SL couvre ${slQty} < position remplie ${filled} (UNDERSIZE -> portion remplie exposee)`);
    else if (hi && slQty > hi * (1 + TOL)) add("critical", `SL couvre ${slQty} > ladder complet ${hi} (OVERSIZE reel -> risque inverse)`);
    else if (filled && slQty > filled * (1 + TOL)) add("info", `SL ${slQty} > position remplie ${filled} mais <= ladder ${hi} : rungs pending pre-couverts -> normal`);
  } else if (refSize && Math.abs(slQty - refSize) / refSize > TOL) {
    add("critical", `SL couvre ${slQty} mais la position est ${refSize} (${slQty > refSize ? "OVERSIZE -> risque inverse au déclenchement" : "UNDERSIZE -> reste exposé"})`);
  }

  // 3. Take-profits : compte attendu présent
  const wantTp = Array.isArray(intended.take_profits) ? intended.take_profits.length : 0;
  if (wantTp && tp.length < wantTp) add("warn", `${tp.length} TP posés vs ${wantTp} prévus (scale-out incomplet)`);

  const critical = issues.some((i) => i.level === "critical");
  // `info` = note benigne (ladder partiel pre-couvert) -> n'invalide PAS le bracket.
  const ok = !issues.some((i) => i.level === "critical" || i.level === "warn");
  return { ok, critical, issues };
}

// findOrphanOrders(orders, positionSymbols, activeSymbols) -> [{ symbol, count }]
// Détecte les ordres conditionnels ORPHELINS : présents sur un symbole qui n'a NI position
// ouverte NI trade actif (open/pending) au journal. Cause classique (bug BNB 02.06) : un SL/TP
// frère resté après clôture (les conditionnels reduceOnly ne sont pas un OCO -> pas auto-annulés).
// Risque : ils se colleraient comme exits fantômes à une FUTURE position du même symbole.
// EXCLUT les pendings légitimes (limit au repos = ordres sans position MAIS trade actif au journal)
// via activeSymbols. Pur/testable. Le nettoyage reste manuel (bybit_cancel_all <sym>) = pas d'auto-annulation.
function findOrphanOrders(orders, positionSymbols, activeSymbols) {
  const base = (s) => String(s || "").toUpperCase().replace(/USDT.*$/, "").replace(/[^A-Z0-9]/g, "");
  const posSet = new Set((positionSymbols || []).map(base));
  const actSet = new Set((activeSymbols || []).map(base));
  // Un ordre d'ENTREE = NON reduce-only. Par symbole : existe-t-il une entree VIVANTE sur Bybit ?
  const isReduce = (o) => !!(o && (o.reduceOnly === true || (o.info && (o.info.reduceOnly === true || o.info.reduceOnly === "true"))));
  const hasEntry = {};
  for (const o of orders || []) { const s = base(o.symbol); if (!s) continue; if (!isReduce(o)) hasEntry[s] = true; }
  const counts = {};
  for (const o of orders || []) {
    const s = base(o.symbol); if (!s) continue;
    if (posSet.has(s)) continue;                          // position vivante -> on ne touche pas
    // ORPHELIN VRAI (fix 27.06, parite scalp) : un ordre reduce-only sur un symbole SANS position ET
    // SANS ordre d'entree vivant ne protege RIEN -> orphelin MEME si un pending stale subsiste au journal
    // (son entree a disparu de Bybit : entry rejete postOnly ou annule sans nettoyer le bracket).
    const orphanReduce = isReduce(o) && !hasEntry[s];
    if (actSet.has(s) && !orphanReduce) continue;         // pending legitime (entree vivante) -> exclu
    counts[s] = (counts[s] || 0) + 1;
  }
  return Object.entries(counts).map(([symbol, count]) => ({ symbol, count }));
}

// ── checkSlPlacement : SL anti-sweep (10.06, finding Hugo) ──────────────────
// Un SL pile sur/dans le niveau évident (swing low pour un long, swing high pour
// un short) = POCHE DE LIQUIDITÉ : le marché balaie ces stops avant de s'inverser
// (cas HYPE : SL 55.50 posé 4.5 ct AU-DESSUS du low 55.455 ; ~150 sweeps de swing
// 12-barres/6 mois mesurés par la détection S11). Le SL doit être AU-DELÀ de
// l'extrême récent avec un buffer >= min_buffer_atr × ATR. PUR (testé offline) ;
// l'appel réseau (fetch OHLCV + ATR) vit dans journal.js cmd_sl_check.
function checkSlPlacement({ side, stop_loss, highs, lows, atr, lookback = 30, min_buffer_atr = 0.3 }) {
  if (!atr || !isFinite(atr) || atr <= 0) return { ok: null, reason: "atr manquant" };
  const sl = Number(stop_loss);
  if (!isFinite(sl)) return { ok: null, reason: "stop_loss manquant" };
  if (side === "long") {
    const ls = (lows || []).slice(-lookback).filter((x) => isFinite(x));
    if (!ls.length) return { ok: null, reason: "lows manquants" };
    const swing = Math.min(...ls);
    const buffer = (swing - sl) / atr; // > 0 si le SL est SOUS le swing low
    const ok = buffer >= min_buffer_atr - 0.02; // tolérance de bord : l'ATR live dérive entre calcul et check
    return {
      ok, side, swing_level: swing, buffer_atr: +buffer.toFixed(2),
      suggested_sl: +(swing - min_buffer_atr * atr).toFixed(6), min_buffer_atr,
      msg: ok ? `SL sous les mèches du swing low ${swing} (buffer ${buffer.toFixed(2)}xATR)`
        : buffer < 0 ? `SL AU-DESSUS du swing low ${swing} = DANS la poche de liquidité (sweep = stop déclenché par construction)`
        : `buffer ${buffer.toFixed(2)}xATR < ${min_buffer_atr} : SL trop proche du swing low ${swing} (sweep probable)`,
    };
  }
  if (side === "short") {
    const hs = (highs || []).slice(-lookback).filter((x) => isFinite(x));
    if (!hs.length) return { ok: null, reason: "highs manquants" };
    const swing = Math.max(...hs);
    const buffer = (sl - swing) / atr; // > 0 si le SL est AU-DESSUS du swing high
    const ok = buffer >= min_buffer_atr - 0.02; // tolérance de bord : l'ATR live dérive entre calcul et check
    return {
      ok, side, swing_level: swing, buffer_atr: +buffer.toFixed(2),
      suggested_sl: +(swing + min_buffer_atr * atr).toFixed(6), min_buffer_atr,
      msg: ok ? `SL au-dessus des mèches du swing high ${swing} (buffer ${buffer.toFixed(2)}xATR)`
        : buffer < 0 ? `SL SOUS le swing high ${swing} = DANS la poche de liquidité (sweep = stop déclenché par construction)`
        : `buffer ${buffer.toFixed(2)}xATR < ${min_buffer_atr} : SL trop proche du swing high ${swing} (sweep probable)`,
    };
  }
  return { ok: null, reason: "side inconnu (long|short)" };
}

// ── checkSlGeometry : plancher de géométrie validée (10.06, post flash-sweep HYPE) ──
// TOUTES les géométries validées OOS ont un SL >= 1xATR (MR8 2.5x, S5 2x, S1 1.5x baseline).
// Un SL < 1xATR = on trade une VARIANTE NON VALIDÉE (SL comprimé pour faire tenir le R:R) —
// c'est la vraie cause de la perte HYPE 10.06 (dist 0.85xATR, sweepé par un flash event).
// ÉCHEC DUR (plus un simple warn) : enforcement de la géométrie validée, pas une règle nouvelle.
function checkSlGeometry({ entry, stop_loss, atr, min_dist_atr = 1 }) {
  if (!atr || !isFinite(atr) || atr <= 0) return { ok: null, reason: "atr manquant" };
  const e = Number(entry), sl = Number(stop_loss);
  if (!isFinite(e) || !isFinite(sl)) return { ok: null, reason: "entry/stop_loss manquant" };
  const dist_atr = +(Math.abs(e - sl) / atr).toFixed(2);
  const ok = dist_atr >= min_dist_atr - 0.02; // même tolérance de bord que checkSlPlacement
  return {
    ok, dist_atr, min_dist_atr,
    msg: ok ? `dist SL ${dist_atr}xATR >= ${min_dist_atr}xATR (géométrie saine)`
      : `dist SL ${dist_atr}xATR < ${min_dist_atr}xATR = GÉOMÉTRIE NON VALIDÉE (toutes les géométries OOS ont un SL >= 1xATR : MR8 2.5x, S5 2x, S1 1.5x) — SL comprimé pour le R:R = candidat au sweep (cas HYPE 10.06). Élargir le SL et rapprocher le TP-cible, ou passer.`,
  };
}

// ── validatedSlFloor : floor de géométrie PAR FAMILLE de setup (GO Hugo 10.06, option A) ──
// L'exemption R:R≥2 des mean-reversion est CONDITIONNELLE à leur géométrie ATR validée OOS
// (configs optimales optimize.js : MR8 SL 2.5×ATR · S5/MR4 SL 2×ATR · S1 SL 1.5×ATR baseline).
// Tolérance ×0.85 (l'ATR live dérive entre le calcul du bracket et le check). Famille inconnue
// → floor universel 1×ATR (le plancher dur de toutes les géométries validées).
const VALIDATED_SL_ATR = { MR8: 2.5, S5: 2.0, MR4: 2.0, S1: 1.5 };
function validatedSlFloor(setup) {
  const s = String(setup || "").toUpperCase();
  for (const [fam, sl] of Object.entries(VALIDATED_SL_ATR)) {
    if (s.startsWith(fam) || s.includes("_" + fam)) return +(sl * 0.85).toFixed(4);
  }
  return 1;
}

module.exports = { verifyBracket, classifyStops, findOrphanOrders, checkSlPlacement, checkSlGeometry, validatedSlFloor, TOL };
