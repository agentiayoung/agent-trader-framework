#!/usr/bin/env node
"use strict";
// Tests offline de la carte de gravite des options (options-context.js). Zero reseau.
// Chaine synthetique a proprietes connues -> asserts deterministes sur max-pain/walls/GEX/put-call/skew.
// Run: node tests/test-options.js
const O = require("../trade-journal/options-context.js");
let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log("  PASS  " + name); } else { failed++; console.log("  FAIL  " + name); } }
function approx(a, b, eps) { return Math.abs(a - b) <= (eps == null ? 1e-9 : eps); }

// ── parseInstrument ──
const pi = O.parseInstrument("BTC-26MAR27-105000-C");
ok("parse strike 105000", pi && pi.strike === 105000);
ok("parse type call", pi && pi.type === "call");
ok("parse expiry Mar 2027", pi && new Date(pi.expiryMs).getUTCFullYear() === 2027 && new Date(pi.expiryMs).getUTCMonth() === 2);
ok("parse put (P)", O.parseInstrument("ETH-27JUN25-3000-P").type === "put");
ok("parse rejette format invalide", O.parseInstrument("BTC-PERPETUAL") === null);

// ── normalizeChain (raw -> normalise, filtre OI>0, expiries proches) ──
const raw = [
  { instrument_name: "BTC-27JUN25-90000-C", open_interest: "200", mark_iv: "45", underlying_price: "100000" },
  { instrument_name: "BTC-27JUN25-100000-C", open_interest: "50", mark_iv: "42", underlying_price: "100000" },
  { instrument_name: "BTC-27JUN25-110000-P", open_interest: "50", mark_iv: "50", underlying_price: "100000" },
  { instrument_name: "BTC-27JUN25-80000-P", open_interest: "0", mark_iv: "55", underlying_price: "100000" }, // OI 0 -> ignore
  { instrument_name: "BTC-PERP", open_interest: "999", mark_iv: "0" }, // invalide -> ignore
];
const chain = O.normalizeChain(raw, { nowMs: Date.UTC(2025, 0, 1) });
ok("normalizeChain garde 3 (OI>0, parsables)", chain.length === 3);
ok("normalizeChain iv en decimal", approx(chain[0].iv, 0.45, 1e-9));
ok("normalizeChain ignore OI=0", !chain.some((x) => x.strike === 80000));

// ── max pain (calcul a la main : min payout a S=90000) ──
ok("maxPain = 90000", O.maxPain(chain) === 90000);

// ── walls ──
const w = O.walls(chain);
ok("call_wall = 90000 (plus gros OI call)", w.call_wall === 90000);
ok("put_wall = 110000", w.put_wall === 110000);

// ── put/call ratio (putOI 50 / callOI 250 = 0.2) ──
ok("put_call = 0.2", approx(O.putCall(chain), 0.2, 1e-9));

// ── bsGamma : max ATM, >0, decroit hors money ──
ok("bsGamma ATM > OTM", O.bsGamma(100, 100, 0.5, 0.1) > O.bsGamma(100, 80, 0.5, 0.1));
ok("bsGamma > 0", O.bsGamma(100, 100, 0.5, 0.1) > 0);
ok("bsGamma 0 si inputs invalides", O.bsGamma(100, 100, 0, 0.1) === 0);

// ── gamma_regime : chaine call-heavy -> net gamma positif ; put-heavy -> negatif ──
const now = Date.UTC(2025, 0, 1);
const callHeavy = O.normalizeChain([
  { instrument_name: "BTC-27JUN25-100000-C", open_interest: "500", mark_iv: "45", underlying_price: "100000" },
  { instrument_name: "BTC-27JUN25-90000-P", open_interest: "10", mark_iv: "50", underlying_price: "100000" },
], { nowMs: now });
ok("gamma_regime positive si call-heavy", O.gammaExposure(callHeavy, 100000, now).gamma_regime === "positive");
const putHeavy = O.normalizeChain([
  { instrument_name: "BTC-27JUN25-100000-P", open_interest: "500", mark_iv: "45", underlying_price: "100000" },
  { instrument_name: "BTC-27JUN25-110000-C", open_interest: "10", mark_iv: "50", underlying_price: "100000" },
], { nowMs: now });
ok("gamma_regime negative si put-heavy", O.gammaExposure(putHeavy, 100000, now).gamma_regime === "negative");

// ── buildOptionsContext : objet complet + read ──
const ctx = O.buildOptionsContext(chain, 100000, now);
ok("ctx non-null", ctx != null);
ok("ctx.max_pain = 90000", ctx.max_pain === 90000);
ok("ctx.call_wall = 90000", ctx.call_wall === 90000);
ok("ctx.gamma_regime present", ["positive", "negative", "flat"].includes(ctx.gamma_regime));
ok("ctx.read non vide", typeof ctx.read === "string" && ctx.read.length > 0);
ok("ctx null sur chaine vide", O.buildOptionsContext([], 100000, now) === null);

// ── inferSpot ──
ok("inferSpot = median underlying", O.inferSpot(chain) === 100000);

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
