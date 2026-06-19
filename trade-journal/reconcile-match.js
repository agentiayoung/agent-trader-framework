"use strict";
// reconcile-match.js — attribution laddered-aware des fills Bybit aux trades journal.
// PUR + teste offline (zero reseau). Cf. fragmentation TAO 13.06.
//
// LE PROBLEME : un trade `entry_mode:laddered` est UNE these = UN trade au journal
// (entry_actual = un rung representatif). Mais sur Bybit ses rungs fillent a des prix
// DIFFERENTS -> Bybit cree PLUSIEURS groupes closed-PnL (un par avgEntry distinct).
// Le matcher historique (1 trade <-> 1 groupe par entry) en rattachait UN seul et
// ORPHELINAIT les rungs hauts : TAO R1 +35.5 garde au parent, R2/R3 -821 ejecte en
// `bybit-open-tao-230` -> R fragmente (parent "win" +0.03R, orphelin -1.01R) + stats
// polluees par une fausse strategie `reconcile_orphan`.
//
// LA SOLUTION : avant de creer un orphelin (groupe closed OU position sans trade),
// tenter de l'ATTRIBUER a un parent laddered de meme (symbol, side) dont l'enveloppe
// de rungs [min(entry,SL), max(entry,SL)] contient l'entry du fill, et qui etait
// ouvert quand le rung a fille. La boucle de matching principale reste INTACTE :
// on n'enrichit que la decision "creer un orphelin ?".

function baseSym(s) {
  return String(s || "").toUpperCase().replace(/USDT.*$/, "").replace(/[^A-Z0-9]/g, "");
}

function isLadder(trade) {
  return !!(trade && trade.entry_mode === "laddered");
}

// Enveloppe de prix des rungs d'un ladder : entre l'entree et le SL (pour un short
// les rungs montent vers le SL ; pour un long ils descendent). Borne par un vrai
// niveau stocke (le SL) -> conservateur, retroactif, sans champ supplementaire.
// pad de 5% de la bande pour tolerer un fill juste au-dela du dernier rung.
function ladderEnvelope(trade) {
  const e = Number(trade && (trade.entry_actual ?? trade.entry_planned));
  const sl = Number(trade && trade.stop_loss);
  if (!Number.isFinite(e) || !Number.isFinite(sl) || e === sl) return null;
  const lo = Math.min(e, sl), hi = Math.max(e, sl);
  const pad = (hi - lo) * 0.05;
  return { lo: lo - pad, hi: hi + pad };
}

function inEnvelope(entry, env) {
  return env != null && Number(entry) >= env.lo && Number(entry) <= env.hi;
}

// Parent laddered candidat pour un fill (sym, side, entry, closeTs). Parmi les
// trades laddered de meme (symbol, side) dont l'enveloppe contient `entry`, on prend
// celui dont l'ouverture est la plus recente AVANT (ou ~) la cloture du fill — la
// these qui etait reellement en vie quand le rung a fille. Garde-fou anti-collision
// si deux ladders du meme symbole se succedent dans le temps.
//   trades   : tableau journal complet
//   entry    : prix d'entree du groupe/position orphelin
//   symbol   : symbole du fill
//   side     : 'long' | 'short'
//   closeTs  : ms epoch de cloture du fill (ou null pour une position encore ouverte)
function findLadderParent(trades, { entry, symbol, side, closeTs = null } = {}) {
  const sym = baseSym(symbol);
  const cands = (trades || []).filter((t) =>
    isLadder(t) && baseSym(t.symbol) === sym && t.side === side && inEnvelope(entry, ladderEnvelope(t)));
  if (!cands.length) return null;
  // garde-fou temporel : le rung fille APRES l'ouverture de la these (tolerance 6h
  // pour les decalages d'horloge / tz du log). closeTs null = position encore ouverte
  // -> on garde le candidat (pas d'info temporelle contraignante).
  const TOL = 6 * 3600 * 1000;
  const openMs = (t) => (t.ts_open ? new Date(t.ts_open).getTime() : 0);
  // closeTs fourni (fill clos) : ne garder que les theses ouvertes AVANT (~) ce fill ;
  // si aucune -> null (le fill est anterieur a toute these laddered = pas a nous).
  // closeTs null (position encore ouverte, pas d'info temporelle) : garder les candidats.
  if (closeTs != null) {
    const eligible = cands.filter((t) => openMs(t) <= closeTs + TOL);
    if (!eligible.length) return null;
    return eligible.slice().sort((a, b) => openMs(b) - openMs(a))[0];
  }
  return cands.slice().sort((a, b) => openMs(b) - openMs(a))[0] || null;
}

// Agrege plusieurs groupes closed-PnL en un fill unique (moy ponderee par qty).
// Chaque groupe : { entry, avgExit, qty, pnl, fees, lastTs }.
function aggregateGroups(groups) {
  let qty = 0, pnl = 0, fees = 0, ew = 0, xw = 0, lastTs = 0;
  for (const g of groups) {
    const q = Number(g.qty) || 0;
    qty += q; pnl += Number(g.pnl) || 0; fees += Number(g.fees) || 0;
    ew += Number(g.entry) * q; xw += Number(g.avgExit) * q;
    lastTs = Math.max(lastTs, Number(g.lastTs) || 0);
  }
  return {
    qty: +qty.toFixed(6),
    pnl: +pnl.toFixed(4),
    fees: +fees.toFixed(4),
    entry: qty ? ew / qty : 0,
    avgExit: qty ? xw / qty : 0,
    lastTs,
  };
}

// Replie un groupe closed dans un parent DEJA CLOS (TAO) : additionne PnL/fees/qty,
// recalcule l'entree ponderee, renvoie les champs a merger. Le parent garde son
// risk_usd (budget total du ladder) -> R recalcule par le caller via computeRMultiple.
function foldGroupIntoClosedParent(parent, g) {
  const pQty = Number(parent.size) || 0;
  const pEntry = Number(parent.entry_actual ?? parent.entry_planned) || 0;
  const pPnl = Number(parent.realized_pnl) || 0;
  const pFees = Number(parent.fees) || 0;
  const gQty = Number(g.qty) || 0;
  const newQty = pQty + gQty;
  const newEntry = newQty ? (pEntry * pQty + Number(g.entry) * gQty) / newQty : pEntry;
  const realized = pPnl + (Number(g.pnl) || 0);
  const fees = pFees + (Number(g.fees) || 0);
  return {
    size: +newQty.toFixed(6),
    entry_actual: newEntry,
    realized_pnl: +realized.toFixed(4),
    fees: +fees.toFixed(4),
    net_pnl: +(realized - fees).toFixed(4),
    outcome: realized > 0 ? "win" : "loss",
  };
}

// Reclame, pour un trade laddered, TOUS ses fills Bybit : les groupes closed et la
// position ouverte de meme (symbol, side) dont l'entree tombe dans l'enveloppe de
// rungs (et postérieurs a l'ouverture de la these pour les groupes clos). Pur.
//   trade     : le trade laddered
//   groups    : tableau gl [{symbol, side, entry, avgExit, qty, pnl, fees, lastTs}]
//   positions : tableau ccxt [{symbol, side, entryPrice, contracts}]
//   usedG/usedP : Set d'indices deja consommes (mutes par le caller, lus ici)
// -> { groupIdx:[...], posIdx:number|-1 }. Idempotent : depend uniquement des fills
//    Bybit courants, pas d'un etat accumule sur le parent.
function claimLadderFills(trade, groups, positions, usedG, usedP) {
  const out = { groupIdx: [], posIdx: -1 };
  if (!isLadder(trade)) return out;
  const env = ladderEnvelope(trade);
  if (!env) return out;
  const sym = baseSym(trade.symbol);
  const openMs = trade.ts_open ? new Date(trade.ts_open).getTime() : 0;
  const TOL = 6 * 3600 * 1000;
  (groups || []).forEach((g, i) => {
    if (usedG && usedG.has(i)) return;
    if (baseSym(g.symbol) !== sym || g.side !== trade.side) return;
    if (!inEnvelope(g.entry, env)) return;
    if (openMs && Number.isFinite(g.lastTs) && g.lastTs < openMs - TOL) return;
    out.groupIdx.push(i);
  });
  out.posIdx = (positions || []).findIndex((p, i) =>
    !(usedP && usedP.has(i)) && baseSym(p.symbol) === sym && p.side === trade.side
    && inEnvelope(Number(p.entryPrice), env));
  return out;
}

module.exports = {
  baseSym, isLadder, ladderEnvelope, inEnvelope,
  findLadderParent, aggregateGroups, foldGroupIntoClosedParent, claimLadderFills,
};
