#!/usr/bin/env node
"use strict";
// ═══════════════════════════════════════════════════════════════════
// read-optimize.js — lecteur standard des sorties optimize.js (skill edge-sprint).
// Affiche par setup : global train/test, buckets régime (test ET train = anti
// cherry-pick), split macro — tout ce que la checklist anti-mirage exige.
//
// Usage : node trade-journal/read-optimize.js <fichier.json> [regex-setups]
//   ex.  node trade-journal/read-optimize.js /tmp/sprint-run.json "S10|MR8_MTF"
//   sans regex : tous les setups, triés par exp OOS desc.
// ═══════════════════════════════════════════════════════════════════
const fs = require("fs");

const file = process.argv[2];
if (!file) { console.error("Usage: node read-optimize.js <fichier.json> [regex]"); process.exit(1); }
const j = JSON.parse(fs.readFileSync(file, "utf8"));
const re = process.argv[3] ? new RegExp(process.argv[3]) : null;

console.log(`périme: ${j.periode} · paires: ${j.pairs} · objectif: ${j.objectif}\n`);
for (const s of j.setups) {
  if (re && !re.test(s.setup)) continue;
  if (!s.test_OOS) { console.log(`== ${s.setup.padEnd(24)} ${s.note || "?"}`); continue; }
  const flag = s.train && Math.sign(s.train.exp) !== Math.sign(s.test_OOS.exp) ? "  ⚠️ SIGNE INVERSÉ train/test" : "";
  const rnd = s.beats_random === false ? "  🎲 NE BAT PAS LE RANDOM" : s.beats_random === true && s.random_control ? `  🎲 bat random (${s.random_control.exp_matched}R)` : "";
  console.log(`== ${s.setup.padEnd(24)} ${(s.verdict || "").slice(0, 14)}  train ${s.train.exp}R/n${s.train.n}  test ${s.test_OOS.exp}R/WR${s.test_OOS.wr}%/n${s.test_OOS.n}${flag}${rnd}`);
  if (s.test_by_regime) {
    for (const [k, v] of Object.entries(s.test_by_regime)) {
      const tr = s.train_by_regime && s.train_by_regime[k];
      const warn = tr && v.exp != null && tr.exp != null && Math.sign(tr.exp) !== Math.sign(v.exp) ? "  ⚠️ bucket incohérent" : "";
      console.log(`     ${k.padEnd(9)} test ${JSON.stringify(v)}  train ${tr ? JSON.stringify(tr) : "—"}${warn}`);
    }
  }
  if (s.test_by_macro_pairfav && Object.keys(s.test_by_macro_pairfav).length) {
    for (const [k, v] of Object.entries(s.test_by_macro_pairfav)) console.log(`     macro ${k.padEnd(15)} ${JSON.stringify(v)}`);
  }
  // #1 validation robuste (OPT_CPCV) : Sharpe OOS, CPCV folds, Deflated Sharpe, null bootstrap
  if (s.cpcv) {
    const c = s.cpcv;
    console.log(`     ROBUST  v2=${c.verdict_v2 || "?"} | OOS_sharpe ${c.oos_sharpe} | CPCV folds+ ${c.folds_pos_frac} (n${c.folds_evaluated}) med_sharpe ${c.cpcv_median_sharpe} | DSR ${c.dsr} (N=${c.dsr_nTrials}) | boot_p ${c.boot_p}`);
  }
}
