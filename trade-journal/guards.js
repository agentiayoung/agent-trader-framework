#!/usr/bin/env node
"use strict";
// guards.js — Guard pipeline DETERMINISTE pre-bracket (11.06, inspire du pattern
// OpenAlice/UTA `guard-pipeline.ts` : un GuardContext read-only passe dans une chaine
// de guards, le PREMIER reject bloque l'ordre ; l'execution n'est jamais atteinte).
//
// PHILOSOPHIE : ne remplace AUCUN seuil. CONSOLIDE en UN point les garde-fous NON
// negociables qui etaient eparpilles dans la SOP (Etapes 1->6) et appeles A LA MAIN
// par le LLM (qui pouvait en oublier un). Module PUR (zero reseau) -> teste offline.
// Le contexte (atr/equity/quota/exposition) est assemble par `journal.js preflight`
// (qui, lui, lit les fichiers + fetch l'ATR) et passe ici en argument.
//
// Chaque guard = { name, check(order, ctx) -> {status, reason} } ou status ∈
//   pass  : conforme
//   block : INTERDIT (ordre rejete) — garde-fou non negociable viole
//   warn  : a surveiller, n'interdit pas
//   skip  : non applicable / donnee manquante (n'interdit pas)
"use strict";
const { checkSlGeometry, validatedSlFloor } = require("./bracket-check.js");

// Familles de setup : MR = mean-reversion (exemptees de R:R>=2 car geometrie ATR
// validee OOS, approved 10.06) ; TREND = tendance/zone (R:R>=2 jusqu'a TP2 obligatoire).
const MR_FAMILIES = new Set(["MR8", "MR4", "S5"]);
const TREND_FAMILIES = new Set(["S1", "S2", "S3", "S12"]);

// Famille = 1er segment avant _ ou - (ex. "MR8_MTF"->MR8, "S12_squeeze_break"->S12,
// "S1_MTF"->S1). Parse STRICT par segment pour ne PAS confondre S1 et S12.
function setupFamily(setup) {
  const seg = String(setup || "").split(/[_-]/)[0].toUpperCase();
  return seg || null;
}

// R:R jusqu'a TP2 (= 2e take-profit ; TP1 en fallback s'il n'y en a qu'un).
function rrToTp2(order) {
  const entry = Number(order.entry ?? order.entry_planned ?? order.entry_actual);
  const sl = Number(order.stop_loss);
  const tps = Array.isArray(order.take_profits) ? order.take_profits : [];
  const tpRaw = tps[1] ?? tps[0];
  const tpPx = tpRaw && typeof tpRaw === "object" ? Number(tpRaw.px) : Number(tpRaw);
  if (![entry, sl, tpPx].every(isFinite)) return null;
  const risk = Math.abs(entry - sl);
  if (!risk) return null;
  const reward = order.side === "short" ? entry - tpPx : tpPx - entry;
  return +(reward / risk).toFixed(2);
}

const pass = (reason) => ({ status: "pass", reason: reason || "ok" });
const block = (reason) => ({ status: "block", reason });
const warn = (reason) => ({ status: "warn", reason });
const skip = (reason) => ({ status: "skip", reason });

const GUARDS = [
  // 1) SL obligatoire absolu (garde-fou racine).
  {
    name: "sl-mandatory",
    check(order) {
      const sl = Number(order.stop_loss);
      if (!isFinite(sl) || sl <= 0)
        return block("Aucun stop-loss valide — SL OBLIGATOIRE sur CHAQUE trade (garde-fou racine non negociable).");
      return pass();
    },
  },
  // 2) Geometrie SL anti-sweep : dist SL >= floor de la famille (reutilise la meme
  //    logique que sl-check ; floor MR8 2.5x / S5,MR4 2x / S1 1.5x ATR, x0.85).
  {
    name: "sl-geometry",
    check(order, ctx) {
      const atr = Number(ctx && ctx.atr);
      if (!atr || !isFinite(atr) || atr <= 0)
        return skip("atr absent du contexte — lancer `sl-check` pour la geometrie live.");
      const floor = validatedSlFloor(order.setup);
      const geo = checkSlGeometry({
        entry: order.entry ?? order.entry_planned,
        stop_loss: order.stop_loss,
        atr,
        min_dist_atr: floor,
      });
      if (geo.ok === false) return block(geo.msg);
      if (geo.ok === null) return skip(geo.reason);
      return pass(`dist SL ${geo.dist_atr}xATR >= floor ${floor}xATR (famille ${setupFamily(order.setup) || "?"})`);
    },
  },
  // 3) R:R>=2 jusqu'a TP2 — UNIQUEMENT setups de tendance (S1/S2/S3/S12). MR exemptes
  //    (couvertes par sl-geometry). Famille inconnue = traitee comme tendance (prudent).
  {
    name: "risk-reward",
    check(order) {
      const fam = setupFamily(order.setup);
      if (fam && MR_FAMILIES.has(fam))
        return skip(`famille MR (${fam}) exemptee de R:R>=2 — geometrie ATR validee, couverte par sl-geometry.`);
      const rr = rrToTp2(order);
      if (rr == null) return skip("R:R incalculable (entry/SL/TP2 manquant).");
      const min = parseFloat(process.env.RM_MIN_RR || "2");
      if (rr < min - 0.01)
        return block(`R:R jusqu'a TP2 = ${rr} < ${min} (setup de tendance ${fam || "inconnu"} -> R:R>=${min} obligatoire). Descendre l'entree / eloigner TP2, ou passer. JAMAIS un SL comprime pour faire tenir le R:R.`);
      return pass(`R:R ${rr} >= ${min} (${fam || "?"})`);
    },
  },
  // 4) Circuit breaker (perte-jour / drawdown) — etat lu de equity.json par preflight.
  {
    name: "breaker",
    check(order, ctx) {
      const es = (ctx && ctx.equityState) || {};
      if (es.halt) {
        const why = (Array.isArray(es.reasons) && es.reasons.length)
          ? es.reasons.join(" ; ")
          : `perte jour ${es.day_pnl_pct}% / drawdown ${es.drawdown_pct}%`;
        return block(`CIRCUIT BREAKER actif : ${why} -> AUCUN nouveau trade aujourd'hui.`);
      }
      return pass();
    },
  },
  // 5) Quota journalier (3/j par defaut) — compte des trades non-test pris aujourd'hui.
  {
    name: "daily-limit",
    check(order, ctx) {
      const max = parseInt(process.env.RM_MAX_TRADES_PER_DAY || "3", 10);
      const n = Number(ctx && ctx.todayCount);
      if (isFinite(n) && n >= max)
        return block(`Quota journalier atteint (${n}/${max} trades pris aujourd'hui) -> stop.`);
      return pass(`${isFinite(n) ? n : "?"}/${max} trades aujourd'hui`);
    },
  },
  // 6) Exposition agregee par sens — reutilise can_add_<side> de cmd_exposure (LE binding =
  //    risque agrege <=12%/sens ET <=18% book, PAS le compte).
  {
    name: "exposure",
    check(order, ctx) {
      const exp = ctx && ctx.exposure;
      if (!exp) return skip("exposure absent du contexte.");
      const side = order.side;
      if (side !== "long" && side !== "short") return skip("side inconnu (long|short).");
      const canAdd = side === "short" ? exp.can_add_short : exp.can_add_long;
      if (canAdd === false) {
        const sideRisk = side === "short" ? (exp.short && exp.short.risk_pct) : (exp.long && exp.long.risk_pct);
        const why = exp.risk_warning || exp.total_warning
          || `actif ${exp.open_pending}/${exp.max_active}, risque ${side} ${sideRisk}%/${exp.max_side_risk_pct}%, book ${exp.total_risk_pct}%/${exp.max_total_risk_pct}%`;
        return block(`Exposition ${side} pleine : ${why} -> ne pas armer ce sens (anti mass-fill correle).`);
      }
      return pass(`exposition ${side} ok (can_add_${side}=true)`);
    },
  },
];

// runGuards : lance la chaine, agrege en verdict ALLOW/BLOCK. opts.only = sous-ensemble
// de noms de guards (pour tester / pour un repositionnement qui ne ré-ajoute pas de risque).
// Guards BLOQUANTS (gates qui EMPECHENT de trader) vs INTEGRITE (sl-mandatory/sl-geometry = data
// propre). En DEMO_ACTIVE, les bloquants sont degrades en warn -> le LLM les VOIT mais TRANCHE
// (approved 16.06 : en demo on trade activement pour tester/optimiser l'infra ; SL + geometrie +
// sizing restent DURS, sinon la data est inexploitable = le but est justement de l'exploiter).
const SOFT_GUARDS = new Set(["risk-reward", "breaker", "daily-limit", "exposure"]);

function runGuards(order, ctx = {}, opts = {}) {
  const only = opts.only ? new Set(opts.only) : null;
  const demo = opts.demo != null ? !!opts.demo : !!process.env.DEMO_ACTIVE;
  const checks = [];
  for (const g of GUARDS) {
    if (only && !only.has(g.name)) continue;
    let r;
    try { r = g.check(order, ctx) || pass(); }
    catch (e) { r = block(`erreur interne du guard: ${e && e.message}`); }
    // DEMO_ACTIVE : un guard BLOQUANT (non-integrite) ne bloque plus -> warn (le LLM decide).
    // On TAGGE le relachement (relaxed:true) -> les metriques peuvent separer "trade sous regles
    // strictes" de "trade sous demo relache" (G10 audit 18.06, non bloquant, additif).
    let relaxed = false;
    if (demo && SOFT_GUARDS.has(g.name) && r.status === "block") {
      r = warn(`[DEMO override] ${r.reason}`);
      relaxed = true;
    }
    checks.push({ guard: g.name, ...r, relaxed });
  }
  const blocks = checks.filter((c) => c.status === "block");
  const warns = checks.filter((c) => c.status === "warn");
  const relaxedGuards = checks.filter((c) => c.relaxed);
  return {
    ok: blocks.length === 0,
    verdict: blocks.length === 0 ? "ALLOW" : "BLOCK",
    demo_active: demo,
    blocks: blocks.map((b) => `[${b.guard}] ${b.reason}`),
    warnings: warns.map((w) => `[${w.guard}] ${w.reason}`),
    relaxed_guards: relaxedGuards.map((c) => c.guard),
    checks,
    rule: demo
      ? "DEMO_ACTIVE : gates BLOQUANTS (R:R/breaker/quota/exposition) degrades en warn -> le LLM tranche. INTEGRITE (SL obligatoire + geometrie) reste DURE. But : trader activement pour optimiser l'infra avec une data propre."
      : "Gate deterministe pre-bracket : 1 seul BLOCK = ordre INTERDIT. Agrege les garde-fous NON negociables (SL obligatoire + geometrie validee + R:R tendance + breaker + quota/j + exposition agregee) en un point unique. Ne remplace AUCUN seuil. Inspire du guard pipeline OpenAlice/UTA.",
  };
}

module.exports = { runGuards, GUARDS, setupFamily, rrToTp2 };
