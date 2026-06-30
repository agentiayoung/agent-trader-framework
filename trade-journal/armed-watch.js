"use strict";
// armed-watch.js -- store des INTENTIONS de setup (handoff routine -> radar d'entree, M002/S02).
// La routine (LLM) ne pose plus un limit aveugle qui fille sur une simple touche : elle ARME une
// intention (symbol/side/setup/level/sl/tp/risk + famille de confirmation). Le radar (S03) lit ces
// intentions a chaque tick, confirme la bougie (confirm.js), puis pose le limit MAKER + preflight.
// Ce module : valide/normalise une intention, gere le no-duplicate (idempotence) et l'expiry.
// PUR (logique) + I/O fin (read/write JSON). Zero reseau. Zero dependance ccxt.

const fs = require("fs");
const path = require("path");
const { setupFamily } = require("./confirm.js");

const WATCH_PATH = path.join(__dirname, "armed-watch.json");
const DEFAULT_EXPIRY_H = 8; // une intention non confirmee dans 8h = perimee (le contexte a change)

const isNum = (x) => typeof x === "number" && Number.isFinite(x);

// confirm_type derive de la famille : ce que le radar doit ATTENDRE avant de poser.
function confirmTypeForFamily(fam) {
  if (fam === "mr") return "immediate";          // pas d'attente (MR8_e_confirm rejete OOS)
  if (fam === "zone") return "sweep_reclaim";    // sweep + reclaim close (M004)
  if (fam === "trend") return "continuation_close";
  if (fam === "long_watch") return "continuation_close"; // forward-test
  return null;
}

// validateSetup(raw) -> { ok, errors[], setup? }. Resout family + confirm_type ; ne stampe PAS le
// temps (armSetup le fait). Rejette toute intention bancale (jamais d'entree sur du flou).
function validateSetup(raw) {
  const errors = [];
  if (!raw || typeof raw !== "object") return { ok: false, errors: ["setup vide"] };
  const symbol = String(raw.symbol || "").trim();
  const side = raw.side;
  const setup = String(raw.setup || "").trim();
  if (!symbol) errors.push("symbol manquant");
  if (side !== "long" && side !== "short") errors.push("side invalide (long|short)");
  if (!setup) errors.push("setup manquant");
  const family = raw.family && ["mr", "zone", "trend", "long_watch"].includes(raw.family)
    ? raw.family : setupFamily(setup);
  if (!family) errors.push(`famille introuvable pour setup '${setup}'`);
  if (!isNum(raw.level)) errors.push("level non numerique");
  if (!isNum(raw.sl)) errors.push("sl non numerique");
  if (!Array.isArray(raw.take_profits) || !raw.take_profits.length) errors.push("take_profits manquant");
  if (!isNum(raw.risk_usd)) errors.push("risk_usd non numerique");
  // geometrie de coherence : SL du bon cote (short SL>level, long SL<level)
  if (isNum(raw.level) && isNum(raw.sl)) {
    if (side === "short" && raw.sl <= raw.level) errors.push("short : sl doit etre AU-DESSUS du level");
    if (side === "long" && raw.sl >= raw.level) errors.push("long : sl doit etre EN-DESSOUS du level");
  }
  if (errors.length) return { ok: false, errors };
  const setupOut = {
    symbol, side, setup, family,
    level: +raw.level, sl: +raw.sl, take_profits: raw.take_profits,
    risk_usd: +raw.risk_usd,
    tf: raw.tf || (family === "zone" ? "15m" : "4h"),
    confirm_type: confirmTypeForFamily(family),
  };
  if (isNum(raw.atr)) setupOut.atr = +raw.atr;                 // requis pour la confirmation zone
  if (isNum(raw.size)) setupOut.size = +raw.size;
  if (raw.track) setupOut.track = String(raw.track);
  if (raw.rationale) setupOut.rationale = String(raw.rationale);
  return { ok: true, errors: [], setup: setupOut };
}

// id deterministe d'une intention (cle de no-duplicate) : symbol|side|setup.
function setupKey(s) { return `${s.symbol}|${s.side}|${s.setup}`; }
function setupId(s, now) { return `${s.symbol}-${s.side}-${s.setup}-${now}`.toLowerCase(); }

function emptyWatch(now) { return { ts: now, setups: [] }; }

// armSetup(watch, raw, now, opts) -> nouveau watch. Idempotent : ne cree PAS un doublon si une
// intention de meme cle (symbol|side|setup) existe deja (rafraichit l'expiry a la place).
function armSetup(watch, raw, now, opts) {
  const o = opts || {};
  const v = validateSetup(raw);
  if (!v.ok) throw new Error("armSetup: setup invalide -> " + v.errors.join("; "));
  const expiryH = isNum(o.expiryHours) ? o.expiryHours : DEFAULT_EXPIRY_H;
  const s = v.setup;
  const key = setupKey(s);
  const setups = (watch.setups || []).slice();
  const existing = setups.find((x) => setupKey(x) === key);
  const stamped = { ...s, id: existing ? existing.id : setupId(s, now), armed_ts: existing ? existing.armed_ts : now, expiry_ts: now + expiryH * 3600 * 1000 };
  if (existing) {
    // rafraichit l'intention existante (level/sl/tp/expiry peuvent bouger d'une routine a l'autre)
    return { ...watch, ts: now, setups: setups.map((x) => (setupKey(x) === key ? stamped : x)) };
  }
  return { ...watch, ts: now, setups: setups.concat([stamped]) };
}

function removeSetup(watch, id) {
  return { ...watch, setups: (watch.setups || []).filter((x) => x.id !== id) };
}

function isExpired(setup, now) { return isNum(setup.expiry_ts) && now >= setup.expiry_ts; }

// pruneExpired(watch, now) -> { watch, dropped[] }.
function pruneExpired(watch, now) {
  const dropped = [], kept = [];
  for (const s of (watch.setups || [])) (isExpired(s, now) ? dropped : kept).push(s);
  return { watch: { ...watch, setups: kept }, dropped };
}

// findActive(watch, symbol, now) -> setups non expires du symbole.
function findActive(watch, symbol, now) {
  return (watch.setups || []).filter((s) => s.symbol === symbol && !isExpired(s, now));
}

// ---- I/O fin (le radar et la routine partagent le fichier) -------------------------------------
function readWatch(p) {
  const file = p || WATCH_PATH;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!raw || !Array.isArray(raw.setups)) return emptyWatch(0);
    return raw;
  } catch (_) { return emptyWatch(0); }
}
function writeWatch(watch, p) {
  const file = p || WATCH_PATH;
  fs.writeFileSync(file, JSON.stringify(watch, null, 1));
  return file;
}

module.exports = {
  WATCH_PATH, validateSetup, confirmTypeForFamily, setupKey, setupId,
  emptyWatch, armSetup, removeSetup, isExpired, pruneExpired, findActive,
  readWatch, writeWatch,
};

// CLI : node trade-journal/armed-watch.js [list|arm <json>|prune]
if (require.main === module) {
  const cmd = process.argv[2] || "list";
  const now = Date.now();
  if (cmd === "list") {
    const w = readWatch();
    const pr = pruneExpired(w, now);
    console.log(JSON.stringify({ ts: w.ts, n: pr.watch.setups.length, expired_dropped: pr.dropped.length, setups: pr.watch.setups }, null, 1));
  } else if (cmd === "arm") {
    const raw = JSON.parse(process.argv[3] || "{}");
    let w = readWatch();
    w = armSetup(w, raw, now, {});
    writeWatch(w);
    console.log(JSON.stringify({ armed: true, n: w.setups.length }, null, 1));
  } else if (cmd === "prune") {
    const pr = pruneExpired(readWatch(), now);
    writeWatch(pr.watch);
    console.log(JSON.stringify({ pruned: pr.dropped.length, remaining: pr.watch.setups.length }, null, 1));
  } else { console.error("usage: armed-watch.js [list|arm <json>|prune]"); }
}
