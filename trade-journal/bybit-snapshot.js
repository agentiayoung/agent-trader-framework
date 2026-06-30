"use strict";
// ═══════════════════════════════════════════════════════════════════
// bybit-snapshot.js — snapshot de l'etat REEL Bybit (positions + ordres au repos).
//
// Ecrit par l'agent (qui a les cles) -> `bybit-live.json`. Le dashboard le LIT (file-only, zero
// secret) pour n'afficher QUE la verite Bybit, au lieu du journal qui derive (pending fantome
// entre 2 reconcile, ex. SOL absent de Bybit mais encore "pending" au journal).
// `buildBybitSnapshot` est PUR (testable) ; le fetch reseau vit dans journal.js cmd_bybit_snapshot.
// ═══════════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");
const SNAP_PATH = path.join(__dirname, "bybit-live.json");

function baseSym(s) { return String(s || "").toUpperCase().replace(/\/.*$/, "").replace(/USDT.*$/, "").replace(/[^A-Z0-9]/g, ""); }
function isReduce(o) { return !!(o && (o.reduceOnly === true || (o.info && (o.info.reduceOnly === true || o.info.reduceOnly === "true")))); }

// PURE : positions + ordres ccxt -> snapshot compact. nowMs injectable (test).
function buildBybitSnapshot(positions, orders, nowMs) {
  const ts = nowMs != null ? nowMs : Date.now();
  const pos = (positions || [])
    .filter((p) => p && Math.abs(Number(p.contracts || 0)) > 0)
    .map((p) => ({
      symbol: baseSym(p.symbol), side: p.side || null, size: Math.abs(Number(p.contracts)),
      entry: p.entryPrice != null ? Number(p.entryPrice) : null,
      mark: p.markPrice != null ? Number(p.markPrice) : null,
      upnl: p.unrealizedPnl != null ? Number(p.unrealizedPnl) : null,
    }));
  const ord = (orders || []).map((o) => ({
    symbol: baseSym(o.symbol), side: o.side || null, type: o.type || null,
    px: o.price != null ? Number(o.price) : null,
    trigger: o.triggerPrice != null ? Number(o.triggerPrice) : null,
    qty: o.amount != null ? Number(o.amount) : null,
    reduceOnly: isReduce(o),
  }));
  return { ts, generated: new Date(ts).toISOString(), positions: pos, orders: ord };
}

function writeBybitSnapshot(snap, p) { try { fs.writeFileSync(p || SNAP_PATH, JSON.stringify(snap)); return true; } catch (_) { return false; } }

module.exports = { buildBybitSnapshot, writeBybitSnapshot, baseSym, isReduce, SNAP_PATH };
