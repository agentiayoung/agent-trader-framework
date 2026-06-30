"use strict";
// ─────────────────────────────────────────────────────────────────────────────
// signal-tick.js (4h) — ALERTES SELF-SOURCED (design 2026-06-30, parite scalp). Le scan VALIDE
// (scan.js -> opportunities) devient une SOURCE d'alertes : a la cloture, mappe les opportunites en
// alertes -> tv-alerts.jsonl (MEME file que la couche TV ; n8n/TV reste source OPTIONNELLE).
//
// SURETE (invariant) : le radar ne POSE QUE les intentions deja armees par le LLM. Un signal self-detecte
// sur un symbole NON arme reste dans la file = FEED que la routine LLM lit -> PAS d'auto-trade.
//
// DRY : reutilise scan.js (le moteur 4h deja valide) -> aucun edge duplique. Gated SIGNAL_TICK=1.
// signalsFromScans = PUR. runSignalTick = shell (scan.js -> map -> append), deps injectables.
// ─────────────────────────────────────────────────────────────────────────────
const path = require("path");
const fs = require("fs");

// signalsFromScans(scans, seenIds, opts) -> alertes fraiches (schema tv-alerts). PUR (identique scalp).
//   scans : [{symbol, plan}] (plan : {opportunity, signal:{side,strategy}, bracket:{entry}, engine}).
function signalsFromScans(scans, seenIds, opts) {
  const o = opts || {};
  const seen = seenIds instanceof Set ? seenIds : new Set(seenIds || []);
  const out = [];
  for (const s of (scans || [])) {
    const plan = s && s.plan;
    if (!plan || !plan.opportunity) continue;
    const sig = plan.signal || {};
    const side = sig.side ? String(sig.side).toLowerCase() : null;
    if (side && side !== "long" && side !== "short") continue;
    const symbol = String(s.symbol || "").toUpperCase();
    if (!symbol) continue;
    const edge = String(plan.engine || sig.engine || "scan");
    const id = `${symbol}-${edge}-${o.tf || ""}-${o.barTs || ""}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const price = (plan.bracket && plan.bracket.entry != null) ? Number(plan.bracket.entry) : null;
    out.push({ id, symbol, edge, side: side || null, tf: o.tf || null, price, ts: o.barTs || null, kind: "entry", via: "self", strategy: sig.strategy || null });
  }
  return out;
}

function seenIdsFromQueue(qf) {
  const s = new Set();
  try { for (const l of fs.readFileSync(qf, "utf8").split("\n")) { if (!l.trim()) continue; try { const o = JSON.parse(l); if (o && o.id) s.add(String(o.id)); } catch (_) {} } } catch (_) {}
  return s;
}

// map opportunites scan.js -> [{symbol, plan}] (shape signalsFromScans).
function oppsToScans(opps) {
  return (opps || []).map((o) => ({ symbol: o.pair || o.symbol, plan: { opportunity: true, signal: { side: o.side, strategy: o.setup }, bracket: { entry: o.px }, engine: o.setup || "scan" } }));
}

// deps reelles : scanAll() = scan.js (toutes les opportunites 4h en 1 appel) ; barTs() = bucket bougie.
function defaultDeps() {
  return {
    scanAll() {
      const { execFileSync } = require("child_process");
      try {
        const out = execFileSync(process.execPath, [path.join(__dirname, "scan.js")], { encoding: "utf8", env: { ...process.env, DEMO_ACTIVE: "1" }, timeout: 120000 });
        const j = JSON.parse(out); return Array.isArray(j.opportunities) ? j.opportunities : [];
      } catch (e) { return []; }
    },
    barTs() { const ms = (process.env.SIGNAL_TICK_TF === "1h") ? 3600000 : 14400000; return String(Math.floor(Date.now() / ms) * ms); }, // 4h par defaut
    log(m) { try { console.log(m); } catch (_) {} },
  };
}

async function runSignalTick(opts) {
  const o = opts || {};
  if (!o.deps) { try { require(path.join(__dirname, "..", "skills", "bybit", "index.js")); } catch (e) {} } // config/.env
  if (process.env.SIGNAL_TICK !== "1") return { ok: false, reason: "SIGNAL_TICK!=1 (gate off)", appended: 0 };
  const deps = o.deps || defaultDeps();
  const tf = o.tf || process.env.SIGNAL_TICK_TF || "4h";
  const queueFile = o.queueFile || path.join(__dirname, "tv-alerts.jsonl");
  const barTs = typeof deps.barTs === "function" ? deps.barTs() : String(Date.now());
  let opps = [];
  try { opps = deps.scanAll() || []; } catch (_) { opps = []; }
  const scans = oppsToScans(opps);
  const fresh = signalsFromScans(scans, seenIdsFromQueue(queueFile), { tf, barTs });
  if (fresh.length) {
    try { fs.appendFileSync(queueFile, fresh.map((a) => JSON.stringify(a)).join("\n") + "\n"); }
    catch (e) { return { ok: false, reason: "append: " + (e && e.message), appended: 0 }; }
  }
  deps.log(`[signal-tick] opps=${scans.length} fresh=${fresh.length} tf=${tf}`);
  return { ok: true, scanned: scans.length, appended: fresh.length };
}

module.exports = { signalsFromScans, oppsToScans, runSignalTick, seenIdsFromQueue, defaultDeps };

// CLI : node trade-journal/signal-tick.js  (gated SIGNAL_TICK=1)
if (require.main === module) {
  runSignalTick({}).then((r) => { console.log(JSON.stringify(r)); process.exit(0); })
    .catch((e) => { console.error("signal-tick err:", e && e.message); process.exit(1); });
}
