"use strict";

// Évalue la QUALITÉ des décisions no-trade : pour chaque no_trade qui portait un candidat
// précis (champ `hypo` = {symbol, side, entry, sl, tp}), rejoue le prix réel depuis la
// décision et dit si refuser était JUSTE (le trade aurait touché le SL = perte évitée) ou
// FAUX (aurait touché le TP = gain raté). Construit un scorecard de la qualité des refus.
//
// Convention de log (routine) : sur un no_trade d'un candidat rejeté, ajouter
//   "hypo": {"symbol":"LTC","side":"short","entry":43.63,"sl":44.30,"tp":40.73}
//
// Usage : node trade-journal/notrade-eval.js

const fs = require("fs");
const path = require("path");
const bybitDir = path.join(__dirname, "..", "skills", "bybit");
require(path.join(bybitDir, "index.js"));
const ccxt = require(require.resolve("ccxt", { paths: [bybitDir] }));

const JFILE = path.join(__dirname, "trades.jsonl");

async function evaluate() {
  const lines = fs.readFileSync(JFILE, "utf8").split(/\r?\n/).filter((l) => l.trim());
  const notrades = lines.map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
    .filter((x) => x && x.status === "no_trade" && x.hypo && x.hypo.symbol && x.hypo.entry && x.hypo.sl && x.hypo.tp);
  if (!notrades.length) return { evaluated: 0, note: "Aucun no_trade avec champ hypo (le suivi demarre quand la routine logge hypo).", scorecard: {} };

  const ex = new ccxt.bybit({ enableRateLimit: true, options: { defaultType: "swap" } });
  await ex.loadMarkets();
  const results = [];
  for (const nt of notrades) {
    const h = nt.hypo;
    const sym = h.symbol + "/USDT:USDT";
    const since = Date.parse(nt.ts_open) || (Date.now() - 14 * 864e5);
    let oh; try { oh = await ex.fetchOHLCV(sym, "1h", since, 400); } catch (e) { results.push({ id: nt.id, verdict: "erreur_data" }); continue; }
    if (!oh || oh.length < 3) { results.push({ id: nt.id, verdict: "pas_de_data" }); continue; }
    const long = h.side === "long";
    let filled = false, verdict = "no_fill", bars = 0;
    for (const b of oh) {
      const hi = b[2], lo = b[3]; bars++;
      if (!filled) { // limit fill : short rempli si le prix MONTE jusqu'a l'entree ; long si DESCEND
        if ((!long && hi >= h.entry) || (long && lo <= h.entry)) filled = true; else continue;
      }
      // une fois rempli : SL ou TP touche en premier ?
      if (long) { if (lo <= h.sl) { verdict = "aurait_PERDU"; break; } if (hi >= h.tp) { verdict = "aurait_GAGNE"; break; } }
      else { if (hi >= h.sl) { verdict = "aurait_PERDU"; break; } if (lo <= h.tp) { verdict = "aurait_GAGNE"; break; } }
      verdict = filled ? "encore_ouvert" : "no_fill";
    }
    const risk = Math.abs(h.entry - h.sl), reward = Math.abs(h.tp - h.entry);
    const rr = risk ? +(reward / risk).toFixed(2) : null;
    results.push({ id: nt.id, symbol: h.symbol, side: h.side, verdict, rr, bars, ts: nt.ts_open });
  }

  // scorecard
  const right = results.filter((r) => r.verdict === "aurait_PERDU").length;   // refus JUSTE (perte evitee)
  const wrong = results.filter((r) => r.verdict === "aurait_GAGNE").length;    // refus FAUX (gain rate)
  const decided = right + wrong;
  const sc = {
    evalues: results.length,
    decides: decided,
    refus_justes: right,
    refus_faux: wrong,
    no_fill: results.filter((r) => r.verdict === "no_fill").length,
    encore_ouverts: results.filter((r) => r.verdict === "encore_ouvert").length,
    qualite_refus_pct: decided ? +(right / decided * 100).toFixed(1) : null,
    lecture: decided ? `${right}/${decided} refus etaient JUSTES (perte evitee). ${wrong} occasion(s) ratee(s).` : "Pas encore de no_trade resolu (attendre que le prix touche SL ou TP hypothetique)."
  };
  return { evaluated: results.length, scorecard: sc, details: results };
}

if (require.main === module) {
  evaluate().then((r) => console.log(JSON.stringify(r, null, 2))).catch((e) => { console.error(e.message); process.exit(1); });
}
module.exports = evaluate;
