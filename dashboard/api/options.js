"use strict";
// ═══════════════════════════════════════════════════════════════════
// dashboard/api/options.js — Agrégateur PUR de la carte options/GEX.
//
// Digère `scan-latest.market.options.{btc,eth}` (shape options-context.js,
// source Deribit) : net GEX, gamma flip, call/put walls, max pain, skew, IV,
// put/call. Ajoute des dérivés d'affichage (spot vs flip). LECTURE SEULE,
// dégradation gracieuse.
// ═══════════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");

// Digère UNE chaîne d'options (btc ou eth). PURE. null si absente.
function buildOptionsOne(o) {
  if (!o) return null;
  const spot = o.spot != null ? o.spot : null;
  const flip = o.gex_flip != null ? o.gex_flip : null;
  const above_flip = spot != null && flip != null ? spot >= flip : null;
  const flip_dist_pct = spot != null && flip != null && flip !== 0
    ? ((spot - flip) / flip) * 100
    : null;
  return {
    spot,
    max_pain: o.max_pain != null ? o.max_pain : null,
    call_wall: o.call_wall != null ? o.call_wall : null,
    put_wall: o.put_wall != null ? o.put_wall : null,
    gex_flip: flip,
    gamma_regime: o.gamma_regime || null,
    net_gex: o.net_gex != null ? o.net_gex : null,
    put_call: o.put_call != null ? o.put_call : null,
    skew_25d: o.skew_25d != null ? o.skew_25d : null,
    atm_iv: o.atm_iv != null ? o.atm_iv : null,
    n_strikes: o.n_strikes != null ? o.n_strikes : null,
    nearest_expiry: o.nearest_expiry != null ? o.nearest_expiry : null,
    read: o.read || null,
    // dérivés d'affichage
    above_flip,
    flip_dist_pct,
  };
}

// Fonction PURE : prend l'objet scan-latest, renvoie { btc, eth } ou stale.
function buildOptions(scan) {
  const opt = scan && scan.market && scan.market.options;
  if (!opt) return { stale: true, reason: "scan-latest.market.options absent" };
  return { stale: false, btc: buildOptionsOne(opt.btc), eth: buildOptionsOne(opt.eth) };
}

// Lecture réelle : scan le plus FRAIS des 2 agents + source retenue.
function readOptions() {
  const { readFreshestScan } = require("./sources.js");
  const { scan, source } = readFreshestScan();
  return Object.assign(buildOptions(scan), { scan_source: source });
}

module.exports = { buildOptions, buildOptionsOne, readOptions };
