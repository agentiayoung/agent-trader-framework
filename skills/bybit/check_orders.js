const ccxt = require("ccxt");
const fs = require('fs');
const path = require('path');

const envFile = fs.readFileSync(path.join(__dirname, '../../config/.env'), 'utf8');
const env = {};
envFile.split('\n').forEach(function(line) {
  var m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) env[m[1].trim()] = m[2].trim().replace(/^['"]|['"]$/g, '');
});

var exchange = new ccxt.bybit({
  apiKey: env.BYBIT_API_KEY_DEMO || env.BYBIT_API_KEY,
  secret: env.BYBIT_API_SECRET_DEMO || env.BYBIT_API_SECRET,
});
exchange.enableDemoTrading(true);

// Usage: node check_orders.js [SYMBOL]   (defaut BTC — ex: node check_orders.js LTC)
// Remonte les ordres normaux ET conditionnels (SL/TP) du symbole.
var coin = String(process.argv[2] || 'BTC').toUpperCase().replace(/\/?USDT.*$/, '');
var symbol = coin + '/USDT:USDT';

exchange.loadTimeDifference().then(function() {
  return Promise.all([
    exchange.fetchOpenOrders(symbol),
    exchange.fetchOpenOrders(symbol, undefined, undefined, { trigger: true }),
  ]);
}).then(function(res) {
  var seen = {};
  var orders = res[0].concat(res[1]).filter(function(o) {
    if (seen[o.id]) return false; seen[o.id] = true; return true;
  });
  console.log('=== Open orders ' + symbol + ' (' + orders.length + ' uniques) ===');
  orders.forEach(function(o) {
    console.log(JSON.stringify({
      id: o.id,
      type: o.type,
      side: o.side,
      amount: o.amount,
      price: o.price,
      triggerPrice: o.info && o.info.triggerPrice,
      stopOrderType: o.info && o.info.stopOrderType,
      reduceOnly: o.reduceOnly
    }));
  });
}).catch(function(e) { console.error('Error:', e.message); });
