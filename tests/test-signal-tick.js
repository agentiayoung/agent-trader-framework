#!/usr/bin/env node
"use strict";
// Tests offline du signal-tick 4h (alertes self-sourced) : signalsFromScans + oppsToScans (mapping
// scan.js -> alertes) + runSignalTick gated (deps mockees). Run: node tests/test-signal-tick.js
const { signalsFromScans, oppsToScans, runSignalTick } = require("../trade-journal/signal-tick.js");
let p = 0, f = 0;
const ok = (n, c) => { if (c) { p++; console.log("  PASS  " + n); } else { f++; console.log("  FAIL  " + n); } };

// ── oppsToScans : map opportunites scan.js -> shape signalsFromScans ──
const opps = [
  { pair: "BTC", side: "short", px: 60000, setup: "MR8" },
  { pair: "ETH", side: "long", px: 3000, setup: "FVG_BOS" },
];
const scans = oppsToScans(opps);
ok("oppsToScans : symbol=pair", scans[0].symbol === "BTC");
ok("oppsToScans : plan.opportunity=true", scans[0].plan.opportunity === true);
ok("oppsToScans : side/entry/engine mappes", scans[0].plan.signal.side === "short" && scans[0].plan.bracket.entry === 60000 && scans[0].plan.engine === "MR8");

// ── signalsFromScans (PUR) ──
const out = signalsFromScans(scans, new Set(), { tf: "4h", barTs: "B1" });
ok("2 alertes", out.length === 2);
ok("schema (BTC short MR8 via=self)", out[0].symbol === "BTC" && out[0].side === "short" && out[0].edge === "MR8" && out[0].via === "self" && out[0].tf === "4h");
ok("id deterministe", out[0].id === "BTC-MR8-4h-B1");
ok("price=px", out[0].price === 60000);
ok("dedup vs seenIds", signalsFromScans(scans, new Set(["BTC-MR8-4h-B1"]), { tf: "4h", barTs: "B1" }).length === 1);
ok("side invalide -> drop", signalsFromScans([{ symbol: "X", plan: { opportunity: true, signal: { side: "up" }, engine: "e" } }], new Set(), {}).length === 0);

// ── runSignalTick gated (scanAll mockee) ──
(async () => {
  const os = require("os"), fsx = require("fs"), pathx = require("path");
  const qf = pathx.join(os.tmpdir(), "signaltick4h-test-" + process.pid + ".jsonl");
  try { fsx.unlinkSync(qf); } catch (_) {}
  const prev = process.env.SIGNAL_TICK;

  process.env.SIGNAL_TICK = "0";
  let r = await runSignalTick({ deps: { scanAll() { throw new Error("ne doit pas etre appele"); }, barTs: () => "B1", log() {} }, queueFile: qf });
  ok("gate off -> no-op", r.ok === false && r.appended === 0);

  process.env.SIGNAL_TICK = "1";
  const deps = { scanAll() { return [{ pair: "BTC", side: "short", px: 60000, setup: "MR8" }]; }, barTs() { return "B1"; }, log() {} };
  r = await runSignalTick({ deps, queueFile: qf, tf: "4h" });
  ok("gate on -> 1 append", r.ok === true && r.appended === 1);
  ok("file ecrite (BTC)", JSON.parse(fsx.readFileSync(qf, "utf8").trim().split("\n")[0]).symbol === "BTC");
  r = await runSignalTick({ deps, queueFile: qf, tf: "4h" });
  ok("2e run meme barre -> dedup (0)", r.appended === 0);

  try { fsx.unlinkSync(qf); } catch (_) {}
  if (prev === undefined) delete process.env.SIGNAL_TICK; else process.env.SIGNAL_TICK = prev;
  console.log(`\n  ${p} passed, ${f} failed`);
  process.exit(f ? 1 : 0);
})();
