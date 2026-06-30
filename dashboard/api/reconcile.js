"use strict";
// ═══════════════════════════════════════════════════════════════════
// dashboard/api/reconcile.js — RECOUPEMENT Bybit ↔ journal des 2 agents (PUR).
//
// Bybit = vérité absolue. cmd_reconcile écrit `reconcile-status.json` (Bybit realized 7j vs
// journal realized 7j). Le dashboard le LIT (file-only, zéro secret) pour afficher si le journal
// colle à Bybit. Un écart = trades >7j que Bybit demo a oubliés (le journal les garde) → non
// bloquant mais visible. `match=true` si |delta_7d| <= tolérance. Dégradation gracieuse.
// ═══════════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");

// PURE : un reconcile-status -> vue normalisée (age, match). tol = écart toléré en USDT.
function buildOne(st, nowMs, tol) {
  if (!st || typeof st !== "object") return { available: false };
  const now = nowMs != null ? nowMs : Date.now();
  const T = tol != null ? tol : 1.0;
  const delta = typeof st.delta_7d === "number"
    ? st.delta_7d
    : ((st.journal_realized_7d || 0) - (st.bybit_realized_7d || 0));
  return {
    available: true,
    ts: st.ts != null ? st.ts : null,
    age_sec: st.ts != null ? Math.round((now - st.ts) / 1000) : null,
    bybit_realized_7d: typeof st.bybit_realized_7d === "number" ? st.bybit_realized_7d : null,
    journal_realized_7d: typeof st.journal_realized_7d === "number" ? st.journal_realized_7d : null,
    journal_realized_all: typeof st.journal_realized_all === "number" ? st.journal_realized_all : null,
    delta_7d: +delta.toFixed(2),
    match: Math.abs(delta) <= T,            // le journal colle-t-il à Bybit (fenêtre 7j) ?
    orphans_open: typeof st.orphans_open === "number" ? st.orphans_open : null,
  };
}

// PURE : les 2 agents.
function buildReconcile(agentStatus, scalpStatus, nowMs, tol) {
  const now = nowMs != null ? nowMs : Date.now();
  return { "agent-trader": buildOne(agentStatus, now, tol), "scalp-trader": buildOne(scalpStatus, now, tol) };
}

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch (_) { return null; } }

function readReconcile() {
  const { resolveDirs } = require("../../trade-journal/portfolio.js");
  const { agentDir, scalpDir } = resolveDirs();
  return buildReconcile(readJson(path.join(agentDir, "reconcile-status.json")), readJson(path.join(scalpDir, "reconcile-status.json")));
}

module.exports = { buildOne, buildReconcile, readReconcile };
