"use strict";

// ═══════════════════════════════════════════════════════════════════
// Signal Executor — reads the TradingView webhook inbox (signals/) and
// places bracket orders on the routed exchange (Bybit).
//
// Pipeline:  TradingView alert → webhook_listener.py → signals/<ts>.json
//            → THIS worker → <exchange>_place_bracket_scaled → processed/
//
// Safety:
//   • SL is mandatory — a signal without stop_loss/take_profits is skipped.
//   • DRY-RUN by default. Set EXECUTOR_LIVE=1 to actually send orders.
//   • Max N signals per cycle (EXECUTOR_MAX_PER_CYCLE, default 2).
//   • execution_implemented=false signals are archived without trading.
//
// Usage:
//   node signal_executor.js --once     # drain current backlog and exit
//   node signal_executor.js --watch    # poll every EXECUTOR_POLL_SEC (default 15s)
// ═══════════════════════════════════════════════════════════════════

const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..", "..");
const SIGNALS_DIR = process.env.TV_SIGNALS_DIR || path.join(REPO, "tradingview", "signals");
const PROCESSED_DIR = path.join(SIGNALS_DIR, "processed");
const LIVE = process.env.EXECUTOR_LIVE === "1";
const MAX_PER_CYCLE = parseInt(process.env.EXECUTOR_MAX_PER_CYCLE || "2", 10);
const POLL_SEC = parseInt(process.env.EXECUTOR_POLL_SEC || "15", 10);

function log(...a) { console.log(new Date().toISOString(), ...a); }

// ── Per-exchange handlers ───────────────────────────────────────────
// hyperliquid retiré le 09.06.2026 (skill archivé → archive/openclaw/) :
// un signal HYPERLIQUID tombe sur !handler → SKIP loggé + archivé, comme
// les autres exchanges non implémentés.
const HANDLERS = {
  bybit: {
    bracket: (sig, dry_run) => require(path.join(REPO, "skills", "bybit", "index.js"))(
      "bybit_place_bracket_scaled",
      {
        symbol: sig.market,
        side: sig.side,
        amount: Number(sig.position_size),
        entry_px: Number(sig.entry),
        stop_loss_px: Number(sig.stop_loss),
        take_profits: sig.take_profits,
        dry_run,
      }
    ),
    close: (sig) => require(path.join(REPO, "skills", "bybit", "index.js"))(
      "bybit_close_position", { symbol: sig.market }
    ),
  },
};

// ── Process a single signal file ────────────────────────────────────
async function processFile(file) {
  const full = path.join(SIGNALS_DIR, file);
  let sig;
  try { sig = JSON.parse(fs.readFileSync(full, "utf-8")); }
  catch (e) { return archive(file, { error: "invalid JSON: " + e.message }); }

  const skill = sig.routes_to_skill;
  const handler = HANDLERS[skill];

  if (!sig.execution_implemented || !handler) {
    log(`SKIP ${file} — exchange ${sig.exchange} not executable (skill=${skill})`);
    return archive(file, { skipped: "exchange not implemented" });
  }

  // Close action → flatten the position, no SL/TP needed.
  if (sig.action === "close") {
    try {
      const r = await handler.close(sig);
      log(`CLOSE ${file} → ${sig.exchange} ${sig.market}`);
      return archive(file, { action: "close", result: r });
    } catch (e) {
      log(`CLOSE-ERR ${file}: ${e.message}`);
      return archive(file, { action: "close", error: e.message });
    }
  }

  // Open action → SL + TPs mandatory.
  if (sig.stop_loss == null || !Array.isArray(sig.take_profits) || sig.take_profits.length === 0) {
    log(`REJECT ${file} — missing stop_loss/take_profits (SL obligatoire)`);
    return archive(file, { rejected: "missing stop_loss or take_profits" });
  }

  const dry_run = !LIVE;
  try {
    const r = await handler.bracket(sig, dry_run);
    log(`${dry_run ? "DRY-RUN" : "LIVE"} ${file} → ${sig.exchange} ${sig.side} ${sig.market} ` +
        `entry=${sig.entry} sl=${sig.stop_loss} tps=${sig.take_profits.length}`);
    return archive(file, { executed: !dry_run, dry_run, result: r });
  } catch (e) {
    log(`EXEC-ERR ${file}: ${e.message}`);
    return archive(file, { error: e.message });
  }
}

// Move a signal file to processed/ with an outcome sidecar.
function archive(file, outcome) {
  fs.mkdirSync(PROCESSED_DIR, { recursive: true });
  const full = path.join(SIGNALS_DIR, file);
  const dest = path.join(PROCESSED_DIR, file);
  try {
    const sig = JSON.parse(fs.readFileSync(full, "utf-8"));
    sig.processed = true;
    sig.outcome = outcome;
    sig.processed_at = Math.floor(Date.now() / 1000);
    fs.writeFileSync(dest, JSON.stringify(sig, null, 2));
    fs.unlinkSync(full);
  } catch {
    try { fs.renameSync(full, dest); } catch { /* best effort */ }
  }
  return outcome;
}

// ── Cycle: drain pending signal files ───────────────────────────────
async function cycle() {
  if (!fs.existsSync(SIGNALS_DIR)) return;
  const pending = fs.readdirSync(SIGNALS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .slice(0, MAX_PER_CYCLE);
  for (const f of pending) await processFile(f);
  return pending.length;
}

// ── Main ────────────────────────────────────────────────────────────
(async () => {
  const mode = process.argv.includes("--watch") ? "watch" : "once";
  log(`signal-executor start — mode=${mode} live=${LIVE} dir=${SIGNALS_DIR} max/cycle=${MAX_PER_CYCLE}`);
  if (mode === "once") {
    const n = await cycle();
    log(`done — ${n || 0} processed`);
    return;
  }
  // watch
  for (;;) {
    try { await cycle(); } catch (e) { log("cycle error:", e.message); }
    await new Promise((r) => setTimeout(r, POLL_SEC * 1000));
  }
})();
