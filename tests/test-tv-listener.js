#!/usr/bin/env node
"use strict";
// Tests offline du listener webhook TradingView (handleAlert PUR : auth + schema + idempotence).
// Zero reseau, zero fichier. Le listener n'execute JAMAIS d'ordre (demo-only) : il authentifie et
// met en file. Pine = trigger de timing ; le node (entry-radar/monitor) re-valide l'edge.
// Run: node tests/test-tv-listener.js
const { handleAlert } = require("../trade-journal/tv-listener.js");
let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log("  PASS  " + name); } else { failed++; console.log("  FAIL  " + name); } }

const S = "topsecret";
const good = { secret: S, symbol: "XAUT", edge: "sweep_reclaim", side: "long", tf: "15m", price: 4007, ts: "2026-06-29T15:00:00Z", id: "a1" };

// ── AUTH ──
ok("mauvais secret -> 401", handleAlert({ ...good, secret: "x" }, { secret: S }).code === 401);
ok("secret absent -> 401", handleAlert({ ...good, secret: undefined }, { secret: S }).code === 401);
ok("opts.secret absent -> 401 (jamais ouvert)", handleAlert(good, {}).code === 401);
ok("bon secret -> ok", handleAlert(good, { secret: S }).ok === true);

// ── SCHEMA ──
ok("symbol manquant -> 400", handleAlert({ ...good, symbol: "" }, { secret: S }).code === 400);
ok("edge manquant -> 400", handleAlert({ ...good, edge: "" }, { secret: S }).code === 400);
ok("side invalide -> 400", handleAlert({ ...good, side: "up" }, { secret: S }).code === 400);
ok("json string invalide -> 400", handleAlert("{pas du json", { secret: S }).code === 400);
ok("json string valide -> ok", handleAlert(JSON.stringify(good), { secret: S }).ok === true);

// ── NORMALISATION ──
const r = handleAlert(good, { secret: S }).record;
ok("record.symbol normalise", r && r.symbol === "XAUT");
ok("record.side normalise lower", r && r.side === "long");
ok("record.price numerique", r && r.price === 4007);
ok("record.kind defaut entry", r && r.kind === "entry");
ok("record secret NON propage", r && r.secret === undefined);
ok("kind exit conserve", handleAlert({ ...good, kind: "exit" }, { secret: S }).record.kind === "exit");

// ── IDEMPOTENCE ──
const seen = new Set();
const first = handleAlert(good, { secret: S, seen });
ok("1er passage -> pas duplicate", first.ok === true && !first.duplicate);
const second = handleAlert(good, { secret: S, seen });
ok("meme id -> duplicate true", second.ok === true && second.duplicate === true);
ok("id different -> pas duplicate", handleAlert({ ...good, id: "a2" }, { secret: S, seen }).duplicate !== true);

// ── LECTEUR DE FILE (TV4 : consommateur entry-radar) ──
const { readNewAlerts } = require("../trade-journal/tv-listener.js");
const fs = require("fs");
const os = require("os");
const qf = os.tmpdir() + "/tv-test-queue-" + process.pid + ".jsonl";
fs.writeFileSync(qf, JSON.stringify({ id: "q1", symbol: "BTC", edge: "sweep_reclaim", kind: "entry" }) + "\n" +
                     JSON.stringify({ id: "q2", symbol: "ETH", edge: "mr8", kind: "entry" }) + "\n");
let rd = readNewAlerts(qf, 0);
ok("readNewAlerts depuis 0 -> 2 alertes", rd.alerts.length === 2);
ok("nextLine = 2", rd.nextLine === 2);
ok("aucune nouvelle depuis offset 2", readNewAlerts(qf, 2).alerts.length === 0);
fs.appendFileSync(qf, JSON.stringify({ id: "q3", symbol: "SOL", edge: "sweep_reclaim", kind: "entry" }) + "\n");
const rd2 = readNewAlerts(qf, 2);
ok("nouvelle alerte apres append -> 1", rd2.alerts.length === 1 && rd2.alerts[0].id === "q3");
fs.appendFileSync(qf, "{ligne corrompue\n");
ok("ligne corrompue ignoree (pas de crash)", readNewAlerts(qf, 3).alerts.length === 0);
ok("fichier absent -> [] sans crash", readNewAlerts(os.tmpdir() + "/nope-" + process.pid + ".jsonl", 0).alerts.length === 0);
try { fs.unlinkSync(qf); } catch (e) {}

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
