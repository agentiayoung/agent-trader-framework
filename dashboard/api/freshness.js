"use strict";
// ═══════════════════════════════════════════════════════════════════
// dashboard/api/freshness.js — Fraîcheur des sources de données.
//
// Calcule l'âge de chaque fichier source (scan-latest, heartbeat, journaux)
// pour afficher un badge de fraîcheur sur chaque carte du dashboard : une
// routine qui n'a pas tourné se voit immédiatement. LECTURE SEULE.
//
// `computeFreshness` est PURE (prend mtimeMs + now en entrée) ; `readFreshness`
// fait le stat des fichiers réels.
// ═══════════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");

const DEFAULT_THRESHOLD_SEC = 7200; // 2h : défaut générique.

// Seuils de péremption PAR SOURCE, calés sur la cadence RÉELLE de chaque flux :
// l'agent 4h écrit son heartbeat ~6×/jour (≈4h) → un seuil de 2h le marquerait
// stale en permanence (faux positif). Le scalp tourne ~horaire → 2h convient.
const STALE_THRESHOLDS = {
  "scan-latest": 5400,       // 90min (le plus frais des 2 scans tourne <=1h)
  "agent-trades": 21600,     // 6h
  "scalp-trades": 10800,     // 3h
  "agent-heartbeat": 18000,  // 5h (agent 4h : 6 routines/j)
  "scalp-heartbeat": 7200,   // 2h (scalp horaire)
};

// PURE. sources = { name: { mtimeMs:number|null, ts:string|null } }
// opts = { nowMs, thresholdSec, thresholds:{ name:sec } }
// -> { name: { exists, age_sec, mtimeMs, stale } }
function computeFreshness(sources, opts = {}) {
  const nowMs = opts.nowMs != null ? opts.nowMs : Date.now();
  const defThr = opts.thresholdSec != null ? opts.thresholdSec : DEFAULT_THRESHOLD_SEC;
  const perSrc = opts.thresholds || {};
  const out = {};
  for (const name of Object.keys(sources || {})) {
    const src = sources[name] || {};
    const thr = perSrc[name] != null ? perSrc[name] : defThr;
    if (src.mtimeMs == null) {
      out[name] = { exists: false, age_sec: null, mtimeMs: null, stale: true };
      continue;
    }
    const age_sec = Math.round((nowMs - src.mtimeMs) / 1000);
    out[name] = { exists: true, age_sec, mtimeMs: src.mtimeMs, stale: age_sec > thr };
  }
  return out;
}

// Stat un fichier -> { mtimeMs|null }. Best-effort, jamais d'exception.
function statSource(file) {
  try { return { mtimeMs: fs.statSync(file).mtimeMs }; } catch (_) { return { mtimeMs: null }; }
}

// Lecture réelle des sources clés des 2 agents. Le `scan-latest` reflète le
// scan le plus FRAIS des deux (celui réellement affiché par market/grid/options).
function readFreshness(opts = {}) {
  const { resolveDirs } = require("../../trade-journal/portfolio.js");
  const { freshestScanMtime } = require("./sources.js");
  const { agentDir, scalpDir } = resolveDirs();
  const agentRoutines = path.join(agentDir, "..", "routines", "heartbeat.json");
  const scalpRoutines = path.join(scalpDir, "..", "routines", "heartbeat.json");
  const sources = {
    "scan-latest": { mtimeMs: freshestScanMtime().mtimeMs },
    "agent-trades": statSource(path.join(agentDir, "trades.jsonl")),
    "scalp-trades": statSource(path.join(scalpDir, "trades.jsonl")),
    "agent-heartbeat": statSource(agentRoutines),
    "scalp-heartbeat": statSource(scalpRoutines),
  };
  const merged = Object.assign({}, STALE_THRESHOLDS, opts.thresholds || {});
  return computeFreshness(sources, Object.assign({}, opts, { thresholds: merged }));
}

module.exports = { computeFreshness, readFreshness, DEFAULT_THRESHOLD_SEC };
