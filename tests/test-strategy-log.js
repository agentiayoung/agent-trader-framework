const assert = require('assert');
const { buildEntry } = require('../trade-journal/strategy-log.js');
const e = buildEntry({
  date: '2026-06-16', time: '18:07', sentiment: 'bear qui decelere',
  bull_case: 'AVAX bull div au low', bear_case: 'SUI surachat 4H',
  decision: 'short SUI', why: 'bear plus convaincant, AVAX pas confirme',
  adjustments: 'resserre trail XRP',
});
assert.ok(e.includes('2026-06-16'));
assert.ok(e.includes('bull_case') || e.includes('Bull'));
assert.ok(e.includes('short SUI'));
assert.ok(e.startsWith('\n') || e.startsWith('#') || e.startsWith('##'));
console.log('test-strategy-log OK');
