// test-trajectory.js — metriques de trajectoire d'une position (MFE/MAE/give-back/velocite). Offline, pur.
// OHLCV = [ts, open, high, low, close, vol]. R signe par le sens (long: (px-entry)/risk ; short: (entry-px)/risk).
const assert = require('assert');
const { trajectory, ohlcvSince } = require('../trade-journal/trajectory.js');
const B = (ts, o, h, l, c) => [ts, o, h, l, c, 100];

// 1) LONG : pic +2R (high 110) puis retour +1R (close 105) -> mfe 2, unreal 1, giveback 0.5
const long1 = trajectory({ side: 'long', entry: 100, stop_loss: 95, ohlcvSinceEntry: [
  B(1, 100, 101, 99, 100.5), B(2, 100.5, 110, 100, 108), B(3, 108, 109, 104, 105),
] });
assert.strictEqual(long1.mfe_R, 2, 'mfe_R 2 (high 110)');
assert.strictEqual(long1.unreal_R, 1, 'unreal_R 1 (close 105)');
assert.strictEqual(long1.giveback_pct, 0.5, 'giveback 50% (rendu la moitie du pic)');
assert.strictEqual(long1.bars_held, 3, 'bars_held 3');

// 2) SHORT symetrique : entry 100 SL 105 (risk 5), low 90 -> mfe (100-90)/5=2 ; close 95 -> unreal 1
const short1 = trajectory({ side: 'short', entry: 100, stop_loss: 105, ohlcvSinceEntry: [
  B(1, 100, 101, 99, 100), B(2, 100, 101, 90, 95),
] });
assert.strictEqual(short1.mfe_R, 2, 'short mfe_R 2 (low 90)');
assert.strictEqual(short1.unreal_R, 1, 'short unreal_R 1 (close 95)');

// 3) MAE profond mais RECUPERE : long entry 100 SL 90 (risk 10), low 92 -> mae -0.8 ; close 103 -> +0.3
const rec = trajectory({ side: 'long', entry: 100, stop_loss: 90, ohlcvSinceEntry: [
  B(1, 100, 100, 92, 94), B(2, 94, 104, 94, 103),
] });
assert.strictEqual(rec.mae_R, -0.8, 'mae_R -0.8 (low 92)');
assert.ok(rec.unreal_R > 0, 'recupere (unreal > 0)');

// 4) mfe < MFE_MIN (0.5) -> giveback null (pas de pic significatif)
const tiny = trajectory({ side: 'long', entry: 100, stop_loss: 95, ohlcvSinceEntry: [
  B(1, 100, 100.5, 99.5, 100), B(2, 100, 101, 99, 100.2),
] });
assert.strictEqual(tiny.giveback_pct, null, 'pas de pic -> giveback null');

// 5) velocity reversing : R monte (0.8) puis 3 dernieres barres declinent -> reversing
const rev = trajectory({ side: 'long', entry: 100, stop_loss: 90, ohlcvSinceEntry: [
  B(1, 100, 108, 100, 108), B(2, 108, 108, 104, 104), B(3, 104, 104, 102, 102), B(4, 102, 102, 100.5, 100.5),
] });
assert.strictEqual(rev.velocity, 'reversing', 'velocity reversing (le gain se retourne)');

// 6) velocity accelerating : R croit -> accelerating
const acc = trajectory({ side: 'long', entry: 100, stop_loss: 90, ohlcvSinceEntry: [
  B(1, 100, 101, 100, 100.5), B(2, 100.5, 102, 100, 101.5), B(3, 101.5, 104, 101, 103.5),
] });
assert.strictEqual(acc.velocity, 'accelerating', 'velocity accelerating (le move file)');

// 7) inputs invalides (risk 0) -> nulls
const bad = trajectory({ side: 'long', entry: 100, stop_loss: 100, ohlcvSinceEntry: [B(1, 100, 101, 99, 100)] });
assert.strictEqual(bad.mfe_R, null, 'risk 0 -> mfe null');

// 8) ohlcvSince : filtre les barres depuis l'entree (ts >= entryTs)
assert.strictEqual(ohlcvSince([[1, 0, 0, 0, 0], [5, 0, 0, 0, 0], [9, 0, 0, 0, 0]], 5).length, 2, 'ohlcvSince filtre');

console.log('test-trajectory OK (12 assertions)');
