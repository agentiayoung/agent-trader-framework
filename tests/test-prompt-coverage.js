const assert = require('assert');
const { checkCoverage } = require('../scripts/audit-prompt-coverage.js');
// Le plancher dur + les commandes obligatoires DOIVENT apparaitre dans (boots + trade-routine.md)
const REQUIRED = [
  'journal.js today', 'journal.js reconcile', 'journal.js preflight',
  'journal.js size', 'journal.js verify-bracket', 'journal.js log', 'journal.js report',
  'scan.js', 'bybit_place_limit_bracket',
  'SL', 'anti-sweep', 'risk_usd', 'DEMO',
];
const corpus = [
  'node trade-journal/journal.js today',
  'node trade-journal/journal.js reconcile',
  'node trade-journal/journal.js preflight',
  'node trade-journal/journal.js size',
  'node trade-journal/journal.js verify-bracket',
  'node trade-journal/journal.js log',
  'node trade-journal/journal.js report',
  'node trade-journal/scan.js',
  'bybit_place_limit_bracket',
  'SL anti-sweep risk_usd DEMO only',
].join(' ... ');
const res = checkCoverage(corpus, REQUIRED);
assert.strictEqual(res.missing.length, 0, 'missing: ' + res.missing.join(','));
const res2 = checkCoverage('rien', ['journal.js today']);
assert.strictEqual(res2.missing.length, 1);
console.log('test-prompt-coverage OK');
