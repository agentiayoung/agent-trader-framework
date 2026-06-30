#!/usr/bin/env node
"use strict";
// Tests offline de l'API recoupement Bybit (dashboard/api/reconcile.js). Zero reseau.
// Bybit = verite : `match` true si le journal colle a Bybit (|delta_7d| <= tol). Run: node tests/test-dashboard-reconcile.js
const { buildOne, buildReconcile } = require("../dashboard/api/reconcile.js");
let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log("  PASS  " + name); } else { failed++; console.log("  FAIL  " + name); } }
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

const NOW = Date.parse("2026-06-29T12:00:00Z");
const stMatch = { ts: NOW - 600000, bybit_realized_7d: 1500.5, journal_realized_7d: 1500.5, journal_realized_all: 4200, delta_7d: 0, orphans_open: 0 };
const stDrift = { ts: NOW - 600000, bybit_realized_7d: 1500, journal_realized_7d: 1480, journal_realized_all: 4200, delta_7d: -20, orphans_open: 1 };

ok("indispo si null", buildOne(null, NOW).available === false);
const m = buildOne(stMatch, NOW, 1.0);
ok("available", m.available === true);
ok("match=true si delta dans la tolerance", m.match === true);
ok("age_sec calcule", m.age_sec === 600);
ok("expose bybit/journal 7j", m.bybit_realized_7d === 1500.5 && m.journal_realized_7d === 1500.5);

const d = buildOne(stDrift, NOW, 1.0);
ok("match=false si delta > tolerance", d.match === false);
ok("delta_7d expose", near(d.delta_7d, -20));
ok("orphans_open expose", d.orphans_open === 1);

// delta recalcule si absent du fichier
const noDelta = buildOne({ ts: NOW, bybit_realized_7d: 100, journal_realized_7d: 100.4 }, NOW, 1.0);
ok("delta recalcule (journal - bybit)", near(noDelta.delta_7d, 0.4) && noDelta.match === true);

const both = buildReconcile(stMatch, stDrift, NOW, 1.0);
ok("buildReconcile -> 2 agents", both["agent-trader"].match === true && both["scalp-trader"].match === false);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
