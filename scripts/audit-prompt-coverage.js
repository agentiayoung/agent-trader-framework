// Verifie que chaque element REQUIRED (plancher dur + commandes) survit dans le corpus
// (= boots des roles + trade-routine.md concatenes). Insensible a la casse, match substring.
function checkCoverage(corpus, required) {
  const hay = String(corpus).toLowerCase();
  const missing = required.filter(r => !hay.includes(String(r).toLowerCase()));
  return { ok: missing.length === 0, missing };
}
// CLI : node scripts/audit-prompt-coverage.js  -> lit boots + trade-routine.md, asserte
if (require.main === module) {
  const fs = require('fs'), path = require('path');
  const root = path.join(__dirname, '..');
  const md = fs.readFileSync(path.join(root, 'routines/trade-routine.md'), 'utf8');
  const ps1 = fs.readFileSync(path.join(root, 'routines/run-routine.ps1'), 'utf8');
  const corpus = md + '\n' + ps1;
  const REQUIRED = [
    'journal.js today','journal.js reconcile','journal.js preflight','journal.js size',
    'journal.js verify-bracket','journal.js log','journal.js report','scan.js',
    'bybit_place_limit_bracket','thesis-check','monitor.js','SL','anti-sweep','risk_usd','DEMO',
    'perception',
  ];
  const res = checkCoverage(corpus, REQUIRED);
  if (!res.ok) { console.error('COVERAGE FAIL, missing:', res.missing); process.exit(1); }
  console.log('COVERAGE OK ('+REQUIRED.length+' elements present)');
}
module.exports = { checkCoverage };
