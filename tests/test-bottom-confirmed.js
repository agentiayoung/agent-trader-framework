#!/usr/bin/env node
"use strict";
// Tests offline du rail bilateral forward-test (scan.js reclaimEma200d + bottomConfirmed). Zero reseau.
// Design : docs/plans/2026-06-15-bilateral-forward-test-rail-design.md (approved 15.06).
// Le rail prend un LONG (track:experiment, tier D) UNIQUEMENT sur un BOTTOM CONFIRME :
//   bull_div_at_low>=1 ET decoupled_from_btc>=1 ET reclaim_ema200d>=1 (la sequence de bottom complete).
// Anti-dead-cat : un simple relief_rally (rebond court) ne suffit PAS.
// Run: node tests/test-bottom-confirmed.js
const { reclaimEma200d, bottomConfirmed } = require("../trade-journal/scan.js");
let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log("  PASS  " + name); } else { failed++; console.log("  FAIL  " + name); } }

// ── reclaimEma200d : px vient de repasser AU-DESSUS de l'EMA200 daily (cross recent) ──
// Downtrend long -> EMA200 trine bien AU-DESSUS des closes recents ; puis spike au-dessus = reclaim frais.
function downThenSpike() {
  const a = [];
  for (let i = 0; i < 215; i++) a.push(300 - i * (200 / 215)); // 300 -> ~100 (descente lente)
  for (let i = 0; i < 5; i++) a.push(250);                      // 5 dernieres barres = spike a 250
  return a;
}
const dts = downThenSpike();
ok("reclaim200 TRUE : px>EMA200 maintenant + close sous EMA200 dans la fenetre (cross recent)", reclaimEma200d(dts, 250) === true);

// Uptrend long : px TOUJOURS au-dessus de l'EMA200 -> pas de reclaim FRAIS (above depuis longtemps).
function steadyUp() { const a = []; for (let i = 0; i < 220; i++) a.push(100 + i); return a; }
const up = steadyUp();
ok("reclaim200 FALSE : tendance up etablie (jamais sous EMA200 dans la fenetre)", reclaimEma200d(up, up[up.length - 1]) === false);

// Downtrend toujours en cours : px SOUS l'EMA200 -> pas de reclaim.
function steadyDown() { const a = []; for (let i = 0; i < 220; i++) a.push(300 - i); return a; }
const dn = steadyDown();
ok("reclaim200 FALSE : px sous l'EMA200 (downtrend en cours)", reclaimEma200d(dn, dn[dn.length - 1]) === false);

// Lookback : si le cross date de >N barres, plus un reclaim FRAIS.
function reclaimedLongAgo() {
  const a = [];
  for (let i = 0; i < 195; i++) a.push(300 - i * (200 / 195)); // descente
  for (let i = 0; i < 25; i++) a.push(250);                     // 25 barres au-dessus (cross il y a 25 barres)
  return a;
}
const old = reclaimedLongAgo();
ok("reclaim200 FALSE : cross trop ancien (>lookback defaut 10)", reclaimEma200d(old, 250) === false);
ok("reclaim200 TRUE : meme cross ancien mais lookback elargi a 30", reclaimEma200d(old, 250, 30) === true);

// Robustesse : pas assez de barres pour un EMA200 fiable -> false sans crash.
ok("reclaim200 FALSE : moins de 210 barres (EMA200 non fiable)", reclaimEma200d([1, 2, 3], 3) === false);
ok("reclaim200 FALSE : tableau vide sans crash", reclaimEma200d([], 100) === false);
ok("reclaim200 FALSE : null sans crash", reclaimEma200d(null, 100) === false);

// ── bottomConfirmed : la sequence de bottom est-elle COMPLETE ? ──
const full = { bull_div_at_low: ["AVAX"], decoupled_from_btc: ["LTC"], reclaim_ema200d: 1 };
ok("CONFIRME : les 3 conditions presentes (div>=1, decoupled>=1, reclaim200>=1)", bottomConfirmed(full) === true);

// Chaque condition est NECESSAIRE (etat live 15.06 = div+decoupled vides = NON confirme).
ok("NON confirme : bull_div_at_low vide", bottomConfirmed({ bull_div_at_low: [], decoupled_from_btc: ["LTC"], reclaim_ema200d: 1 }) === false);
ok("NON confirme : decoupled_from_btc vide", bottomConfirmed({ bull_div_at_low: ["AVAX"], decoupled_from_btc: [], reclaim_ema200d: 1 }) === false);
ok("NON confirme : reclaim_ema200d = 0 (pas de bascule EMA200d)", bottomConfirmed({ bull_div_at_low: ["AVAX"], decoupled_from_btc: ["LTC"], reclaim_ema200d: 0 }) === false);

// Etat LIVE actuel (15.06) : div + decoupled VIDES -> rail DORMANT (la garantie anti-dead-cat).
const liveNow = { bull_div_at_low: [], decoupled_from_btc: [], reclaim_ema200d: 4, alt_capitulation: true, fear_extreme: true };
ok("DORMANT sur l'etat live 15.06 (capitulation SANS div ni decoupling)", bottomConfirmed(liveNow) === false);

// Seuils configurables.
ok("seuil minDiv=2 -> 1 seule div insuffisante", bottomConfirmed(full, { minDiv: 2 }) === false);

// Robustesse.
ok("bw null -> false sans crash", bottomConfirmed(null) === false);
ok("champs absents -> false sans crash", bottomConfirmed({}) === false);

console.log("\n" + passed + " pass / " + failed + " fail");
process.exit(failed ? 1 : 0);
