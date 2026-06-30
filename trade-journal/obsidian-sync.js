"use strict";
// ═══════════════════════════════════════════════════════════════════
// obsidian-sync.js — met à jour le bloc « État live (auto-routine) » de la
// fiche Obsidian Agent-Trader.md depuis les données du journal.
//
// DÉTERMINISTE (pas de LLM qui édite la note = zéro drift). Ne touche QUE le
// bloc entre les marqueurs AUTO-ROUTINE-START/END ; le reste de la note est
// intact. Appelé en fin de CHAQUE routine (run-routine.ps1). No-op gracieux
// si la note est absente (vault déplacé / Obsidian non installé).
//
// Chemin note : OBSIDIAN_NOTE_PATH ou ../../../tools/obsidian/02-Projets/Agent-Trader.md
// ═══════════════════════════════════════════════════════════════════

const fs = require("fs");
const path = require("path");

const DIR = __dirname;
const FILE = path.join(DIR, "trades.jsonl");
const START = "<!-- AUTO-ROUTINE-START -->";
const END = "<!-- AUTO-ROUTINE-END -->";
const NOTE = process.env.OBSIDIAN_NOTE_PATH ||
  path.join(DIR, "..", "..", "..", "tools", "obsidian", "02-Projets", "Agent-Trader.md");

function sysDateTime() {
  const d = new Date(); const p = (n) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset(), sg = off >= 0 ? "+" : "-";
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
// Pourquoi un pending a été annulé (jamais déclenché) — même catégorisation que journal.js cmd_stats.
function cancelReason(t) {
  const r = (t.review || "").toLowerCase();
  if (/rebond rat|entree-rebond|entrée-rebond/.test(r)) return "rebond raté";
  if (/pruning/.test(r)) return "pruning";
  if (/>5%|sop ?>?5|trop loin|inatteignable/.test(r)) return "trop loin (5%)";
  if (/supersed|supersédé|remplac|repositionn/.test(r)) return "repositionné";
  if (/quota|max 3/.test(r)) return "quota";
  if (/these cass|thèse cass|invalid/.test(r)) return "thèse invalidée";
  return "autre";
}

function gatherState() {
  let trades = [];
  try { trades = fs.readFileSync(FILE, "utf-8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); } catch (e) {}
  const active = trades.filter((t) => ["open", "pending"].includes(t.status));
  let equity = null, halt = false, dayPnl = null;
  try {
    const st = JSON.parse(fs.readFileSync(path.join(DIR, "equity.json"), "utf-8"));
    const h = st.history || []; equity = h.length ? h[h.length - 1].equity : st.day_start;
    if (st.day_start && equity != null) dayPnl = ((equity - st.day_start) / st.day_start) * 100;
    const dd = st.high_water && equity != null ? ((st.high_water - equity) / st.high_water) * 100 : 0;
    halt = (dayPnl != null && dayPnl < -parseFloat(process.env.RM_DAILY_LOSS_PCT || "5")) || dd > parseFloat(process.env.RM_MAX_DRAWDOWN_PCT || "10");
  } catch (e) {}
  // Exclut les tests pipeline (MANUAL_TEST_*) -> même définition que journal.js stats / score-eval
  // (sinon décalage entre la fiche et les stats que l'agent lit = confusion).
  const isTest = (t) => /^MANUAL_TEST/i.test(t.strategy || "");
  const closed = trades.filter((t) => t.status === "closed" && !isTest(t)).reverse(); // récents d'abord
  const wins = closed.filter((t) => (t.net_pnl ?? 0) > 0).length;
  const rs = closed.filter((t) => typeof t.r_multiple === "number").map((t) => t.r_multiple);
  const avgR = rs.length ? +(rs.reduce((a, b) => a + b, 0) / rs.length).toFixed(2) : null;
  const cpnl = +closed.reduce((s, t) => s + (t.net_pnl ?? 0), 0).toFixed(2);
  // Catégorie SÉPARÉE : pendings annulés (jamais déclenchés) -> n'affectent PAS le WR.
  const cancelled = trades.filter((t) => t.status === "cancelled");
  const cancelReasons = {};
  for (const t of cancelled) { const k = cancelReason(t); cancelReasons[k] = (cancelReasons[k] || 0) + 1; }
  return { ts: sysDateTime(), equity, halt, day_pnl_pct: dayPnl, active, closed, closed_n: closed.length,
    win_rate: closed.length ? +(wins / closed.length * 100).toFixed(0) : null, avg_r: avgR, closed_pnl: cpnl,
    cancelled_n: cancelled.length, cancelled_reasons: cancelReasons };
}

// Construit le bloc markdown (pur, testable). Affichage propre Obsidian : un callout COMPACT
// pour le résumé, puis de VRAIS tableaux markdown alignés (hors blockquote -> rendu net).
function renderBlock(s) {
  const sep = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " "); // 50002 -> 50 002
  const eq = s.equity != null ? `${sep(Number(s.equity).toFixed(0))} USDT` : "—";
  const dp = s.day_pnl_pct != null ? ` (${s.day_pnl_pct > 0 ? "+" : ""}${Number(s.day_pnl_pct).toFixed(2)} %/j)` : "";
  const wr = s.win_rate != null ? `${s.win_rate} %` : "—";
  const num = (v, signed) => v == null ? "—" : `${signed && v > 0 ? "+" : ""}${v}`;

  let md = `${START}\n`;
  // Résumé = callout compact (1 ligne riche)
  md += `> [!abstract]+ 🔄 État live — ${s.ts}\n`;
  md += `> 💰 **${eq}**${dp} · breaker ${s.halt ? "🛑 **HALT**" : "🟢 OK"} · **${s.active.length}/4** positions · clôturés **${s.closed_n}** (WR **${wr}** · R ${s.avg_r ?? "—"} · PnL ${num(s.closed_pnl, true)}) · 🚫 ${s.cancelled_n || 0} non déclenchés\n`;

  // Positions actives — tableau aligné
  md += `\n##### 📊 Positions actives\n`;
  if (s.active.length) {
    md += `| Statut | Paire | Sens | Entrée | SL | Mark | uPnL | Déc. |\n|:--|:--|:--:|--:|--:|--:|--:|:--|\n`;
    for (const t of s.active) {
      const tl = Array.isArray(t.timeline) ? t.timeline : [];
      const last = tl.length ? tl[tl.length - 1] : null;
      const badge = t.status === "open" ? "🟢 open" : "⏳ pending";
      const entry = t.entry_actual ?? t.entry_planned ?? t.entry ?? "—";
      md += `| ${badge} | **${t.symbol}** | ${t.side} | ${entry} | ${t.stop_loss ?? "—"} | ${last && last.mark != null ? last.mark : "—"} | ${last ? num(last.upnl, true) : "—"} | ${last ? last.decision : "—"} |\n`;
    }
  } else md += `_Aucune position active._\n`;

  // Trades clôturés (déclenchés, tests exclus) — SOURCE UNIQUE
  md += `\n##### ✅ Trades clôturés _(déclenchés · tests exclus)_\n`;
  md += `**${s.closed_n}** trades · WR **${wr}** · R moy **${s.avg_r ?? "—"}** · PnL net **${num(s.closed_pnl, true)} USDT**\n`;
  const cl = Array.isArray(s.closed) ? s.closed : [];
  if (cl.length) {
    md += `\n| Paire | Setup | Sens | Résultat | PnL | R |\n|:--|:--|:--:|:--:|--:|--:|\n`;
    for (const t of cl.slice(0, 8)) {
      const win = (t.net_pnl ?? 0) > 0;
      const pnl = t.net_pnl != null ? num(+Number(t.net_pnl).toFixed(2), true) : "—";
      md += `| **${t.symbol}** | ${(t.strategy || "?").replace(/_/g, " ").slice(0, 20)} | ${t.side} | ${win ? "✅ win" : "❌ loss"} | ${pnl} | ${t.r_multiple ?? "—"} |\n`;
    }
  }

  // Non déclenchés (séparé, hors WR)
  const cr = s.cancelled_reasons || {};
  const crTxt = Object.keys(cr).length ? Object.entries(cr).map(([k, v]) => `${k} **${v}**`).join(" · ") : "—";
  md += `\n##### 🚫 Non déclenchés _(annulés avant fill · hors WR)_\n`;
  md += `**${s.cancelled_n || 0}** pending(s) jamais entré(s) — ${crTxt}\n`;

  md += `\n*Régénéré à chaque routine par \`obsidian-sync.js\` (déterministe, source = journal).*\n`;
  md += END;
  return md;
}

// Remplace le bloc entre les marqueurs (pur). Si marqueurs absents -> insère après le 1er titre H1.
function injectBlock(noteText, block) {
  const i = noteText.indexOf(START), j = noteText.indexOf(END);
  if (i !== -1 && j !== -1 && j > i) {
    return noteText.slice(0, i) + block + noteText.slice(j + END.length);
  }
  // pas de marqueurs : insérer après la 1re ligne de titre "# ..."
  const lines = noteText.split("\n");
  const h1 = lines.findIndex((l) => /^#\s/.test(l));
  if (h1 === -1) return noteText + "\n\n" + block + "\n";
  lines.splice(h1 + 1, 0, "", block, "");
  return lines.join("\n");
}

function run() {
  if (!fs.existsSync(NOTE)) { console.log(`(obsidian: note absente ${NOTE} — skip)`); return false; }
  const block = renderBlock(gatherState());
  const updated = injectBlock(fs.readFileSync(NOTE, "utf-8"), block);
  fs.writeFileSync(NOTE, updated);
  console.log(`obsidian: bloc auto-routine mis à jour (${NOTE})`);
  return true;
}

if (require.main === module) { try { run(); } catch (e) { console.error("(obsidian sync échec non-bloquant: " + e.message + ")"); } }
module.exports = { renderBlock, injectBlock, gatherState };
