#!/usr/bin/env node
"use strict";
// Tests offline de trade-note.js (buildTradeNote + mergeManualBlock).
// Zero reseau, zero ecriture vault. Run: node tests/test-trade-note.js
const { buildTradeNote, mergeManualBlock, dateOnly, deriveSetup } = require("../trade-journal/trade-note.js");
let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log("  PASS  " + name); } else { failed++; console.log("  FAIL  " + name); } }

// ── helpers ─────────────────────────────────────────────────────────
ok("dateOnly ISO local", dateOnly("2026-06-09T19:53:52+02:00") === "2026-06-09");
ok("dateOnly Z backfill", dateOnly("2026-06-08T00:00:00Z") === "2026-06-08");
ok("dateOnly date nue", dateOnly("2026-06-08") === "2026-06-08");
ok("dateOnly invalide -> null", dateOnly(undefined) === null && dateOnly("") === null);
ok("deriveSetup depuis strategy", deriveSetup({ strategy: "S1_short_bounce_rejection" }) === "S1");
ok("deriveSetup champ setup prioritaire", deriveSetup({ setup: "MR8", strategy: "autre" }) === "MR8");
ok("deriveSetup fallback", deriveSetup({ strategy: "routine_scan" }) === "routine");

// ── trade clôturé WIN (forme réelle BTC S1) ─────────────────────────
const closedWin = {
  id: "s1shortreject-btc-20260608", strategy: "S1_short_bounce_rejection", tier: "A_plus",
  exchange: "bybit", source: "routine_v2", symbol: "BTC", side: "short", size: 0.006,
  entry_planned: 63200, entry_actual: 63200, stop_loss: 64500,
  take_profits: [{ px: 60500, frac: 0.4 }, { px: 58500, frac: 0.3 }, { px: 56500, frac: 0.3 }],
  status: "closed", outcome: "win", exit_reason: "take_profit", avg_exit: 62006.3,
  net_pnl: 6.6514, r_multiple: 0.92,
  ts_open: "2026-06-08T00:00:00Z", ts_close: "2026-06-09T19:32:04.472Z",
  rationale: "S1 short du rebond TRIGGER CONFIRME. | pipe & \"quotes\" test",
  invalidation: "Cloture 4H > 64500",
  review: "Correction audit: fill partiel 0.006",
  score: { total: 3, tier: "sub", rr: 2.08 },
  timeline: [
    { ts: "2026-06-09T18:16:33+02:00", mark: 61063, upnl: 12.97, decision: "trail", note: "Short gagnant | trailing 62000", score: { total: 3 } },
  ],
};
const w = buildTradeNote(closedWin);
ok("closed: relpath = <id>.md", w && w.relpath === "s1shortreject-btc-20260608.md");
ok("closed: frontmatter type/dates", w.content.includes("type: trade") && w.content.includes("date_open: 2026-06-08") && w.content.includes("date_close: 2026-06-09"));
ok("closed: frontmatter perf", w.content.includes("r_multiple: 0.92") && w.content.includes("net_pnl: 6.65") && w.content.includes("outcome: win") && w.content.includes("status: closed"));
ok("closed: tags trade+setup+win", /tags:[\s\S]*?- trade[\s\S]*?- S1[\s\S]*?- win/.test(w.content));
ok("closed: callout WIN", w.content.includes("[!success]") && w.content.includes("+0.92R"));
ok("closed: these + invalidation + review", w.content.includes("## 🧠 Thèse") && w.content.includes("TRIGGER CONFIRME") && w.content.includes("Cloture 4H > 64500") && w.content.includes("fill partiel"));
ok("closed: niveaux entry/SL/TP", w.content.includes("63200") && w.content.includes("64500") && w.content.includes("60500 (40%)"));
ok("closed: timeline en table datee", w.content.includes("## 📅 Timeline") && w.content.includes("09.06 18:16") && w.content.includes("trail"));
ok("closed: pipes echappes dans les cellules", w.content.includes("Short gagnant \\| trailing 62000"));
ok("closed: bloc manuel present", w.content.includes("<!-- NOTES-MANUELLES-START -->") && w.content.includes("<!-- NOTES-MANUELLES-END -->"));
ok("closed: lien fiche projet", w.content.includes("[[Agent-Trader]]"));

// ── pending sans timeline ───────────────────────────────────────────
const pending = {
  id: "s1shortbouncerejection-ltc-20260609", strategy: "S1_short_bounce_rejection", tier: "B",
  exchange: "bybit", source: "manual", symbol: "LTC", side: "short", size: 1509,
  entry_planned: 43.61, stop_loss: 44.3,
  take_profits: [{ px: 40.77, frac: 0.4 }, { px: 40.5, frac: 0.3 }, { px: 40.23, frac: 0.3 }],
  status: "pending", ts_open: "2026-06-09T19:53:52+02:00",
  rationale: "[MANUEL] S1 short-du-rebond trend-aligne", invalidation: "4H close > 44.10",
  score: { total: 7, tier: "B", rr: 4.12 },
};
const p = buildTradeNote(pending);
ok("pending: status + pas de date_close", p.content.includes("status: pending") && !p.content.includes("date_close: 2026"));
ok("pending: callout TODO", p.content.includes("[!todo]") && p.content.includes("43.61"));
ok("pending: score entree 7", p.content.includes("score_entry: 7"));
ok("pending: source manual", p.content.includes("source: manual"));

// ── no_trade avec hypo ──────────────────────────────────────────────
const noTrade = {
  id: "s1shortbounce-hbar-20260609", status: "no_trade", strategy: "S1_short_bounce",
  symbol: "HBAR", side: "short", ts_open: "2026-06-09T18:23:48+02:00",
  reason: "Pas d entree S1 valide", hypo: { symbol: "HBAR", side: "short", entry: 0.081, sl: 0.0836, tp: 0.073 },
  score: { total: 6, tier: "B" },
};
const n = buildTradeNote(noTrade);
ok("no_trade avec hypo: note generee", n && n.content.includes("status: no_trade"));
ok("no_trade: callout INFO + niveaux hypo", n.content.includes("[!info]") && n.content.includes("0.081") && n.content.includes("0.0836"));
ok("no_trade: tag no-trade", /tags:[\s\S]*?- no-trade/.test(n.content));

// ── no_trade SANS hypo (log de scan) → exclu ────────────────────────
ok("no_trade sans hypo -> null", buildTradeNote({ id: "routinescan-btc-1", status: "no_trade", strategy: "routine_scan", rationale: "..." }) === null);

// ── cancelled ───────────────────────────────────────────────────────
const cancelled = {
  id: "s3longethoversold-eth-20260607", strategy: "S3_long_eth_oversold", symbol: "ETH", side: "long",
  status: "cancelled", entry_planned: 1570, stop_loss: 1480, ts_open: "2026-06-07",
  review: "Annule session 08.06 - SOP >5%: rebond direct rate",
};
const c = buildTradeNote(cancelled);
ok("cancelled: note generee + callout", c && c.content.includes("status: cancelled") && c.content.includes("[!quote]") && c.content.includes("SOP >5%"));

// ── MANUAL_TEST exclu ───────────────────────────────────────────────
ok("MANUAL_TEST -> null", buildTradeNote({ id: "t", strategy: "MANUAL_TEST_long", status: "closed", symbol: "TON" }) === null);
ok("trade sans id -> null", buildTradeNote({ strategy: "S1", status: "open" }) === null);

// ── mergeManualBlock ────────────────────────────────────────────────
const fresh = "---\nx: 1\n---\n# T\n\n<!-- NOTES-MANUELLES-START -->\n_(tes annotations ici — jamais écrasées)_\n<!-- NOTES-MANUELLES-END -->\n\nfin";
const existing = "---\nx: 0\n---\n# OLD\n\n<!-- NOTES-MANUELLES-START -->\nMa note perso importante\n<!-- NOTES-MANUELLES-END -->\n\nvieux";
const merged = mergeManualBlock(fresh, existing);
ok("merge: annotations preservees", merged.includes("Ma note perso importante") && !merged.includes("tes annotations ici"));
ok("merge: contenu frais conserve", merged.includes("# T") && merged.includes("x: 1") && !merged.includes("# OLD"));
ok("merge: existing sans bloc -> fresh tel quel", mergeManualBlock(fresh, "# vieux sans bloc") === fresh);
ok("merge: existing null -> fresh", mergeManualBlock(fresh, null) === fresh);

console.log(`\n--- Trade-note Tests ---\n${passed}/${passed + failed} tests passed`);
process.exit(failed ? 1 : 0);
