#!/usr/bin/env node
"use strict";
// Tests offline de obsidian-sync.js (renderBlock + injectBlock). Zero reseau, zero ecriture vault.
// Run: node tests/test-obsidian-sync.js
const { renderBlock, injectBlock } = require("../trade-journal/obsidian-sync.js");
let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log("  PASS  " + name); } else { failed++; console.log("  FAIL  " + name); } }

const state = {
  ts: "2026-06-09 14:15", equity: 50001.7, halt: false, day_pnl_pct: 0.01,
  closed_n: 4, win_rate: 50, avg_r: 0.47, closed_pnl: -2.79,
  active: [
    { status: "open", symbol: "BTC", side: "short", entry_actual: 63200, stop_loss: 64500, timeline: [{ decision: "keep", mark: 62823 }] },
    { status: "pending", symbol: "SOL", side: "short", entry_planned: 67.49, stop_loss: 68.70 },
  ],
  closed: [
    { symbol: "ETH", strategy: "S2_short_continuation", side: "short", net_pnl: -9.02, r_multiple: -0.57 },
    { symbol: "BTC", strategy: "A_short_rebound", side: "short", net_pnl: 7.66, r_multiple: 1.87 },
  ],
  cancelled_n: 7, cancelled_reasons: { "rebond raté": 2, "repositionné": 3, "quota": 1, "autre": 1 },
};
const block = renderBlock(state);
ok("bloc a les marqueurs", block.includes("<!-- AUTO-ROUTINE-START -->") && block.includes("<!-- AUTO-ROUTINE-END -->"));
ok("equity formatée + breaker", block.includes("50 002 USDT") && block.includes("🟢 OK"));
ok("callout résumé (rendu propre)", block.includes("[!abstract]+ 🔄 État live"));
ok("tableau positions aligné (hors blockquote)", block.includes("##### 📊 Positions actives") && block.includes("|:--|:--|:--:|--:|--:|--:|--:|:--|") && block.includes("**BTC**") && block.includes("⏳ pending"));
ok("positions montrent mark + décision séparés", block.includes("62823") && block.includes("keep"));
ok("clôturés 4 WR 50% (cohérent)", block.includes("**4** trades · WR **50 %**") && block.includes("tests exclus"));
ok("tableau clôturés aligné", block.includes("##### ✅ Trades clôturés") && block.includes("✅ win") && block.includes("❌ loss"));
ok("non-déclenchés séparé (hors WR)", block.includes("##### 🚫 Non déclenchés") && block.includes("hors WR") && block.includes("**7**") && block.includes("rebond raté **2**"));

// injectBlock : remplace entre marqueurs
const note1 = "# Titre\n\nIntro\n\n<!-- AUTO-ROUTINE-START -->\nVIEUX CONTENU\n<!-- AUTO-ROUTINE-END -->\n\n## Suite\nblabla\n";
const r1 = injectBlock(note1, block);
ok("remplace l'ancien bloc", !r1.includes("VIEUX CONTENU") && r1.includes("50 002 USDT"));
ok("preserve le reste de la note", r1.includes("# Titre") && r1.includes("## Suite") && r1.includes("blabla"));
ok("un seul bloc apres remplacement", r1.split("AUTO-ROUTINE-START").length === 2);

// injectBlock sans marqueurs : insere apres le H1
const note2 = "# Titre\n\nIntro\n\n## Section\ntexte\n";
const r2 = injectBlock(note2, block);
ok("insere le bloc si marqueurs absents", r2.includes("<!-- AUTO-ROUTINE-START -->") && r2.includes("# Titre"));
ok("re-sync idempotent (2e passe remplace, pas duplique)", injectBlock(r2, block).split("AUTO-ROUTINE-START").length === 2);

console.log(`\n  obsidian-sync.js: ${passed} pass, ${failed} fail`);
process.exit(failed ? 1 : 0);
