"use strict";
// ═══════════════════════════════════════════════════════════════════
// dashboard/api/sources.js — Sélection de la source de scan la PLUS FRAÎCHE.
//
// Les 2 agents écrivent chacun leur `scan-latest.json` (scalp ~horaire,
// agent 4h ~6×/jour). Pour que le dashboard montre la donnée marché la plus
// LIVE possible, on lit le scan au mtime le plus récent des deux (et on expose
// quelle source a été retenue). LECTURE SEULE.
// ═══════════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");

// PURE : choisit le candidat au mtime le plus récent. null si aucun dispo.
// cands = [{ source, file, mtimeMs:number|null }]
function pickFreshest(cands) {
  const avail = (cands || []).filter((c) => c && c.mtimeMs != null);
  if (!avail.length) return null;
  return avail.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
}

function statMtime(file) { try { return fs.statSync(file).mtimeMs; } catch (_) { return null; } }

// Les 2 scans candidats (agent + scalp), via la résolution de portfolio.js.
function scanCandidates() {
  const { resolveDirs } = require("../../trade-journal/portfolio.js");
  const { agentDir, scalpDir } = resolveDirs();
  return [
    { source: "agent-trader", file: path.join(agentDir, "scan-latest.json") },
    { source: "scalp-trader", file: path.join(scalpDir, "scan-latest.json") },
  ];
}

// Lit le scan le plus frais -> { scan, source, mtimeMs }.
function readFreshestScan() {
  const cands = scanCandidates().map((c) => Object.assign({}, c, { mtimeMs: statMtime(c.file) }));
  const best = pickFreshest(cands);
  if (!best) return { scan: null, source: null, mtimeMs: null };
  try { return { scan: JSON.parse(fs.readFileSync(best.file, "utf-8")), source: best.source, mtimeMs: best.mtimeMs }; }
  catch (_) { return { scan: null, source: best.source, mtimeMs: best.mtimeMs }; }
}

// mtime du scan le plus frais (pour le badge de fraîcheur).
function freshestScanMtime() {
  const best = pickFreshest(scanCandidates().map((c) => Object.assign({}, c, { mtimeMs: statMtime(c.file) })));
  return best ? { mtimeMs: best.mtimeMs, source: best.source } : { mtimeMs: null, source: null };
}

module.exports = { pickFreshest, readFreshestScan, freshestScanMtime, scanCandidates };
