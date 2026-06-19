"use strict";

// ═══════════════════════════════════════════════════════════════════
// Trade Journal — historique structuré des trades pour amélioration continue.
//
// Chaque trade : setup + rationale (POURQUOI) → exécution → outcome (résultat)
// → review (leçon). Les sessions d'analyse futures LISENT JOURNAL.md + LESSONS.md
// AVANT de décider, pour ne pas répéter les erreurs et renforcer ce qui marche.
//
// Commandes :
//   node trade-journal/journal.js log '<json>'    # enregistrer un trade ouvert
//   node trade-journal/journal.js close '<json>'  # finaliser manuellement
//   node trade-journal/journal.js sync            # auto-clôture depuis Bybit (closed PnL)
//   node trade-journal/journal.js stats           # agrégats (win rate, R moyen, par stratégie)
//   node trade-journal/journal.js report          # (re)génère JOURNAL.md
// ═══════════════════════════════════════════════════════════════════

const fs = require("fs");
const path = require("path");

const DIR = __dirname;
const FILE = path.join(DIR, "trades.jsonl");
const { enrichScore, perceptionScore } = require("./score.js");
const { addSnapshot, renderTradePage, staleOpen } = require("./timeline.js");
const { buildDigest, buildHeartbeat, isStale } = require("./digest.js");

function load() {
  if (!fs.existsSync(FILE)) return [];
  // Lecture TOLÉRANTE (10.06, pattern Vibe-Trading #147) : une ligne corrompue (crash mid-write)
  // ne doit PAS faire tomber tout le système (reconcile/heartbeat/routines/obsidian dépendent tous
  // de load()). On skippe la ligne avec un warning stderr au lieu de throw.
  const out = [];
  const lines = fs.readFileSync(FILE, "utf-8").split(/\r?\n/).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    try { out.push(JSON.parse(lines[i])); }
    catch (e) { console.error(`[journal] ligne ${i + 1} de trades.jsonl CORROMPUE, ignorée (${lines[i].slice(0, 80)}...) — réparer manuellement`); }
  }
  return out;
}
function saveAll(trades) {
  fs.writeFileSync(FILE, trades.map((t) => JSON.stringify(t)).join("\n") + "\n");
}

// ── log : enregistre un trade ouvert ────────────────────────────────
// ── GARDE-FOU DATE (source unique = horloge systeme locale) ──────────
// La date d'un trade ne doit JAMAIS dependre d'une saisie manuelle (cause
// d'erreurs repetees). On derive tout de l'horloge machine, en local.
function sysDate() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; // YYYY-MM-DD local, sans dependance ICU
}
// Datetime LOCALE avec offset (ex. 2026-06-08T18:45:12+02:00) -> heure claire pour les routines
function sysDateTime() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
}
// Affichage compact "YYYY-MM-DD HH:MM" en heure locale (gere UTC et offset local)
function fmtTime(ts) {
  if (!ts) return "";
  const s = String(ts);
  if (!/T\d/.test(s)) return s.slice(0, 10); // date seule (anciennes entrees) -> pas d'heure fictive
  const d = new Date(s);
  if (isNaN(d.getTime())) return s.slice(0, 16).replace("T", " ");
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function cmd_log(input) {
  const t = typeof input === "string" ? JSON.parse(input) : input;
  const trades = load();
  const today = sysDate();

  // Date = horloge systeme, TOUJOURS. Exception unique : backfill historique
  // (reconcile/orphelins) avec allow_backdate:true qui passe un ts_open Bybit.
  if (t.allow_backdate) {
    t.ts_open = t.ts_open || sysDateTime();
  } else {
    const supplied = (t.ts_open || "").slice(0, 10);
    if (supplied && supplied !== today) {
      console.error(`[journal] DATE CORRIGEE: ts_open fourni '${supplied}' != date systeme '${today}' -> force a '${today}'. (allow_backdate:true pour un backfill volontaire).`);
    }
    t.ts_open = sysDateTime(); // date + HEURE locale (la date reste pilotee par l'horloge systeme)
    // Re-derive le suffixe-date de l'id (8 chiffres + lettre optionnelle) depuis la date systeme
    if (t.id && /\d{8}[a-z]?$/.test(t.id)) t.id = t.id.replace(/\d{8}([a-z]?)$/, today.replace(/-/g, "") + "$1");
  }
  delete t.allow_backdate;

  if (!t.id) {
    const d = t.ts_open.slice(0, 10).replace(/-/g, "") || "nodate";
    t.id = `${t.strategy || "trade"}-${t.symbol || "NA"}-${d}`.toLowerCase().replace(/[^a-z0-9-]/g, "");
  }
  t.status = t.status || "open";

  // ── Risque geometrique REEL (data-quality, bug DOGE 16.06 cote scalp, meme garde ici) ──
  // risk_usd logge = BUDGET ; la geometrie reelle (size x |entry-SL|) peut diverger -> R-multiple
  // fausse. Pour un trade arme SIMPLE, la GEOMETRIE fait foi. Laddered EXEMPTE (risk_usd = somme rungs,
  // garde-fou essentiel cote agent qui ladder beaucoup). Budget conserve dans risk_budget + flag.
  if (["open", "pending"].includes(t.status)) {
    const rv = require("./risk-verify.js").verifyTradeRisk(t);
    if (rv.geom_risk != null) {
      if (rv.diverged) {
        t.risk_budget = t.risk_usd;
        t.risk_usd = rv.authoritative;
        t.sizing_warn = rv.reason;
        console.error("[journal] SIZING WARN " + (t.id || t.symbol) + " : " + rv.reason + " -> risk_usd corrige a " + rv.authoritative + " (R-multiple honnete).");
      }
      t.risk_usd_geom = rv.geom_risk;
    }
  }

  // ORIGINE (contexte d'execution) : si non passee explicitement, la routine la stampe via
  // $env:TRADE_ORIGIN (routine_auto / routine_manual, pose par run-routine.ps1) -> deterministe,
  // pas a la charge du LLM. Hors routine (session conv avec Claude) l'env est absent -> reste vide
  // et tradeOrigin() infere 'conv' depuis source:manual. Valeur libre toleree mais on borne au connu.
  if (!t.origin && process.env.TRADE_ORIGIN) t.origin = process.env.TRADE_ORIGIN;

  // Collision d'id -> auto-suffixe b,c,d... (ne jamais ecraser ni jeter un log)
  if (trades.find((x) => x.id === t.id)) {
    const root = t.id.replace(/[a-z]$/, "");
    let c = 98; // 'b'
    while (trades.find((x) => x.id === root + String.fromCharCode(c))) c++;
    t.id = root + String.fromCharCode(c);
  }

  // ── Instrumentation scoring /14 (additif, ne change PAS la décision de trade) ──
  // Le code dérive total/tier/rr/gate.passed des composantes brutes passées par la
  // routine. Niveaux résolus depuis le trade (ou hypo pour un no_trade).
  if (t.score && t.score.components) {
    const lv = {
      entry: t.score.entry ?? t.entry_actual ?? t.entry_planned ?? t.entry ?? (t.hypo && t.hypo.entry),
      sl: t.score.sl ?? t.stop_loss ?? (t.hypo && t.hypo.sl),
      // R:R du tier = vers le TP le PLUS LOIN (cible finale) = coherent avec rrToTp2 des guards
      // (angle mort corrige 18.06 : avant on prenait TP1 -> un ladder TP1@1R/TP2@2R sortait "sub" a tort).
      tp: t.score.tp ?? (Array.isArray(t.take_profits) && t.take_profits.length ? t.take_profits[t.take_profits.length - 1].px : undefined) ?? (t.hypo && t.hypo.tp),
    };
    t.score = enrichScore(t.score, lv);
  }

  // ── Scoring PERCEPTION /14 (F1, 18.06) : source DETERMINISTE (dispo ~14/14 opps, contrairement au
  // /14 Desktop souvent en fallback zones). Derive en PARALLELE de score Desktop (jamais a sa place)
  // -> calibration propre via score-eval.by_perception. Aligne au sens du trade. La routine passe la
  // perception compacte de l'opportunite (scan-latest) dans le champ `perception`.
  if (t.perception && t.perception.confluence && !t.score_perception) {
    const sp = perceptionScore(t.perception.confluence, t.side);
    if (sp) t.score_perception = sp;
  }

  if (!(t.score && t.score.components) && ["open", "pending", "no_trade"].includes(t.status)) {
    if (t.score_perception) console.error(`[journal] score Desktop absent -> scoring via PERCEPTION /14 (deterministe): ${t.score_perception.score14}/14 ${t.score_perception.tier}${t.score_perception.aligned === false ? " (CONTRE la confluence!)" : ""}.`);
    else console.error("[journal] SANS SCORE: decision loggee sans score.components NI perception -> instrumentation /14 incomplete. Ajouter score:{components:{...},gate:{...},zones} ou perception:{confluence:{...}} (non bloquant).");
  }

  // ── Renforcement HYPO sur les no_trade (alimente notrade-eval) ──
  // Un no_trade qui a rejeté un candidat PRÉCIS doit porter hypo:{symbol,side,entry,sl,tp}
  // -> notrade-eval rejoue le prix et dit si le refus était JUSTE (perte évitée) ou FAUX (gain raté).
  // Sans hypo, le refus n'est pas mesurable. (Légitimement absent si le scanner n'a rien trouvé.)
  if (t.status === "no_trade") {
    const h = t.hypo;
    const complete = h && h.symbol && h.entry != null && h.sl != null && h.tp != null;
    if (!complete) {
      console.error("[journal] SANS HYPO: no_trade sans hypo:{symbol,side,entry,sl,tp} complet -> notrade-eval ne pourra PAS juger ce refus (juste/faux). OBLIGATOIRE si un candidat precis a ete rejete avec des niveaux ; omettable seulement si scanner=0 opportunite (non bloquant).");
    }
  }

  // ── Contexte d'analyse (tracabilite G8, audit 18.06) : snapshot du scan/marche au moment du trade ──
  // Auto-capture DETERMINISTE depuis scan-latest.json (pas a la charge du LLM) -> un trade reste
  // reconstructible (posture, candidats concurrents, options, cycle de la paire). Best-effort :
  // ne bloque JAMAIS le log. Un entry_context fourni explicitement est preserve (non ecrase).
  if (["open", "pending"].includes(t.status) && !t.entry_context) {
    try { t.entry_context = require("./entry-context.js").loadEntryContext(t, DIR); } catch (e) { /* best-effort */ }
  }

  trades.push(t);
  saveAll(trades);
  return { logged: t.id, status: t.status, ts_open: t.ts_open };
}

// ── roundPx : arrondi PRESERVANT la precision selon la magnitude ─────
// Bug 12.06 (DOGE) : `.toFixed(2)` hardcode ecrasait entry_actual ET avg_exit
// d'un alt sub-dollar (0.086 -> "0.09") -> entry==exit -> R price-based = 0.
// Touche TOUT actif < 1 USD. On garde ~5 chiffres significatifs.
function roundPx(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return n;
  const m = Math.abs(n);
  const dec = m >= 1000 ? 2 : m >= 1 ? 4 : m >= 0.01 ? 6 : 8;
  return +n.toFixed(dec);
}

// ── computeRMultiple : R d'un trade CLOS, robuste laddered + sub-dollar ──
// PRIMAIRE = PnL realise (verite Bybit) / risque budgete (`risk_usd`). C'est le
// R le plus fiable : insensible aux problemes d'avg entry/exit d'une entree
// echelonnee (plusieurs rungs) et a l'arrondi de prix. Fallback = geometrie prix.
// Pur + exporte (teste offline). Cf. bug DOGE 12.06 : entry==exit -> price-based=0
// alors que realized_pnl -997.71 / risk 1034 = -0.96R.
function computeRMultiple(t) {
  if (t && Number.isFinite(t.risk_usd) && t.risk_usd > 0 && Number.isFinite(t.realized_pnl)) {
    return +(t.realized_pnl / t.risk_usd).toFixed(2);
  }
  if (t && t.entry_actual && t.stop_loss && t.avg_exit) {
    const risk = Math.abs(t.stop_loss - t.entry_actual);
    const reward = t.side === "short" ? t.entry_actual - t.avg_exit : t.avg_exit - t.entry_actual;
    if (risk) return +(reward / risk).toFixed(2);
  }
  return (t && typeof t.r_multiple === "number") ? t.r_multiple : null;
}

// ── close : finalise un trade (manuel ou via sync) ──────────────────
function cmd_close(input) {
  const u = typeof input === "string" ? JSON.parse(input) : input;
  const trades = load();
  const t = trades.find((x) => x.id === u.id);
  if (!t) throw new Error("trade not found: " + u.id);
  Object.assign(t, u, { status: "closed" });
  const r = computeRMultiple(t);
  if (r != null) t.r_multiple = r;
  saveAll(trades);
  return { closed: t.id, net_pnl: t.net_pnl, r_multiple: t.r_multiple };
}

// ── manage-check : alertes deterministes de resserrement de SL ──────
// Croise les positions actives avec le dernier scan (scan-latest.json) via le
// module pur manage.js. A lancer APRES scan.js dans la routine. Surface les
// shorts a risque de squeeze (divergence:bull pendant alt_capitulation, ou
// at_cycle_low) -> resserrer le SL au lieu de garder le SL planifie (lecon DOGE 12.06).
function cmd_manage_check() {
  const scanPath = path.join(DIR, "scan-latest.json");
  if (!fs.existsSync(scanPath)) return { error: "scan-latest.json absent -> lancer `node trade-journal/scan.js` d'abord", n: 0, alerts: [] };
  const scan = JSON.parse(fs.readFileSync(scanPath, "utf8"));
  const active = load().filter((t) => t.status === "open" || t.status === "pending");
  const out = require("./manage.js").slTightenAlerts(active, scan.all, scan.market);
  out.scan_ts = scan.ts || null;
  out.note = out.n ? "Pour chaque OPEN flague -> RESSERRER le SL (trailing serre / breakeven+) ; pour un PENDING -> reconsiderer l'annulation. Lecon DOGE 12.06 (-0.96R)." : "Aucune position a risque de squeeze (pas de short avec divergence:bull/at_cycle_low).";
  return out;
}

// ── thesis-check : PERCEPTION live "sante de these" par position tenue (15.06) ──
// Generalise manage-check (tighten-only, short-only) en un verdict BIDIRECTIONNEL
// hold|weakening|flipped (module pur thesis.js) en croisant les positions actives avec
// le dernier scan persiste. flipped (>=2 signaux structurels CONTRE la position : trend
// 4H flippe + meilleur setup du scan a l'oppose + reclaim EMA50d ...) = these cassee ->
// take_partial + SL break-even ; weakening -> resserrer ; hold -> rien. A lancer APRES
// scan.js, A LA PLACE de manage-check (le tighten est inclus). Le LLM AGIT (seuil dur de
// cut total = P1 OOS). Repond a "voir le breakout XRP en live" (the maintainer 15.06).
async function cmd_thesis_check() {
  const scanPath = path.join(DIR, "scan-latest.json");
  if (!fs.existsSync(scanPath)) return { error: "scan-latest.json absent -> lancer `node trade-journal/scan.js` d'abord", n: 0, positions: [] };
  const scan = JSON.parse(fs.readFileSync(scanPath, "utf8"));
  const active = load().filter((t) => t.status === "open" || t.status === "pending");
  // TRAJECTOIRE (16.06) : fetch OHLCV-depuis-l'entree par position OPEN -> MFE/MAE/give-back/velocite
  // (capte les pics de l'ANGLE MORT entre routines). Best-effort : tout echec -> trajById vide ->
  // thesisHealth retombe sur son comportement instantane (retro-compatible). Observabilite, le LLM agit.
  const trajById = {};
  // PERCEPTION PROFONDE par position OPEN (F3, 18.06) : structure + ORDERFLOW (sweep/CVD/OI) -> alimente
  // le signal SWEEP de flipSignals (la structure CHoCH/MSS vient deja, gratuite, du scan row). Best-effort
  // par position : tout echec -> percById vide -> thesisHealth retombe sur la structure seule. Desactivable
  // par THESIS_DEEP_PERCEPTION=0 (economie de fetch ; la structure CHoCH/MSS reste, elle).
  const percById = {};
  const deepOn = process.env.THESIS_DEEP_PERCEPTION !== "0";
  try {
    const { trajectory } = require("./trajectory.js");
    const U = require("./universe.js");
    const ccxt = require(require.resolve("ccxt", { paths: [path.join(DIR, "..", "skills", "bybit", "node_modules")] }));
    const ex = new ccxt.bybit({ enableRateLimit: true, options: { defaultType: "swap" } });
    const TF = process.env.TRAJ_TF || "1h"; // TF fine -> MFE/MAE granulaires (capte le pic intra-4h)
    for (const t of active) {
      if (t.status !== "open") continue;
      const entry = Number(t.entry_actual ?? t.avg_entry ?? t.entry_planned);
      const sl = Number(t.stop_loss);
      const entryTs = Date.parse(t.ts_open || "");
      if (Number.isFinite(entry) && Number.isFinite(sl) && Number.isFinite(entryTs)) {
        let ccxtSym; try { const e = U.bySymbol(t.symbol); ccxtSym = (e && (e.ccxt || e.symbol)) || `${t.symbol}/USDT:USDT`; } catch (_) { ccxtSym = `${t.symbol}/USDT:USDT`; }
        try {
          const ohlcv = await ex.fetchOHLCV(ccxtSym, TF, entryTs, 300); // since = entree -> deja "depuis l'entree"
          trajById[t.id] = trajectory({ side: t.side, entry, stop_loss: sl, ohlcvSinceEntry: ohlcv });
        } catch (_) { /* best-effort par position */ }
      }
      if (deepOn) { try { const dp = await require("./perception.js").deepPerception(t.symbol, "4h"); if (dp && !dp.error) percById[t.id] = dp; } catch (_) { /* best-effort */ } }
    }
  } catch (_) { /* ccxt indispo -> pas de trajectoire/orderflow, thesis fonctionne quand meme */ }
  const out = require("./thesis.js").thesisHealth(active, scan.all, scan.market, trajById, percById);
  out.scan_ts = scan.ts || null;
  return out;
}

// ── sync : auto-clôture des trades Bybit ouverts via closed PnL ──────
async function cmd_sync() {
  const bybitDir = path.join(DIR, "..", "skills", "bybit");
  require(path.join(bybitDir, "index.js")); // déclenche le chargement .env
  const ccxt = require(require.resolve("ccxt", { paths: [bybitDir] }));
  const c = new ccxt.bybit({
    apiKey: process.env.BYBIT_API_KEY, secret: process.env.BYBIT_API_SECRET,
    enableRateLimit: true, options: { defaultType: "swap", recvWindow: 10000, adjustForTimeDifference: true },
  });
  if (process.env.BYBIT_DEMO !== "0") c.enableDemoTrading(true);
  await c.loadTimeDifference();

  // Inclut "pending" : un ordre limit au repos peut s'etre rempli ET ferme (SL/TP)
  // entre deux runs — il faut le reconcilier contre le closed PnL Bybit.
  const open = load().filter((t) => (t.status === "open" || t.status === "pending") && t.exchange === "bybit");
  if (!open.length) return { synced: 0, msg: "aucun trade Bybit ouvert/pending" };

  const r = await c.privateGetV5PositionClosedPnl({ category: "linear", limit: 100 });
  const rows = (r.result && r.result.list) || [];
  let synced = 0;

  for (const t of open) {
    const sym = (String(t.symbol).toUpperCase().includes("USDT") ? t.symbol : t.symbol + "USDT")
      .toUpperCase().replace(/[^A-Z]/g, "");
    const entryRef = t.entry_actual ?? t.entry_planned;
    const matched = rows.filter((x) => x.symbol === sym && Math.abs(Number(x.avgEntryPrice) - entryRef) < Math.max(1, entryRef * 0.001));
    if (!matched.length) continue;

    const pnl = matched.reduce((s, x) => s + Number(x.closedPnl), 0);
    const fees = matched.reduce((s, x) => s + Number(x.openFee || 0) + Number(x.closeFee || 0), 0);
    const qty = matched.reduce((s, x) => s + Number(x.qty), 0);
    const avgEntry = matched.reduce((s, x) => s + Number(x.avgEntryPrice) * Number(x.qty), 0) / qty;
    const avgExit = matched.reduce((s, x) => s + Number(x.avgExitPrice) * Number(x.qty), 0) / qty;
    const lastTs = Math.max(...matched.map((x) => Number(x.updatedTime)));
    const slHit = t.side === "short" ? avgExit >= avgEntry : avgExit <= avgEntry;

    cmd_close({
      id: t.id, ts_close: new Date(lastTs).toISOString(),
      entry_actual: roundPx(avgEntry),     // moy ponderee (laddered) + precision sub-dollar (fix DOGE 12.06)
      avg_exit: roundPx(avgExit), realized_pnl: +pnl.toFixed(4),
      fees: +fees.toFixed(4), net_pnl: +(pnl - fees).toFixed(4),
      exits: matched.map((x) => ({ px: roundPx(x.avgExitPrice), qty: +x.qty, pnl: +Number(x.closedPnl).toFixed(4) }))
        .sort((a, b) => b.pnl - a.pnl),
      outcome: pnl > 0 ? "win" : "loss", exit_reason: slHit ? "stop_loss" : "take_profit",
    });
    synced++;
  }
  return { synced };
}

// ── set : merge des champs arbitraires dans un trade (status, note...) ──
function cmd_set(input) {
  const u = typeof input === "string" ? JSON.parse(input) : input;
  const trades = load();
  const t = trades.find((x) => x.id === u.id);
  if (!t) throw new Error("trade not found: " + u.id);
  Object.assign(t, u);
  // Un `set` qui (re)pose un bloc score brut (ex. repositionnement de bracket) doit l'enrichir
  // comme cmd_log — sinon total/tier manquent et score-eval bucketerait à 0 (bug HYPE 10.06).
  if (u.score && t.score && t.score.components && t.score.total == null) {
    const lv = {
      entry: t.score.entry ?? t.entry_actual ?? t.entry_planned ?? t.entry ?? (t.hypo && t.hypo.entry),
      sl: t.score.sl ?? t.stop_loss ?? (t.hypo && t.hypo.sl),
      tp: t.score.tp ?? (Array.isArray(t.take_profits) && t.take_profits.length ? (t.take_profits[t.take_profits.length - 1].px ?? t.take_profits[t.take_profits.length - 1]) : undefined) ?? (t.hypo && t.hypo.tp),
    };
    t.score = enrichScore(t.score, lv);
  }
  saveAll(trades);
  return { updated: t.id, status: t.status };
}

// ── stats : agrégats ────────────────────────────────────────────────
// Un trade TEST de pipeline (strategy MANUAL_TEST_*) n'est PAS une perf réelle -> exclu des stats
// (cohérence : score-eval exclut aussi les tests ; sinon l'agent se brouille sur sa vraie perf).
function isTestTrade(t) { return /^MANUAL_TEST/i.test(t.strategy || ""); }
// PISTE d'un trade (labo demo 2-pistes, 10.06) : separe la mesure de PRODUCTION (edges valides,
// routine OU manuel a setup catalogue = LA perf qui juge le systeme) de l'EXPERIMENT (manuel a
// geometrie NOUVELLE : deep accum, swing, contra-trend... = cohorte forward-test qui ne pollue PAS
// la prod) et du TEST (plomberie). Infere si non explicite -> marche RETROACTIVEMENT sur l'historique.
// (?![A-Za-z0-9]) = frontiere digit-aware : "S1_short" matche (le "_" suit), "S12_.." matche via S12,
// mais "S1" NE matche PAS "S12" (le "2" suit) ; "DEEP_ACCUM"/"swing" ne matchent aucun token catalogue.
const CATALOG_SETUP = /^(S12|S1|S2|S3|S4|S5|S6|S7|S8|S9|MR1|MR2|MR3|MR4|MR5|MR7|MR8|WEB1|WEB2|TR1)(?![A-Za-z0-9])/i;
function tradeTrack(t) {
  if (t.track) return t.track;                                          // explicite (passe au log)
  if (isTestTrade(t)) return "test";
  const key = String(t.strategy || t.setup || "");
  if (t.source === "manual" && !CATALOG_SETUP.test(key)) return "experiment"; // manuel hors catalogue
  return "production";                                                  // routine, ou manuel a setup valide
}
// ORIGINE (contexte d'EXECUTION, ORTHOGONAL au track) : distingue COMMENT le trade a ete pris,
// pour un forward-test complet ou conv et routines sont COMPLEMENTAIRES (memes datas, splittables) :
//  - conv           : execute par Claude DANS une conversation interactive (session dev, niveaux lus live)
//  - routine_auto   : routine autonome planifiee (Task Scheduler -> claude -p)
//  - routine_manual : routine declenchee a la main par the maintainer (run-routine.ps1 -Manual / ROUTINE-MANUELLE.bat)
// Le TRACK decide si le trade COMPTE dans la perf (production) ; l'ORIGIN ne fait que SPLITTER l'analyse
// (conv ET routine a setup catalogue restent TOUS dans production = LE MEME forward-test, jamais exclus).
// Inference retroactive (avant le champ) : source:manual = conv (l'historique manuel = sessions conv
// avec Claude : ASTER, HYPE, DOGE...) ; sinon routine_auto (le gros des trades = routines).
const ORIGINS = ["conv", "routine_auto", "routine_manual"];
function tradeOrigin(t) {
  if (t.origin && ORIGINS.includes(t.origin)) return t.origin;          // explicite (passe au log)
  if (t.origin) return t.origin;                                        // valeur libre toleree
  if (t.source === "manual") return "conv";                            // heritage : manuel = session conv
  return "routine_auto";                                               // heritage : le reste = routine
}
// Catégorise POURQUOI un pending a été annulé (jamais déclenché) — pour comprendre, SANS interférer
// avec le WR (les annulés n'ont pas de net_pnl, ne sont jamais comptés dans la perf).
function cancelReason(t) {
  const r = (t.review || "").toLowerCase();
  if (/rebond rat|entree-rebond|entrée-rebond/.test(r)) return "rebond_rate";
  if (/pruning/.test(r)) return "pruning";
  if (/>5%|sop ?>?5|trop loin|inatteignable/.test(r)) return "trop_loin_5pct";
  if (/supersed|supersédé|remplac|repositionn/.test(r)) return "repositionne";
  if (/quota|max 3/.test(r)) return "quota";
  if (/these cass|thèse cass|invalid/.test(r)) return "these_invalidee";
  return "autre";
}
function cmd_stats() {
  const all = load();
  const closed = all.filter((t) => t.status === "closed" && !isTestTrade(t));
  const testsClosed = all.filter((t) => t.status === "closed" && isTestTrade(t)).length;
  const n = closed.length;
  const wins = closed.filter((t) => (t.net_pnl ?? t.realized_pnl ?? 0) > 0).length;
  const pnl = closed.reduce((s, t) => s + (t.net_pnl ?? 0), 0);
  const rs = closed.filter((t) => typeof t.r_multiple === "number").map((t) => t.r_multiple);
  const avgR = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null;
  const byStrat = {};
  for (const t of closed) {
    const k = t.strategy || "?";
    byStrat[k] = byStrat[k] || { n: 0, wins: 0, pnl: 0 };
    byStrat[k].n++; if ((t.net_pnl ?? 0) > 0) byStrat[k].wins++; byStrat[k].pnl += t.net_pnl ?? 0;
  }
  // Catégorie SÉPARÉE : pendings annulés (jamais déclenchés) -> n'interfèrent PAS avec le WR.
  const cancelled = all.filter((t) => t.status === "cancelled");
  const cancelByReason = {};
  for (const t of cancelled) { const k = cancelReason(t); cancelByReason[k] = (cancelByReason[k] || 0) + 1; }
  // SPLIT PAR PISTE (labo demo) : production vs experiment vs test -> l'experimental manuel ne
  // se confond plus avec la perf de production (le juge du systeme). Inclut open+pending pour le suivi.
  const byTrack = {};
  for (const t of all.filter((x) => ["closed", "open", "pending"].includes(x.status))) {
    const k = tradeTrack(t); const b = (byTrack[k] = byTrack[k] || { closed: 0, wins: 0, pnl: 0, rs: [], live: 0 });
    if (t.status === "closed") { b.closed++; if ((t.net_pnl ?? 0) > 0) b.wins++; b.pnl += t.net_pnl ?? 0; if (typeof t.r_multiple === "number") b.rs.push(t.r_multiple); }
    else b.live++;
  }
  for (const k of Object.keys(byTrack)) {
    const b = byTrack[k];
    b.win_rate = b.closed ? +(b.wins / b.closed * 100).toFixed(1) : 0;
    b.avg_r = b.rs.length ? +(b.rs.reduce((a, c) => a + c, 0) / b.rs.length).toFixed(2) : null;
    b.net_pnl = +b.pnl.toFixed(2); delete b.rs; delete b.pnl;
  }
  // SPLIT PAR ORIGINE (contexte d'execution, ORTHOGONAL au track) : conv vs routine_auto vs routine_manual
  // -> verifie si les trades conv (curated, niveaux lus live) et les routines autonomes se comportent
  // pareil (WR/avgR/PnL), SANS jamais exclure aucune cohorte. Les deux nourrissent LE MEME forward-test.
  const byOrigin = {};
  for (const t of all.filter((x) => ["closed", "open", "pending"].includes(x.status) && !isTestTrade(x))) {
    const k = tradeOrigin(t); const b = (byOrigin[k] = byOrigin[k] || { closed: 0, wins: 0, pnl: 0, rs: [], live: 0 });
    if (t.status === "closed") { b.closed++; if ((t.net_pnl ?? 0) > 0) b.wins++; b.pnl += t.net_pnl ?? 0; if (typeof t.r_multiple === "number") b.rs.push(t.r_multiple); }
    else b.live++;
  }
  for (const k of Object.keys(byOrigin)) {
    const b = byOrigin[k];
    b.win_rate = b.closed ? +(b.wins / b.closed * 100).toFixed(1) : 0;
    b.avg_r = b.rs.length ? +(b.rs.reduce((a, c) => a + c, 0) / b.rs.length).toFixed(2) : null;
    b.net_pnl = +b.pnl.toFixed(2); delete b.rs; delete b.pnl;
  }
  return {
    trades: n, open: all.filter((t) => t.status === "open").length,
    win_rate: n ? +(wins / n * 100).toFixed(1) : 0, net_pnl: +pnl.toFixed(2),
    avg_r: avgR != null ? +avgR.toFixed(2) : null, by_strategy: byStrat,
    by_track: byTrack, // labo demo : production (le juge) | experiment (forward-test, separe) | test
    by_origin: byOrigin, // contexte d'exec : conv | routine_auto | routine_manual (complementaires, jamais exclus)
    tests_closed: testsClosed, // tests pipeline exclus de la perf ci-dessus
    // --- séparé de la perf : ne JAMAIS compter dans le WR ---
    triggered_def: "trades(closed)/win_rate = UNIQUEMENT les trades DÉCLENCHÉS (entrée remplie) clôturés gain/perte.",
    not_triggered: { cancelled: cancelled.length, by_reason: cancelByReason, note: "Pendings annulés AVANT fill (jamais déclenchés). Comptés ici pour comprendre, JAMAIS dans le WR." },
  };
}

// ── scorecard : expectancy par setup (boucle quantitative) ──────────
function cmd_scorecard() {
  const closed = load().filter((t) => t.status === "closed");
  const by = {};
  for (const t of closed) {
    const k = t.strategy || "?";
    by[k] = by[k] || { n: 0, wins: 0, pnl: 0, R: [] };
    by[k].n++; if ((t.net_pnl ?? 0) > 0) by[k].wins++; by[k].pnl += t.net_pnl ?? 0;
    if (typeof t.r_multiple === "number") by[k].R.push(t.r_multiple);
  }
  const cards = Object.entries(by).map(([k, v]) => {
    const expectancy = v.n ? v.pnl / v.n : 0; // PnL net moyen / trade
    const avgR = v.R.length ? v.R.reduce((a, b) => a + b, 0) / v.R.length : null;
    let verdict;
    if (v.n < 5) verdict = "SAMPLE INSUFFISANT (logger plus)";
    else if (expectancy > 0) verdict = "TRADER (sizer selon expectancy)";
    else verdict = "EVITER (expectancy negative)";
    return {
      setup: k, n: v.n, win_rate: +((v.wins / v.n) * 100).toFixed(1),
      expectancy: +expectancy.toFixed(2), avg_r: avgR != null ? +avgR.toFixed(2) : null,
      total_pnl: +v.pnl.toFixed(2), verdict,
    };
  }).sort((a, b) => b.expectancy - a.expectancy);
  return { setups: cards, regle: "Trader les setups expectancy>0 ET n>=5 ; eviter les expectancy<0 ; sizer proportionnel a l'expectancy." };
}

// ── observabilité : état consolidé (offline) pour digest/heartbeat ──
// equity.json est maintenu par `cmd_risk` (lance en début de routine) -> frais.
function _equityState() {
  const f = path.join(DIR, "equity.json");
  if (!fs.existsSync(f)) return { equity: null, day_pnl_pct: null, drawdown_pct: null, halt: false };
  let st; try { st = JSON.parse(fs.readFileSync(f, "utf-8")); } catch (e) { return { equity: null, day_pnl_pct: null, drawdown_pct: null, halt: false }; }
  const hist = st.history || [];
  const equity = hist.length ? hist[hist.length - 1].equity : (st.day_start ?? null);
  const dayPnl = st.day_start && equity != null ? ((equity - st.day_start) / st.day_start) * 100 : null;
  const dd = st.high_water && equity != null ? ((st.high_water - equity) / st.high_water) * 100 : null;
  const dailyLoss = parseFloat(process.env.RM_DAILY_LOSS_PCT || "5");
  const maxDd = parseFloat(process.env.RM_MAX_DRAWDOWN_PCT || "10");
  // DEMO_ACTIVE (approved) : en compte DEMO on peut aller AU-DELA de 10% de drawdown (objectif = trader
  // activement pour tester l'infra). Le drawdown ne declenche PAS le halt en demo. L'anti-martingale
  // (sizing.drawdownScale, taper a RM_MAX_DRAWDOWN_PCT) reste actif => la taille reduit toujours, ca
  // ne STOPPE plus. Hors demo, le halt drawdown re-arme. La perte-jour garde sa logique (degradee en
  // warning par guards.js en demo de toute facon).
  const demoActive = process.env.DEMO_ACTIVE === "1";
  const halt = (dayPnl != null && dayPnl < -dailyLoss) || (!demoActive && dd != null && dd > maxDd);
  return { equity, day_pnl_pct: dayPnl != null ? +dayPnl.toFixed(2) : null, drawdown_pct: dd != null ? +dd.toFixed(2) : null, halt };
}
function _gatherState() {
  const trades = load();
  const today = sysDate();
  const isToday = (t) => String(t.ts_open || "").slice(0, 10) === today;
  return {
    ts: sysDateTime().slice(0, 16).replace("T", " "),
    ..._equityState(),
    open: trades.filter((t) => t.status === "open"),
    pending: trades.filter((t) => t.status === "pending"),
    today_trades: trades.filter((t) => isToday(t) && ["open", "pending", "closed"].includes(t.status)).length,
    today_no_trades: trades.filter((t) => isToday(t) && t.status === "no_trade").length,
    stale_count: staleOpen(trades, today).length,
    score_eval_n: require("./score.js").evalScores(trades).n,
    zones_fallback: require("./entry-context.js").zonesFallbackRate(trades, 7),
  };
}
function _ping(url) {
  return new Promise((resolve) => {
    let mod; try { mod = url.startsWith("https") ? require("https") : require("http"); } catch (e) { return resolve(false); }
    const req = mod.get(url, (res) => { res.resume(); resolve(res.statusCode >= 200 && res.statusCode < 400); });
    req.on("error", () => resolve(false));
    req.setTimeout(5000, () => { req.destroy(); resolve(false); });
  });
}

// ── digest : état consolidé lisible (Telegram). `send` -> envoie via notify ──
async function cmd_digest(arg) {
  const text = buildDigest(_gatherState());
  let sent;
  if (arg === "send") { try { sent = await require("./notify.js")(text); } catch (e) { sent = false; } }
  return { digest: text, sent };
}

// portfolio : regenere PORTFOLIO.md (vue unifiee des 2 agents) + note Obsidian.
// --json -> renvoie l'agregat brut (consomme par le dashboard web). Best-effort.
function cmd_portfolio(arg) {
  const pf = require("./portfolio.js");
  if (arg === "json") return pf.buildLive();
  pf.run([]);
  const p = pf.buildLive();
  return { ok: true, total_equity: p.aggregate.total_equity, total_closed: p.aggregate.total_closed,
    combined_win_rate: p.aggregate.combined_win_rate, agents: p.agents.map((a) => a.name) };
}

// Charge config/.env dans process.env (loader zéro-dep du skill bybit — même
// pattern que notify.js). Nécessaire pour les commandes qui lisent l'env SANS
// passer par le client exchange (heartbeat/heartbeat-check) : sans ça,
// HEALTHCHECK_PING_URL/HEARTBEAT_MAX_AGE_MIN ne sont jamais vus en appel direct.
function _loadEnv() { try { require(path.join(DIR, "..", "skills", "bybit", "index.js")); } catch (e) {} }

// ── heartbeat : écrit routines/heartbeat.json + ping dead-man externe ──
// Appelé à chaque routine -> trace "l'agent est vivant". HEALTHCHECK_PING_URL
// (ex. healthchecks.io) = dead-man qui survit au PC éteint (alerte côté serveur).
async function cmd_heartbeat() {
  _loadEnv();
  const state = _gatherState();
  const f = path.join(DIR, "..", "routines", "heartbeat.json");
  // Preserve le flag de completude (ecrit par routine-status APRES) -> jamais de fenetre sans flag.
  let prev = {}; try { prev = JSON.parse(fs.readFileSync(f, "utf-8")); } catch (e) {}
  const hb = { ...buildHeartbeat(state), ts_iso: sysDateTime(),
    last_complete: prev.last_complete, last_incomplete_reason: prev.last_incomplete_reason, last_status_ts: prev.last_status_ts };
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(hb, null, 2));
  let pinged = false;
  const url = process.env.HEALTHCHECK_PING_URL || "";
  if (url) pinged = await _ping(url);
  return { heartbeat: hb, pinged, dead_man: url ? "configuré" : "non configuré (HEALTHCHECK_PING_URL)" };
}

// ── heartbeat-check : le dead-man local (lu par health-check.ps1) ──
function cmd_heartbeat_check() {
  _loadEnv();
  const f = path.join(DIR, "..", "routines", "heartbeat.json");
  const maxAge = parseFloat(process.env.HEARTBEAT_MAX_AGE_MIN || "300"); // 5h (routines toutes les 4h)
  if (!fs.existsSync(f)) return { stale: true, reason: "aucun heartbeat", max_age_min: maxAge };
  let hb; try { hb = JSON.parse(fs.readFileSync(f, "utf-8")); } catch (e) { return { stale: true, reason: "heartbeat illisible", max_age_min: maxAge }; }
  const stale = isStale(Date.parse(hb.ts_iso || hb.ts), Date.now(), maxAge);
  return { stale, last: hb.ts_iso || hb.ts, max_age_min: maxAge, equity: hb.equity, open: hb.open, pending: hb.pending,
    // COMPLETUDE (10.06) : vivant mais a-t-il TRADE ? Le heartbeat seul ne capte que le silence TOTAL.
    // last_complete=false => claude est mort tot (cap usage) mais les post-steps ont tire le heartbeat.
    last_complete: hb.last_complete !== false, last_incomplete_reason: hb.last_incomplete_reason || null, last_status_ts: hb.last_status_ts || null };
}

// ── routine-status : marque la COMPLETUDE de la derniere routine dans heartbeat.json ──
// Ecrit par run-routine.ps1 APRES le check de completude. Comble le gap watchdog : le heartbeat
// dit "vivant" meme si claude meurt tot (cap usage) car les post-steps PowerShell tirent quand meme
// le heartbeat -> ici on enregistre AUSSI "la routine a-t-elle reellement trade ?". health-check
// alerte alors sur "vivant mais incomplet", pas seulement sur le silence total.
function cmd_routine_status(input) {
  // Parse tolerant : PowerShell 5.1 peut manger les guillemets en passant le JSON inline
  // a node.exe (node recevrait {complete:true} sans quotes -> JSON.parse echoue, last_status_ts
  // se fige). On degrade proprement. Voir routines/run-routine.ps1 (echappement \").
  let u = {};
  if (typeof input === "string") {
    try { u = JSON.parse(input); }
    catch (e) {
      u = { complete: !/complete["']?\s*:\s*false/i.test(input) };
      const m = input.match(/reason["']?\s*:\s*["']?([^"'}]+)/i);
      if (m) u.reason = m[1].trim();
    }
  } else { u = input || {}; }
  const f = path.join(DIR, "..", "routines", "heartbeat.json");
  let hb = {}; try { hb = JSON.parse(fs.readFileSync(f, "utf-8")); } catch (e) {}
  hb.last_complete = u.complete !== false;
  hb.last_incomplete_reason = u.complete === false ? String(u.reason || "incomplet").slice(0, 200) : null;
  hb.last_status_ts = sysDateTime();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(hb, null, 2));
  return { ok: true, last_complete: hb.last_complete, last_incomplete_reason: hb.last_incomplete_reason };
}

// ── note : appende un snapshot d'analyse au timeline d'un trade ─────
// La routine appelle ceci pour CHAQUE trade open/pending géré -> historise
// l'évolution de la décision (keep/trail/exit) + score live entre les routines.
function cmd_note(input) {
  const u = typeof input === "string" ? JSON.parse(input) : input;
  if (!u.id) throw new Error("note: champ 'id' requis");
  const trades = load();
  const t = trades.find((x) => x.id === u.id);
  if (!t) throw new Error(`note: trade introuvable: ${u.id}`);
  const snap = {
    ts: sysDateTime(), // horloge système (discipline DATE)
    routine: u.routine || null,
    mark: u.mark != null ? Number(u.mark) : null,
    upnl: u.upnl != null ? Number(u.upnl) : null,
    decision: u.decision || "note",
    note: u.note || "",
  };
  if (u.score && u.score.components) {
    const lv = {
      entry: t.entry_actual ?? t.entry_planned ?? t.entry ?? (t.hypo && t.hypo.entry),
      sl: t.stop_loss ?? (t.hypo && t.hypo.sl),
      tp: (Array.isArray(t.take_profits) && t.take_profits[0] ? t.take_profits[0].px : undefined) ?? (t.hypo && t.hypo.tp),
    };
    snap.score = enrichScore(u.score, lv);
  } else {
    // Durci : un snapshot SANS score ne permet pas de suivre la décroissance du /14 en détention.
    console.error("[journal] SANS SCORE: note sans score.components -> on ne suit pas la décroissance du /14 sur ce trade. Ajouter score:{components,gate} (RE-évalué maintenant) à CHAQUE note (non bloquant).");
  }
  addSnapshot(t, snap);
  saveAll(trades);
  return { id: t.id, snapshots: t.timeline.length, decision: snap.decision };
}

// ── strategy-log : auto-documentation du raisonnement de l'orchestrateur ──
// Trace de DECISION (distincte de JOURNAL.md=trades, LESSONS.md=leçons, timeline=gestion).
// Append-only dans STRATEGY_LOG.md : sentiment, bull/bear case, decision, pourquoi, ajustements.
function cmd_strategy_log(input) {
  const { buildEntry } = require("./strategy-log.js");
  const u = typeof input === "string" ? JSON.parse(input) : (input || {});
  const obj = {
    date: u.date || sysDate(),                       // horloge système (discipline DATE) par défaut
    time: u.time || sysDateTime().slice(11, 16),
    sentiment: u.sentiment, bull_case: u.bull_case, bear_case: u.bear_case,
    decision: u.decision, why: u.why, adjustments: u.adjustments,
  };
  const file = path.join(DIR, "STRATEGY_LOG.md");
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, "# Strategy Log — agent-trader\n\n> Trace de raisonnement de l'orchestrateur (sentiment, bull/bear, decision, pourquoi). Append-only.\n", "utf8");
  }
  fs.appendFileSync(file, buildEntry(obj), "utf8");
  return { logged: true, date: obj.date, time: obj.time, decision: obj.decision || "no_trade", file: "trade-journal/STRATEGY_LOG.md" };
}

// ── score-eval : corrèle score/14, tier, composante, gate -> R réalisé ──
function cmd_score_eval() {
  const { evalScores, evalPerception } = require("./score.js");
  // PISTE PRODUCTION uniquement : le /14 a ete calibre sur les setups VALIDES. Les experiments
  // manuels (geometrie nouvelle) ont un /14->R different -> les inclure brouillerait la calibration.
  const all = load();
  const prod = all.filter((t) => tradeTrack(t) === "production");
  const nExp = all.filter((t) => tradeTrack(t) === "experiment" && t.status === "closed").length;
  const r = evalScores(prod);
  // by_perception : meme correlation mais sur le /14 PERCEPTION (deterministe, dispo ~14/14 opps).
  const byPerception = evalPerception(prod);
  return { ...r, by_perception: byPerception, _track: "production seulement", _experiments_exclus: nExp };
}

// ── slippage : friction live (slip d'entrée + frais) en R vs modèle backtest ──
// Valide l'hypothèse fondatrice "coût live ≈ coût modélisé" (FEE, B1 maker, EDGE).
// Piste 1. Observabilité (flag review), pas d'auto-action sur les EDGE tant que n<5.
function cmd_slippage() {
  const { analyzeSlippage } = require("./slippage.js");
  return analyzeSlippage(load());
}

// ── trade <id> : brief CONCIS d'un trade (Imp 1, suivi qualitatif) ──
// À lire AVANT de gérer un trade ouvert : fait fluer la thèse + invalidation + R + décroissance
// du /14 vers la décision -> continuité (la routine continue l'analyse au lieu de re-dériver).
function cmd_trade(id) {
  const { buildBrief } = require("./timeline.js");
  const t = load().find((x) => x.id === id);
  return buildBrief(t || null);
}

// ── review : synthèse hebdo (méta-apprentissage) -> flags actionnables ──
// Agrège stats (perf déclenchée) + scorecard (expectancy/setup) + score-eval (/14→R)
// + slippage (friction live) + non-déclenchés -> FLAGS (que faire). `review send` -> Telegram. E1.
async function cmd_review(arg) {
  const { reviewFlags, renderReview } = require("./review.js");
  const trades = load();
  const stats = cmd_stats(), scorecard = cmd_scorecard();
  const scoreEval = require("./score.js").evalScores(trades);
  const slippage = require("./slippage.js").analyzeSlippage(trades);
  const flags = reviewFlags(stats, scorecard, scoreEval, slippage, trades);
  const markdown = renderReview({ date: sysDate(), stats, scorecard, scoreEval, slippage, flags });
  let sent;
  if (arg === "send") { try { sent = await require("./notify.js")(markdown); } catch (e) { sent = false; } }
  return { date: sysDate(), flags, score_eval_n: scoreEval.n, triggered: stats.trades, sent, markdown };
}

// ── risk : circuit breaker portefeuille (drawdown / perte jour) ──────
async function cmd_risk() {
  const bybitDir = path.join(DIR, "..", "skills", "bybit");
  require(path.join(bybitDir, "index.js"));
  const ccxt = require(require.resolve("ccxt", { paths: [bybitDir] }));
  const c = new ccxt.bybit({
    apiKey: process.env.BYBIT_API_KEY, secret: process.env.BYBIT_API_SECRET,
    enableRateLimit: true, options: { defaultType: "swap", recvWindow: 10000, adjustForTimeDifference: true },
  });
  if (process.env.BYBIT_DEMO !== "0") c.enableDemoTrading(true);
  await c.loadTimeDifference();
  const bal = await c.fetchBalance();
  const equity = Number((bal.USDT && bal.USDT.total) || 0);

  const stateFile = path.join(DIR, "equity.json");
  let st = fs.existsSync(stateFile)
    ? JSON.parse(fs.readFileSync(stateFile, "utf-8"))
    : { high_water: equity, day: null, day_start: equity, history: [] };
  const today = sysDate(); // heure LOCALE (cohérence DATE projet) — la fenêtre perte-jour reset à minuit , comme le quota 3/jour (était UTC = incohérent)
  if (st.day !== today) { st.day = today; st.day_start = equity; }
  st.high_water = Math.max(st.high_water || equity, equity);
  st.history.push({ ts: new Date().toISOString(), equity });
  if (st.history.length > 1000) st.history = st.history.slice(-1000);
  fs.writeFileSync(stateFile, JSON.stringify(st, null, 2));

  const dailyLossPct = parseFloat(process.env.RM_DAILY_LOSS_PCT || "5");
  const maxDdPct = parseFloat(process.env.RM_MAX_DRAWDOWN_PCT || "10");
  const dailyPnlPct = st.day_start ? ((equity - st.day_start) / st.day_start) * 100 : 0;
  const ddPct = st.high_water ? ((st.high_water - equity) / st.high_water) * 100 : 0;
  // DEMO_ACTIVE (approved) : en DEMO on autorise le drawdown AU-DELA de 10% (trader activement pour
  // tester l'infra) -> le drawdown ne declenche pas le halt en demo. L'anti-martingale (sizing) reste
  // actif (la taille reduit toujours). Hors demo, le breaker drawdown re-arme normalement.
  const demoActive = process.env.DEMO_ACTIVE === "1";
  const reasons = [];   // => pilote halt (halt = reasons.length > 0)
  const notes = [];     // observabilite, ne declenche PAS le halt
  if (dailyPnlPct < -dailyLossPct) reasons.push(`Perte jour ${dailyPnlPct.toFixed(2)}% > seuil -${dailyLossPct}%`);
  if (ddPct > maxDdPct) {
    // En DEMO : le drawdown >10% est AUTORISE (note d'observabilite, pas un halt). Hors demo : halt.
    if (demoActive) notes.push(`[DEMO] Drawdown ${ddPct.toFixed(2)}% > ${maxDdPct}% AUTORISE en demo (halt leve ; sizing anti-martingale toujours actif)`);
    else reasons.push(`Drawdown ${ddPct.toFixed(2)}% > seuil ${maxDdPct}%`);
  }
  return {
    equity, day_start: +st.day_start.toFixed(2), high_water: +st.high_water.toFixed(2),
    daily_pnl_pct: +dailyPnlPct.toFixed(2), drawdown_pct: +ddPct.toFixed(2),
    halt: reasons.length > 0, reasons, notes,
  };
}

// ── reconcile : aligne le journal sur la VÉRITÉ Bybit ───────────────
// Bybit est la source de vérité. On (1) corrige le statut/PnL des trades du
// journal selon les positions/closed PnL réels, (2) crée les trades présents
// sur Bybit mais absents du journal (orphelins), (3) vérifie que le PnL réalisé
// du journal == celui de Bybit.
async function cmd_reconcile() {
  const bybitDir = path.join(DIR, "..", "skills", "bybit");
  require(path.join(bybitDir, "index.js"));
  const ccxt = require(require.resolve("ccxt", { paths: [bybitDir] }));
  const c = new ccxt.bybit({
    apiKey: process.env.BYBIT_API_KEY, secret: process.env.BYBIT_API_SECRET,
    enableRateLimit: true, options: { defaultType: "swap", recvWindow: 10000, adjustForTimeDifference: true },
  });
  if (process.env.BYBIT_DEMO !== "0") c.enableDemoTrading(true);
  await c.loadTimeDifference(); await c.loadMarkets();

  const closedRows = (((await c.privateGetV5PositionClosedPnl({ category: "linear", limit: 100 })).result) || {}).list || [];
  const positions = (await c.fetchPositions()).filter((p) => Math.abs(Number(p.contracts || 0)) > 0);
  const baseSym = (s) => String(s).toUpperCase().replace(/USDT.*$/, "").replace(/[^A-Z0-9]/g, "");
  const matchPx = (a, b) => Math.abs(Number(a) - Number(b)) < Math.max(1, Number(b) * 0.0015);

  // Ordres ouverts (limit au repos + conditionnels) : indispensables pour ne PAS
  // annuler a tort un 'pending' dont l'ordre limit n'est pas encore rempli.
  // ATTENTION (bug LTC 10.06) : fetchOpenOrders() SANS symbole est CAPE/pagine par Bybit
  // (~20 ordres). Avec plusieurs brackets (ex. ladder 4 rungs = ~14 ordres), les ordres d'un
  // AUTRE symbole peuvent etre TRONQUES de la page globale -> son pending serait annule a tort
  // ET ses conditionnels comptes comme orphelins (le ladder ASTER a ejecte la limite LTC @44.05).
  // On complete donc la page globale par un fetch CIBLE par symbole (non cape) pour chaque
  // symbole concerne (trades actifs au journal + positions + ceux vus dans la page globale).
  const ordersById = {};
  try { for (const o of await c.fetchOpenOrders()) ordersById[o.id] = o; } catch (e) {}
  const symbolsToCheck = new Set([
    ...load().filter((t) => ["open", "pending"].includes(t.status)).map((t) => baseSym(t.symbol)),
    ...positions.map((p) => baseSym(p.symbol)),
    ...Object.values(ordersById).map((o) => baseSym(o.symbol)),
  ].filter(Boolean));
  for (const sym of symbolsToCheck) {
    try { for (const o of await c.fetchOpenOrders(sym + "/USDT:USDT")) ordersById[o.id] = o; } catch (e) {}
  }
  const openOrders = Object.values(ordersById);

  // grouper les closed PnL par (symbol, entry) = un cycle de position
  const groups = {};
  for (const x of closedRows) {
    const entry = Number(x.avgEntryPrice);
    const key = baseSym(x.symbol) + "|" + entry.toFixed(2);
    const g = (groups[key] = groups[key] || { symbol: baseSym(x.symbol), entry, side: x.side === "Sell" ? "long" : "short", qty: 0, pnl: 0, fees: 0, exitW: 0, lastTs: 0 });
    g.qty += Number(x.qty); g.pnl += Number(x.closedPnl);
    g.fees += Number(x.openFee || 0) + Number(x.closeFee || 0);
    g.exitW += Number(x.avgExitPrice) * Number(x.qty); g.lastTs = Math.max(g.lastTs, Number(x.updatedTime));
  }
  const gl = Object.values(groups).map((g) => ({ ...g, avgExit: g.exitW / g.qty }));

  const report = { updated: [], orphans: [], cancelled: [], ladder_folds: [], ladder_partials: [] };
  const usedG = new Set(), usedP = new Set();

  // ── PRE-PASSE LADDERED (idempotente : RECOMPUTE depuis les fills Bybit, n'accumule pas) ──
  // Un trade `entry_mode:laddered` fille ses rungs a des prix DIFFERENTS -> Bybit cree
  // PLUSIEURS groupes closed-PnL. La boucle de matching exact (plus bas) n'en prendrait
  // qu'UN et orphelinerait le reste en `reconcile_orphan` -> R fragmente (cf. TAO 13.06 :
  // R1 +35.5 garde, R2/R3 -821 ejecte). Ici on RECLAME tous les groupes/la position d'un
  // ladder par enveloppe de rungs et on (re)construit le parent. INVARIANT D'IDEMPOTENCE :
  // on ne touche JAMAIS `entry_actual` (= l'ancre de l'enveloppe) ; l'entree melangee va
  // dans `avg_entry`. Sinon l'enveloppe se decale a chaque passe et re-orphelinise les rungs bas.
  const { aggregateGroups, claimLadderFills } = require("./reconcile-match.js");
  const handledLadder = new Set();
  for (const t of load()) {
    if (t.entry_mode !== "laddered" || !["open", "pending", "closed"].includes(t.status)) continue;
    const { groupIdx, posIdx } = claimLadderFills(t, gl, positions, usedG, usedP);
    if (!groupIdx.length && posIdx < 0) continue;   // pas encore fille -> la boucle gere le pending
    groupIdx.forEach((i) => usedG.add(i));
    if (posIdx >= 0) usedP.add(posIdx);
    handledLadder.add(t.id);
    const agg = groupIdx.length ? aggregateGroups(groupIdx.map((i) => gl[i])) : null;

    if (posIdx >= 0) {
      // position encore OUVERTE -> ladder EN COURS.
      const p = positions[posIdx];
      if (t.status !== "open" || Number(t.size) !== Number(p.contracts)) {
        cmd_set({ id: t.id, status: "open", size: Number(p.contracts), avg_entry: roundPx(Number(p.entryPrice)) });
        report.updated.push(`${t.id} -> open ${p.contracts}@${p.entryPrice} (ladder)`);
      }
      if (agg) {
        // des rungs ont ete stoppes/pris pendant que la these reste OUVERTE -> realized
        // PARTIEL attribue via une ligne enfant closed UPSERTEE (strategy du parent + parent_id
        // + is_partial) : la somme realisee reste juste, plus de `reconcile_orphan` fantome.
        const childId = `${t.id}-partial`;
        const net = +(agg.pnl - agg.fees).toFixed(4);
        const child = {
          id: childId, status: "closed", strategy: t.strategy, parent_id: t.id, is_partial: true,
          source: t.source || "bybit_reconcile", exchange: "bybit", mode: "demo",
          symbol: baseSym(t.symbol), side: t.side, size: +agg.qty.toFixed(4),
          entry_actual: roundPx(agg.entry), avg_exit: roundPx(agg.avgExit),
          realized_pnl: +agg.pnl.toFixed(4), fees: +agg.fees.toFixed(4), net_pnl: net,
          outcome: agg.pnl > 0 ? "win" : "loss", exit_reason: agg.pnl > 0 ? "take_profit" : "stop_loss",
          ts_close: new Date(agg.lastTs).toISOString(),
          review: `Rung(s) partiel(s) du ladder ${t.id} stoppes pendant que la these reste OUVERTE -> attribues (pas orphelin).`,
        };
        const exists = load().find((x) => x.id === childId);
        if (!exists) { cmd_log({ ...child, allow_backdate: true, ts_open: new Date(agg.lastTs - 3600000).toISOString() }); report.ladder_partials.push(`${childId} net=${net}`); }
        else if (Math.abs((exists.net_pnl ?? 0) - net) > 0.01) { cmd_set(child); report.ladder_partials.push(`${childId} net=${net} (maj)`); }
      }
      continue;
    }

    // pas de position -> ladder ENTIEREMENT CLOS : agrege tous ses groupes en UN trade clos.
    // Caveat aging : Bybit demo ne garde ~7j de closed PnL. La cloture totale est captee
    // par les 6 runs/j tant que les groupes sont frais -> agg complet. Si une cloture
    // partielle vieillit hors fenetre AVANT la cloture totale, son PnL survit dans le
    // child partiel (conserve tant que ses groupes sont visibles) ; ici on ne supprime le
    // child que lorsque ses groupes sont re-agreges dans le parent (meme fenetre).
    const net = +(agg.pnl - agg.fees).toFixed(4);
    if (t.status !== "closed" || Math.abs((t.net_pnl ?? 0) - net) > 0.01) {
      cmd_close({
        id: t.id, avg_entry: roundPx(agg.entry), avg_exit: roundPx(agg.avgExit),
        realized_pnl: +agg.pnl.toFixed(4), fees: +agg.fees.toFixed(4), net_pnl: net,
        size: +agg.qty.toFixed(4), outcome: agg.pnl > 0 ? "win" : "loss",
        exit_reason: agg.pnl > 0 ? "take_profit" : "stop_loss", ts_close: new Date(agg.lastTs).toISOString(),
      });
      report.ladder_folds.push(`${t.id} <- ${groupIdx.length} rung(s) -> net ${net}`);
    }
    // le child partiel (s'il existe) est desormais agrege dans le parent -> retirer pour
    // ne pas double-compter (ses groupes sont dans `agg`, fenetre commune).
    const childId = `${t.id}-partial`;
    if (load().find((x) => x.id === childId)) {
      saveAll(load().filter((x) => x.id !== childId));
      report.ladder_folds.push(`${childId} retire (agrege dans ${t.id})`);
    }
  }

  for (const t of load()) {
    if (handledLadder.has(t.id)) continue;          // ladder deja traite par la pre-passe
    if (!["open", "pending", "closed"].includes(t.status)) continue;
    const ref = t.entry_actual ?? t.entry_planned;
    const pi = positions.findIndex((p, i) => !usedP.has(i) && baseSym(p.symbol) === baseSym(t.symbol) && p.side === t.side && matchPx(p.entryPrice, ref));
    if (pi >= 0) {
      usedP.add(pi); const p = positions[pi];
      if (t.status !== "open" || Number(t.size) !== Number(p.contracts)) { cmd_set({ id: t.id, status: "open", entry_actual: Number(p.entryPrice), size: Number(p.contracts) }); report.updated.push(`${t.id} -> open ${p.contracts}@${p.entryPrice}`); }
      continue;
    }
    const gi = gl.findIndex((g, i) => !usedG.has(i) && g.symbol === baseSym(t.symbol) && g.side === t.side && matchPx(g.entry, ref));
    if (gi >= 0) {
      usedG.add(gi); const g = gl[gi]; const net = +(g.pnl - g.fees).toFixed(4);
      if (t.status !== "closed" || Math.abs((t.net_pnl ?? 0) - net) > 0.01) {
        cmd_close({ id: t.id, entry_actual: roundPx(g.entry), avg_exit: roundPx(g.avgExit), realized_pnl: +g.pnl.toFixed(4), fees: +g.fees.toFixed(4), net_pnl: net, size: +g.qty.toFixed(4), outcome: g.pnl > 0 ? "win" : "loss", exit_reason: g.pnl > 0 ? "take_profit" : "stop_loss", ts_close: new Date(g.lastTs).toISOString() });
        report.updated.push(`${t.id} -> closed net=${net} (qty ${g.qty.toFixed(4)})`);
      }
      continue;
    }
    if (t.status !== "closed") {
      // Garde-fou : ne PAS annuler un 'pending' dont l'ordre limit/conditionnel
      // est encore au repos sur Bybit (le fill n'a juste pas encore eu lieu).
      const ref2 = t.entry ?? t.entry_actual ?? t.entry_planned;
      const stillResting = t.status === "pending" && openOrders.some((o) =>
        baseSym(o.symbol) === baseSym(t.symbol) &&
        (matchPx(o.price, ref2) || matchPx(o.info && o.info.price, ref2) || matchPx(o.info && o.info.triggerPrice, ref2)));
      if (stillResting) continue; // pending vivant (ordre au repos) -> on garde tel quel
      cmd_set({ id: t.id, status: "cancelled", review: ((t.review || "") + " [reconcile: introuvable sur Bybit -> cancelled]").trim() });
      report.cancelled.push(t.id);
    }
  }

  // orphelins : groupes closed Bybit sans trade journal -> créer
  // (les groupes appartenant a un ladder ont DEJA ete claimes par la pre-passe
  //  laddered ci-dessus -> usedG : ils ne fragmentent plus en `reconcile_orphan`.)
  gl.forEach((g, i) => {
    if (usedG.has(i)) return;
    const net = +(g.pnl - g.fees).toFixed(4);
    const id = `bybit-${g.symbol}-${g.entry.toFixed(0)}-${String(g.lastTs).slice(-6)}`.toLowerCase();
    if (load().find((x) => x.id === id)) return;
    cmd_log({ id, allow_backdate: true, ts_open: new Date(g.lastTs - 3600000).toISOString(), ts_close: new Date(g.lastTs).toISOString(), status: "closed", strategy: "reconcile_orphan", source: "bybit_reconcile", exchange: "bybit", mode: "demo", symbol: g.symbol, side: g.side, size: +g.qty.toFixed(4), entry_actual: +g.entry.toFixed(2), avg_exit: +g.avgExit.toFixed(2), realized_pnl: +g.pnl.toFixed(4), fees: +g.fees.toFixed(4), net_pnl: net, outcome: g.pnl > 0 ? "win" : "loss", exit_reason: g.pnl > 0 ? "take_profit" : "stop_loss", review: "Trade Bybit absent du journal -> cree par reconcile (drift corrige)." });
    report.orphans.push(`${id} net=${net}`);
  });
  // orphelins : positions ouvertes Bybit sans trade journal
  // (les positions appartenant a un ladder ont DEJA ete claimees par la pre-passe.)
  positions.forEach((p, i) => {
    if (usedP.has(i)) return;
    const id = `bybit-open-${baseSym(p.symbol)}-${Number(p.entryPrice).toFixed(0)}`.toLowerCase();
    if (load().find((x) => x.id === id)) return;
    cmd_log({ id, allow_backdate: true, ts_open: sysDateTime(), status: "open", strategy: "reconcile_orphan", source: "bybit_reconcile", exchange: "bybit", mode: "demo", symbol: baseSym(p.symbol), side: p.side, size: Number(p.contracts), entry_actual: Number(p.entryPrice), review: "Position Bybit absente du journal -> creee par reconcile." });
    report.orphans.push(`${id} (open ${p.contracts}@${p.entryPrice})`);
  });

  // Ordres conditionnels ORPHELINS : sur un symbole sans position NI trade actif (open/pending)
  // au journal -> restes d'un trade clôturé (SL/TP frère non annulé, cf. bug BNB 02.06). FLAG-only
  // (pas d'auto-annulation : on n'annule jamais à l'aveugle ; la routine fait bybit_cancel_all <sym>).
  const { findOrphanOrders } = require("./bracket-check.js");
  const activeSymbols = load().filter((t) => ["open", "pending"].includes(t.status)).map((t) => t.symbol);
  const orphanOrders = findOrphanOrders(openOrders, positions.map((p) => p.symbol), activeSymbols);

  // Bybit demo ne garde que ~7j d'historique closed PnL -> comparer la même fenêtre.
  const cutoff = Date.now() - 7.5 * 24 * 3600 * 1000;
  const bybitReal = +gl.reduce((s, g) => s + (g.pnl - g.fees), 0).toFixed(2);
  const closed = load().filter((t) => t.status === "closed");
  const journalReal7d = +closed.filter((t) => t.ts_close && new Date(t.ts_close).getTime() > cutoff).reduce((s, t) => s + (t.net_pnl ?? 0), 0).toFixed(2);
  const journalRealAll = +closed.reduce((s, t) => s + (t.net_pnl ?? 0), 0).toFixed(2);
  const fixed = report.updated.length + report.orphans.length + report.cancelled.length;
  return {
    aligned: true, fixed, ...report,
    orphan_orders: orphanOrders,
    bybit_realized_7d: bybitReal, journal_realized_7d: journalReal7d, journal_realized_all: journalRealAll,
    note: "Journal aligne sur la verite Bybit. Tout ecart de somme = trades >7j que Bybit demo a oublies (retention 7j) mais que le journal conserve."
      + (orphanOrders.length ? ` ⚠️ ORDRES ORPHELINS (symbole flat, hors journal actif): ${orphanOrders.map((o) => o.symbol + "×" + o.count).join(", ")} -> annuler via 'node skills/bybit/index.js bybit_cancel_all <symbol>'.` : ""),
  };
}

// ── exposure : cap de corrélation (crypto = beta BTC) ───────────────
function cmd_exposure() {
  const all = load();
  const liveTrades = all.filter((t) => t.status === "open");      // capital DEPLOYE (vrai risque)
  const pendTrades = all.filter((t) => t.status === "pending");   // armes (zero risque tant que non rempli)
  const active = [...liveTrades, ...pendTrades];
  const bySide = { long: [], short: [] };
  active.forEach((t) => { (bySide[t.side] = bySide[t.side] || []).push(t.symbol); });
  const cap = parseInt(process.env.CORR_MAX_SAME_SIDE || "3", 10);     // legacy compte same-side (info)
  const maxLive = parseInt(process.env.RM_MAX_LIVE || "5", 10);        // positions REMPLIES simultanees
  const maxActive = parseInt(process.env.RM_MAX_ACTIVE || "8", 10);    // live + pending (armes)
  const longN = (bySide.long || []).length, shortN = (bySide.short || []).length;
  // RISQUE AGRÉGÉ par sens = LE garde-fou (mesure 10.06 : correl 4H vs BTC 0.70, 49% des bars en chute
  // groupee -> les memes-sens fillent ENSEMBLE dans un dump). Le cap sur le COMPTE ne protege pas d'un
  // mass-fill correle ; seul le risque-si-tout-fille <= X%/sens le borne. On somme size*|entry-SL|/equity.
  const equity = _equityState().equity;
  // Risque d'un trade = `risk_usd` si present (LADDER : vrai risque budgete = somme par rung, evite la
  // surestimation +51% de size_totale x distance(T1->SL) — T1 est le rung le plus LOIN du SL) ; sinon
  // calcul standard size x |entry-SL|. (fix audit 10.06)
  const tradeRiskUsd = (t) => {
    if (t.risk_usd != null && isFinite(Number(t.risk_usd))) return Number(t.risk_usd);
    const e = t.entry_actual ?? t.entry_planned ?? t.entry, sl = t.stop_loss;
    return (e != null && sl != null && t.size) ? Math.abs(e - sl) * t.size : 0;
  };
  const sideRisk = (side) => {
    if (!equity) return null;
    let r = 0;
    for (const t of active.filter((x) => x.side === side)) r += tradeRiskUsd(t) / equity * 100;
    return +r.toFixed(2);
  };
  const maxSidePct = parseFloat(process.env.RM_MAX_SIDE_RISK_PCT || "12");
  const maxTotalPct = parseFloat(process.env.RM_MAX_TOTAL_RISK_PCT || "18"); // (fix audit c) cap book total (long+short)
  const longRisk = sideRisk("long"), shortRisk = sideRisk("short");
  const totalRisk = (longRisk != null && shortRisk != null) ? +(longRisk + shortRisk).toFixed(2) : null;
  const liveN = liveTrades.length, activeN = active.length;
  // can_add = il reste de la place pour ARMER un pending (le live se borne par annulation dynamique au fill) :
  //   (1) total actif < maxActive ET (2) risque agrege du sens < cap% ET (3) risque TOTAL book < cap total%.
  const canAdd = (sideRiskVal) => activeN < maxActive && (sideRiskVal == null || sideRiskVal < maxSidePct) && (totalRisk == null || totalRisk < maxTotalPct);
  // by_class : risque agrege par classe d'actif (crypto/commodity/etf/equity). Or & ETF sont
  // DECORRELES de la crypto -> peuvent tourner en parallele sans le wash corr-0.70 same-side.
  const U = require("./universe.js");
  const byClass = U.classBreakdown(active, (t) => U.classOf(t.symbol), (t) => (equity ? tradeRiskUsd(t) / equity * 100 : 0));
  return {
    open_pending: activeN,
    live: { n: liveN, pairs: liveTrades.map((t) => t.symbol) },
    pending: { n: pendTrades.length, pairs: pendTrades.map((t) => t.symbol) },
    long: { n: longN, pairs: bySide.long || [], risk_pct: longRisk },
    short: { n: shortN, pairs: bySide.short || [], risk_pct: shortRisk },
    cap_same_side: cap, max_live: maxLive, max_active: maxActive, max_side_risk_pct: maxSidePct, max_total_risk_pct: maxTotalPct,
    total_risk_pct: totalRisk,
    by_class: byClass,
    live_full: liveN >= maxLive,
    can_add_long: canAdd(longRisk), can_add_short: canAdd(shortRisk),
    risk_warning: (longRisk != null && longRisk > maxSidePct) ? `LONG risque agrege ${longRisk}% > ${maxSidePct}% -> ne pas ajouter`
      : (shortRisk != null && shortRisk > maxSidePct) ? `SHORT risque agrege ${shortRisk}% > ${maxSidePct}% -> ne pas ajouter` : null,
    total_warning: (totalRisk != null && totalRisk > maxTotalPct) ? `RISQUE TOTAL book ${totalRisk}% > ${maxTotalPct}% -> ne plus rien ajouter (les 2 sens cumules)` : null,
    live_warning: liveN >= maxLive ? `LIVE plein (${liveN}/${maxLive}) -> au prochain fill, annuler le pending same-side le plus faible (pruning gratuit) ; NE JAMAIS annuler les rungs d'un trade deja partiellement live (entree en cours)` : null,
    note: `Le cap = le RISQUE AGREGE (<=${maxSidePct}%/sens, <=${maxTotalPct}% book), PAS le compte. Pending<=${maxActive} (armes, zero risque) DECOUPLE de live<=${maxLive}. Un trade laddered = 1 THESE = 1 unite de risque (risk_usd = vrai max somme par rung), ses 3 rungs ne sont PAS 3 trades et doivent toujours pouvoir filler. Mass-fill correle (beta BTC 0.70) -> risque agrege borne le fill groupe.`,
  };
}

// ── size : taille par risque (% equity / distance au SL) ────────────
async function cmd_size(input) {
  const u = typeof input === "string" ? JSON.parse(input) : input;
  const entry = Number(u.entry), sl = Number(u.stop_loss), tier = u.tier || "A";
  const bybitDir = path.join(DIR, "..", "skills", "bybit");
  require(path.join(bybitDir, "index.js"));
  const ccxt = require(require.resolve("ccxt", { paths: [bybitDir] }));
  const c = new ccxt.bybit({ apiKey: process.env.BYBIT_API_KEY, secret: process.env.BYBIT_API_SECRET, enableRateLimit: true, options: { defaultType: "swap", recvWindow: 10000, adjustForTimeDifference: true } });
  if (process.env.BYBIT_DEMO !== "0") c.enableDemoTrading(true);
  await c.loadTimeDifference();
  const equity = Number(((await c.fetchBalance()).USDT || {}).total || 0);
  // Tier D = DATA-MODE (labo demo, 10.06) : risque reduit pour les trades EXPLORATOIRES -> beaucoup
  // plus de trades concurrents sous les memes caps -> calibration (score-eval/slippage/regime) se
  // remplit vite. En demo le P&L est faux, c'est le COUNT d'outcomes resolus qui compte. A/B inchanges.
  const riskBase = tier === "D" ? parseFloat(process.env.RM_RISK_PCT_D || "0.75")
    : tier === "B" ? parseFloat(process.env.RM_RISK_PCT_B || "0.5")
    : parseFloat(process.env.RM_RISK_PCT_A || "1");
  // A2 SIZING PAR EDGE (Kelly-lite) : on RÉDUIT le risque sur les edges marginaux (MR4/S1/S3),
  // plein sur les forts (S5/MR8). `edge` = multiplicateur EDGE du setup (scan.js, basé NET de frais).
  // Strictement <= riskBase (garde le 5% max pour les meilleurs edges).
  const { computeSize, edgeScale, drawdownScale } = require("./sizing.js");
  const eScale = edgeScale(u.edge != null ? Number(u.edge) : null);
  // PISTE 3 — drawdown-scaled sizing (anti-martingale) : réduit le risque à l'approche du
  // breaker. Lit le high_water maintenu par cmd_risk (equity.json) ; sans état -> dd 0 -> neutre.
  let ddPct = 0;
  try {
    const st = JSON.parse(fs.readFileSync(path.join(DIR, "equity.json"), "utf-8"));
    const hw = Math.max(Number(st.high_water) || equity, equity);
    ddPct = hw > 0 ? +(((hw - equity) / hw) * 100).toFixed(2) : 0;
  } catch (e) { ddPct = 0; }
  const ddScale = drawdownScale(ddPct);
  const riskPct = +(riskBase * eScale * ddScale).toFixed(3);
  // Clamp de levier (active RM_MAX_LEVERAGE) : garde le risque% comme cible, plafonne le levier
  // sur un SL serré (sinon notional explose -> liquidation possible AVANT le SL). Cf. sizing.js.
  const maxLeverage = parseFloat(process.env.RM_MAX_LEVERAGE || "0");
  const r = computeSize({ equity, entry, sl, riskPct, maxLeverage });
  return {
    tier, risk_pct_base: riskBase, edge: u.edge ?? null, edge_scale: eScale,
    drawdown_pct: ddPct, dd_scale: ddScale, risk_pct: riskPct, equity: +equity.toFixed(2),
    entry, stop_loss: sl, sl_distance: r.sl_distance, size: r.size,
    notional: r.notional, leverage: r.leverage, max_leverage: maxLeverage || null,
    risk_usd: r.risk_usd, risk_pct_effective: r.risk_pct_effective,
    clamped: r.clamped, clamp_reasons: r.reasons,
    note: (eScale < 1 ? `EDGE marginal (x${u.edge}) -> risque réduit (Kelly-lite x${eScale}). ` : "")
      + (ddScale < 1 ? `DRAWDOWN ${ddPct}% -> risque réduit x${ddScale} (anti-martingale, atterrissage avant breaker). ` : "")
      + (r.clamped
        ? `SIZE PLAFONNÉE (${r.reasons.join("; ")}) -> risque effectif ${r.risk_pct_effective}% < cible ${riskPct}%.`
        : `size = (equity*risk% net)/|entry-SL| (base ${riskBase}% -> ${riskPct}%) ; levier OK.`),
  };
}

// ── verify-bracket : un bracket a-t-il bien atterri sur Bybit ? ─────
// Lit position + ordres stop réels, classe SL vs TP (trigger vs entrée/sens),
// compare à l'intention. Détecte position nue / SL oversize / fill partiel / TP
// manquants (cf. bracket-check.js). À appeler APRÈS un place_bracket.
// ── sl-check : SL anti-sweep, OBLIGATOIRE AVANT de poser un bracket ──
// (10.06, finding the maintainer — cas HYPE SL 55.50 vs low 55.455). Fetch 4H, calcule
// l'ATR(14) + l'extrême récent, et vérifie via bracket-check.checkSlPlacement
// que le SL est AU-DELÀ des mèches avec buffer >= 0.3xATR. Renvoie suggested_sl
// si ko. + Alerte géométrie : dist SL < 1xATR = suspect (MR8 validé = 1.5xATR).
// Usage : node trade-journal/journal.js sl-check '{"symbol":"HYPE","side":"long","entry":56.75,"stop_loss":54.75}'
async function cmd_sl_check(input) {
  const u = typeof input === "string" ? JSON.parse(input) : input;
  const { checkSlPlacement } = require("./bracket-check.js");
  const sym = String(u.symbol || "").includes("/") ? u.symbol : `${u.symbol}/USDT:USDT`;
  const bybitDir = path.join(DIR, "..", "skills", "bybit");
  require(path.join(bybitDir, "index.js"));
  const ccxt = require(require.resolve("ccxt", { paths: [bybitDir] }));
  const c = new ccxt.bybit({ enableRateLimit: true, options: { defaultType: "swap" } });
  if (process.env.BYBIT_DEMO !== "0") c.enableDemoTrading(true);
  const oh = await c.fetchOHLCV(sym, "4h", undefined, 45);
  if (!oh || oh.length < 20) return { ok: null, reason: "OHLCV insuffisant" };
  const H = oh.map((x) => x[2]), L = oh.map((x) => x[3]), C = oh.map((x) => x[4]);
  let atr = 0; for (let i = oh.length - 14; i < oh.length; i++) atr += Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1])); atr /= 14;
  const r = checkSlPlacement({ side: u.side, stop_loss: u.stop_loss, highs: H, lows: L, atr });
  const entry = Number(u.entry || u.entry_planned);
  // Géométrie = ÉCHEC DUR depuis le 10.06 (post flash-sweep HYPE : dist 0.85xATR n'était qu'un
  // warn -> perdu -0.30R). Floor PAR FAMILLE si `setup` est passé (approved 10.06, option A :
  // l'exemption R:R>=2 des MR est conditionnelle à leur géométrie validée -> MR8 2.5x, S5/MR4 2x,
  // S1 1.5x, tolérance 0.85) ; sinon floor universel 1xATR.
  const { checkSlGeometry, validatedSlFloor } = require("./bracket-check.js");
  const floor = validatedSlFloor(u.setup);
  const geo = checkSlGeometry({ entry, stop_loss: u.stop_loss, atr, min_dist_atr: floor });
  const ok = r.ok === false ? false : geo.ok === false ? false : r.ok;
  return { ...r, ok, atr: +atr.toFixed(6), px: C[C.length - 1], dist_atr: geo.dist_atr ?? null,
    geometry_ok: geo.ok, geometry_floor_atr: floor, setup_family: u.setup || null,
    geometry_warn: geo.ok === false ? geo.msg : null,
    rule: "SL au-dela des MECHES du niveau evident, buffer >= 0.3xATR, ET dist SL >= floor de la famille (MR8 2.5x / S5,MR4 2x / S1 1.5x, x0.85 tolerance ; 1xATR si famille inconnue). MR exemptes de R:R>=2 UNIQUEMENT a geometrie validee (approved 10.06) ; TP MR = ~geometrie (1:1 / 2xATR), pas une zone lointaine." };
}

async function cmd_verify_bracket(input) {
  const u = typeof input === "string" ? JSON.parse(input) : input;
  const { verifyBracket, classifyStops } = require("./bracket-check.js");
  const sym = String(u.symbol || "").includes("/") ? u.symbol : `${u.symbol}/USDT:USDT`;
  const bybitDir = path.join(DIR, "..", "skills", "bybit");
  require(path.join(bybitDir, "index.js"));
  const ccxt = require(require.resolve("ccxt", { paths: [bybitDir] }));
  const c = new ccxt.bybit({ apiKey: process.env.BYBIT_API_KEY, secret: process.env.BYBIT_API_SECRET, enableRateLimit: true, options: { defaultType: "swap", recvWindow: 10000, adjustForTimeDifference: true } });
  if (process.env.BYBIT_DEMO !== "0") c.enableDemoTrading(true);
  await c.loadTimeDifference();
  await c.loadMarkets();
  const positions = await c.fetchPositions([sym]).catch(() => []);
  const p = (positions || []).find((x) => Number(x.contracts) > 0);
  const position = p ? { size: Number(p.contracts), side: p.side, entry: Number(p.entryPrice) } : null;
  let stops = [];
  try { stops = await c.fetchOpenOrders(sym, undefined, undefined, { orderFilter: "StopOrder" }); } catch (e) {}
  const trig = (o) => Number(o.triggerPrice || (o.info && o.info.triggerPrice) || 0);
  const entry = position ? position.entry : Number(u.entry || u.entry_planned || 0);
  const side = u.side || (position && position.side);
  // Prix courant -> classification SL/TP ROBUSTE AU TRAILING (un SL trailé en profit, sous
  // l'entrée pour un short, ne doit PAS être classé TP -> faux "position nue"). cf. bracket-check.classifyStops.
  let market = 0;
  try { const tk = await c.fetchTicker(sym); market = Number(tk && tk.last) || 0; } catch (e) {}
  const norm = stops.map((o) => ({
    trigger: trig(o),
    amount: Number(o.amount || (o.info && o.info.qty) || 0),
    triggerDirection: Number((o.info && o.info.triggerDirection) || o.triggerDirection || 0),
  }));
  const { slOrders, tpOrders } = classifyStops(norm, { side, entry, market });
  const intended = { side, size: Number(u.size), stop_loss: Number(u.stop_loss), take_profits: u.take_profits || [] };
  const res = verifyBracket(intended, { position, slOrders, tpOrders });
  return { symbol: u.symbol, ...res, position, sl_orders: slOrders.length, tp_orders: tpOrders.length };
}

// ── monitor-tick (F3.3, 19.06) : MONITORING ENTRE LES ROUTINES (cadence ~20-30 min, sans LLM).
// READ-ONLY : fetch positions + SL server-side -> needsAttention (NUE/STALE) + planMonitoring
// (flipped/mature/set_trailing si scan-latest frais). ALERTE-ONLY par defaut (Telegram) : ferme
// l'angle mort 4h (une position NUE est detectee en ~30 min au lieu de 4h). AUCUN ordre place
// (MONITOR_TICK_AUTO non implemente = approved requis pour l'auto-execution). Persiste monitor-state.json.
async function cmd_monitor_tick() {
  const { planMonitoring, needsAttention, summarize, loadState, saveState } = require("./monitor.js");
  const { classifyStops } = require("./bracket-check.js");
  const bybitDir = path.join(DIR, "..", "skills", "bybit");
  require(path.join(bybitDir, "index.js"));
  const ccxt = require(require.resolve("ccxt", { paths: [bybitDir] }));
  const c = new ccxt.bybit({ apiKey: process.env.BYBIT_API_KEY, secret: process.env.BYBIT_API_SECRET, enableRateLimit: true, options: { defaultType: "swap", recvWindow: 10000, adjustForTimeDifference: true } });
  if (process.env.BYBIT_DEMO !== "0") c.enableDemoTrading(true);
  await c.loadTimeDifference(); await c.loadMarkets();
  const baseSym = (s) => String(s).toUpperCase().replace(/USDT.*$/, "").replace(/[^A-Z0-9]/g, "");
  const live = (await c.fetchPositions()).filter((p) => Math.abs(Number(p.contracts || 0)) > 0);
  const active = load().filter((t) => ["open", "pending"].includes(t.status));
  const findActive = (sym, side) => active.find((t) => baseSym(t.symbol) === baseSym(sym) && t.side === side) || null;

  const monPos = [];
  for (const p of live) {
    const sym = baseSym(p.symbol); const side = p.side === "short" ? "short" : "long";
    const entry = Number(p.entryPrice || (p.info && p.info.avgPrice) || 0);
    const mark = Number(p.markPrice || (p.info && p.info.markPrice) || 0);
    let stops = [];
    try { stops = await c.fetchOpenOrders(sym + "/USDT:USDT", undefined, undefined, { orderFilter: "StopOrder" }); } catch (e) {}
    const norm = stops.map((o) => ({ trigger: Number(o.triggerPrice || (o.info && o.info.triggerPrice) || 0), amount: Number(o.amount || (o.info && o.info.qty) || 0), triggerDirection: Number((o.info && o.info.triggerDirection) || o.triggerDirection || 0) }));
    const { slOrders } = classifyStops(norm, { side, entry, market: mark });
    const t = findActive(sym, side);
    monPos.push({ id: t ? t.id : sym, symbol: sym, side, status: "open", entry, entry_actual: entry, px: mark,
      stop_loss: t ? t.stop_loss : null, take_profits: t ? t.take_profits : null, strategy: t ? t.strategy : null,
      sl_orders: slOrders.length, has_sl: slOrders.length > 0 });
  }

  // verdicts thesis (flipped/mature/running) SI scan-latest frais (sinon keep -> jamais destructeur)
  let verdicts = [];
  try {
    const scan = JSON.parse(fs.readFileSync(path.join(DIR, "scan-latest.json"), "utf8"));
    const ageMin = scan.ts ? (Date.now() - Date.parse(scan.ts)) / 60000 : 1e9;
    if (ageMin < (process.env.MONITOR_SCAN_MAX_AGE_MIN ? +process.env.MONITOR_SCAN_MAX_AGE_MIN : 360)) {
      verdicts = require("./thesis.js").thesisHealth(monPos, scan.all || scan.opportunities || [], scan.market || {}).positions || [];
    }
  } catch (e) {}

  const now = Date.now(); const state = loadState();
  const att = needsAttention({ positions: monPos, state, now });
  const res = planMonitoring({ verdicts, positions: monPos, state, now });
  saveState(res.newState);

  const actionable = res.plans.filter((pl) => ["place_sl", "take_partial_be", "take_partial_lock", "set_trailing"].includes(pl.action));
  const lines = [];
  if (res.criticals.length) lines.push("CRITIQUE position NUE (pas de SL): " + res.criticals.map((x) => x.symbol).join(", "));
  if (res.stale.length) lines.push("STALE (non gere): " + res.stale.map((s) => s.symbol + " " + s.gap_h + "h").join(", "));
  for (const pl of actionable) if (!res.criticals.find((x) => x.id === pl.id)) lines.push(pl.symbol + " " + pl.verdict + " -> " + pl.action);
  const alert = att.alert || res.criticals.length > 0 || actionable.length > 0;
  const summary = summarize(res);

  let notified = false;
  if (alert && process.env.MONITOR_TICK_NOTIFY !== "0") {
    try { notified = !!(await require("./notify.js")("MONITOR-TICK (entre routines)\n" + lines.join("\n") + "\n" + summary)); } catch (e) {}
  }
  return { ok: true, n: monPos.length, alert, criticals: res.criticals, stale: res.stale, actionable: actionable.length, notified, summary, plans: res.plans, auto_exec: false };
}

// ── preflight : GATE DETERMINISTE pre-bracket (11.06, pattern OpenAlice/UTA) ──────
// UN SEUL appel a lancer AVANT chaque bybit_place_limit_bracket. Agrege en un verdict
// ALLOW/BLOCK tous les garde-fous NON negociables qui etaient eparpilles dans la SOP et
// appeles a la main (le LLM pouvait en oublier un) : SL obligatoire + geometrie SL
// (anti-sweep, floor par famille) + R:R>=2 (tendance) + circuit breaker + quota/j +
// exposition agregee. Ne change AUCUN seuil. Assemble le contexte reel ici (reseau pour
// l'ATR via sl-check ; offline pour breaker/quota/exposition) puis delegue au module PUR
// guards.js. `ok:false` -> NE PAS poser le bracket (lire `blocks[]` pour les raisons).
// Usage : node trade-journal/journal.js preflight '{"symbol":"BTC","side":"long","setup":"S1_MTF","entry":..,"stop_loss":..,"take_profits":[{"px":..},{"px":..}]}'
async function cmd_preflight(input) {
  const order = typeof input === "string" ? JSON.parse(input) : input;
  const { runGuards } = require("./guards.js");
  // 1) Geometrie LIVE (reseau) : reutilise sl-check pour obtenir l'ATR 4H + son verdict.
  let slc = null;
  try {
    slc = await cmd_sl_check({ symbol: order.symbol, side: order.side, entry: order.entry ?? order.entry_planned, stop_loss: order.stop_loss, setup: order.setup });
  } catch (e) { slc = { ok: null, reason: `sl-check indisponible: ${e && e.message}` }; }
  // 2) Circuit breaker (offline, lu de equity.json maintenu par cmd_risk).
  const equityState = _equityState();
  // 3) Quota du jour (offline) : trades NON-test pris aujourd'hui (open/pending/closed).
  const today = sysDate();
  const todayCount = load().filter((t) =>
    String(t.ts_open || "").slice(0, 10) === today &&
    ["open", "pending", "closed"].includes(t.status) &&
    !isTestTrade(t)).length;
  // 4) Exposition agregee par sens (offline).
  const exposure = cmd_exposure();
  const ctx = { atr: slc && slc.atr, equityState, todayCount, exposure };
  const res = runGuards(order, ctx);
  return {
    ...res,
    context: {
      atr: (slc && slc.atr) ?? null,
      breaker_halt: !!equityState.halt,
      today_count: todayCount,
      can_add_long: exposure.can_add_long,
      can_add_short: exposure.can_add_short,
    },
    sl_check: slc,
  };
}

// ── dashboard : courbe d'équité + scorecard + positions -> DASHBOARD.md
function cmd_dashboard() {
  const st = fs.existsSync(path.join(DIR, "equity.json")) ? JSON.parse(fs.readFileSync(path.join(DIR, "equity.json"), "utf-8")) : null;
  const sc = cmd_scorecard();
  const open = load().filter((t) => ["open", "pending"].includes(t.status));
  let md = "# 📊 Dashboard — agent-trader\n\n> Auto-généré (`journal.js dashboard`).\n\n";
  if (st && st.history && st.history.length) {
    const eqs = st.history.map((h) => h.equity);
    const last = eqs[eqs.length - 1], min = Math.min(...eqs), max = Math.max(...eqs);
    const hw = st.high_water || max;
    const blocks = "▁▂▃▄▅▆▇█";
    const spark = eqs.slice(-60).map((e) => blocks[Math.min(7, Math.floor((max - min ? (e - min) / (max - min) : 0.5) * 8))]).join("");
    md += "## Équité\n";
    md += `- Actuelle : **${last.toFixed(2)} USDT** · Net : **${last - 50000 >= 0 ? "+" : ""}${(last - 50000).toFixed(2)}** (départ 50 000)\n`;
    md += `- High-water : ${hw.toFixed(2)} · Drawdown actuel : ${(((hw - last) / hw) * 100).toFixed(2)} %\n`;
    md += `- Courbe (${eqs.length} pts) : \`${spark}\`\n\n`;
  } else md += "_Pas encore d'historique d'équité._\n\n";
  md += "## Scorecard par setup\n\n| Setup | n | Win% | Expectancy | R moy | Verdict |\n|---|---|---|---|---|---|\n";
  sc.setups.forEach((s) => { md += `| ${s.setup} | ${s.n} | ${s.win_rate}% | ${s.expectancy} | ${s.avg_r ?? "—"} | ${s.verdict} |\n`; });
  md += `\n## Positions actives (${open.length})\n`;
  open.forEach((t) => { md += `- **${t.status}** ${t.side} ${t.symbol} ${t.size || ""} @ ${t.entry_actual || t.entry_planned} (SL ${t.stop_loss}) — ${t.strategy}\n`; });
  // Section instrumentation /14 (additif). Affiche les corrélations dès qu'il y a du n.
  try {
    const se = require("./score.js").evalScores(load());
    md += "\n## 🎯 Score /14 → résultat (instrumentation)\n\n";
    if (!se.n) {
      md += "_Pas encore de trade clôturé porteur d'un bloc `score` — se remplit en forward-test._\n";
    } else {
      md += `Trades scorés clôturés : **${se.n}**\n\n`;
      md += "| Bucket /14 | n | WR | R moyen |\n|---|---|---|---|\n";
      for (const k of ["12+", "9-11", "6-8", "<6"]) {
        const b = se.by_bucket[k]; if (b) md += `| ${k} | ${b.n} | ${b.win_rate ?? "—"}% | ${b.avg_r ?? "—"} |\n`;
      }
      md += "\n| Gate | n | WR | R moyen |\n|---|---|---|---|\n";
      md += `| passed | ${se.by_gate.passed.n} | ${se.by_gate.passed.win_rate ?? "—"}% | ${se.by_gate.passed.avg_r ?? "—"} |\n`;
      md += `| blocked | ${se.by_gate.blocked.n} | ${se.by_gate.blocked.win_rate ?? "—"}% | ${se.by_gate.blocked.avg_r ?? "—"} |\n`;
      md += "\n_Gate→outcome counterfactuel (no-trades bloqués) : `node trade-journal/notrade-eval.js`._\n";
    }
  } catch (e) { /* section optionnelle : ne jamais casser le dashboard */ }
  fs.writeFileSync(path.join(DIR, "DASHBOARD.md"), md);
  return { dashboard: "DASHBOARD.md", equity: st && st.history ? st.history[st.history.length - 1].equity : null, setups: sc.setups.length, open: open.length };
}

// ── report : génère JOURNAL.md ──────────────────────────────────────
function cmd_report() {
  const trades = load();
  const s = cmd_stats();
  let md = "# 📒 Journal de trading — agent-trader\n\n";
  md += "> Auto-généré par `journal.js report`. **Lire AVANT toute décision de trade** (avec `LESSONS.md`).\n\n";
  md += "## Stats globales\n";
  md += `- Clôturés : **${s.trades}** · Ouverts : ${s.open} · Win rate : **${s.win_rate}%** · PnL net : **${s.net_pnl} USDT** · R moyen : **${s.avg_r ?? "—"}**\n\n`;
  md += "### Par stratégie\n\n| Stratégie | Trades | Win | PnL net (USDT) |\n|---|---|---|---|\n";
  for (const [k, v] of Object.entries(s.by_strategy)) md += `| ${k} | ${v.n} | ${v.wins}/${v.n} | ${v.pnl.toFixed(2)} |\n`;
  md += "\n## Trades (récents en premier)\n\n";
  for (const t of [...trades].reverse()) {
    const badge = t.status === "closed" ? ((t.net_pnl ?? 0) > 0 ? "✅ WIN" : "❌ LOSS")
      : t.status === "pending" ? "⏳ PENDING (limit au repos)"
      : t.status === "cancelled" ? "🚫 CANCELLED"
      : t.status === "no_trade" ? "⚪ NO-TRADE (décision documentée)"
      : t.status === "planned" ? "🎯 PLANNED (à exécuter sur déclencheur)" : "🟢 OPEN";
    md += `### ${t.id} — ${badge}\n`;
    const when = fmtTime(t.ts_open);
    if (when) md += `- 🕒 ${when}${t.ts_close ? ` → clôture ${fmtTime(t.ts_close)}` : ""}\n`;
    md += `- ${t.exchange}/${t.mode} · **${t.side} ${t.symbol}** ${t.size} · entrée ${t.entry_actual ?? t.entry_planned} · SL ${t.stop_loss}\n`;
    if (t.take_profits) md += `- TP : ${t.take_profits.map((x) => x.px).join(" / ")}\n`;
    if (t.status === "closed") md += `- sortie moy ${t.avg_exit} · PnL net **${t.net_pnl} USDT** · R **${t.r_multiple ?? "—"}** · ${t.exit_reason || t.outcome}\n`;
    if (t.rationale) md += `- 💭 **Rationale** : ${t.rationale}\n`;
    if (t.review) md += `- 🔎 **Review** : ${t.review}\n`;
    const hasPage = (Array.isArray(t.timeline) && t.timeline.length) || ["open", "pending"].includes(t.status);
    if (hasPage) md += `- 📄 [story (timeline)](trades/${t.id}.md)${Array.isArray(t.timeline) ? ` · ${t.timeline.length} snapshot(s)` : ""}\n`;
    md += "\n";
  }
  fs.writeFileSync(path.join(DIR, "JOURNAL.md"), md);

  // Pages par trade (vue générée, gitignorée) : story d'un trade géré dans le temps.
  const tradesDir = path.join(DIR, "trades");
  fs.mkdirSync(tradesDir, { recursive: true });
  let pages = 0;
  for (const t of trades) {
    if ((Array.isArray(t.timeline) && t.timeline.length) || ["open", "pending"].includes(t.status)) {
      fs.writeFileSync(path.join(tradesDir, `${t.id}.md`), renderTradePage(t));
      pages++;
    }
  }
  // Warn doux : trades open/pending non notés aujourd'hui (timeline trouée).
  const today = sysDate();
  for (const s of staleOpen(trades, today)) {
    console.error(`[journal] TIMELINE: trade ${s.id} (open/pending) sans snapshot aujourd'hui -> 'journal.js note' pour historiser la gestion (non bloquant).`);
  }
  return { report: "JOURNAL.md", trades: trades.length, pages };
}

// ── exports (pour les tests offline ; n'affecte PAS le CLI) ─────────
module.exports = { tradeTrack, tradeOrigin, isTestTrade, ORIGINS, CATALOG_SETUP, computeRMultiple, roundPx, cmd_manage_check };

// ── dispatcher (CLI uniquement : ne tourne PAS quand le module est require()) ──
const [, , cmd, arg] = process.argv;
if (require.main === module) (async () => {
  let out;
  if (cmd === "log") out = cmd_log(arg);
  else if (cmd === "set") out = cmd_set(arg);
  else if (cmd === "close") out = cmd_close(arg);
  else if (cmd === "sync") out = await cmd_sync();
  else if (cmd === "stats") out = cmd_stats();
  else if (cmd === "scorecard") out = cmd_scorecard();
  else if (cmd === "score-eval") out = cmd_score_eval();
  else if (cmd === "slippage") out = cmd_slippage();
  else if (cmd === "trade") out = cmd_trade(arg);
  else if (cmd === "review") out = await cmd_review(arg);
  else if (cmd === "note") out = cmd_note(arg);
  else if (cmd === "strategy-log") out = cmd_strategy_log(arg);
  else if (cmd === "portfolio") out = cmd_portfolio(arg);
  else if (cmd === "digest") out = await cmd_digest(arg);
  else if (cmd === "heartbeat") out = await cmd_heartbeat();
  else if (cmd === "heartbeat-check") out = cmd_heartbeat_check();
  else if (cmd === "routine-status") out = cmd_routine_status(arg);
  else if (cmd === "risk") out = await cmd_risk();
  else if (cmd === "reconcile") out = await cmd_reconcile();
  else if (cmd === "exposure") out = cmd_exposure();
  else if (cmd === "manage-check") out = cmd_manage_check();
  else if (cmd === "thesis-check") out = await cmd_thesis_check();
  else if (cmd === "monitor-tick") out = await cmd_monitor_tick();
  else if (cmd === "perception") out = await require("./perception.js").deepPerception(arg || "BTC", process.argv[5] || "4h"); // confluence profonde (avec orderflow) sur 1 candidat — OBSERVABILITE
  else if (cmd === "size") out = await cmd_size(arg);
  else if (cmd === "verify-bracket") out = await cmd_verify_bracket(arg);
  else if (cmd === "sl-check") out = await cmd_sl_check(arg);
  else if (cmd === "preflight") out = await cmd_preflight(arg);
  else if (cmd === "dashboard") out = cmd_dashboard();
  else if (cmd === "report") out = cmd_report();
  else if (cmd === "today" || cmd === "now") out = { date: sysDate(), time: sysDateTime().slice(11, 16), datetime: sysDateTime(), tz: (Intl.DateTimeFormat().resolvedOptions().timeZone || "?"), note: "Date/heure systeme = source unique. Utiliser AVANT toute decision/log." };
  else throw new Error("commandes: log | note | strategy-log | set | close | sync | reconcile | risk | exposure | manage-check | thesis-check | perception <sym> | size | verify-bracket | trade <id> | scorecard | score-eval | slippage | review | digest | heartbeat | heartbeat-check | stats | report | dashboard | today/now");
  console.log(typeof out === "string" ? out : JSON.stringify(out, null, 2)); // brief = texte brut, le reste = JSON
})().catch((e) => { console.error(e.message); process.exit(1); });
