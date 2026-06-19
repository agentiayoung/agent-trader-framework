// ─────────────────────────────────────────────────────────────────────────────
// trajectory.js — TRAJECTOIRE d'une position ouverte (observabilite pour le monitoring)
// ─────────────────────────────────────────────────────────────────────────────
// Donne au LLM ce qui manquait pour mieux gerer une position (rapprocher SL / prendre TP
// plus tot / cut) : combien le trade a PARCOURU (MFE), SOUFFERT (MAE), s'il REND les gains
// du pic (give-back), s'il ACCELERE ou STAGNE (velocite). Calcule depuis l'OHLCV-depuis-l'entree
// -> capte les pics de l'ANGLE MORT entre routines (un +2R intra-periode revenu au SL sinon invisible).
//
// PUR (aucun reseau) : le caller fetch l'OHLCV et l'injecte. STATELESS : recalcul integral a chaque
// routine (exact, pas de pic persiste a faire deriver, survit aux redemarrages).
// OBSERVABILITE : ne declenche AUCUN exit ; thesis.js le consomme pour AFFINER ses verdicts, le LLM agit.

const MFE_MIN = process.env.TRAJ_MFE_MIN ? +process.env.TRAJ_MFE_MIN : 0.5; // pic mini (R) pour que le give-back ait un sens
const VEL_EPS = process.env.TRAJ_VEL_EPS ? +process.env.TRAJ_VEL_EPS : 0.05; // seuil R/barre accel vs stagne
const VEL_WIN = process.env.TRAJ_VEL_WIN ? +process.env.TRAJ_VEL_WIN : 3;     // fenetre (barres) de velocite

// ohlcvSince : tranche les barres OHLCV dont le timestamp est >= entryTs (ms). PUR.
function ohlcvSince(ohlcv, entryTs) {
  if (!Array.isArray(ohlcv) || entryTs == null) return [];
  return ohlcv.filter((b) => Array.isArray(b) && Number(b[0]) >= Number(entryTs));
}

// trajectory : { side, entry, stop_loss, ohlcvSinceEntry } -> metriques. PUR, aucun reseau.
//   mfe_R       : max favorable en R (extreme intra-barre : long=high, short=low)
//   mae_R       : max adverse en R (<= 0 ; borne ~ -1R par le SL pour une position encore ouverte)
//   unreal_R    : R courant (dernier close)
//   giveback_pct: (mfe_R - unreal_R)/mfe_R, SEULEMENT si mfe_R >= MFE_MIN (sinon null = pas de vrai pic)
//   velocity    : 'accelerating' | 'stalling' | 'reversing' (pente R sur les VEL_WIN dernieres barres)
//   bars_held   : nb de barres depuis l'entree
function trajectory({ side, entry, stop_loss, ohlcvSinceEntry } = {}) {
  const e = Number(entry), sl = Number(stop_loss);
  const risk = Math.abs(e - sl);
  const bars = Array.isArray(ohlcvSinceEntry) ? ohlcvSinceEntry.filter((b) => Array.isArray(b) && b.length >= 5) : [];
  const empty = { mfe_R: null, mae_R: null, unreal_R: null, giveback_pct: null, velocity: null, vel_r_per_bar: null, bars_held: bars.length };
  if (!Number.isFinite(e) || !Number.isFinite(sl) || risk === 0 || !bars.length) return empty;

  const isShort = side === 'short';
  const rAt = (px) => (isShort ? (e - px) / risk : (px - e) / risk);

  let mfe = -Infinity, mae = Infinity;
  for (const b of bars) {
    const hi = Number(b[2]), lo = Number(b[3]);
    if (!Number.isFinite(hi) || !Number.isFinite(lo)) continue;
    const favR = isShort ? rAt(lo) : rAt(hi); // extreme FAVORABLE
    const advR = isShort ? rAt(hi) : rAt(lo); // extreme ADVERSE
    if (favR > mfe) mfe = favR;
    if (advR < mae) mae = advR;
  }
  if (!Number.isFinite(mfe) || !Number.isFinite(mae)) return empty;

  const unreal = +rAt(Number(bars[bars.length - 1][4])).toFixed(3);
  const mfe_R = +mfe.toFixed(3), mae_R = +mae.toFixed(3);

  let giveback_pct = null;
  if (mfe_R >= MFE_MIN && mfe_R > 0) {
    giveback_pct = +Math.max(0, Math.min(1, (mfe_R - unreal) / mfe_R)).toFixed(3);
  }

  let velocity = null, vel_r_per_bar = null;
  if (bars.length >= 2) {
    const k = Math.min(VEL_WIN, bars.length - 1);
    const rNow = rAt(Number(bars[bars.length - 1][4]));
    const rPrev = rAt(Number(bars[bars.length - 1 - k][4]));
    const perBar = (rNow - rPrev) / k;
    vel_r_per_bar = +perBar.toFixed(3);
    velocity = perBar > VEL_EPS ? 'accelerating' : perBar < -VEL_EPS ? 'reversing' : 'stalling';
  }

  return { mfe_R, mae_R, unreal_R: unreal, giveback_pct, velocity, vel_r_per_bar, bars_held: bars.length };
}

module.exports = { trajectory, ohlcvSince };
