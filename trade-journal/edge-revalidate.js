"use strict";
// ═══════════════════════════════════════════════════════════════════
// edge-revalidate.js — harness de revalidation walk-forward (piste 5b).
//
// Lance optimize.js (réseau, ~minutes), snapshot le résultat dans
// optimize-history/<date>.json, compare au dernier snapshot via edge-watch.js,
// et imprime { flags, table } (consommé par routines/edge-revalidation.ps1 -> Telegram).
//
// Tâche planifiée MENSUELLE (AgentTrader-EdgeRevalidation). review.js couvre
// déjà l'hebdo sur NOS trades ; ici on re-valide les EDGES eux-mêmes sur la
// donnée marché (échantillon massif, indépendant de notre compteur de trades).
//
// Usage : node trade-journal/edge-revalidate.js
//   EDGE_DROP_PCT=0.5   (seuil de décroissance qui alerte, déf. 0.5)
// ═══════════════════════════════════════════════════════════════════

const fs = require("fs");
const path = require("path");
const { compareEdges } = require("./edge-watch.js");

const HIST_DIR = path.join(__dirname, "optimize-history");

function sysDate() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Charge le snapshot le plus récent AVANT le fichier `exclude` (le nouveau du jour).
function loadPrevious(exclude) {
  if (!fs.existsSync(HIST_DIR)) return null;
  const files = fs.readdirSync(HIST_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f !== exclude).sort();
  if (!files.length) return null;
  try { return JSON.parse(fs.readFileSync(path.join(HIST_DIR, files[files.length - 1]), "utf8")); }
  catch (e) { return null; }
}

async function run() {
  const date = sysDate();
  const file = `${date}.json`;
  const prev = loadPrevious(file); // AVANT d'écrire le nouveau (sinon il s'auto-compare)

  const optimize = require("./optimize.js");
  const curr = await optimize();

  if (!fs.existsSync(HIST_DIR)) fs.mkdirSync(HIST_DIR, { recursive: true });
  fs.writeFileSync(path.join(HIST_DIR, file), JSON.stringify({ date, ...curr }, null, 2));

  const dropPct = process.env.EDGE_DROP_PCT != null ? parseFloat(process.env.EDGE_DROP_PCT) : 0.5;
  const { flags, table } = compareEdges(prev ? prev.setups : null, curr.setups, { dropPct });

  return {
    date,
    compared_to: prev ? prev.date : null,
    pairs: curr.pairs,
    flags,
    table,
    note: prev ? "Comparé au dernier snapshot." : "Premier snapshot (pas de comparaison historique encore).",
  };
}

if (require.main === module) {
  run().then((r) => console.log(JSON.stringify(r, null, 2))).catch((e) => { console.error(e.message); process.exit(1); });
}
module.exports = run;
