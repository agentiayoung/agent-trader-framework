"use strict";
// entry-radar.js -- RADAR D'ENTREE (M002/S03). Tick deterministe (~15 min agent / ~5 min scalp,
// meme classe d'infra que monitor-tick) qui DECOUPLE le timing d'entree de l'analyse :
//   la routine (LLM) ARME des intentions dans armed-watch.json ; le radar les confirme bougie par
//   bougie (confirm.js) et ne pose le limit MAKER QUE quand la confirmation joue. Il ne CREE aucun
//   edge -- il ameliore le TIMING/FILL d'edges DEJA valides (M004 reclaim, shorts agent).
//
//   planRadar()  = COEUR PUR, deterministe, zero I/O (teste par tests/test-entry-radar.js).
//   runRadar()   = shell async (fetch bougies + openKeys + preflight + bybit), deps injectables.
//
// Garde-fous DURS (inchanges) : preflight (SL/geometrie anti-sweep/sizing) AVANT de poser ; LIMIT
// MAKER uniquement (jamais chase) ; expiry (intention perimee -> drop) ; no-duplicate (idempotence) ;
// DEMO only, REEL INTERDIT (le radar ne change jamais le statut reel).

const path = require("path");
const { confirmCandle } = require("./confirm.js");
const { readNewAlerts } = require("./tv-listener.js");
const aw = require("./armed-watch.js");

// ---- COUCHE TV / SELF-SOURCED (30.06) : Pine/signal-tick = TIMING, node = JUGE ------------------
// tvTriggerSet(alerts, watch) -> Set "SYMBOL|side" pour les alertes ENTREE qui matchent une intention
// armee. Une alerte (TV ou signal-tick) REVEILLE le radar au bon moment mais NE POSE JAMAIS : confirm.js
// reste le seul gate (re-validation node) -> pas d'auto-trade sur signal non arme (anti-mirage/repaint).
function tvTriggerSet(alerts, watch) {
  const keys = new Set();
  const setups = (watch && watch.setups) || [];
  for (const a of (alerts || [])) {
    if (!a || (a.kind && String(a.kind).toLowerCase() === "exit")) continue;
    const sym = String(a.symbol || "").toUpperCase();
    if (!sym) continue;
    const aside = a.side ? String(a.side).toLowerCase() : null;
    for (const s of setups) {
      if (String(s.symbol).toUpperCase() !== sym) continue;
      if (aside && aside !== String(s.side).toLowerCase()) continue;
      keys.add(`${s.symbol}|${s.side}`);
    }
  }
  return keys;
}

const isNum = (x) => typeof x === "number" && Number.isFinite(x);

// ---- COEUR PUR : planRadar({watch, barsBySymbol, openKeys, now}) -> decisions ------------------
// Pour chaque intention armee :
//   - expiree           -> drop (reason expiry)
//   - deja active        -> drop (no-duplicate : symbol|side dans openKeys)
//   - confirmee (confirm.js) -> post (avec price + confirm)
//   - sinon              -> keep (on attend la prochaine bougie jusqu'a expiry)
function planRadar({ watch, barsBySymbol, openKeys, now, tvTriggered }) {
  const keys = openKeys instanceof Set ? openKeys : new Set(openKeys || []);
  const tv = tvTriggered instanceof Set ? tvTriggered : new Set(tvTriggered || []);
  const bars = barsBySymbol || {};
  const decisions = [];
  for (const s of (watch && watch.setups) || []) {
    // tv_triggered = METADONNEE (alerte TV/self a reveille ce setup) ; ne change PAS la decision :
    // confirm.js reste le seul gate -> une alerte ne pose jamais sans re-validation node.
    const base = { id: s.id, symbol: s.symbol, side: s.side, setup: s.setup, family: s.family, tv_triggered: tv.has(`${s.symbol}|${s.side}`) };
    if (aw.isExpired(s, now)) { decisions.push({ ...base, action: "drop", reason: `intention expiree (expiry ${s.expiry_ts})` }); continue; }
    if (keys.has(`${s.symbol}|${s.side}`)) { decisions.push({ ...base, action: "drop", reason: "position/pending deja active (no-duplicate)" }); continue; }
    const c = confirmCandle(s.family, s.side, bars[s.symbol] || [], s.level, { atr: s.atr });
    if (c.confirmed) {
      decisions.push({ ...base, action: "post", price: c.price, confirm: c, reason: c.reason });
    } else {
      decisions.push({ ...base, action: "keep", reason: c.reason });
    }
  }
  return {
    decisions,
    toPost: decisions.filter((d) => d.action === "post"),
    toDrop: decisions.filter((d) => d.action === "drop"),
    toKeep: decisions.filter((d) => d.action === "keep"),
  };
}

// taille a poser : size explicite sinon risque / distance SL (sizing risk-first, identique au coeur
// de sizing.js -- le radar ne reinvente pas le sizing, il honore l'intention armee).
function amountFor(setup) {
  if (isNum(setup.size) && setup.size > 0) return setup.size;
  const dist = Math.abs(setup.level - setup.sl);
  if (!(dist > 0) || !isNum(setup.risk_usd)) return null;
  return +(setup.risk_usd / dist);
}

// ---- deps reelles par defaut (reseau) ----------------------------------------------------------
function defaultDeps() {
  const bybitDir = path.join(__dirname, "..", "skills", "bybit");
  let bybit = null, ccxt = null;
  try { bybit = require(path.join(bybitDir, "index.js")); } catch (_) {}
  try { ccxt = require(require.resolve("ccxt", { paths: [bybitDir] })); } catch (_) {}
  const pairOf = (sym) => /\/.*:/.test(sym) ? sym : `${String(sym).replace(/USDT.*/, "").toUpperCase()}/USDT:USDT`;
  let _client = null;
  const client = () => (_client || (_client = new ccxt.bybit({ enableRateLimit: true, options: { defaultType: "swap" } })));

  return {
    // bougies CLOSES de la TF demandee (on retire la bougie en cours = derniere)
    async fetchBars(symbol, tf, n = 30) {
      if (!ccxt) return [];
      const rows = await client().fetchOHLCV(pairOf(symbol), tf || "4h", undefined, n + 1).catch(() => []);
      return rows.length > 1 ? rows.slice(0, -1) : rows; // drop la bougie non close
    },
    // positions + ordres limit ouverts -> Set symbol|side (no-duplicate)
    async getOpenKeys(symbols) {
      const keys = new Set();
      if (!ccxt) return keys;
      const c = client();
      try {
        const ps = await c.fetchPositions();
        for (const p of ps) {
          const sz = Math.abs(Number(p.contracts || 0));
          if (sz > 0) keys.add(`${String(p.symbol).replace(/\/.*/, "")}|${p.side}`);
        }
      } catch (_) {}
      for (const sym of (symbols || [])) {
        try {
          const oo = await c.fetchOpenOrders(pairOf(sym));
          for (const o of oo) if ((o.type || "").includes("limit")) keys.add(`${sym}|${o.side === "buy" ? "long" : "short"}`);
        } catch (_) {}
      }
      return keys;
    },
    // preflight DETERMINISTE (SL/geometrie anti-sweep durs meme en demo)
    preflight(setup) {
      const { execFileSync } = require("child_process");
      const payload = JSON.stringify({ symbol: setup.symbol, side: setup.side, setup: setup.setup, entry: setup.level, stop_loss: setup.sl, take_profits: setup.take_profits });
      try {
        const out = execFileSync(process.execPath, [path.join(__dirname, "journal.js"), "preflight", payload], { encoding: "utf8", timeout: 60000 });
        // journal.js imprime un JSON MULTI-LIGNE (indent 2) -> parser le bloc {...} entier, pas la derniere ligne
        let j; try { j = JSON.parse(out.trim()); } catch (_) { const m = out.match(/\{[\s\S]*\}\s*$/); j = m ? JSON.parse(m[0]) : null; }
        return j || { ok: false, reason: "preflight: sortie illisible" };
      } catch (e) { return { ok: false, reason: "preflight erreur: " + (e && e.message) }; }
    },
    async place(setup, confirm, dryRun) {
      if (!bybit) return { ok: false, error: "bybit indisponible" };
      const amount = amountFor(setup);
      if (!(amount > 0)) return { ok: false, error: "taille indeterminee" };
      return bybit("bybit_place_limit_bracket", {
        symbol: setup.symbol, side: setup.side, amount,
        entry_px: confirm.price || setup.level, stop_loss_px: setup.sl,
        take_profits: setup.take_profits, dry_run: !!dryRun,
      });
    },
    // journalise le trade pose par le radar (preserve la rationale de l'orchestrateur + tag entry_via:radar)
    logTrade(setup, price) {
      try {
        const { execFileSync } = require("child_process");
        const tps = (setup.take_profits || []).map((t) => (t && t.px != null) ? t.px : t).filter((x) => Number.isFinite(+x));
        // Le radar pose un LIMIT MAKER au repos -> status PENDING + entry_planned (pas entry_actual, le
        // fill n'a pas eu lieu). reconcile/sync flippera en open avec entry_actual au fill. (Sans status
        // pending, cmd_log defaut "open" -> reconcile annule le trade car aucune position Bybit encore.)
        const payload = { strategy: setup.setup, exchange: "bybit", symbol: setup.symbol, side: setup.side,
          size: amountFor(setup), status: "pending", entry_planned: price, stop_loss: setup.sl, take_profits: tps,
          rationale: (setup.rationale || "radar entry") + " [entry_via:radar " + setup.confirm_type + "]",
          entry_via: "radar", risk_usd: setup.risk_usd };
        if (setup.track) payload.track = setup.track;
        if (setup.invalidation) payload.invalidation = setup.invalidation;
        execFileSync(process.execPath, [path.join(__dirname, "journal.js"), "log", JSON.stringify(payload)], { encoding: "utf8", timeout: 60000 });
        return true;
      } catch (_) { return false; }
    },
    // COUCHE TV/SELF : lit les nouvelles alertes depuis l'offset persiste (sidecar tv-alerts.offset).
    readAlerts() {
      const fs = require("fs");
      const queueFile = path.join(__dirname, "tv-alerts.jsonl");
      const offsetFile = path.join(__dirname, "tv-alerts.offset");
      let from = 0;
      try { from = parseInt(fs.readFileSync(offsetFile, "utf8").trim(), 10) || 0; } catch (_) {}
      return readNewAlerts(queueFile, from);
    },
    saveOffset(nextLine) {
      try { require("fs").writeFileSync(path.join(__dirname, "tv-alerts.offset"), String(nextLine || 0)); } catch (_) {}
    },
    log(msg) { try { console.log(msg); } catch (_) {} },
  };
}

// ---- shell async : runRadar({dryRun, deps, now}) -----------------------------------------------
async function runRadar(opts) {
  const o = opts || {};
  // Charge config/.env (TV_ALERTS y vit -> le radar consomme tv-alerts.jsonl en mode alert-driven).
  if (!o.deps) { try { require(path.join(__dirname, "..", "skills", "bybit", "index.js")); } catch (e) {} }
  const deps = o.deps || defaultDeps();
  const now = isNum(o.now) ? o.now : Date.now();
  const watchPath = o.watchPath || aw.WATCH_PATH;

  let watch = aw.readWatch(watchPath);
  const pr = aw.pruneExpired(watch, now);
  watch = pr.watch;
  const expiredDropped = pr.dropped;

  const symbols = [...new Set(watch.setups.map((s) => s.symbol))];
  // fetch bougies par symbole (groupe par tf)
  const barsBySymbol = {};
  for (const s of watch.setups) {
    if (barsBySymbol[s.symbol]) continue;
    if (s.family === "mr") { barsBySymbol[s.symbol] = []; continue; } // MR n'a pas besoin de bougie
    try { barsBySymbol[s.symbol] = await deps.fetchBars(s.symbol, s.tf, 30); } catch (_) { barsBySymbol[s.symbol] = []; }
  }
  const openKeys = await deps.getOpenKeys(symbols);

  // COUCHE TV/SELF (gated TV_ALERTS=1) : lit les alertes ENTREE (TV ou signal-tick) depuis l'offset et
  // marque les setups reveilles. Best-effort. confirm.js reste le gate dur (le node re-valide).
  let tvTriggered = new Set();
  if (process.env.TV_ALERTS === "1" && typeof deps.readAlerts === "function") {
    try {
      const { alerts, nextLine } = deps.readAlerts();
      tvTriggered = tvTriggerSet(alerts, watch);
      if (typeof deps.saveOffset === "function") deps.saveOffset(nextLine);
      if (tvTriggered.size) deps.log(`[RADAR] TV/self: ${tvTriggered.size} setup(s) reveille(s)`);
    } catch (e) { deps.log(`[RADAR] TV lecture echec non bloquant: ${(e && e.message) || e}`); }
  }

  const plan = planRadar({ watch, barsBySymbol, openKeys, now, tvTriggered });

  const posted = [], kept = [], dropped = [...expiredDropped.map((s) => ({ symbol: s.symbol, reason: "expiry" }))];
  for (const d of plan.decisions) {
    if (d.action === "keep") { kept.push(d); continue; }
    if (d.action === "drop") {
      watch = aw.removeSetup(watch, d.id);
      dropped.push({ symbol: d.symbol, reason: d.reason });
      continue;
    }
    // action === 'post' : garde-fou DUR preflight AVANT de poser
    const setup = watch.setups.find((x) => x.id === d.id);
    if (!setup) continue;
    const pf = deps.preflight(setup);
    if (!pf || pf.ok === false) {
      // hors demo un preflight ko = on garde l'intention (re-tente au prochain tick) ; on NE pose PAS
      deps.log(`[RADAR] ${d.symbol} ${d.side} preflight KO -> non pose (${pf && pf.reason || "?"})`);
      kept.push({ ...d, action: "keep", reason: "preflight ko" });
      continue;
    }
    let res;
    try { res = await deps.place(setup, d.confirm, !!o.dryRun); }
    catch (e) { res = { ok: false, error: (e && e.message) || String(e) }; } // isole : un setup qui plante ne tue pas le run
    if (res && res.ok !== false) {
      watch = aw.removeSetup(watch, d.id);
      // journalise le trade pose (sauf en dry-run) -> preserve la rationale + tag entry_via:radar
      let logged = false;
      if (!o.dryRun && typeof deps.logTrade === "function") logged = deps.logTrade(setup, d.price);
      posted.push({ symbol: d.symbol, side: d.side, setup: d.setup, price: d.price, dry_run: !!o.dryRun, logged, confirm: d.reason });
      deps.log(`[RADAR] POSE ${d.symbol} ${d.side} @${d.price} (${d.setup}) dry_run=${!!o.dryRun} logged=${logged}`);
    } else {
      kept.push({ ...d, action: "keep", reason: "place ko: " + (res && res.error || "?") });
    }
  }

  aw.writeWatch(watch, watchPath);
  return { now, posted, kept, dropped, remaining: watch.setups.length };
}

module.exports = { planRadar, runRadar, amountFor, defaultDeps, tvTriggerSet };

// CLI : node trade-journal/entry-radar.js [--dry-run]
if (require.main === module) {
  const dryRun = process.argv.includes("--dry-run") || process.argv.includes("--dry");
  runRadar({ dryRun }).then((r) => {
    console.log(JSON.stringify({ radar: true, dry_run: dryRun, posted: r.posted, kept: r.kept.map((k) => ({ symbol: k.symbol, reason: k.reason })), dropped: r.dropped, remaining: r.remaining }, null, 1));
  }).catch((e) => { console.error("radar err:", e && e.message); process.exit(1); });
}
