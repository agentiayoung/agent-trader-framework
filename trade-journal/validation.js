"use strict";
// ═══════════════════════════════════════════════════════════════════
// validation.js — validation ROBUSTE des edges (#1 fondation, approved 16.06).
//
// PUR, deterministe, testable offline. Reponse a C7/C8/C10/O6 : un split unique 62/38 + 6 mois +
// N candidats testes/fenetre sous-estime gravement l'overfit (Lopez de Prado) -> une partie des
// edges "valides" est probablement du bruit. Briques :
//   - CPCV-light (Combinatorial Purged CV) : distribution de perf OOS sur plusieurs folds, embargo.
//   - Deflated Sharpe Ratio (Bailey & Lopez de Prado) : corrige le Sharpe pour non-normalite +
//     multiple testing (N essais) -> proba que l'edge ne soit pas du data-mining.
//   - null block-bootstrap : p-value preservant l'autocorrelation (> random seede i.i.d.).
//
// L'INTEGRATION dans optimize.js (tag des folds, calcul DSR/p-value, gate durci) = etape suivante,
// opt-in (OPT_CPCV=1) et lineage recherche (garde-fou 9). Ce module ne fait que les MATHS, testees.
// ═══════════════════════════════════════════════════════════════════

// ---- PRNG seede local (auto-suffisant, pas de dependance ccxt) ----
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function strSeed(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

// ---- stats de base ----
function mean(R) { if (!R || !R.length) return 0; let s = 0; for (const x of R) s += x; return s / R.length; }
function std(R) { if (!R || R.length < 2) return 0; const m = mean(R); let s = 0; for (const x of R) s += (x - m) * (x - m); return Math.sqrt(s / (R.length - 1)); }
function sharpe(R) { if (!R || R.length < 2) return null; const sd = std(R); return sd === 0 ? null : mean(R) / sd; }
function skewness(R) { const n = R.length; if (n < 3) return 0; const m = mean(R), sd = std(R); if (sd === 0) return 0; let s = 0; for (const x of R) s += ((x - m) / sd) ** 3; return s / n; }
function kurtosisRaw(R) { const n = R.length; if (n < 4) return 3; const m = mean(R), sd = std(R); if (sd === 0) return 3; let s = 0; for (const x of R) s += ((x - m) / sd) ** 4; return s / n; } // non-excess (normal=3)

// ---- loi normale : CDF (erf A&S 7.1.26) + inverse PPF (Acklam) ----
function erf(x) {
  const s = x < 0 ? -1 : 1; x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
function normCdf(x) { return 0.5 * (1 + erf(x / Math.SQRT2)); }
function normPpf(p) {
  if (p <= 0) return -Infinity; if (p >= 1) return Infinity;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const plow = 0.02425, phigh = 1 - plow; let q, r;
  if (p < plow) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > phigh) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  q = p - 0.5; r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// ---- Deflated Sharpe Ratio (Bailey & Lopez de Prado) ----
// sr = Sharpe observe (par trade). opts : nTrials (N candidats testes), varTrials (variance des
// Sharpe des essais), skew/kurt (de la serie de R), n (nb de trades). Retourne P(SR vrai > SR0) in [0,1].
// nTrials<=1 -> SR0=0 (= Probabilistic Sharpe Ratio, pas de deflation multiple-testing).
const EULER = 0.5772156649015329;
function deflatedSharpe(sr, opts) {
  const o = opts || {};
  const N = o.nTrials || 1, varTrials = o.varTrials || 0, skew = o.skew || 0, kurt = o.kurt == null ? 3 : o.kurt, n = o.n || 0;
  if (n < 2) return null;
  let sr0 = 0;
  if (N > 1 && varTrials > 0) {
    sr0 = Math.sqrt(varTrials) * ((1 - EULER) * normPpf(1 - 1 / N) + EULER * normPpf(1 - 1 / (N * Math.E)));
  }
  const denom = Math.sqrt(Math.max(1e-12, 1 - skew * sr + ((kurt - 1) / 4) * sr * sr));
  const z = (sr - sr0) * Math.sqrt(n - 1) / denom;
  return normCdf(z);
}

// Gate pragmatique simple (rapport : haircut 30-50% sur les Sharpe de backtest quand bcp de modeles).
function haircutSharpe(sr, factor = 0.6) { return sr * factor; }

// ---- CPCV-light : combinaisons train/test de blocs temporels + embargo (anti-leakage) ----
// Retourne la STRUCTURE des folds ({test:[blocs], train:[blocs]}). Le mapping blocs->indices de
// signaux se fait a l'integration. Pure combinatoire C(nBlocks, nTest).
function cpcvFolds(nBlocks = 6, nTest = 2, embargo = 1) {
  const all = Array.from({ length: nBlocks }, (_, i) => i);
  const combos = [];
  const rec = (start, pick) => { if (pick.length === nTest) { combos.push(pick.slice()); return; } for (let b = start; b < nBlocks; b++) { pick.push(b); rec(b + 1, pick); pick.pop(); } };
  rec(0, []);
  return combos.map((test) => {
    const excluded = new Set(test);
    for (const t of test) for (let e = 1; e <= embargo; e++) { excluded.add(t - e); excluded.add(t + e); }
    return { test, train: all.filter((b) => !excluded.has(b)) };
  });
}

// ---- null block-bootstrap : p-value (H0 : mean <= 0) preservant l'autocorrelation ----
// Reechantillonne des blocs de longueur blockLen avec remise -> series surrogates de meme longueur ;
// p = fraction des moyennes surrogates <= 0. Bas = moyenne robustement positive (vs le hasard
// autocorrele). Seede (reproductible). > random i.i.d. car preserve la structure de dependance (C10).
function blockBootstrapPValue(R, opts) {
  if (!R || !R.length) return 1;
  const o = opts || {}, blockLen = o.blockLen || 5, draws = o.draws || 1000, n = R.length;
  const rng = mulberry32(strSeed(String(o.seed == null ? "bb" : o.seed)));
  let countLE0 = 0;
  for (let d = 0; d < draws; d++) {
    let sum = 0, cnt = 0;
    while (cnt < n) {
      const start = Math.floor(rng() * n);
      for (let j = 0; j < blockLen && cnt < n; j++) { sum += R[(start + j) % n]; cnt++; }
    }
    if (sum / cnt <= 0) countLE0++;
  }
  return countLE0 / draws;
}

module.exports = {
  mean, std, sharpe, skewness, kurtosisRaw,
  erf, normCdf, normPpf,
  deflatedSharpe, haircutSharpe,
  cpcvFolds, blockBootstrapPValue,
  mulberry32, strSeed,
};
