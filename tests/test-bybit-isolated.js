// Test PUR (pas de reseau) : le helper construit le bon appel ccxt et avale l'erreur idempotente.
const assert = require('assert');
const { _isolatedMarginCall } = require('../skills/bybit/index.js');
// 1) construit l'intention {mode:'isolated', symbol, leverage}
const call = _isolatedMarginCall('BTC/USDT:USDT', 5);
assert.strictEqual(call.marginMode, 'isolated');
assert.strictEqual(call.symbol, 'BTC/USDT:USDT');
assert.strictEqual(call.leverage, 5);
// 2) classifie l'erreur Bybit "not modified" (110026) comme benigne (deja isole)
assert.strictEqual(_isolatedMarginCall.isBenign({ message: 'margin mode is not modified (110026)' }), true);
assert.strictEqual(_isolatedMarginCall.isBenign({ message: 'insufficient balance' }), false);
console.log('test-bybit-isolated OK');
