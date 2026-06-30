"use strict";
// ═══════════════════════════════════════════════════════════════════
// dashboard/api/routines.js — Santé des routines des 2 agents (PUR).
//
// Digère `routines/heartbeat.json` de chaque agent : dernier run, fraîcheur
// (age depuis ts_iso), last_complete, halt/kill-switch, day_pnl, open/pending,
// equity. Permet de voir d'un coup d'œil si une routine n'a pas tourné.
// LECTURE SEULE, graceful.
// ═══════════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");

const HEARTBEAT_STALE_SEC = 7200;       // défaut (scalp horaire), aligné health-check.ps1.
const AGENT_HEARTBEAT_STALE_SEC = 18000; // agent 4h : 6 routines/j (~4h) -> seuil 5h, sinon faux "stale".

// PURE : digère un heartbeat (ou null). opts={nowMs, staleSec}.
function buildRoutine(hb, opts = {}) {
  if (!hb) return { stale: true, reason: "heartbeat absent" };
  const nowMs = opts.nowMs != null ? opts.nowMs : Date.now();
  const staleSec = opts.staleSec != null ? opts.staleSec : HEARTBEAT_STALE_SEC;
  const tsMs = hb.ts_iso ? Date.parse(hb.ts_iso) : NaN;
  const age_sec = Number.isFinite(tsMs) ? Math.round((nowMs - tsMs) / 1000) : null;
  // Liveness ÉLARGIE : le heartbeat de l'agent 4h peut tarder (il n'écrit pas toujours à chaque run).
  // On considère aussi l'activité externe la plus récente (scan / dernier trade, via opts.activityMs)
  // -> `live` ne crie pas faux-mort quand l'agent scanne/trade mais n'a pas réécrit son heartbeat.
  const extAgeSec = opts.activityMs != null ? Math.round((nowMs - opts.activityMs) / 1000) : null;
  const last_activity_sec = [age_sec, extAgeSec].filter((v) => v != null).reduce((a, b) => Math.min(a, b), Infinity);
  const activity = last_activity_sec === Infinity ? null : last_activity_sec;
  return {
    stale: false,
    ts: hb.ts || null,
    ts_iso: hb.ts_iso || null,
    age_sec,
    heartbeat_stale: age_sec != null ? age_sec > staleSec : null,
    last_activity_sec: activity,
    live: activity != null ? activity <= staleSec : null,
    equity: hb.equity != null ? hb.equity : null,
    open: hb.open != null ? hb.open : null,
    pending: hb.pending != null ? hb.pending : null,
    day_pnl_pct: hb.day_pnl_pct != null ? hb.day_pnl_pct : null,
    halt: !!hb.halt,
    last_complete: hb.last_complete != null ? !!hb.last_complete : null,
    last_incomplete_reason: hb.last_incomplete_reason || null,
    stale_count: hb.stale_count != null ? hb.stale_count : null,
  };
}

// PURE : les 2 agents, avec seuil de péremption PAR cadence (agent 5h / scalp 2h).
// opts.agentStaleSec / opts.scalpStaleSec surchargent ; sinon les défauts par cadence.
function buildRoutines(hbAgent, hbScalp, opts = {}) {
  const agentOpts = Object.assign({}, opts, { staleSec: opts.agentStaleSec != null ? opts.agentStaleSec : (opts.staleSec != null ? opts.staleSec : AGENT_HEARTBEAT_STALE_SEC), activityMs: opts.agentActivityMs });
  const scalpOpts = Object.assign({}, opts, { staleSec: opts.scalpStaleSec != null ? opts.scalpStaleSec : (opts.staleSec != null ? opts.staleSec : HEARTBEAT_STALE_SEC), activityMs: opts.scalpActivityMs });
  return { agent: buildRoutine(hbAgent, agentOpts), scalp: buildRoutine(hbScalp, scalpOpts) };
}

// mtime fichier + ts du dernier trade journalisé -> activité externe la plus récente (ms).
function activityMsFor(dir) {
  let best = null;
  try { best = fs.statSync(path.join(dir, "scan-latest.json")).mtimeMs; } catch (_) {}
  try {
    const lines = fs.readFileSync(path.join(dir, "trades.jsonl"), "utf-8").trim().split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0 && i >= lines.length - 5; i--) {
      try { const t = JSON.parse(lines[i]); const ms = Date.parse(t.ts_close || t.ts_open || ""); if (Number.isFinite(ms) && (best == null || ms > best)) best = ms; break; } catch (_) {}
    }
  } catch (_) {}
  return best;
}

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch (_) { return null; } }

function readRoutines(opts = {}) {
  const { resolveDirs } = require("../../trade-journal/portfolio.js");
  const { agentDir, scalpDir } = resolveDirs();
  const hbAgent = readJson(path.join(agentDir, "..", "routines", "heartbeat.json"));
  const hbScalp = readJson(path.join(scalpDir, "..", "routines", "heartbeat.json"));
  return buildRoutines(hbAgent, hbScalp, Object.assign({
    agentActivityMs: activityMsFor(agentDir),
    scalpActivityMs: activityMsFor(scalpDir),
  }, opts));
}

module.exports = { buildRoutine, buildRoutines, readRoutines, HEARTBEAT_STALE_SEC, AGENT_HEARTBEAT_STALE_SEC };
