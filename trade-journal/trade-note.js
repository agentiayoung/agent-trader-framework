"use strict";
// ═══════════════════════════════════════════════════════════════════
// trade-note.js — builder PUR de notes Obsidian par trade (deuxième cerveau).
//
// buildTradeNote(trade) → { relpath, content } | null
//   Projette UNE entrée de trades.jsonl en note markdown datée :
//   frontmatter riche (dates/perf/setup → vues Bases), thèse, invalidation,
//   niveaux, timeline (la « story » routine par routine), review, et un
//   bloc NOTES-MANUELLES préservé entre régénérations (annotations the maintainer).
//
// Exclusions (null) : MANUAL_TEST_* (tests pipeline, hors perf — même règle
// que stats/score-eval/obsidian-sync), no_trade SANS hypo (logs de scan non
// mesurables), entrée sans id.
//
// PUR : aucune lecture disque — testé offline (tests/test-trade-note.js).
// L'écriture vault = obsidian-trades-sync.js.
// ═══════════════════════════════════════════════════════════════════

const M_START = "<!-- NOTES-MANUELLES-START -->";
const M_END = "<!-- NOTES-MANUELLES-END -->";

// Même définition que journal.js stats / score-eval / obsidian-sync.
function isTestTrade(t) { return /^MANUAL_TEST/i.test(t.strategy || ""); }

// "2026-06-09T19:53:52+02:00" | "2026-06-08T00:00:00Z" | "2026-06-08" → "YYYY-MM-DD".
// Substring volontaire (pas de parse Date) : les ts du journal sont à intention
// locale ; parser un backfill "00:00:00Z" ferait glisser la date d'un jour.
function dateOnly(ts) {
  const m = String(ts || "").match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

// "2026-06-09T18:16:33+02:00" → "09.06 18:16" (lignes de timeline).
function fmtTs(ts) {
  const m = String(ts || "").match(/^\d{4}-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return m ? `${m[2]}.${m[1]} ${m[3]}:${m[4]}` : (dateOnly(ts) ? dateOnly(ts).slice(8) + "." + dateOnly(ts).slice(5, 7) : "—");
}

// Setup court pour tags/groupement : champ setup sinon 1er token de strategy.
function deriveSetup(t) {
  if (t.setup) return String(t.setup);
  const s = String(t.strategy || "").split("_")[0];
  return s || "autre";
}

function yamlStr(v) {
  const s = String(v ?? "");
  return /[:#\[\]{}&*!|>'"%@`,\n]/.test(s) ? JSON.stringify(s) : s;
}
function num(v, dec) { return typeof v === "number" && isFinite(v) ? +v.toFixed(dec ?? 2) : null; }
function cell(s) { return String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " "); }

function fmtTps(tps) {
  if (!Array.isArray(tps) || !tps.length) return null;
  return tps.map((tp) => (typeof tp === "object" && tp !== null)
    ? `${tp.px}${tp.frac != null ? ` (${Math.round(tp.frac * 100)}%)` : ""}`
    : String(tp)).join(" / ");
}

function statusCallout(t) {
  const r = num(t.r_multiple), pnl = num(t.net_pnl);
  const perf = `${pnl != null ? (pnl > 0 ? "+" : "") + pnl + " USDT" : ""}${r != null ? ` · ${r > 0 ? "+" : ""}${r}R` : ""}`;
  switch (t.status) {
    case "closed":
      return t.outcome === "win"
        ? `> [!success] WIN **${perf}**${t.exit_reason ? ` · ${t.exit_reason}` : ""}${t.avg_exit ? ` · exit ${t.avg_exit}` : ""}`
        : `> [!failure] LOSS **${perf}**${t.exit_reason ? ` · ${t.exit_reason}` : ""}${t.avg_exit ? ` · exit ${t.avg_exit}` : ""}`;
    case "open": return `> [!note] OPEN — entrée ${t.entry_actual ?? t.entry_planned ?? "?"} · SL ${t.stop_loss ?? "?"}`;
    case "pending": return `> [!todo] PENDING — limit @${t.entry_planned ?? "?"} · SL ${t.stop_loss ?? "?"}`;
    case "cancelled": return `> [!quote] ANNULÉ — ${cell(t.review || "pending jamais déclenché")}`;
    case "no_trade": {
      const h = t.hypo || {};
      return `> [!info] NO-TRADE — hypo ${h.side ?? ""} entry ${h.entry ?? "?"} · SL ${h.sl ?? "?"} · TP ${h.tp ?? "?"} (refus mesurable via notrade-eval)`;
    }
    default: return `> [!question] statut ${t.status}`;
  }
}

function buildTimeline(tl) {
  if (!Array.isArray(tl) || !tl.length) return null;
  const rows = tl.map((s) =>
    `| ${fmtTs(s.ts)} | ${s.mark ?? "—"} | ${s.upnl ?? "—"} | ${cell(s.decision ?? "—")} | ${s.score?.total ?? "—"} | ${cell(s.note ?? "")} |`);
  return ["| Date | Mark | uPnL | Décision | /14 | Note |", "|---|--:|--:|:--|--:|:--|", ...rows].join("\n");
}

function buildTradeNote(t) {
  if (!t || !t.id || isTestTrade(t)) return null;
  if (t.status === "no_trade" && !t.hypo) return null;

  const setup = deriveSetup(t);
  const dOpen = dateOnly(t.ts_open);
  const dClose = dateOnly(t.ts_close);
  const outcome = t.status === "closed" ? (t.outcome || ((t.net_pnl ?? 0) > 0 ? "win" : "loss")) : null;
  const tags = ["trade", setup, t.status === "closed" ? outcome : (t.status === "no_trade" ? "no-trade" : t.status)]
    .filter(Boolean).map((x) => String(x).replace(/\s+/g, "-"));

  const fm = [
    "---", "type: trade",
    `trade_id: ${yamlStr(t.id)}`,
    `symbol: ${yamlStr(t.symbol ?? t.hypo?.symbol ?? "?")}`,
    `side: ${yamlStr(t.side ?? t.hypo?.side ?? "?")}`,
    `strategy: ${yamlStr(t.strategy ?? "?")}`,
    `setup: ${yamlStr(setup)}`,
    `status: ${yamlStr(t.status)}`,
    outcome ? `outcome: ${outcome}` : null,
    t.source ? `source: ${yamlStr(t.source)}` : null,
    t.tier ? `tier: ${yamlStr(t.tier)}` : null,
    dOpen ? `date_open: ${dOpen}` : null,
    dClose ? `date_close: ${dClose}` : null,
    num(t.r_multiple) != null ? `r_multiple: ${num(t.r_multiple)}` : null,
    num(t.net_pnl) != null ? `net_pnl: ${num(t.net_pnl)}` : null,
    (t.entry_actual ?? t.entry_planned) != null ? `entry: ${t.entry_actual ?? t.entry_planned}` : null,
    t.stop_loss != null ? `stop_loss: ${t.stop_loss}` : null,
    t.score?.total != null ? `score_entry: ${t.score.total}` : null,
    t.exchange ? `exchange: ${yamlStr(t.exchange)}` : null,
    "tags:", ...tags.map((x) => `  - ${x}`),
    "---",
  ].filter(Boolean).join("\n");

  const title = `# ${t.symbol ?? t.hypo?.symbol ?? "?"} ${t.side ?? t.hypo?.side ?? ""} — ${t.strategy ?? "?"} (${dOpen ? dOpen.slice(8) + "." + dOpen.slice(5, 7) : "?"}${dClose ? ` → ${dClose.slice(8)}.${dClose.slice(5, 7)}` : ""})`;

  const tps = fmtTps(t.take_profits);
  const niveaux = (t.entry_actual ?? t.entry_planned) != null
    ? `Entrée **${t.entry_actual ?? t.entry_planned}** · SL **${t.stop_loss ?? "?"}**${tps ? ` · TP ${tps}` : ""}${t.size ? ` · taille ${t.size}` : ""}`
    : null;

  const timeline = buildTimeline(t.timeline);

  const body = [
    title, "", statusCallout(t), "",
    (t.rationale || t.reason) ? `## 🧠 Thèse\n${t.rationale || t.reason}` : null,
    t.invalidation ? `## ⚠️ Invalidation\n${t.invalidation}` : null,
    niveaux ? `## 📐 Niveaux\n${niveaux}` : null,
    timeline ? `## 📅 Timeline (la story du trade)\n${timeline}` : null,
    (t.review && t.status !== "cancelled") ? `## 🔍 Review\n${t.review}` : null,
    `${M_START}\n_(tes annotations ici — jamais écrasées)_\n${M_END}`,
    "", "[[Agent-Trader]] · [[Agent-Trader-Trades]]", "",
  ].filter((x) => x !== null).join("\n\n");

  return { relpath: `${t.id}.md`, content: fm + "\n" + body };
}

// Préserve le bloc NOTES-MANUELLES de la note existante dans la fraîche.
function mergeManualBlock(fresh, existing) {
  if (!existing || typeof existing !== "string") return fresh;
  const ex = existing.indexOf(M_START), exEnd = existing.indexOf(M_END);
  if (ex === -1 || exEnd === -1 || exEnd < ex) return fresh;
  const kept = existing.slice(ex, exEnd + M_END.length);
  const f = fresh.indexOf(M_START), fEnd = fresh.indexOf(M_END);
  if (f === -1 || fEnd === -1) return fresh;
  return fresh.slice(0, f) + kept + fresh.slice(fEnd + M_END.length);
}

module.exports = { buildTradeNote, mergeManualBlock, dateOnly, deriveSetup, isTestTrade, M_START, M_END };
