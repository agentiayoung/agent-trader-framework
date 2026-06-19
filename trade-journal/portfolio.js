"use strict";
// ═══════════════════════════════════════════════════════════════════
// portfolio.js — PORTFOLIO LIVE unifié des 2 agents (agent-trader 4H + scalp).
//
// PUR + DÉTERMINISTE (zéro réseau) : lit les `trades.jsonl` + `equity.json` des
// 2 instances (lecture seule, comptes Bybit SÉPARÉS — jamais d'écriture croisée)
// et agrège en une vue unique : equity / drawdown / jour / positions / PnL / WR / R
// par agent + un bloc AGRÉGÉ. Régénéré à chaque routine (run-routine.ps1) et exposé
// en CLI (`journal.js portfolio` / `--json` pour le dashboard web).
//
// Chemins overridables : AGENT_TRADER_DIR / SCALP_TRADER_DIR (sinon déduits).
// ═══════════════════════════════════════════════════════════════════

const fs = require("fs");
const path = require("path");

const DIR = __dirname; // = .../agent-trader/trade-journal
const START = "<!-- PORTFOLIO-START -->";
const END = "<!-- PORTFOLIO-END -->";

function sysDateTime() {
  const d = new Date(); const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const isTest = (t) => /^MANUAL_TEST/i.test(t.strategy || "");

// Lecture tolérante (1 ligne corrompue ne tue pas le calcul).
function readTrades(file) {
  let out = [];
  try {
    for (const ln of fs.readFileSync(file, "utf-8").split(/\r?\n/)) {
      if (!ln.trim()) continue;
      try { out.push(JSON.parse(ln)); } catch (_) { /* skip corrompue */ }
    }
  } catch (_) {}
  return out;
}
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch (_) { return null; } }

// ---- coeur PUR : agrège un agent depuis ses trades + son état equity ----
function aggregateAgent(trades, equityState, opts = {}) {
  trades = Array.isArray(trades) ? trades : [];
  const env = opts.env || process.env;
  const name = opts.name || "agent";

  const active = trades.filter((t) => t.status === "open" || t.status === "pending");
  const open_n = active.filter((t) => t.status === "open").length;
  const pending_n = active.filter((t) => t.status === "pending").length;

  let equity = null, day_start = null, high_water = null, day_pnl_pct = null, dd_pct = null, halt = false;
  if (equityState && typeof equityState === "object") {
    const h = Array.isArray(equityState.history) ? equityState.history : [];
    day_start = equityState.day_start != null ? equityState.day_start : null;
    high_water = equityState.high_water != null ? equityState.high_water : null;
    equity = h.length ? h[h.length - 1].equity : day_start;
    if (day_start && equity != null) day_pnl_pct = ((equity - day_start) / day_start) * 100;
    dd_pct = high_water && equity != null ? ((high_water - equity) / high_water) * 100 : 0;
    const dailyMax = parseFloat(env.RM_DAILY_LOSS_PCT || "5");
    const ddMax = parseFloat(env.RM_MAX_DRAWDOWN_PCT || "10");
    halt = (day_pnl_pct != null && day_pnl_pct < -dailyMax) || (dd_pct != null && dd_pct > ddMax);
  }

  const closed = trades.filter((t) => t.status === "closed" && !isTest(t));
  const wins = closed.filter((t) => (t.net_pnl ?? 0) > 0).length;
  const rs = closed.filter((t) => typeof t.r_multiple === "number").map((t) => t.r_multiple);
  const r_sum = rs.reduce((a, b) => a + b, 0);
  const closed_pnl = +closed.reduce((s, t) => s + (t.net_pnl ?? 0), 0).toFixed(2);
  const cancelled_n = trades.filter((t) => t.status === "cancelled").length;

  return {
    name, equity, day_start, high_water,
    day_pnl_pct, dd_pct, halt,
    active, active_n: active.length, open_n, pending_n,
    closed_n: closed.length, wins,
    win_rate: closed.length ? +(wins / closed.length * 100).toFixed(0) : null,
    avg_r: rs.length ? +(r_sum / rs.length).toFixed(2) : null,
    r_sum, r_count: rs.length,
    closed_pnl, cancelled_n,
  };
}

// ---- agrégation cross-agent (PUR) ----
function buildPortfolio(agentStates) {
  const agents = Array.isArray(agentStates) ? agentStates : [];
  const sum = (f) => agents.reduce((s, a) => s + (f(a) || 0), 0);
  const total_equity = +sum((a) => a.equity).toFixed(2);
  const total_active = sum((a) => a.active_n);
  const total_closed = sum((a) => a.closed_n);
  const total_wins = sum((a) => a.wins);
  const total_closed_pnl = +sum((a) => a.closed_pnl).toFixed(2);
  const total_r_sum = sum((a) => a.r_sum);
  const total_r_count = sum((a) => a.r_count);
  const any_halt = agents.some((a) => a.halt);
  return {
    generated: sysDateTime(),
    agents,
    aggregate: {
      total_equity, total_active, total_closed, total_wins,
      combined_win_rate: total_closed ? +(total_wins / total_closed * 100).toFixed(0) : null,
      combined_avg_r: total_r_count ? +(total_r_sum / total_r_count).toFixed(2) : null,
      total_closed_pnl, any_halt,
    },
  };
}

// ---- rendu Markdown (PUR) ----
function renderPortfolio(p) {
  const sep = (x) => String(x).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const usd = (v) => v == null ? "—" : `${sep(Number(v).toFixed(0))} USDT`;
  const sgn = (v) => v == null ? "—" : `${v > 0 ? "+" : ""}${v}`;
  const pct = (v) => v == null ? "—" : `${v > 0 ? "+" : ""}${Number(v).toFixed(2)} %`;
  const ag = p.aggregate || {};

  let md = `${START}\n`;
  md += `> [!abstract]+ 💼 Portfolio live — ${p.generated}\n`;
  md += `> 💰 **${usd(ag.total_equity)}** (2 agents) · PnL clos **${sgn(ag.total_closed_pnl)} USDT** · `;
  md += `clôturés **${ag.total_closed}** (WR **${ag.combined_win_rate ?? "—"} %** · R ${ag.combined_avg_r ?? "—"}) · `;
  md += `positions actives **${ag.total_active}**${ag.any_halt ? " · 🛑 un breaker HALT" : ""}\n`;

  md += `\n##### 📊 Par agent\n`;
  md += `| Agent | Equity | Jour | DD | Breaker | Actives | Clos | WR | R moy | PnL clos |\n`;
  md += `|:--|--:|--:|--:|:--:|:--:|--:|--:|--:|--:|\n`;
  for (const a of p.agents) {
    md += `| **${a.name}** | ${usd(a.equity)} | ${pct(a.day_pnl_pct)} | ${a.dd_pct != null ? Number(a.dd_pct).toFixed(1) + " %" : "—"} | `;
    md += `${a.halt ? "🛑" : "🟢"} | ${a.active_n} (${a.open_n}o/${a.pending_n}p) | ${a.closed_n} | ${a.win_rate != null ? a.win_rate + " %" : "—"} | ${a.avg_r ?? "—"} | ${sgn(a.closed_pnl)} |\n`;
  }

  for (const a of p.agents) {
    md += `\n##### 🔓 ${a.name} — positions actives\n`;
    if (a.active.length) {
      md += `| Statut | Paire | Sens | Entrée | SL | Mark | uPnL |\n|:--|:--|:--:|--:|--:|--:|--:|\n`;
      for (const t of a.active) {
        const tl = Array.isArray(t.timeline) ? t.timeline : [];
        const last = tl.length ? tl[tl.length - 1] : null;
        const badge = t.status === "open" ? "🟢 open" : "⏳ pending";
        const entry = t.entry_actual ?? t.entry_planned ?? t.entry ?? "—";
        md += `| ${badge} | **${t.symbol}** | ${t.side || "—"} | ${entry} | ${t.stop_loss ?? "—"} | ${last && last.mark != null ? last.mark : "—"} | ${last && last.upnl != null ? sgn(+Number(last.upnl).toFixed(2)) : "—"} |\n`;
      }
    } else md += `_Aucune position active._\n`;
  }

  md += `\n*Régénéré à chaque routine par \`portfolio.js\` (déterministe, source = journaux des 2 agents).*\n`;
  md += END;
  return md;
}

// ---- wrappers fs ----
function gatherAgent(dir, name, env) {
  return aggregateAgent(readTrades(path.join(dir, "trades.jsonl")), readJson(path.join(dir, "equity.json")), { name, env });
}

function resolveDirs() {
  const agentDir = process.env.AGENT_TRADER_DIR || DIR;
  const scalpDir = process.env.SCALP_TRADER_DIR ||
    path.join(DIR, "..", "..", "scalp-trader", "trade-journal");
  return { agentDir, scalpDir };
}

function buildLive() {
  const { agentDir, scalpDir } = resolveDirs();
  const states = [gatherAgent(agentDir, "agent-trader")];
  if (fs.existsSync(path.join(scalpDir, "trades.jsonl"))) states.push(gatherAgent(scalpDir, "scalp-trader"));
  return buildPortfolio(states);
}

// Série equity downsamplée d'un agent (pour les courbes du dashboard). Lecture seule.
function equityHistory(dir, maxPoints = 200) {
  const st = readJson(path.join(dir, "equity.json"));
  const h = st && Array.isArray(st.history) ? st.history : [];
  if (h.length <= maxPoints) return h;
  const step = Math.ceil(h.length / maxPoints);
  const out = h.filter((_, i) => i % step === 0);
  if (out[out.length - 1] !== h[h.length - 1]) out.push(h[h.length - 1]);
  return out;
}

// Snapshot complet pour le dashboard : agrégat + courbes equity des 2 agents.
function dashboardData() {
  const { agentDir, scalpDir } = resolveDirs();
  const p = buildLive();
  const series = { "agent-trader": equityHistory(agentDir) };
  if (fs.existsSync(path.join(scalpDir, "trades.jsonl"))) series["scalp-trader"] = equityHistory(scalpDir);
  return Object.assign({}, p, { series });
}

// Injecte le bloc entre les marqueurs (réutilisé pour PORTFOLIO.md et la note Obsidian).
function injectBlock(text, block) {
  const i = text.indexOf(START), j = text.indexOf(END);
  if (i !== -1 && j !== -1 && j > i) return text.slice(0, i) + block + text.slice(j + END.length);
  const lines = text.split("\n");
  const h1 = lines.findIndex((l) => /^#\s/.test(l));
  if (h1 === -1) return text + "\n\n" + block + "\n";
  lines.splice(h1 + 1, 0, "", block, "");
  return lines.join("\n");
}

function run(argv) {
  const p = buildLive();
  if (argv && argv.includes("--json")) { process.stdout.write(JSON.stringify(p, null, 2)); return p; }
  const block = renderPortfolio(p);
  // 1) PORTFOLIO.md à la racine du repo agent-trader
  const mdPath = path.join(DIR, "..", "PORTFOLIO.md");
  const header = `# Portfolio live — agent-trader + scalp-trader\n\n> Vue unifiée des 2 agents (demo Bybit, comptes séparés). Régénéré à chaque routine.\n\n`;
  let existing = "";
  try { existing = fs.readFileSync(mdPath, "utf-8"); } catch (_) {}
  fs.writeFileSync(mdPath, existing.includes(START) ? injectBlock(existing, block) : header + block + "\n");
  // 2) note Obsidian (optionnelle, no-op si absente)
  const note = process.env.PORTFOLIO_NOTE_PATH ||
    path.join(DIR, "..", "..", "..", "tools", "obsidian", "02-Projets", "Portfolio-Trading.md");
  if (fs.existsSync(note)) {
    fs.writeFileSync(note, injectBlock(fs.readFileSync(note, "utf-8"), block));
    console.log(`portfolio: PORTFOLIO.md + Obsidian mis a jour`);
  } else {
    console.log(`portfolio: PORTFOLIO.md mis a jour (note Obsidian absente -> skip)`);
  }
  return p;
}

if (require.main === module) {
  try { run(process.argv.slice(2)); } catch (e) { console.error("(portfolio echec non-bloquant: " + e.message + ")"); }
}
module.exports = { aggregateAgent, buildPortfolio, renderPortfolio, gatherAgent, buildLive, injectBlock, run, resolveDirs, equityHistory, dashboardData };
