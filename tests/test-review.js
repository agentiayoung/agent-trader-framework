#!/usr/bin/env node
"use strict";
// Tests offline de review.js (flags actionnables + markdown). Zero reseau.
// Run: node tests/test-review.js
const { reviewFlags, renderReview } = require("../trade-journal/review.js");
let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log("  PASS  " + name); } else { failed++; console.log("  FAIL  " + name); } }

const stats = { trades: 6, win_rate: 33, net_pnl: -20, avg_r: -0.2, not_triggered: { cancelled: 5, by_reason: { rebond_rate: 3, repositionne: 2 } } };
const scorecard = { setups: [
  { setup: "S5_fade_range", n: 6, win_rate: 60, expectancy: 0.3, verdict: "TRADER" },
  { setup: "MR4_bb_trendfilt", n: 5, win_rate: 30, expectancy: -0.2, verdict: "EVITER" },
] };
const scoreEval = { n: 6, by_bucket: { "12+": { avg_r: 0.5 }, "<6": { avg_r: -0.3 } } };

const flags = reviewFlags(stats, scorecard, scoreEval);
const f = flags.join(" | ");
ok("flag WR bas (<40, n>=5)", /WR déclenché 33%/.test(f));
ok("flag PnL négatif", /PnL net déclenché négatif/.test(f));
ok("flag setup gagnant (S5 privilégier)", /S5_fade_range.*privilégier/.test(f));
ok("flag setup perdant (MR4 éviter)", /MR4_bb_trendfilt.*ÉVITER/.test(f));
ok("flag /14 prédit (haut 0.5 > bas -0.3)", /\/14 prédit le R/.test(f));
ok("flag rebond raté (3 annulés)", /rebond raté/.test(f));

// échantillon faible -> flag info
const fLow = reviewFlags({ trades: 2 }, { setups: [] }, { n: 0 }).join(" | ");
ok("petit échantillon -> flag info (laisser tourner)", /échantillon faible/.test(fLow) && /pas assez pour valider le \/14/.test(fLow));

// ── Slippage (piste 1) : flags de friction live ────────────────────────────
// coût live >> modèle (entrées market) -> ⚠️ forcer LIMIT/maker
const slipBad = { n: 4, cost_ratio: 2.4, avg_realized_cost_R: 0.18, avg_modeled_cost_R: 0.075, avg_entry_slip_R: 0.3, avg_total_friction_R: 0.48 };
const fBad = reviewFlags(stats, scorecard, scoreEval, slipBad).join(" | ");
ok("slip: coût live >> modèle -> flag LIMIT/maker", /coût live 2\.4× le modèle/.test(fBad) && /LIMIT\/maker/.test(fBad));
ok("slip: slip adverse menace edges marginaux", /slip d'entrée moyen 0\.3R/.test(fBad) && /MR4\/S1/.test(fBad));
// slip ≈ 0 (B1 maker tient) -> ✅
const slipOk = { n: 5, cost_ratio: 1.05, avg_realized_cost_R: 0.05, avg_modeled_cost_R: 0.048, avg_entry_slip_R: 0.0, avg_total_friction_R: 0.05 };
const fOk = reviewFlags(stats, scorecard, scoreEval, slipOk).join(" | ");
ok("slip: ≈0 -> ✅ B1 maker tient", /slip d'entrée ≈ 0/.test(fOk) && /B1 maker tient/.test(fOk));
// n<3 -> info "laisser tourner"
const fSlipLow = reviewFlags(stats, scorecard, scoreEval, { n: 1 }).join(" | ");
ok("slip: n<3 -> info laisser tourner", /slippage n=1/.test(fSlipLow));
// slippage absent -> aucun flag slippage (retrocompat 3 args)
ok("slip: absent -> pas de flag slippage (retrocompat)", !/slip|friction|coût live/i.test(reviewFlags(stats, scorecard, scoreEval).join(" | ")));

// renderReview
const md = renderReview({ date: "2026-06-09", stats, scorecard, scoreEval, slippage: slipBad, flags });
ok("markdown: titre + perf déclenchée", md.includes("Review agent-trader") && md.includes("Perf DÉCLENCHÉE") && md.includes("6 trades"));
ok("markdown: non déclenchés + flags", md.includes("Non déclenchés* : 5") && md.includes("Flags / actions"));
ok("markdown: ligne friction live", md.includes("Friction live") && md.includes("×2.4"));

console.log(`\n  review.js: ${passed} pass, ${failed} fail`);
process.exit(failed ? 1 : 0);
