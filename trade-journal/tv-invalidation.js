"use strict";
// ─────────────────────────────────────────────────────────────────────────────
// EXITS EVENT-DRIVEN (TV5, design 2026-06-29) — niveau d'invalidation d'une position.
//
// A chaque FILL, l'agent cree une alerte TV "close croise le niveau d'invalidation CONTRE la
// position" (zone source, sinon SL structurel). Au declenchement -> webhook (kind:exit) -> le
// monitor RE-VALIDE par node (thesis) -> si confirme, cut reduce-only + reveille le monitoring LLM.
// PUR (testable offline). Le node a TOUJOURS le dernier mot ; l'alerte ne fait que reveiller.
// ─────────────────────────────────────────────────────────────────────────────

// invalidationLevel(plan) -> { level, cross } | null
//   plan: { side:"long"|"short", entry, stop_loss, zone?:{lo,hi} }
//   long  : invalide quand close < level (zone.lo si valide, sinon stop_loss). cross="below".
//   short : invalide quand close > level (zone.hi si valide, sinon stop_loss). cross="above".
//   Garde-fou : le level doit etre du BON cote de l'entree (sinon cut immediat absurde) -> sinon null.
function invalidationLevel(plan) {
  if (!plan || typeof plan !== "object") return null;
  const side = String(plan.side || "").toLowerCase();
  const entry = Number(plan.entry);
  const sl = Number(plan.stop_loss);
  const zone = plan.zone || null;
  if (!Number.isFinite(entry)) return null;

  if (side === "long") {
    let level = (zone && Number.isFinite(Number(zone.lo)) && Number(zone.lo) < entry) ? Number(zone.lo) : sl;
    if (!Number.isFinite(level) || level >= entry) return null;
    return { level, cross: "below" };
  }
  if (side === "short") {
    let level = (zone && Number.isFinite(Number(zone.hi)) && Number(zone.hi) > entry) ? Number(zone.hi) : sl;
    if (!Number.isFinite(level) || level <= entry) return null;
    return { level, cross: "above" };
  }
  return null;
}

// buildInvalidationAlert(plan, tf) -> payload pour alert_create (kind:exit), ou null.
// trade_id relie l'alerte a la position (l'agent supprime l'alerte a la cloture).
function buildInvalidationAlert(plan, tf) {
  const inv = invalidationLevel(plan);
  if (!inv) return null;
  return {
    kind: "exit",
    trade_id: plan.id || null,
    symbol: String(plan.symbol || "").toUpperCase() || null,
    side: String(plan.side || "").toLowerCase() || null,
    level: inv.level,
    cross: inv.cross,
    tf: tf || null,
    edge: "invalidation",
  };
}

module.exports = { invalidationLevel, buildInvalidationAlert };
