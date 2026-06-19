"use strict";
// options-context.js (16.06) — CARTE DE GRAVITE des options (Deribit BTC/ETH) en CONTEXTE price-action.
// 100% PUR (la chaine brute est fetchee par scan.js, ce module ne fait QUE du calcul -> teste offline).
// Philosophie : OBSERVABILITE. Le LLM lit ces niveaux-aimants (walls/max-pain/gex flip) + le regime de
// gamma (fade-vs-follow) comme CONFLUENCE pour son price action. Aucun gate, aucun edge backtest.
//
// Refs : max pain = strike qui minimise le payout total des detenteurs (aimant pres expiry).
//        walls = plus gros OI call (plafond) / put (plancher). GEX = gamma dealer net ; au-dessus du
//        flip = gamma+ (vol amortie -> range/fade) ; en-dessous = gamma- (vol amplifiee -> momentum).

// ── Black-Scholes gamma (r=0, pur) ──────────────────────────────────────────────────────
function normPdf(x) { return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI); }
// gamma = N'(d1) / (S * sigma * sqrt(T)). iv en DECIMAL (0.42), tYears en annees.
function bsGamma(spot, strike, iv, tYears) {
  if (!(spot > 0) || !(strike > 0) || !(iv > 0) || !(tYears > 0)) return 0;
  const d1 = (Math.log(spot / strike) + 0.5 * iv * iv * tYears) / (iv * Math.sqrt(tYears));
  return normPdf(d1) / (spot * iv * Math.sqrt(tYears));
}

// ── Parsing d'un instrument Deribit : "BTC-26MAR27-105000-C" -> {strike,type,expiryMs} ──
const _MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
function parseInstrument(name) {
  const p = String(name || "").split("-");
  if (p.length !== 4) return null;
  const [cur, dexp, strikeS, cp] = p;
  const m = /^(\d{1,2})([A-Z]{3})(\d{2})$/.exec(dexp);
  if (!m) return null;
  const day = +m[1], mon = _MONTHS[m[2]], yr = 2000 + +m[3];
  if (mon == null) return null;
  const strike = +strikeS;
  const type = cp === "C" ? "call" : cp === "P" ? "put" : null;
  if (!(strike > 0) || !type) return null;
  return { currency: cur, strike, type, expiryMs: Date.UTC(yr, mon, day, 8, 0, 0) }; // Deribit expire 08:00 UTC
}

// ── Normalisation de la chaine brute (book_summary) -> [{strike,type,oi,iv,expiryMs}] ──
// opts.nowMs : horloge (injectee pour purete/tests). opts.maxExpiries : nb d'expiries proches a garder.
function normalizeChain(raw, opts) {
  const o = opts || {};
  const now = o.nowMs != null ? o.nowMs : 0;
  const maxExp = o.maxExpiries || 2;
  const parsed = [];
  for (const r of (raw || [])) {
    const meta = parseInstrument(r.instrument_name);
    if (!meta) continue;
    if (now && meta.expiryMs <= now) continue; // expiree
    const oi = parseFloat(r.open_interest);
    const iv = parseFloat(r.mark_iv);
    if (!(oi > 0)) continue; // strike sans interet -> ignore
    parsed.push({ strike: meta.strike, type: meta.type, oi, iv: iv > 0 ? iv / 100 : null, expiryMs: meta.expiryMs, underlying: parseFloat(r.underlying_price) || null });
  }
  // garder les N expiries les plus proches (les plus pertinentes pour la gravite price-action)
  const exps = Array.from(new Set(parsed.map((x) => x.expiryMs))).sort((a, b) => a - b).slice(0, maxExp);
  const keep = new Set(exps);
  return parsed.filter((x) => keep.has(x.expiryMs));
}

// ── Spot de reference (underlying median des instruments proches du money) ──
function inferSpot(chain) {
  const us = chain.map((x) => x.underlying).filter((v) => v > 0).sort((a, b) => a - b);
  if (!us.length) return null;
  return us[Math.floor(us.length / 2)];
}

// ── Max pain : strike qui minimise le payout total des detenteurs d'options ──
function maxPain(chain) {
  const strikes = Array.from(new Set(chain.map((x) => x.strike))).sort((a, b) => a - b);
  if (!strikes.length) return null;
  let best = null, bestPay = Infinity;
  for (const S of strikes) {
    let pay = 0;
    for (const o of chain) {
      if (o.type === "call") pay += Math.max(0, S - o.strike) * o.oi;
      else pay += Math.max(0, o.strike - S) * o.oi;
    }
    if (pay < bestPay) { bestPay = pay; best = S; }
  }
  return best;
}

// ── Walls : plus gros OI call (plafond) / put (plancher), agreges par strike ──
function walls(chain) {
  const callOi = new Map(), putOi = new Map();
  for (const o of chain) {
    const m = o.type === "call" ? callOi : putOi;
    m.set(o.strike, (m.get(o.strike) || 0) + o.oi);
  }
  const top = (m) => { let k = null, v = -1; for (const [s, oi] of m) if (oi > v) { v = oi; k = s; } return k; };
  return { call_wall: top(callOi), put_wall: top(putOi) };
}

// ── Put/Call ratio (sur OI) ──
function putCall(chain) {
  let c = 0, p = 0;
  for (const o of chain) { if (o.type === "call") c += o.oi; else p += o.oi; }
  return c > 0 ? +(p / c).toFixed(2) : null;
}

// ── Skew 25-delta approx : IV moyen des puts OTM - IV moyen des calls OTM (proxy de peur) ──
function skew25d(chain, spot) {
  if (!(spot > 0)) return null;
  const putIv = chain.filter((o) => o.type === "put" && o.strike < spot && o.iv > 0).map((o) => o.iv);
  const callIv = chain.filter((o) => o.type === "call" && o.strike > spot && o.iv > 0).map((o) => o.iv);
  if (!putIv.length || !callIv.length) return null;
  const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  return +((avg(putIv) - avg(callIv)) * 100).toFixed(1); // en points d'IV
}

function atmIv(chain, spot) {
  if (!(spot > 0)) return null;
  let best = null, bd = Infinity;
  for (const o of chain) { if (o.iv > 0) { const d = Math.abs(o.strike - spot); if (d < bd) { bd = d; best = o.iv; } } }
  return best != null ? +(best * 100).toFixed(1) : null;
}

// ── GEX : gamma dealer net (convention retail : call gamma +, put gamma -). Le flip = niveau de spot
//    ou le GEX net croise zero. spot > flip -> gamma+ (range/fade) ; spot < flip -> gamma- (momentum). ──
function netGex(chain, atSpot, nowMs) {
  let g = 0;
  for (const o of chain) {
    if (!(o.iv > 0)) continue;
    const tY = Math.max((o.expiryMs - (nowMs || 0)) / (365.25 * 24 * 3600 * 1000), 1 / 365);
    const gm = bsGamma(atSpot, o.strike, o.iv, tY);
    g += gm * o.oi * (o.type === "call" ? 1 : -1);
  }
  return g;
}
function gammaExposure(chain, spot, nowMs) {
  if (!(spot > 0)) return { net_gex: null, gex_flip: null, gamma_regime: null };
  const net = netGex(chain, spot, nowMs);
  // flip : balayage de spot +-25%, on cherche le croisement de signe le plus proche du spot.
  const lo = spot * 0.75, hi = spot * 1.25, steps = 50;
  let flip = null, prev = null, prevS = null, bestDist = Infinity;
  for (let i = 0; i <= steps; i++) {
    const S = lo + (hi - lo) * (i / steps);
    const v = netGex(chain, S, nowMs);
    if (prev != null && ((prev <= 0 && v >= 0) || (prev >= 0 && v <= 0)) && (v - prev) !== 0) {
      const cross = prevS + (S - prevS) * (0 - prev) / (v - prev); // interpolation lineaire
      if (Math.abs(cross - spot) < bestDist) { bestDist = Math.abs(cross - spot); flip = cross; }
    }
    prev = v; prevS = S;
  }
  return {
    net_gex: +net.toFixed(4),
    gex_flip: flip != null ? Math.round(flip) : null,
    gamma_regime: net > 0 ? "positive" : net < 0 ? "negative" : "flat",
  };
}

// ── Assemblage du contexte + lecture courte ──
function buildOptionsContext(chain, spotArg, nowMs) {
  if (!chain || !chain.length) return null;
  const spot = spotArg > 0 ? spotArg : inferSpot(chain);
  if (!(spot > 0)) return null;
  const mp = maxPain(chain);
  const w = walls(chain);
  const gex = gammaExposure(chain, spot, nowMs);
  const pc = putCall(chain);
  const sk = skew25d(chain, spot);
  const iv = atmIv(chain, spot);
  const exps = Array.from(new Set(chain.map((x) => x.expiryMs))).sort((a, b) => a - b);
  const round = (v) => (v >= 1000 ? Math.round(v) : v);
  // lecture FR courte (le LLM peut s'en passer mais ca cadre la confluence)
  const bits = [];
  if (gex.gamma_regime) bits.push(`gamma ${gex.gamma_regime === "positive" ? "+ (vol amortie -> fade les extremes/range)" : gex.gamma_regime === "negative" ? "- (vol amplifiee -> momentum, ne pas fader)" : "neutre"}`);
  if (mp != null) bits.push(`max-pain ${round(mp)}${spot > mp ? " (sous le spot=aimant baissier)" : spot < mp ? " (au-dessus=aimant haussier)" : ""}`);
  if (w.call_wall != null) bits.push(`call wall ${round(w.call_wall)} (plafond-aimant)`);
  if (w.put_wall != null) bits.push(`put wall ${round(w.put_wall)} (plancher)`);
  if (gex.gex_flip != null) bits.push(`gex flip ${round(gex.gex_flip)}`);
  return {
    spot: +spot, max_pain: mp, call_wall: w.call_wall, put_wall: w.put_wall,
    gex_flip: gex.gex_flip, gamma_regime: gex.gamma_regime, net_gex: gex.net_gex,
    put_call: pc, skew_25d: sk, atm_iv: iv, nearest_expiry: exps[0] || null, n_strikes: chain.length,
    read: bits.join(" ; "),
  };
}

module.exports = { bsGamma, parseInstrument, normalizeChain, inferSpot, maxPain, walls, putCall, skew25d, atmIv, gammaExposure, netGex, buildOptionsContext };
