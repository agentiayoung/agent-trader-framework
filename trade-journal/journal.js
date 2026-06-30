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
// cut total = P1 OOS). Repond a "voir le breakout XRP en live" (Hugo 15.06).
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

// Apparie les lignes closed-PnL Bybit à UN trade. FIX 29.06 (contamination SUI 28.06 :
// les fills du SUI 27.06 aspirés dans le 28.06 -> exits faux, R sous-évalué). Trois gardes :
//  1) tolérance prix RELATIVE (PAS de plancher absolu 1 USDT : sur sous-dollar ~0.69, le floor
//     de 1 USDT faisait matcher TOUT le symbole — même bug que matchPx corrigé le 27.06) ;
//  2) borne de TEMPS : un trade ne peut pas avoir de fills de clôture avant son ouverture
//     (les lignes d'un trade antérieur ont un updatedTime < ts_open du trade courant) ;
//  3) DEDUP via consumedIds : deux trades du même symbole ne se partagent pas les mêmes fills.
// PUR / testable offline.
function matchClosedRows(t, rows, consumedIds = new Set()) {
  const sym = (String(t.symbol).toUpperCase().includes("USDT") ? t.symbol : t.symbol + "USDT")
    .toUpperCase().replace(/[^A-Z]/g, "");
  const entryRef = t.entry_actual ?? t.entry_planned;
  if (entryRef == null || !isFinite(entryRef)) return [];
  const tol = Math.abs(entryRef) * 0.005;                 // 0.5% relatif : tolère le slippage, distingue 2 trades
  const tOpenMs = t.ts_open ? new Date(t.ts_open).getTime() : 0;
  const SLACK = 3600e3;                                   // le fill d'entrée peut précéder le log de <=1h
  return rows.filter((x) => {
    if (x.symbol !== sym) return false;
    if (x.orderId != null && consumedIds.has(x.orderId)) return false;
    if (Math.abs(Number(x.avgEntryPrice) - entryRef) > tol) return false;
    if (tOpenMs && Number(x.updatedTime) < tOpenMs - SLACK) return false;
    return true;
  });
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
  const consumedIds = new Set(); // dédup : un fill closed-PnL n'est attribué qu'à UN trade par passe

  for (const t of open) {
    const matched = matchClosedRows(t, rows, consumedIds);
    if (!matched.length) continue;
    matched.forEach((x) => { if (x.orderId != null) consumedIds.add(x.orderId); });

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
      outcome: (pnl - fees) > 0 ? "win" : "loss", exit_reason: slHit ? "stop_loss" : "take_profit", // win/loss = NET (apres frais)
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
  // FILL TIMESTAMP (30.06, Hugo) : la duree d'un trade se compte A PARTIR DU FILL (limit touche),
  // PAS de la pose/arm (ts_open). A la transition pending->open, on stampe ts_fill = moment du fill :
  // u.ts_fill si fourni (reconcile passe l'heure EXACTE Bybit), sinon l'heure de detection. Idempotent
  // (jamais re-ecrase). Entrees market : pose ~= fill -> le fallback ts_open reste juste.
  const wasOpen = t.status === "open";
  Object.assign(t, u);
  if (t.status === "open" && !wasOpen && !t.ts_fill) t.ts_fill = u.ts_fill || sysDateTime();
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
//  - routine_manual : routine declenchee a la main par Hugo (run-routine.ps1 -Manual / ROUTINE-MANUELLE.bat)
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
// Breaker DRAWDOWN (RM_MAX_DRAWDOWN_PCT, defaut 10%) = garde-fou ARGENT REEL UNIQUEMENT (GO Hugo
// 25.06). En DEMO les deux agents continuent de trader malgre un drawdown >10% (objectif = forward-test
// actif pour optimiser l'infra) ; le sizing anti-martingale (drawdownScale) reste actif. Argent reel
// <=> BYBIT_DEMO === "0" : la condition EXACTE qui envoie de vrais ordres (cf. cmd_risk/reconcile :
// enableDemoTrading(true) sauf si BYBIT_DEMO==="0"). Decouple de DEMO_ACTIVE (flag "trader activement"
// qui adoucit les SOFT_GUARDS) -> meme si DEMO_ACTIVE est leve, un compte demo ne HALT jamais sur le
// drawdown. La PERTE-JOUR (kill-switch RM_DAILY_LOSS_PCT) reste DURE dans les deux cas. Pur + offline
// -> teste dans tests/test-halt.js.
function isRealMoney() { return process.env.BYBIT_DEMO === "0"; }
function computeHalt({ dayPnl, dd, dailyLoss, maxDd, realMoney }) {
  const dayBreach = dayPnl != null && dayPnl < -dailyLoss;
  const ddBreach = !!realMoney && dd != null && dd > maxDd;
  return { halt: dayBreach || ddBreach, dayBreach, ddBreach };
}

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
  const { halt } = computeHalt({ dayPnl, dd, dailyLoss, maxDd, realMoney: isRealMoney() });
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
  const today = sysDate(); // heure LOCALE (cohérence DATE projet) — la fenêtre perte-jour reset à minuit Genève, comme le quota 3/jour (était UTC = incohérent)
  if (st.day !== today) { st.day = today; st.day_start = equity; }
  st.high_water = Math.max(st.high_water || equity, equity);
  st.history.push({ ts: new Date().toISOString(), equity });
  if (st.history.length > 1000) st.history = st.history.slice(-1000);
  fs.writeFileSync(stateFile, JSON.stringify(st, null, 2));

  const dailyLossPct = parseFloat(process.env.RM_DAILY_LOSS_PCT || "5");
  const maxDdPct = parseFloat(process.env.RM_MAX_DRAWDOWN_PCT || "10");
  const dailyPnlPct = st.day_start ? ((equity - st.day_start) / st.day_start) * 100 : 0;
  const ddPct = st.high_water ? ((st.high_water - equity) / st.high_water) * 100 : 0;
  // Breaker DRAWDOWN = ARGENT REEL UNIQUEMENT (GO Hugo 25.06). En DEMO le drawdown >10% est AUTORISE
  // (note d'observabilite, pas un halt) ; l'anti-martingale (sizing) reste actif. Argent reel <=>
  // BYBIT_DEMO === "0". La perte-jour (kill-switch) reste DURE dans les deux cas.
  const realMoney = isRealMoney();
  const reasons = [];   // => pilote halt (halt = reasons.length > 0)
  const notes = [];     // observabilite, ne declenche PAS le halt
  if (dailyPnlPct < -dailyLossPct) reasons.push(`Perte jour ${dailyPnlPct.toFixed(2)}% > seuil -${dailyLossPct}%`);
  if (ddPct > maxDdPct) {
    if (!realMoney) notes.push(`[DEMO] Drawdown ${ddPct.toFixed(2)}% > ${maxDdPct}% AUTORISE en demo (breaker drawdown = ARGENT REEL only ; sizing anti-martingale actif)`);
    else reasons.push(`Drawdown ${ddPct.toFixed(2)}% > seuil ${maxDdPct}% (ARGENT REEL)`);
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
// Snapshot Bybit STANDALONE (tick monitor-manage ~30 min) : fetch positions + ordres -> bybit-live.json.
// Le dashboard lit ce fichier pour n'afficher QUE la verite Bybit. Best-effort (echec -> garde le dernier).
async function cmd_bybit_snapshot() {
  const _bsm = require("./bybit-snapshot.js");
  const bybitDir = path.join(DIR, "..", "skills", "bybit");
  require(path.join(bybitDir, "index.js")); // charge config/.env (loadEnvFile du skill)
  const ccxt = require(require.resolve("ccxt", { paths: [bybitDir] }));
  const c = new ccxt.bybit({ apiKey: process.env.BYBIT_API_KEY, secret: process.env.BYBIT_API_SECRET, enableRateLimit: true, options: { defaultType: "swap", recvWindow: 10000, adjustForTimeDifference: true } });
  if (process.env.BYBIT_DEMO !== "0") c.enableDemoTrading(true);
  await c.loadTimeDifference();
  const positions = (await c.fetchPositions()).filter((p) => Math.abs(Number(p.contracts || 0)) > 0);
  const ordersById = {};
  try { for (const o of await c.fetchOpenOrders()) ordersById[o.id] = o; } catch (e) {}
  const syms = new Set([
    ...positions.map((p) => _bsm.baseSym(p.symbol)),
    ...load().filter((t) => ["open", "pending"].includes(t.status)).map((t) => _bsm.baseSym(t.symbol)),
    ...Object.values(ordersById).map((o) => _bsm.baseSym(o.symbol)),
  ].filter(Boolean));
  for (const s of syms) {
    try { for (const o of await c.fetchOpenOrders(s + "/USDT:USDT")) ordersById[o.id] = o; } catch (e) {}
    try { for (const o of await c.fetchOpenOrders(s + "/USDT:USDT", undefined, undefined, { orderFilter: "StopOrder" })) ordersById[o.id] = o; } catch (e) {}
  }
  const snap = _bsm.buildBybitSnapshot(positions, Object.values(ordersById), Date.now());
  const ok = _bsm.writeBybitSnapshot(snap);
  return { ok, ts: snap.ts, n_positions: snap.positions.length, n_orders: snap.orders.length };
}

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
    // Les SL stop-market sont dans une LISTE SEPAREE (orderFilter StopOrder) que le fetch regulier
    // RATE -> sans ca, l'orphelin-detection ne voyait que les TP et sous-comptait (fix 27.06, parite scalp).
    try { for (const o of await c.fetchOpenOrders(sym + "/USDT:USDT", undefined, undefined, { orderFilter: "StopOrder" })) ordersById[o.id] = o; } catch (e) {}
  }
  const openOrders = Object.values(ordersById);

  // SNAPSHOT BYBIT (27.06) : ecrit l'etat REEL (positions + ordres au repos) -> bybit-live.json, lu par
  // le dashboard pour n'afficher QUE la verite Bybit (fini les pending fantomes du journal).
  // Best-effort, reutilise les donnees deja fetchees (gratuit).
  try { const _bs = require("./bybit-snapshot.js"); _bs.writeBybitSnapshot(_bs.buildBybitSnapshot(positions, openOrders, Date.now())); } catch (e) { /* best-effort */ }

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
  const { aggregateGroups, claimLadderFills, claimScaleOutFills } = require("./reconcile-match.js");
  const handledLadder = new Set();
  const handledScaleOut = new Set();
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
          outcome: net > 0 ? "win" : "loss", exit_reason: agg.pnl > 0 ? "take_profit" : "stop_loss",
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
        size: +agg.qty.toFixed(4), outcome: net > 0 ? "win" : "loss",
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

  // ── PRE-PASSE SCALE-OUT (29.06) : trade NON-laddered qui SORT en plusieurs paliers (TP) ──
  // Le matcher principal attribue SOIT la position SOIT un seul groupe -> un partiel clos
  // pendant que la position reste ouverte (ou un partiel d'un run anterieur) s'ORPHELINE
  // (LINK 20.06 : -13 parent / +71 orphelin = +58 reel ; SUI long 28.06 : +3.74 / +1.43).
  // On RECLAME tous les groupes + la position du meme (symbol, side) par proximite d'entree :
  //   position OUVERTE -> child partiel (jamais de cloture prematuree) ; FLAT -> agrege en UN trade.
  // N'ENGAGE QUE sur evidence de scale-out (position partielle ouverte OU >=2 groupes) -> le cas
  // commun (1 groupe, flat) reste gere a l'IDENTIQUE par la boucle principale. Idempotent (recompute).
  for (const t of load()) {
    if (handledLadder.has(t.id) || t.entry_mode === "laddered") continue;
    if (!["open", "pending", "closed"].includes(t.status)) continue;
    const { groupIdx, posIdx } = claimScaleOutFills(t, gl, positions, usedG, usedP);
    if (!groupIdx.length) continue;                          // rien a agreger -> boucle principale
    if (!(posIdx >= 0 || groupIdx.length >= 2)) continue;    // pas d'evidence scale-out -> boucle principale (cas commun inchange)
    groupIdx.forEach((i) => usedG.add(i));
    if (posIdx >= 0) usedP.add(posIdx);
    handledScaleOut.add(t.id);
    const agg = aggregateGroups(groupIdx.map((i) => gl[i]));
    const net = +(agg.pnl - agg.fees).toFixed(4);
    if (posIdx >= 0) {
      // position encore OUVERTE -> scale-out EN COURS : child partiel, parent reste open.
      const p = positions[posIdx];
      if (t.status !== "open" || Number(t.size) !== Number(p.contracts)) {
        cmd_set({ id: t.id, status: "open", size: Number(p.contracts) });
        report.updated.push(`${t.id} -> open ${p.contracts}@${p.entryPrice} (scale-out)`);
      }
      const childId = `${t.id}-partial`;
      const child = {
        id: childId, status: "closed", strategy: t.strategy, parent_id: t.id, is_partial: true,
        source: t.source || "bybit_reconcile", exchange: "bybit", mode: "demo",
        symbol: baseSym(t.symbol), side: t.side, size: +agg.qty.toFixed(4),
        entry_actual: roundPx(agg.entry), avg_exit: roundPx(agg.avgExit),
        realized_pnl: +agg.pnl.toFixed(4), fees: +agg.fees.toFixed(4), net_pnl: net,
        outcome: net > 0 ? "win" : "loss", exit_reason: agg.pnl > 0 ? "take_profit" : "stop_loss",
        ts_close: new Date(agg.lastTs).toISOString(),
        review: `Partiel(s) scale-out de ${t.id} pris pendant que la position reste OUVERTE -> attribues (pas orphelin).`,
      };
      const exists = load().find((x) => x.id === childId);
      if (!exists) { cmd_log({ ...child, allow_backdate: true, ts_open: new Date(agg.lastTs - 3600000).toISOString() }); report.ladder_partials.push(`${childId} net=${net}`); }
      else if (Math.abs((exists.net_pnl ?? 0) - net) > 0.01) { cmd_set(child); report.ladder_partials.push(`${childId} net=${net} (maj)`); }
    } else {
      // position FLAT, >=2 groupes -> scale-out entierement clos : agrege en UN trade.
      if (t.status !== "closed" || Math.abs((t.net_pnl ?? 0) - net) > 0.01) {
        cmd_close({ id: t.id, entry_actual: roundPx(agg.entry), avg_exit: roundPx(agg.avgExit), realized_pnl: +agg.pnl.toFixed(4), fees: +agg.fees.toFixed(4), net_pnl: net, size: +agg.qty.toFixed(4), outcome: net > 0 ? "win" : "loss", exit_reason: agg.pnl > 0 ? "take_profit" : "stop_loss", ts_close: new Date(agg.lastTs).toISOString() });
        report.updated.push(`${t.id} <- ${groupIdx.length} groupes scale-out -> net ${net}`);
      }
      const childId = `${t.id}-partial`;
      if (load().find((x) => x.id === childId)) saveAll(load().filter((x) => x.id !== childId));
    }
  }

  for (const t of load()) {
    if (handledLadder.has(t.id) || handledScaleOut.has(t.id)) continue; // deja traite par une pre-passe
    if (!["open", "pending", "closed"].includes(t.status)) continue;
    const ref = t.entry_actual ?? t.entry_planned;
    const pi = positions.findIndex((p, i) => !usedP.has(i) && baseSym(p.symbol) === baseSym(t.symbol) && p.side === t.side && matchPx(p.entryPrice, ref));
    if (pi >= 0) {
      usedP.add(pi); const p = positions[pi];
      if (t.status !== "open" || Number(t.size) !== Number(p.contracts)) {
        const _set = { id: t.id, status: "open", entry_actual: Number(p.entryPrice), size: Number(p.contracts) };
        // ts_fill EXACT (30.06) : a la transition pending->open, heure d'ouverture Bybit de la position
        // (= fill du limit) -> duree comptee depuis le fill, sans le lag du cycle reconcile (horaire scalp).
        if (t.status !== "open") { const _fms = Number(p.timestamp || (p.info && (p.info.createdTime || p.info.updatedTime)) || 0); if (_fms > 0) _set.ts_fill = new Date(_fms).toISOString(); }
        cmd_set(_set); report.updated.push(`${t.id} -> open ${p.contracts}@${p.entryPrice}`);
      }
      continue;
    }
    const gi = gl.findIndex((g, i) => !usedG.has(i) && g.symbol === baseSym(t.symbol) && g.side === t.side && matchPx(g.entry, ref));
    if (gi >= 0) {
      usedG.add(gi); const g = gl[gi]; const net = +(g.pnl - g.fees).toFixed(4);
      if (t.status !== "closed" || Math.abs((t.net_pnl ?? 0) - net) > 0.01) {
        cmd_close({ id: t.id, entry_actual: roundPx(g.entry), avg_exit: roundPx(g.avgExit), realized_pnl: +g.pnl.toFixed(4), fees: +g.fees.toFixed(4), net_pnl: net, size: +g.qty.toFixed(4), outcome: net > 0 ? "win" : "loss", exit_reason: g.pnl > 0 ? "take_profit" : "stop_loss", ts_close: new Date(g.lastTs).toISOString() });
        report.updated.push(`${t.id} -> closed net=${net} (qty ${g.qty.toFixed(4)})`);
      }
      continue;
    }
    if (t.status !== "closed") {
      // Garde-fou : ne PAS annuler un 'pending' dont l'ordre limit/conditionnel
      // est encore au repos sur Bybit (le fill n'a juste pas encore eu lieu).
      // BUG corrige 27.06 (parite scalp D053) : pour un actif sous-dollar (SUI ~0.70), matchPx
      // a un floor de 1 USDT -> n'importe quel ordre du symbole matche par le prix. Sans filtre
      // de SENS + reduce-only, les SL/TP buy-reduceOnly d'une AUTRE position live etaient pris
      // pour "l'ordre d'entree au repos" du pending fantome -> jamais annule (reconcile_orphan).
      // Un vrai ordre d'entree au repos = NON reduce-only ET du MEME sens (short->sell, long->buy).
      const ref2 = t.entry ?? t.entry_actual ?? t.entry_planned;
      const wantSide = t.side === "short" ? "sell" : "buy";
      const isRestingEntry = (o) => {
        const ro = o.reduceOnly ?? (o.info && (o.info.reduceOnly === true || o.info.reduceOnly === "true"));
        const side = (o.side || (o.info && o.info.side) || "").toLowerCase();
        return ro !== true && side === wantSide;
      };
      const stillResting = t.status === "pending" && openOrders.some((o) =>
        baseSym(o.symbol) === baseSym(t.symbol) && isRestingEntry(o) &&
        (matchPx(o.price, ref2) || matchPx(o.info && o.info.price, ref2) || matchPx(o.info && o.info.triggerPrice, ref2)));
      if (stillResting) continue; // pending vivant (ordre d'entree au repos, meme sens, non reduce-only) -> on garde
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
    cmd_log({ id, allow_backdate: true, ts_open: new Date(g.lastTs - 3600000).toISOString(), ts_close: new Date(g.lastTs).toISOString(), status: "closed", strategy: "reconcile_orphan", source: "bybit_reconcile", exchange: "bybit", mode: "demo", symbol: g.symbol, side: g.side, size: +g.qty.toFixed(4), entry_actual: +g.entry.toFixed(2), avg_exit: +g.avgExit.toFixed(2), realized_pnl: +g.pnl.toFixed(4), fees: +g.fees.toFixed(4), net_pnl: net, outcome: net > 0 ? "win" : "loss", exit_reason: g.pnl > 0 ? "take_profit" : "stop_loss", review: "Trade Bybit absent du journal -> cree par reconcile (drift corrige)." });
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

  // AUTO-CANCEL des orphelins (24.06, SUIVI COMPLET du trade, porte du scalp) : findOrphanOrders ne
  // retourne QUE des symboles SANS position NI trade actif -> tous SURS a annuler (restes de bracket clos
  // SL/TP frere). On les annule au lieu d'accumuler. Gate RECONCILE_AUTOCANCEL (defaut ON). Best-effort.
  const orphanCancelled = [];
  if (process.env.RECONCILE_AUTOCANCEL !== "0") {
    for (const oo of orphanOrders) {
      try { await c.cancelAllOrders(oo.symbol + "/USDT:USDT"); orphanCancelled.push(`${oo.symbol}×${oo.count}`); }
      catch (e) { /* best-effort : reste flague */ }
    }
  }
  const orphanRemaining = orphanOrders.filter((o) => !orphanCancelled.includes(`${o.symbol}×${o.count}`));

  // Bybit demo ne garde que ~7j d'historique closed PnL -> comparer la même fenêtre.
  const cutoff = Date.now() - 7.5 * 24 * 3600 * 1000;
  const bybitReal = +gl.reduce((s, g) => s + (g.pnl - g.fees), 0).toFixed(2);
  const closed = load().filter((t) => t.status === "closed");
  const journalReal7d = +closed.filter((t) => t.ts_close && new Date(t.ts_close).getTime() > cutoff).reduce((s, t) => s + (t.net_pnl ?? 0), 0).toFixed(2);
  const journalRealAll = +closed.reduce((s, t) => s + (t.net_pnl ?? 0), 0).toFixed(2);
  const fixed = report.updated.length + report.orphans.length + report.cancelled.length + orphanCancelled.length;
  // Persiste le RECOUPEMENT Bybit (file-only, lu par le dashboard) : la verite Bybit vs le journal.
  // Un ecart = trades > 7j que Bybit demo a oublies (le journal les garde) -> non bloquant, mais visible.
  try {
    fs.writeFileSync(path.join(DIR, "reconcile-status.json"), JSON.stringify({
      ts: Date.now(), generated: new Date().toISOString(),
      bybit_realized_7d: bybitReal, journal_realized_7d: journalReal7d, journal_realized_all: journalRealAll,
      delta_7d: +(journalReal7d - bybitReal).toFixed(2), orphans_open: report.orphans.length, fixed,
    }, null, 2));
  } catch (_) { /* best-effort */ }
  return {
    aligned: true, fixed, ...report,
    orphan_orders: orphanRemaining,
    orphan_cancelled: orphanCancelled,
    bybit_realized_7d: bybitReal, journal_realized_7d: journalReal7d, journal_realized_all: journalRealAll,
    note: "Journal aligne sur la verite Bybit. Tout ecart de somme = trades >7j que Bybit demo a oublies (retention 7j) mais que le journal conserve."
      + (orphanCancelled.length ? ` Restes de bracket clos AUTO-ANNULES (suivi complet): ${orphanCancelled.join(", ")}.` : ""),
  };
}

// ── defrag : replie les `reconcile_orphan` (fragments de scale-out) dans leur parent ──
// REPARE l'historique : un trade qui a scale-out a pu se fragmenter en parent + orphelin(s)
// (LINK 20.06 -13/+71 -> +58 ; SUI long 28.06 +3.74/+1.43 -> +5.17). Pur via
// foldOrphansIntoParents (combine des PnL DEJA au journal -> total conserve, aucune dependance
// Bybit). Dry-run par defaut ; `defrag --apply` ecrit. Recalcule le R des parents repliés.
function cmd_defrag(arg) {
  const apply = arg === "--apply" || arg === true || (arg && arg.apply === true);
  const { foldOrphansIntoParents } = require("./reconcile-match.js");
  const { trades, merges } = foldOrphansIntoParents(load());
  for (const m of merges) {
    const p = trades.find((t) => t.id === m.parent);
    if (p && p.status === "closed") { const r = computeRMultiple(p); if (r != null) p.r_multiple = r; }
  }
  if (apply && merges.length) saveAll(trades);
  return {
    apply, merged: merges.length, merges,
    msg: apply
      ? `${merges.length} orphelin(s) replie(s) dans leur parent (journal mis a jour).`
      : `${merges.length} orphelin(s) repliable(s) — DRY-RUN. Relancer 'defrag --apply' pour ecrire.`,
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
// (10.06, finding Hugo — cas HYPE SL 55.50 vs low 55.455). Fetch 4H, calcule
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
  // warn -> perdu -0.30R). Floor PAR FAMILLE si `setup` est passé (GO Hugo 10.06, option A :
  // l'exemption R:R>=2 des MR est conditionnelle à leur géométrie validée -> MR8 2.5x, S5/MR4 2x,
  // S1 1.5x, tolérance 0.85) ; sinon floor universel 1xATR.
  const { checkSlGeometry, validatedSlFloor } = require("./bracket-check.js");
  const floor = validatedSlFloor(u.setup);
  const geo = checkSlGeometry({ entry, stop_loss: u.stop_loss, atr, min_dist_atr: floor });
  const ok = r.ok === false ? false : geo.ok === false ? false : r.ok;
  return { ...r, ok, atr: +atr.toFixed(6), px: C[C.length - 1], dist_atr: geo.dist_atr ?? null,
    geometry_ok: geo.ok, geometry_floor_atr: floor, setup_family: u.setup || null,
    geometry_warn: geo.ok === false ? geo.msg : null,
    rule: "SL au-dela des MECHES du niveau evident, buffer >= 0.3xATR, ET dist SL >= floor de la famille (MR8 2.5x / S5,MR4 2x / S1 1.5x, x0.85 tolerance ; 1xATR si famille inconnue). MR exemptes de R:R>=2 UNIQUEMENT a geometrie validee (GO Hugo 10.06) ; TP MR = ~geometrie (1:1 / 2xATR), pas une zone lointaine." };
}

async function cmd_verify_bracket(input) {
  // GUARD (21.06) : appele sans payload (ou {} / sans symbol) -> ne PLUS crasher sur u.symbol.
  // La SOP/monitoring peut invoquer verify-bracket sans JSON complet ; on degrade proprement.
  const u = (typeof input === "string" ? JSON.parse(input) : input) || {};
  if (!u.symbol) return { ok: null, reason: "verify-bracket requiert un JSON {symbol, side, size, stop_loss, take_profits}. Ex: node trade-journal/journal.js verify-bracket '{\"symbol\":\"BTC\",\"side\":\"short\",\"size\":0.1,\"stop_loss\":99999,\"take_profits\":[100,200]}'" };
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
// (MONITOR_TICK_AUTO non implemente = GO Hugo requis pour l'auto-execution). Persiste monitor-state.json.
async function cmd_monitor_tick() {
  const { planMonitoring, needsAttention, summarize, loadState, saveState, breakevenAfterTp1 } = require("./monitor.js");
  const { trajectory, ohlcvSince } = require("./trajectory.js");
  const { classifyStops } = require("./bracket-check.js");
  const bybitDir = path.join(DIR, "..", "skills", "bybit");
  const bybit = require(path.join(bybitDir, "index.js"));
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
    const { slOrders, tpOrders } = classifyStops(norm, { side, entry, market: mark });
    const t = findActive(sym, side);
    // BREAKEVEN-APRES-TP1 (levier #1 post-mortem) : MFE depuis l'entree (trajectory) -> SL au BE si TP1 atteint
    // + ATR live (echelle MONITOR_TRAJ_TF) reutilise pour l'auto-manage (trailing/resserrement). 1 seul fetch.
    let be = null, atr = null, struct = null, structN = null;
    {
      try {
        const ohlcv = await c.fetchOHLCV(sym + "/USDT:USDT", process.env.MONITOR_TRAJ_TF || "1h", undefined, 300);
        try { atr = require("./scan.js").atrFrom(ohlcv, 14); } catch (_) {}
        // A.2 FRAICHEUR : structure LIVE (CHoCH/MSS) sur l'OHLCV frais -> escalade le verdict si la
        // structure casse CONTRE la position MAINTENANT (sans attendre le scan). Meme fetch.
        try { struct = require("./structure.js").marketStructure(ohlcv, atr); structN = ohlcv.length; } catch (_) {}
        if (t && t.stop_loss != null && Array.isArray(t.take_profits) && t.take_profits.length) {
          const e0 = Number(t.entry_actual != null ? t.entry_actual : (t.entry_planned != null ? t.entry_planned : entry));
          const traj = trajectory({ side, entry: e0, stop_loss: t.stop_loss, ohlcvSinceEntry: ohlcvSince(ohlcv, t.ts_open ? Date.parse(t.ts_open) : null) });
          be = breakevenAfterTp1({ side, entry: e0, stop_loss: t.stop_loss, take_profits: t.take_profits, px: mark }, traj);
        }
      } catch (e) {}
    }
    monPos.push({ id: t ? t.id : sym, symbol: sym, side, status: "open", entry, entry_actual: entry, px: mark,
      ts_open: t ? (t.ts_fill || t.ts_open) : null, // TIME-STOP : age du hold (mean-rev)
      stop_loss: t ? t.stop_loss : null, take_profits: t ? t.take_profits : null, strategy: t ? t.strategy : null,
      size: t ? (t.size != null ? Math.abs(+t.size) : Math.abs(Number(p.contracts || 0))) : Math.abs(Number(p.contracts || 0)),
      pos_size: Math.abs(Number(p.contracts || 0)), tp_pxs: tpOrders.map((o) => o.trigger), tp_taken: t ? (t.tp_taken || []) : [],
      atr, managed: t ? (t.monitor_managed || []) : [], structure: struct, struct_nbars: structN,
      sl_orders: slOrders.length, has_sl: slOrders.length > 0,
      tp_orders: tpOrders.length, has_tp: tpOrders.length > 0, be });
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

  // A.2 FRAICHEUR : escalade le verdict (scan <=1h) par la structure LIVE FRAICHE par position. Un MSS/
  // CHoCH recent CONTRE la position passe le verdict a flipped/weakening (cut/tighten) sans attendre le
  // scan -> le monitor reagit aux "donnees actuelles". N'escalade QUE vers plus protecteur.
  {
    const { freshStructureVerdict, moreProtectiveVerdict } = require("./monitor-exec.js");
    const recency = parseInt(process.env.MONITOR_STRUCT_RECENCY || "3", 10);
    for (const p of monPos) {
      if (!p.structure) continue;
      const fv = freshStructureVerdict({ side: p.side, structure: p.structure, nBars: p.struct_nbars, recencyBars: recency });
      if (!fv) continue;
      let v = verdicts.find((x) => x.id === p.id);
      if (!v) { v = { id: p.id, symbol: p.symbol, verdict: "hold" }; verdicts.push(v); }
      const merged = moreProtectiveVerdict(v.verdict || "hold", fv);
      if (merged !== v.verdict) { v.verdict = merged; v.fresh_structure = fv; }
    }
  }

  const now = Date.now(); const state = loadState();
  const att = needsAttention({ positions: monPos, state, now });
  const res = planMonitoring({ verdicts, positions: monPos, state, now });
  saveState(res.newState);

  const actionable = res.plans.filter((pl) => ["place_sl", "take_partial_be", "take_partial_lock", "set_trailing"].includes(pl.action));
  const lines = [];
  if (res.criticals.length) lines.push("CRITIQUE position NUE (pas de SL): " + res.criticals.map((x) => x.symbol).join(", "));
  if (res.stale.length) lines.push("STALE (non gere): " + res.stale.map((s) => s.symbol + " " + s.gap_h + "h").join(", "));
  if (att.missing_tp && att.missing_tp.length) lines.push("SANS TP sur Bybit (re-poser): " + att.missing_tp.map((x) => x.symbol + " (" + x.planned + " prevus)").join(", "));
  for (const pl of actionable) if (!res.criticals.find((x) => x.id === pl.id)) lines.push(pl.symbol + " " + pl.verdict + " -> " + pl.action);

  // BREAKEVEN-APRES-TP1 (levier #1) : be_due -> ALERTE toujours ; apply + MONITOR_TICK_AUTO_BE=1 -> deplacer le SL a l'entree
  const beDue = monPos.filter((p) => p.be && p.be.be_due);
  for (const p of beDue) lines.push("BE-DUE " + p.symbol + " : " + p.be.reason);
  const beMoved = [];
  if (process.env.MONITOR_TICK_AUTO_BE === "1") {
    for (const p of beDue) {
      if (!p.be.apply) continue;
      try { await bybit("bybit_move_sl", { symbol: p.symbol, new_sl: p.be.new_sl }); beMoved.push({ symbol: p.symbol, new_sl: p.be.new_sl }); lines.push("BE-AUTO " + p.symbol + " SL -> " + p.be.new_sl); }
      catch (e) { lines.push("BE-AUTO ECHEC " + p.symbol + ": " + (e && e.message)); }
    }
  }

  // PRISE DE TP GARANTIE (23.06, directive Hugo "si gain de 20%, prendre TP1") : pour chaque position
  // OUVERTE, compare les TP PREVUS aux TP REELLEMENT POSES sur Bybit ; un TP manquant (souvent le TP1
  // proche, differe au placement car au-dessus du prix) est REACHED -> BANK (market reduce-only) ou
  // REPOST (conditionnel). Garde-fou idempotent via tp_taken (persiste). Actif par defaut ; couper avec
  // MONITOR_TICK_AUTO_TP=0 (alors observabilite seule). Reduce-only -> ne fait que VERROUILLER du gain.
  const { tpTakePlan } = require("./monitor.js");
  const tpActions = [], bankedByTrade = {};
  const autoTp = process.env.MONITOR_TICK_AUTO_TP !== "0";
  for (const p of monPos) {
    if (!p.take_profits || !p.take_profits.length || !(p.size > 0)) continue;
    const plan = tpTakePlan({ side: p.side, px: p.px, plannedTps: p.take_profits, postedTpPxs: p.tp_pxs || [],
      size: p.size, tpTaken: p.tp_taken || [], tp1Frac: parseFloat(process.env.PLACE_TP1_FRAC) || 0.2 });
    if (!plan.incomplete) continue;
    const pair = p.symbol + "/USDT:USDT";
    for (const a of plan.actions) {
      let qty = Math.min(a.qty, p.pos_size || a.qty); // jamais plus que la taille reelle
      try { qty = +c.amountToPrecision(pair, qty); } catch (_) {}
      if (!(qty > 0)) continue;
      const exitSide = p.side === "short" ? "buy" : "sell";
      lines.push(`TP-${a.action.toUpperCase()} ${p.symbol} ${(a.frac * 100).toFixed(0)}% @${a.px}` + (a.reached ? " (niveau atteint)" : ""));
      if (!autoTp) { tpActions.push({ symbol: p.symbol, ...a, executed: false }); continue; }
      try {
        if (a.action === "bank") { // niveau deja atteint -> verrouille le partiel maintenant (market reduce-only)
          await c.createOrder(pair, "market", exitSide, qty, undefined, { reduceOnly: true });
          (bankedByTrade[p.id] = bankedByTrade[p.id] || []).push(a.px); // idempotence : marquer pris
        } else { // repost : TP conditionnel (valide post-fill, fillera au niveau)
          const trig = +c.priceToPrecision(pair, a.px);
          await c.createOrder(pair, "market", exitSide, qty, undefined, { reduceOnly: true, triggerPrice: trig, triggerDirection: p.side === "short" ? "below" : "above" });
        }
        tpActions.push({ symbol: p.symbol, ...a, executed: true });
      } catch (e) { lines.push(`TP-${a.action.toUpperCase()} ECHEC ${p.symbol}: ${(e && e.message || "").slice(0, 80)}`); tpActions.push({ symbol: p.symbol, ...a, executed: false, error: (e && e.message) }); }
    }
  }
  // persiste tp_taken (anti double-prise au prochain tick) en une passe
  if (Object.keys(bankedByTrade).length) {
    const all = load();
    for (const t of all) if (bankedByTrade[t.id]) t.tp_taken = [...new Set([...(t.tp_taken || []), ...bankedByTrade[t.id]])];
    saveAll(all);
  }

  // AUTO-MANAGE (Phase A, 25.06) : EXECUTE les actions de JUGEMENT du plan (cut=take_partial_be /
  // prise de profit=take_partial_lock / continuation=set_trailing / tighten_sl / place_sl) en
  // RISK-REDUCING ONLY via monitor-exec.js. Gated MONITOR_TICK_AUTO_MANAGE=1 (defaut OFF -> alerte
  // seule). Idempotent : partiels one-shot memorises dans t.monitor_managed. Jugement = deterministe
  // (thesis.js) ; ce bloc execute seulement, jamais ouvrir/flipper/scale-in/elargir un SL.
  const { manageIntents } = require("./monitor-exec.js");
  const manageActions = [], managedByTrade = {};
  const autoManage = process.env.MONITOR_TICK_AUTO_MANAGE === "1";
  if (autoManage) {
    const partialFrac = parseFloat(process.env.MONITOR_MANAGE_PARTIAL_FRAC) || 0.5;
    const trailAtrMult = parseFloat(process.env.MONITOR_MANAGE_TRAIL_ATR) || 1.5;
    for (const pl of res.plans) {
      if (!["place_sl", "take_partial_be", "take_partial_lock", "set_trailing", "tighten_sl", "time_stop_close"].includes(pl.action)) continue;
      const p = monPos.find((x) => x.id === pl.id);
      if (!p) continue;
      const r = manageIntents(pl, p, { partialFrac, trailAtrMult });
      if (!r.do) { if (r.skip) lines.push(`MANAGE-SKIP ${p.symbol} ${pl.action}: ${r.skip}`); continue; }
      for (const intent of r.intents) {
        try {
          if (intent.kind === "move_sl") await bybit("bybit_move_sl", intent.params);
          else if (intent.kind === "take_partial") await bybit("bybit_take_partial", intent.params);
          else if (intent.kind === "set_trailing") await bybit("bybit_set_trailing_stop", intent.params);
          else if (intent.kind === "close_position") await bybit("bybit_take_partial", { symbol: intent.params.symbol, fraction: 1.0 }); // TIME-STOP : clore reduce-only full
          manageActions.push({ symbol: p.symbol, action: pl.action, kind: intent.kind, executed: true });
          lines.push(`MANAGE ${p.symbol} ${pl.verdict || pl.action} -> ${intent.kind} ${JSON.stringify(intent.params)}`);
        } catch (e) {
          manageActions.push({ symbol: p.symbol, action: pl.action, kind: intent.kind, executed: false, error: e && e.message });
          lines.push(`MANAGE ECHEC ${p.symbol} ${intent.kind}: ${(e && e.message || "").slice(0, 80)}`);
        }
      }
      if (r.tag === "be" || r.tag === "lock" || r.tag === "time_stop") (managedByTrade[p.id] = managedByTrade[p.id] || []).push(r.tag);
    }
    if (Object.keys(managedByTrade).length) {
      const all = load();
      for (const t of all) if (managedByTrade[t.id]) t.monitor_managed = [...new Set([...(t.monitor_managed || []), ...managedByTrade[t.id]])];
      saveAll(all);
    }
  }

  const alert = att.alert || res.criticals.length > 0 || actionable.length > 0 || beDue.length > 0 || tpActions.length > 0 || manageActions.length > 0;
  const summary = summarize(res);

  let notified = false;
  if (alert && process.env.MONITOR_TICK_NOTIFY !== "0") {
    try { notified = !!(await require("./notify.js")("MONITOR-TICK (entre routines)\n" + lines.join("\n") + "\n" + summary)); } catch (e) {}
  }
  return { ok: true, n: monPos.length, alert, criticals: res.criticals, stale: res.stale, missing_tp: att.missing_tp || [], actionable: actionable.length,
    tp_actions: tpActions, auto_tp: autoTp,
    manage_actions: manageActions, auto_manage: autoManage,
    be_due: beDue.map((p) => ({ symbol: p.symbol, apply: p.be.apply, new_sl: p.be.new_sl })), be_moved: beMoved,
    notified, summary, plans: res.plans, auto_be: process.env.MONITOR_TICK_AUTO_BE === "1" };
}

// ── arm : ARME une intention de setup pour le RADAR D'ENTREE (M002/S02) ───────────
// L'orchestrateur appelle ceci AU LIEU de poser le bracket directement (quand ENTRY_RADAR_ARM=1) :
// il ARME l'intention (avec sa rationale), le radar (entry-radar.js, 15 min + fin de routine)
// confirme la bougie PAR FAMILLE puis pose le limit MAKER + preflight + journalise. MR = confirme
// immediat (pose au prochain tick radar = fin de routine, ~secondes). Garde-fous DURS dans le radar.
// Usage : node trade-journal/journal.js arm '{"symbol":"BTC","side":"short","setup":"S2_short_continuation","level":63500,"sl":64200,"take_profits":[{"px":62000}],"risk_usd":250,"atr":900,"rationale":"...","track":"experiment"}'
function cmd_arm(input) {
  const aw = require("./armed-watch.js");
  let u; try { u = typeof input === "string" ? JSON.parse(input) : input; } catch (e) { return { ok: false, error: "JSON invalide: " + e.message }; }
  if (!u || typeof u !== "object") return { ok: false, error: "payload requis" };
  // accepte take_profits en [number] ou [{px}] -> armed-watch valide un array non vide
  const v = aw.validateSetup(u);
  if (!v.ok) return { ok: false, errors: v.errors };
  const now = Date.now();
  let watch = aw.readWatch();
  const expiryHours = Number.isFinite(+u.expiry_hours) ? +u.expiry_hours : undefined;
  watch = aw.armSetup(watch, u, now, expiryHours != null ? { expiryHours } : {});
  aw.writeWatch(watch);
  const s = v.setup;
  return { ok: true, armed: { symbol: s.symbol, side: s.side, setup: s.setup, family: s.family, confirm_type: s.confirm_type, level: s.level, tf: s.tf }, n_armed: watch.setups.length,
    note: "Intention armee. Le radar d'entree confirmera la bougie (" + s.confirm_type + ") puis posera le limit MAKER + preflight + log. MR=immediat (fin de routine)." };
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
  // 5) RAIL DE SESSION (D051) : le sous-jacent cash de l'actif est-il ouvert ? (perp TradFi decroche hors-session)
  let session = null;
  try {
    const Uni = require("./universe.js");
    const bare = String(order.symbol || "").toUpperCase().replace(/\/.*$/, "").replace(/USDT.*$/, "").replace(/[^A-Z0-9]/g, "");
    const sess = Uni.sessionOf(bare);
    if (sess) { const so = Uni.sessionOpen(sess, new Date()); session = { session: sess, asset_class: Uni.classOf(bare), open: so.open, reason: so.reason }; }
  } catch (e) { /* non bloquant */ }
  const ctx = { atr: slc && slc.atr, equityState, todayCount, exposure, session };
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
module.exports = { tradeTrack, tradeOrigin, isTestTrade, ORIGINS, CATALOG_SETUP, computeRMultiple, roundPx, cmd_manage_check, computeHalt, isRealMoney, matchClosedRows };

// ── dispatcher (CLI uniquement : ne tourne PAS quand le module est require()) ──
const [, , cmd, arg] = process.argv;
if (require.main === module) (async () => {
  let out;
  if (cmd === "log") out = cmd_log(arg);
  // FILET COMPLETUDE (26.06) : ecrit un no_trade DETERMINISTE sans AUCUN argument JSON -> le wrapper
  // PowerShell (run-routine.ps1) n'a plus a passer de JSON (la cause du bug : PowerShell re-tokenisait
  // la string sur les guillemets/espaces -> JSON casse -> filet jamais ecrit). Appel : node journal.js auto-no-trade.
  else if (cmd === "auto-no-trade") out = cmd_log({ status: "no_trade", symbol: "MARKET", origin: process.env.TRADE_ORIGIN || "routine_auto", source: "auto_completeness", rationale: "routine sans nouvelle decision -> no_trade auto (filet completude)" });
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
  else if (cmd === "defrag") out = cmd_defrag(arg);
  else if (cmd === "bybit-snapshot") out = await cmd_bybit_snapshot();
  else if (cmd === "exposure") out = cmd_exposure();
  else if (cmd === "manage-check") out = cmd_manage_check();
  else if (cmd === "thesis-check") out = await cmd_thesis_check();
  else if (cmd === "monitor-tick") out = await cmd_monitor_tick();
  else if (cmd === "perception") out = await require("./perception.js").deepPerception(arg || "BTC", process.argv[5] || "4h"); // confluence profonde (avec orderflow) sur 1 candidat — OBSERVABILITE
  else if (cmd === "size") out = await cmd_size(arg);
  else if (cmd === "verify-bracket") out = await cmd_verify_bracket(arg);
  else if (cmd === "sl-check") out = await cmd_sl_check(arg);
  else if (cmd === "preflight") out = await cmd_preflight(arg);
  else if (cmd === "arm") out = cmd_arm(arg);
  else if (cmd === "dashboard") out = cmd_dashboard();
  else if (cmd === "report") out = cmd_report();
  else if (cmd === "today" || cmd === "now") out = { date: sysDate(), time: sysDateTime().slice(11, 16), datetime: sysDateTime(), tz: (Intl.DateTimeFormat().resolvedOptions().timeZone || "?"), note: "Date/heure systeme = source unique. Utiliser AVANT toute decision/log." };
  else throw new Error("commandes: log | note | strategy-log | set | close | sync | reconcile | risk | exposure | manage-check | thesis-check | monitor-tick | perception <sym> | size | verify-bracket | sl-check | preflight | arm | trade <id> | scorecard | score-eval | slippage | review | digest | heartbeat | heartbeat-check | stats | report | dashboard | today/now");
  console.log(typeof out === "string" ? out : JSON.stringify(out, null, 2)); // brief = texte brut, le reste = JSON
})().catch((e) => { console.error(e.message); process.exit(1); });
