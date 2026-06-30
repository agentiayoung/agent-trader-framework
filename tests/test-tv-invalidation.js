#!/usr/bin/env node
"use strict";
// Tests offline du calcul du niveau d'invalidation (exits event-driven TV5).
// invalidationLevel(plan) -> { level, cross } : le prix ou la THESE casse + le sens du croisement
// (long: close < level ; short: close > level). Pine alerte sur ce croisement (isconfirmed) ; le
// node re-valide avant de couper. PUR, zero reseau.
// Run: node tests/test-tv-invalidation.js
const { invalidationLevel } = require("../trade-journal/tv-invalidation.js");
let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log("  PASS  " + name); } else { failed++; console.log("  FAIL  " + name); } }

// LONG : invalidation sous la zone source (priorite) ou le SL structurel.
const long = { side: "long", entry: 100, stop_loss: 98, zone: { lo: 99, hi: 101 } };
let r = invalidationLevel(long);
ok("long -> cross below", r.cross === "below");
ok("long -> level = bas de zone (99) si plus proche que SL", r.level === 99);

const longNoZone = { side: "long", entry: 100, stop_loss: 98 };
ok("long sans zone -> level = SL structurel", invalidationLevel(longNoZone).level === 98);

// SHORT : invalidation au-dessus.
const short = { side: "short", entry: 100, stop_loss: 102, zone: { lo: 99, hi: 101 } };
r = invalidationLevel(short);
ok("short -> cross above", r.cross === "above");
ok("short -> level = haut de zone (101)", r.level === 101);

// GARDE-FOUS : un niveau d'invalidation ne doit jamais etre du MAUVAIS cote (cut immediat absurde).
ok("long : level < entry (sinon cut immediat)", invalidationLevel(long).level < long.entry);
ok("short : level > entry", invalidationLevel(short).level > short.entry);

// ROBUSTESSE : entree invalide -> null (pas de crash).
ok("plan vide -> null", invalidationLevel({}) === null);
ok("side inconnu -> null", invalidationLevel({ side: "x", entry: 1, stop_loss: 0.9 }) === null);

// PAYLOAD : buildInvalidationAlert produit le JSON pour alert_create (kind:exit, secret inclus a part).
const { buildInvalidationAlert } = require("../trade-journal/tv-invalidation.js");
const a = buildInvalidationAlert({ id: "t1", symbol: "XAUT", side: "long", entry: 100, stop_loss: 98, zone: { lo: 99, hi: 101 } }, "15m");
ok("alert.kind = exit", a && a.kind === "exit");
ok("alert.symbol", a && a.symbol === "XAUT");
ok("alert.level present", a && a.level === 99);
ok("alert.trade_id propage (lien position)", a && a.trade_id === "t1");

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
