#!/usr/bin/env node
"use strict";
// Tests offline du mode PRICE-ACTION (histo court, DEMO_ACTIVE). Zero reseau.
// GO Hugo 16.06 : toutes les paires tradables en demo (SPCX inclus) -> un actif a histo court rend une
// row price-action (structure recente + ATR) au lieu d'etre droppe. Le LLM lit le mouvement.
// Run: node tests/test-price-action.js
const scan = require("../trade-journal/scan.js");
const { priceActionRow, atrFrom } = scan;
let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log("  PASS  " + name); } else { failed++; console.log("  FAIL  " + name); } }
function approx(a, b, eps) { return Math.abs(a - b) <= (eps == null ? 1e-6 : eps); }

// OHLCV : [ts, open, high, low, close, volume]
function bar(h, l, c) { return [0, c, h, l, c, 100]; }

// ── atrFrom : true range moyen sur peu de barres ──
const simple = [bar(11, 9, 10), bar(12, 10, 11), bar(13, 11, 12)];
ok("atrFrom calcule sur 3 barres (>0)", atrFrom(simple, 14) > 0);
ok("atrFrom null si <2 barres", atrFrom([bar(10, 9, 9.5)], 14) === null);
ok("atrFrom borne n a la longueur dispo", atrFrom(simple, 14) != null);

// ── priceActionRow : 8 barres (cas SPCX) ──
const entry = { symbol: "SPCX", class: "equity", session: "24x7" };
const bars8 = [bar(200, 180, 190), bar(210, 188, 205), bar(215, 200, 208), bar(220, 205, 212), bar(228, 210, 225), bar(226, 215, 218), bar(222, 208, 214), bar(216, 205, 210)];
const r = priceActionRow(entry, bars8, [], { last: 210.5 }, true);
ok("row non-null sur 8 barres", r != null);
ok("tradable:true", r.tradable === true);
ok("low_history:true", r.low_history === true);
ok("mode price_action", r.mode === "price_action");
ok("swing_hi = max des hauts (228)", approx(r.swing_hi, 228));
ok("swing_lo = min des bas (180)", approx(r.swing_lo, 180));
ok("px = ticker.last (210.5)", approx(r.px, 210.5));
ok("atr > 0", r.atr > 0);
ok("ema20 calcule (>0)", r.ema20 > 0);
ok("pa_trend up/down/flat", ["up", "down", "flat"].includes(r.pa_trend));
ok("bars = 8", r.bars === 8);

// ── fallback timing bars si setup bars insuffisants ──
const r2 = priceActionRow(entry, [], bars8, { last: 210.5 }, false);
ok("fallback sur timing bars", r2 != null && r2.bars === 8);
ok("session_open propage (false)", r2.session_open === false);

// ── trop peu de barres partout -> null (non tradable, meme en demo) ──
ok("null si <6 barres des deux cotes", priceActionRow(entry, [bar(10, 9, 9.5)], [bar(10, 9, 9.5)], null, true) === null);

// ── px fallback sur close si pas de ticker ──
const r3 = priceActionRow(entry, bars8, [], null, true);
ok("px fallback dernier close (210)", approx(r3.px, 210));

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
