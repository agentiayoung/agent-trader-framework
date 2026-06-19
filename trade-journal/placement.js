"use strict";
// ═══════════════════════════════════════════════════════════════════
// placement.js — disposition d'un bracket FADE ancrée sur la STRUCTURE LIVE.
//
// PUR, déterministe, testé offline. Cf. design docs/plans/2026-06-12-sweep-fade-design.md §8.
// Objectif (the maintainer 12.06) : que la décision live se fasse PARFAITEMENT sur les
// indicateurs live. La routine lit les niveaux sur le Desktop (résistance-wick,
// zones d'overshoot au-dessus, supports en-dessous) -> les passe ici -> sort les
// rungs + SL + TP exacts. Plus de placement "à la louche".
//
// STRUCTURE (short ; miroir long) :
//   - RUNGS au-dessus de la résistance : R1 = bout de la mèche de résistance,
//     R2/R3 = zones d'overshoot au-dessus (susceptibles de rejet). R1 capte le
//     rejet standard, R2/R3 captent la mèche violente AU MEILLEUR PRIX.
//   - SL COMMUN "bien haut" au-dessus de la PLUS HAUTE zone d'overshoot + buffer
//     = anti-sweep MULTI-RUNGS (un SL par rung serait sweepé par l'overshoot qui
//     remplit les rungs hauts -- c'est la perte qu'on évite).
//   - TP scale-out ancré supports : safe (rejet rapide) + far. Le far = AVANT le
//     support le plus bas pour R1/R2, et RUNNER au-delà du support pour le rung
//     d'overshoot le plus profond (il a fillé plus haut "si débordement" -> room).
//
// CONTRAINTE BROKER respectée : Bybit cap 10 stops/symbole + fracs TP somment à 1.
//   3 rungs x (1 SL + 2 TP) = 9 <= 10. Le runner = far-TP du rung profond.
//
// GARDE la géométrie de RISQUE validée : plancher SL par famille, risque total =
// budget (risque ÉGAL par rung -> si seul R1 fille, 1/n du risque engagé).
// L'ANCRAGE aux zones = précision d'entrée (forward-test) ; le RISQUE ne bouge pas.
// ═══════════════════════════════════════════════════════════════════

const FLOOR_ATR = { MR8: 2.5, S5: 2.0, MR4: 2.0, S1: 1.5, S2: 1.5, S3: 1.5, S12: 1.5 };

function floorAtr(setup) {
  const m = String(setup || "").toUpperCase().match(/^(MR8|MR4|S12|S5|S1|S2|S3)/);
  return m ? FLOOR_ATR[m[1]] : 1.0; // famille inconnue -> 1xATR (le plancher dur global)
}

// buildPlacement(input) -> disposition complète. side: "short"|"long".
// Niveaux LIVE attendus (lus sur le Desktop) :
//   entry_zone      : la résistance (short) / support (long) que le prix fade — ancre R1
//   overshoot_zones : niveaux AU-DELA de entry_zone (au-dessus short / dessous long) — ancres R2/R3
//   target_levels   : niveaux vers le profit (supports sous short / résistances au-dessus long)
//   swing           : swing high (short) / low (long) — référence anti-sweep du SL
//   atr, risk_usd   : ATR live + budget de risque total (de journal.js size)
function buildPlacement(input) {
  const {
    side, setup = "", entry_zone, atr, risk_usd,
    overshoot_zones = [], target_levels = [], swing = null,
    n_rungs = 3, buffer_atr = 0.3, quick_frac = 0.35, main_frac = 0.40,
  } = input;
  if (side !== "short" && side !== "long") throw new Error('side requis ("short"|"long")');
  if (!atr || !isFinite(atr) || atr <= 0) throw new Error("atr requis (>0)");
  if (!isFinite(entry_zone)) throw new Error("entry_zone requis");
  if (!risk_usd || !isFinite(risk_usd) || risk_usd <= 0) throw new Error("risk_usd requis (>0)");

  const isShort = side === "short";
  const up = isShort ? +1 : -1;   // direction "au-delà / overshoot" (au-dessus pour un short)
  const dn = -up;                 // direction "vers le profit" (en-dessous pour un short)
  const warnings = [];
  const px = (v) => +Number(v).toFixed(8);

  // ── 1) RUNGS : R1 = entry_zone ; R2/R3 = zones overshoot (espacement min 0.3xATR), fallback ATR
  const beyond = overshoot_zones
    .filter((z) => isFinite(z) && (isShort ? z > entry_zone : z < entry_zone))
    .sort((a, b) => (isShort ? a - b : b - a)); // du plus proche au plus loin de entry_zone
  const rungLevels = [Number(entry_zone)];
  let fallback_used = false;
  for (let k = 1; k < n_rungs; k++) {
    const prev = rungLevels[rungLevels.length - 1];
    const idx = beyond.findIndex((x) => Math.abs(x - prev) >= 0.3 * atr);
    if (idx >= 0) { rungLevels.push(beyond[idx]); beyond.splice(idx, 1); }
    else { rungLevels.push(prev + up * 0.5 * atr); fallback_used = true; } // approxime le ladder validé
  }

  // ── 2) SL COMMUN "bien haut" : au-delà du rung le PLUS LOIN (overshoot max) + buffer/floor + au-delà du swing
  const topRung = isShort ? Math.max(...rungLevels) : Math.min(...rungLevels);
  const floor = floorAtr(setup);
  const cands = [topRung + up * floor * atr, topRung + up * buffer_atr * atr];
  if (isFinite(swing)) cands.push(swing + up * buffer_atr * atr);
  const sl = isShort ? Math.max(...cands) : Math.min(...cands);
  const slDistClosest = Math.abs(sl - topRung) / atr; // le rung le plus PROCHE du SL = le plus contraignant
  if (slDistClosest < floor - 0.02) warnings.push(`SL dist ${slDistClosest.toFixed(2)}xATR < floor ${floor} (${setup||"?"})`);

  // ── 3) TP 3-PALIERS (19.06, approved — "capturer un 1er TP rapide aussi", parite scalp) :
  //    QUICK (1er partiel RAPIDE = banque vite, reduit le give-back) + MAIN (avant le support bas,
  //    cible structurelle) + RUNNER (au-dela = extension). quick = front-run du niveau le plus proche,
  //    borne pour rester RAPIDE (0.3..1.3xATR sinon partiel ATR ~0.7x). Le quick est sur CHAQUE rung ;
  //    main sur chaque rung ; runner SUR LE RUNG PROFOND seulement (cap Bybit 10 stops respecte).
  const targets = target_levels
    .filter((t) => isFinite(t) && (isShort ? t < entry_zone : t > entry_zone))
    .sort((a, b) => (isShort ? b - a : a - b)); // du plus proche (haut, short) au plus loin (support bas)
  const quickAtr = isFinite(input.quick_tp_atr) ? input.quick_tp_atr : 0.7;
  const profOf = (p) => (isShort ? entry_zone - p : p - entry_zone); // profit (>0 dans le sens du trade)
  let tpQuick, tpMain, tpRunner;
  if (targets.length >= 1) {
    const lowest = targets[targets.length - 1];                 // support le plus bas = cible principale
    tpMain = lowest - dn * 0.15 * atr;                          // AVANT le support (anti-front-run) : dn pointe vers le profit
    tpRunner = lowest + dn * 0.5 * atr;                         // AU-DELA du support (runner)
    if (targets.length >= 2) {                                  // 1er TP = front-run du niveau le plus proche
      let q = targets[0] - dn * 0.15 * atr; const qd = Math.abs(profOf(q)) / atr;
      tpQuick = (qd > 1.3 || qd < 0.3) ? entry_zone + dn * quickAtr * atr : q; // trop loin/proche -> partiel ATR rapide
    } else {
      tpQuick = entry_zone + dn * quickAtr * atr;               // 1 seul target -> partiel ATR rapide
    }
  } else {
    warnings.push("aucun target_level -> TP en fallback geometrie ATR (quick 0.7x / main 2x / runner 3x)");
    tpQuick = entry_zone + dn * quickAtr * atr;
    tpMain = entry_zone + dn * 2 * atr;
    tpRunner = entry_zone + dn * 3 * atr;
  }
  // garde l'ordre QUICK (proche) -> MAIN -> RUNNER : si quick deborde main, le ramener a mi-chemin
  if (profOf(tpQuick) >= profOf(tpMain) - 0.05 * atr) tpQuick = entry_zone + dn * profOf(tpMain) * 0.5;

  // ── 4) SIZES : risque EGAL par rung (risk_usd/n) ; size = risque/dist(SL). Total = budget.
  const perRisk = risk_usd / rungLevels.length;
  const deepIdx = isShort ? rungLevels.indexOf(Math.max(...rungLevels)) : rungLevels.indexOf(Math.min(...rungLevels));
  const rungs = rungLevels.map((e, i) => {
    const dist = Math.abs(sl - e);
    const size = dist > 0 ? perRisk / dist : 0;
    const isDeep = i === deepIdx;                               // le rung d'overshoot le plus profond porte le RUNNER
    // CHAQUE rung = QUICK (1er partiel rapide) + MAIN ; le rung PROFOND ajoute le RUNNER (3 paliers).
    const tps = isDeep
      ? [ { px: px(tpQuick), frac: quick_frac }, { px: px(tpMain), frac: main_frac }, { px: px(tpRunner), frac: +(1 - quick_frac - main_frac).toFixed(2) } ]
      : [ { px: px(tpQuick), frac: quick_frac }, { px: px(tpMain), frac: +(1 - quick_frac).toFixed(2) } ];
    return {
      label: "R" + (i + 1), entry: px(e), size: +size.toFixed(6), risk_usd: +perRisk.toFixed(2),
      sl_dist_atr: +(dist / atr).toFixed(2), is_runner: isDeep, take_profits: tps,
    };
  });

  const n_stops = rungs.reduce((a, r) => a + 1 + r.take_profits.length, 0); // 1 SL + n TP par rung
  if (n_stops > 10) warnings.push(`n_stops ${n_stops} > cap Bybit 10 -> reduire n_rungs ou quick/runner`);

  return {
    side, setup, atr: +atr, risk_usd_total: +risk_usd,
    sl: px(sl), sl_floor_atr: floor, sl_dist_closest_atr: +slDistClosest.toFixed(2),
    rungs,
    tp_zones: { quick: px(tpQuick), main_before_support: px(tpMain), runner_beyond_support: px(tpRunner) },
    n_stops, fallback_used, warnings,
    note: "FADE ancre structure live. RUNGS au-dela de la zone (R1=bout meche resistance/support, R2/R3=overshoot). SL COMMUN bien haut (anti-sweep multi-rungs, >= floor famille). TP 3-PALIERS : QUICK (1er partiel rapide = banque vite/reduit le give-back) sur chaque rung + MAIN (avant support bas) sur chaque rung + RUNNER (au-dela) sur le rung profond (is_runner). Risque egal par rung (seul R1 fille = 1/n). Poser chaque rung via bybit_place_limit_bracket puis preflight/verify-bracket. Geometrie de RISQUE validee gardee ; ancrage zones = forward-test.",
  };
}

module.exports = { buildPlacement, floorAtr };

if (require.main === module) {
  const arg = process.argv[2];
  if (!arg) { console.error("usage: node placement.js '<json>'  (side, setup, entry_zone, atr, risk_usd, overshoot_zones[], target_levels[], swing)"); process.exit(1); }
  try { console.log(JSON.stringify(buildPlacement(JSON.parse(arg)), null, 2)); }
  catch (e) { console.error(e.message); process.exit(1); }
}
