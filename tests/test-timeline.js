#!/usr/bin/env node
"use strict";
// Tests offline deterministes de timeline.js. Zero reseau.
// Run: node tests/test-timeline.js
const { addSnapshot, renderTradePage, staleOpen, buildBrief } = require("../trade-journal/timeline.js");
let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log("  PASS  " + name); } else { failed++; console.log("  FAIL  " + name); } }

// addSnapshot : init [] + append, pas d'ecrasement
const t = { id: "x", status: "open", side: "short", symbol: "BTC", strategy: "S1" };
ok("addSnapshot 1er -> count 1", addSnapshot(t, { ts: "2026-06-09T10:00+02:00", decision: "open", note: "a" }) === 1);
ok("addSnapshot 2e -> count 2", addSnapshot(t, { ts: "2026-06-09T14:00+02:00", decision: "keep", note: "b" }) === 2);
ok("timeline conserve les 2 (append, pas overwrite)", t.timeline.length === 2 && t.timeline[0].note === "a" && t.timeline[1].note === "b");

// renderTradePage : contient rationale + lignes timeline + decisions
const t2 = {
  id: "s1-btc-x", status: "open", exchange: "bybit", mode: "demo", side: "short", symbol: "BTC",
  size: 0.006, entry_planned: 63200, stop_loss: 64500, strategy: "S1_short_bounce",
  rationale: "Short du rebond, thèse baissière daily.",
  timeline: [
    { ts: "2026-06-09T10:00+02:00", decision: "open", mark: 63200, upnl: 0, note: "entrée placée", score: { total: 9, tier: "B", gate: { passed: true } } },
    { ts: "2026-06-09T14:00+02:00", decision: "keep", mark: 63477, upnl: -1.6, note: "SL safe, KEEP", score: { total: 7, tier: "B", gate: { passed: true } } },
  ],
};
const page = renderTradePage(t2);
ok("page contient le titre/id", page.includes("# Trade s1-btc-x"));
ok("page contient la rationale", page.includes("Short du rebond"));
ok("page contient la table timeline", page.includes("| # | quand | décision"));
ok("page liste les 2 snapshots", page.includes("entrée placée") && page.includes("SL safe, KEEP"));
ok("page montre l'evolution du score (9 puis 7)", page.includes("| 9 |") && page.includes("| 7 |"));

// page d'un trade SANS timeline
const empty = renderTradePage({ id: "y", status: "pending", side: "long", symbol: "ETH", strategy: "MR8" });
ok("page sans timeline -> message dedie", empty.includes("Aucun snapshot de gestion"));

// staleOpen : open sans note du jour = stale ; avec note du jour = OK ; closed ignore
const trades = [
  { id: "a", status: "open", timeline: [{ ts: "2026-06-08T22:00+02:00", decision: "keep" }] }, // hier -> stale
  { id: "b", status: "open", timeline: [{ ts: "2026-06-09T06:00+02:00", decision: "keep" }] }, // aujourd'hui -> OK
  { id: "c", status: "pending" },                                                              // pas de timeline -> stale
  { id: "d", status: "closed", timeline: [{ ts: "2026-06-08T22:00+02:00" }] },                 // closed -> ignore
];
const stale = staleOpen(trades, "2026-06-09");
ok("staleOpen detecte a (hier) et c (vide)", stale.length === 2 && stale.map((s) => s.id).sort().join(",") === "a,c");
ok("staleOpen ignore b (note du jour) et d (closed)", !stale.find((s) => s.id === "b") && !stale.find((s) => s.id === "d"));

// ── buildBrief : le brief lu par la routine AVANT de gérer (Imp 1, suivi qualitatif) ──
const openTrade = {
  id: "s1shortreject-btc-20260608", strategy: "S1_short_bounce", side: "short", status: "open",
  entry_actual: 63200, stop_loss: 64500, take_profits: [{ px: 60500 }, { px: 58500 }], size: 0.006,
  rationale: "S1 short du rebond TRIGGER CONFIRME. STRONG BEAR, rejet EMA20, RSI 4H falling.",
  invalidation: "4H close > 64500 OU RSI 4H > 50 rising",
  timeline: [
    { ts: "2026-06-09 02:00", mark: 63044, upnl: 1.12, decision: "keep", note: "continuation bear, SL intact", score: { total: 9 } },
    { ts: "2026-06-09 18:08", mark: 61063, upnl: 12.97, decision: "trail", note: "trail SL 64500->62000 verrouille +0.92R", score: { total: 7 } },
  ],
};
const brief = buildBrief(openTrade);
ok("brief: id + setup + side", /s1shortreject-btc-20260608/.test(brief) && /S1_short_bounce/.test(brief) && /short/.test(brief));
ok("brief: entrée + SL", /63200/.test(brief) && /64500/.test(brief));
ok("brief: invalidation loggée affichée", /4H close > 64500/.test(brief));
ok("brief: dernière action + note", /trail/.test(brief) && /verrouille \+0\.92R/.test(brief));
ok("brief: R calculé (12.97 / 7.8 = 1.66R)", /1\.66R/.test(brief));
ok("brief: /14 trend 9->7 + alerte décroissance", /9.?→.?7/.test(brief) && /DÉCROISSANCE/.test(brief));

// pending sans timeline -> pas de crash, signale l'absence de snapshot + invalidation manquante
const pend = { id: "p", strategy: "MR8", side: "long", status: "pending", entry_planned: 50, stop_loss: 49, size: 1, rationale: "test" };
const briefP = buildBrief(pend);
ok("brief pending sans timeline: pas de crash + signale absence snapshot", /aucun snapshot/i.test(briefP));
ok("brief: invalidation absente -> À LOGGER", /À LOGGER/.test(briefP));

// closed -> montre le résultat
const cl = { id: "c", strategy: "S3", side: "long", status: "closed", entry_actual: 60500, stop_loss: 58800, size: 0.012, net_pnl: 15.43, r_multiple: 1.57, avg_exit: 63166, exit_reason: "take_profit" };
ok("brief closed: montre résultat (PnL + R)", /15\.43/.test(buildBrief(cl)) && /1\.57/.test(buildBrief(cl)));
ok("brief trade null -> pas de crash", typeof buildBrief(null) === "string");

console.log(`\n  timeline.js: ${passed} pass, ${failed} fail`);
process.exit(failed ? 1 : 0);
