"use strict";
// confirm.js -- logique de CONFIRMATION DE BOUGIE PAR FAMILLE (M002/S01, radar d'entree).
// PUR, deterministe, zero reseau, zero dependance ccxt. C'est la piece sensible du radar :
// le radar d'entree (S03) appelle confirmCandle() a chaque tick et ne POSE le limit MAKER que si
// la bougie confirme. La logique PAR FAMILLE est dictee par la donnee OOS (design 2026-06-22) --
// elle ne CREE aucun edge, elle ne fait qu'ameliorer le TIMING/FILL d'edges DEJA valides :
//
//   - MR (S5/MR8/MR4)          -> IMMEDIAT. `MR8_e_confirm` a ete REJETE OOS : attendre une bougie
//                                 de confirmation TUE l'edge mean-reversion (on entre trop tard).
//                                 Le radar pose le resting-limit tout de suite.
//   - ZONE (M004 sweep+reclaim) -> sweep close + reclaim close = LA confirmation VALIDEE OOS
//                                 (mirror exact de scalp/zone-reaction.js, edge +0.235R 15m taker).
//   - TREND (S1/S2/S12)        -> bougie de REJET/continuation AU niveau, greffee sur des edges
//                                 deja valides (la confirmation ameliore le fill, pas l'edge).
//   - LONG_WATCH (S_long_*)    -> meme logique trend mais FORWARD-TEST (reel interdit, n<30) :
//                                 confirmation cablee, activee quand une paire entre en daily-bull.
//
// Entree TOUJOURS en LIMIT MAKER au niveau (`price` retourne) ; JAMAIS market au close
// (`_chase` negatif prouve OOS). bars = OHLCV ccxt [[ts,o,h,l,c,v],...] de bougies CLOSES.
//
// API : confirmCandle(family, side, bars, level, opts) -> { confirmed, reason, price, family, side,
//        forward_test? , meta? }

const DEF = {
  sweepK: 0.15,   // profondeur mini de la meche au-dela du niveau (en xATR) pour qualifier un sweep
  lookback: 6,    // fenetre de bougies regardee pour le sweep+reclaim (zone)
};

function cfg(o) { return { ...DEF, ...(o || {}) }; }
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const validBar = (b) => Array.isArray(b) && b.length >= 5 &&
  isNum(+b[2]) && isNum(+b[3]) && isNum(+b[4]);

// Normalise une famille (accepte des alias et des noms de setup deja resolus).
function normFamily(f) {
  const s = String(f || "").toLowerCase();
  if (s === "mr" || s === "mean_reversion" || s === "mean-reversion" || s === "reversion") return "mr";
  if (s === "zone" || s === "reaction_zone" || s === "zone_reaction" || s === "reclaim") return "zone";
  if (s === "trend" || s === "continuation" || s === "momentum") return "trend";
  if (s === "long_watch" || s === "longwatch" || s === "watch_long") return "long_watch";
  return null;
}

// Mapping nom de setup -> famille de confirmation. Utilise par la routine pour remplir armed-watch
// (S02) et expose ici pour que le radar puisse resoudre directement un nom de setup.
function setupFamily(setupName) {
  const s = String(setupName || "");
  if (/^S_long_(dip|break)/i.test(s)) return "long_watch";
  if (/^(MR8|MR4|MR1|MR2|MR3|MR7|S5)\b/i.test(s) || /^(MR8|MR4|S5)_/i.test(s)) return "mr";
  if (/^(S1|S2|S3|S12)\b/i.test(s) || /^(S1|S2|S3|S12)_/i.test(s)) return "trend";
  if (/zone|reclaim/i.test(s)) return "zone";
  return null;
}

const fail = (family, side, reason) => ({ confirmed: false, reason, price: null, family: family || null, side: side || null });

// --- ZONE : sweep + reclaim close (mirror de scalp/zone-reaction.js detectZone, edge OOS) -------
// long  : la meche perce SOUS level-sweepK*atr, puis une bougie referme (close >= level).
// short : la meche perce SUR  level+sweepK*atr, puis une bougie referme (close <= level).
// On parcourt du plus RECENT au plus ancien : 1er reclaim (close du bon cote) precede d'un sweep
// dans la grappe contigue. sweep_extreme = la meche la plus profonde de la grappe.
function confirmZone(side, bars, level, c) {
  const atr = +c.atr;
  if (!isNum(atr) || atr <= 0) return fail("zone", side, "ZONE : atr requis pour mesurer le seuil de sweep");
  const rows = Array.isArray(bars) ? bars.filter(validBar) : [];
  if (!rows.length) return fail("zone", side, "ZONE : aucune bougie valide");
  const margin = c.sweepK * atr;
  const sweepDown = side === "long";
  const threshold = sweepDown ? level - margin : level + margin;
  const pierces = (b) => sweepDown ? (+b[3] < threshold) : (+b[2] > threshold);
  const wick = (b) => sweepDown ? +b[3] : +b[2];
  const reclaimed = (cl) => sweepDown ? cl >= level : cl <= level;

  const n = rows.length;
  const start = Math.max(0, n - c.lookback);
  for (let i = n - 1; i >= start; i--) {
    const cl = +rows[i][4];
    if (!reclaimed(cl)) continue;                       // pas un reclaim -> on remonte
    // grappe contigue de sweep menant a ce reclaim (i inclus + bougies anterieures qui percent)
    let swept = false, sweepExtreme = null, firstSweepIdx = i;
    for (let k = i; k >= start; k--) {
      if (pierces(rows[k])) {
        swept = true; firstSweepIdx = k;
        const w = wick(rows[k]);
        if (sweepExtreme == null || (sweepDown ? w < sweepExtreme : w > sweepExtreme)) sweepExtreme = w;
      } else if (k < i) break;                           // fin de grappe
    }
    if (!swept) continue;                                // reclaim sans sweep = touche propre
    const depthAtr = Math.abs(level - sweepExtreme) / atr;
    const reason = `ZONE ${side} : sweep ${(sweepDown ? "sous" : "sur")} ${level} ` +
      `(meche ${depthAtr.toFixed(2)}xATR) + reclaim close ${cl}` + (i > firstSweepIdx ? ` (+${i - firstSweepIdx} bougie)` : "");
    return { confirmed: true, reason, price: level, family: "zone", side,
      meta: { sweep_extreme: +sweepExtreme, reclaim_close: +cl, sweep_depth_atr: +depthAtr.toFixed(3) } };
  }
  return fail("zone", side, "ZONE : pas de sweep+reclaim dans la fenetre");
}

// --- TREND / LONG_WATCH : bougie de rejet/continuation AU niveau ---------------------------------
// La DERNIERE bougie close doit avoir TESTE le niveau (meche) puis referme du bon cote (rejet).
//   short : derniere bougie high >= level (teste la resistance) ET close < level (rejet, referme dessous)
//   long  : derniere bougie low  <= level (teste le support)    ET close > level (rejet haussier)
// Le radar entre ensuite en LIMIT MAKER au niveau (`price`=level) -> fade le retour vers le niveau.
function confirmTrend(family, side, bars, level) {
  const rows = Array.isArray(bars) ? bars.filter(validBar) : [];
  if (!rows.length) return fail(family, side, "TREND : aucune bougie valide");
  const b = rows[rows.length - 1];
  const hi = +b[2], lo = +b[3], cl = +b[4];
  let confirmed = false;
  if (side === "short") confirmed = hi >= level && cl < level;
  else confirmed = lo <= level && cl > level;
  if (!confirmed) {
    const why = side === "short"
      ? (hi < level ? "niveau pas teste (high < niveau)" : "pas de rejet (close au-dessus du niveau)")
      : (lo > level ? "niveau pas teste (low > niveau)" : "pas de rejet (close sous le niveau)");
    return fail(family, side, `TREND ${side} : ${why} -> attendre`);
  }
  const fw = family === "long_watch";
  const reason = `TREND ${side} : bougie de rejet/continuation au niveau ${level} (close ${cl})` +
    (fw ? " [forward-test, reel interdit]" : "");
  const out = { confirmed: true, reason, price: level, family, side, meta: { close: +cl, high: +hi, low: +lo } };
  if (fw) out.forward_test = true;
  return out;
}

// confirmCandle(family, side, bars, level, opts)
function confirmCandle(family, side, bars, level, opts) {
  const fam = normFamily(family);
  const sd = side === "long" || side === "short" ? side : null;
  if (!fam) return fail(family, sd, `famille inconnue: ${family}`);
  if (!sd) return fail(fam, side, `side invalide: ${side}`);
  if (!isNum(level)) return fail(fam, sd, `niveau invalide: ${level}`);
  const lvl = level;
  const c = cfg(opts);

  if (fam === "mr") {
    // Mean-reversion : confirmation IMMEDIATE (ne JAMAIS attendre -- MR8_e_confirm rejete OOS).
    return { confirmed: true, family: "mr", side: sd, price: lvl,
      reason: "MR : limit immediat (pas d'attente ; confirmation de bougie rejetee OOS sur mean-reversion)" };
  }
  if (fam === "zone") return confirmZone(sd, bars, lvl, c);
  if (fam === "trend" || fam === "long_watch") return confirmTrend(fam, sd, bars, lvl);
  return fail(fam, sd, `famille non geree: ${fam}`);
}

module.exports = { confirmCandle, setupFamily, normFamily };

// CLI : node trade-journal/confirm.js  (auto-demo sur fixtures synthetiques, zero reseau)
if (require.main === module) {
  const demo = [
    ["mr", "long", [], 100, { atr: 2 }],
    ["zone", "long", [[0,102,103,101,101.5,1],[0,101,101.5,99.2,99.4,1],[0,99.5,100.8,99.3,100.4,1]], 100, { atr: 2 }],
    ["trend", "short", [[0,197,198,196,197.5,1],[0,198,200.5,197.8,199.2,1]], 200, { atr: 2 }],
  ];
  for (const [f, s, b, l, o] of demo) console.log(f, s, "->", JSON.stringify(confirmCandle(f, s, b, l, o)));
}
