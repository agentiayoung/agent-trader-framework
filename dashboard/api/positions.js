"use strict";
// ═══════════════════════════════════════════════════════════════════
// dashboard/api/positions.js — Positions/ordres RÉELS Bybit (PUR).
//
// Lit les `bybit-live.json` des 2 agents (snapshot écrit par eux au reconcile/tick) et expose la
// VÉRITÉ Bybit : positions remplies (mark/uPnL) + ordres au repos réels (entrées limit non remplies).
// Fini les pending fantômes du journal (un ordre disparu de Bybit n'est PAS dans le snapshot).
// LECTURE SEULE, zéro secret (les agents ont les clés, pas le dashboard). Dégradation gracieuse.
// ═══════════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");

// PURE : un snapshot agent -> vue { positions remplies, pending=entrées au repos, bracket_n=SL/TP }.
function buildOne(snap, nowMs) {
  if (!snap || typeof snap !== "object") return { available: false };
  const now = nowMs != null ? nowMs : Date.now();
  const age_sec = snap.ts != null ? Math.round((now - snap.ts) / 1000) : null;
  const orders = Array.isArray(snap.orders) ? snap.orders : [];
  const pending = orders.filter((o) => o && !o.reduceOnly); // entrées limit au repos (les "pending" réels)
  const brackets = orders.filter((o) => o && o.reduceOnly);  // SL/TP attachés (pour retrouver le SL par symbole)
  return {
    available: true,
    ts: snap.ts != null ? snap.ts : null,
    age_sec,
    positions: Array.isArray(snap.positions) ? snap.positions : [],
    pending,
    brackets,
    bracket_n: brackets.length,
  };
}

// PURE : les 2 agents.
function buildPositions(agentSnap, scalpSnap, nowMs) {
  const now = nowMs != null ? nowMs : Date.now();
  return { "agent-trader": buildOne(agentSnap, now), "scalp-trader": buildOne(scalpSnap, now) };
}

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch (_) { return null; } }

function readPositions() {
  const { resolveDirs } = require("../../trade-journal/portfolio.js");
  const { agentDir, scalpDir } = resolveDirs();
  return buildPositions(readJson(path.join(agentDir, "bybit-live.json")), readJson(path.join(scalpDir, "bybit-live.json")));
}

module.exports = { buildOne, buildPositions, readPositions };
