#!/usr/bin/env node
"use strict";
/**
 * export-public.js — Derive a CLEAN, PUBLIC snapshot of agent-trader from the
 * private working repo. Security model = ALLOWLIST (nothing ships unless it is
 * explicitly listed) + text transforms (parameterize paths, redact PII) + a HARD
 * forbidden-pattern scan that ABORTS the build if any secret/PII leaks through.
 *
 * Output: ./dist-public/  (gitignored). NEVER pushes anything — review then
 * `git init` + push by hand. Re-run anytime to refresh the public snapshot.
 *
 * Run: node scripts/export-public.js
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "dist-public");
const PUBLIC_SRC = path.join(ROOT, "public"); // hand-written public docs (README/LICENSE/...)

// Universe = git-tracked files only. Respects .gitignore automatically (no .venv,
// node_modules, data/, logs, etc.) -> the allowlist filters ON TOP of this set.
const TRACKED = new Set(
  execSync("git ls-files", { cwd: ROOT, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 })
    .split(/\r?\n/).filter(Boolean).map((p) => p.replace(/^"|"$/g, "")),
);

// ── ALLOWLIST ──────────────────────────────────────────────────────────────
// Directories copied recursively (with per-dir excludes). The framework only.
const ALLOW_DIRS = [
  { dir: "trade-journal", exclude: ["obsidian-sync.js", "obsidian-trades-sync.js", "JOURNAL.md", "LESSONS.md", "DASHBOARD.md", "trades.jsonl", "equity.json", "optimize-history", "trades"] },
  { dir: "skills/bybit", exclude: ["node_modules"] },
  { dir: "skills/shared/tradingview", exclude: ["node_modules"] },
  { dir: "tests", exclude: ["test-obsidian-sync.js"] },
  { dir: "routines", exclude: ["vps", "logs"] },
  { dir: "scripts", exclude: ["logs", "export-public.js"] },
  { dir: "tradingview/pine", exclude: ["pinescriptv6-ref"] },
  { dir: "tradingview/scripts", exclude: ["run_hbar_d1_validation.ps1", "run_hbar_d1_validation.sh"] },
  { dir: "tradingview/webhook", exclude: ["signals_test", "__pycache__"] },
  { dir: "tradingview/executor", exclude: ["signals", "processed"] },
  { dir: "tradingview/indicateurs", exclude: [] },
];
// Individual files copied as-is (with transforms).
const ALLOW_FILES = [
  ".env.example",
  ".gitignore",
  ".dockerignore",
  "docker-compose.yml",
  "tradingview/PINE_RULES.md",
  "tradingview/README_MCP.md",
  "tradingview/MCP_DESKTOP_TOOLS.md",
  "tradingview/MCP_SCREENER_TOOLS.md",
];
// Everything under ./public/ is copied to the dist ROOT (recursively) — README,
// LICENSE, CONTRIBUTING, SECURITY, CHANGELOG, package.json, .github/, .gitattributes...

// Strategy-bearing files get an "illustrative" banner prepended (genericization:
// the specific edge values in them are the author's overfit demo defaults).
const ILLUSTRATIVE_BANNER_MD =
  "> [!IMPORTANT]\n> The setup names, R-multiples, win-rates, and regime thresholds below are **illustrative defaults** from the author's own demo runs — almost certainly overfit. Re-validate out-of-sample (`optimize.js`) before trusting any number. See [DISCLAIMER.md](../DISCLAIMER.md).\n\n";
const ILLUSTRATIVE_BANNER_PS =
  "# NOTE: the edge values, R-multiples and findings embedded in the prompt below are\n# ILLUSTRATIVE defaults from the author's demo runs (overfit). Re-validate OOS before\n# trusting them. See DISCLAIMER.md.\n";
const BANNER_FILES = {
  "routines/trade-routine.md": (c) => ILLUSTRATIVE_BANNER_MD + c,
  "routines/run-routine.ps1": (c) => c.replace(/^(param\([^\n]*\)\r?\n)/m, "$1" + ILLUSTRATIVE_BANNER_PS),
};

// ── TEXT TRANSFORMS (applied to every copied text file) ──────────────────────
const ABS_PATH = "C:\\Users\\admin\\Desktop\\DEV CLAUDE CODE\\projets\\agent-trader";
const ABS_PATH_BASH = "/c/Users/admin/Desktop/DEV CLAUDE CODE";
// Public GitHub owner the repo is published under (replaces the OWNER placeholder in
// public docs). This handle is the PUBLIC repo owner, not secret -> set after redaction.
const GH_HANDLE = "agentiayoung";
function transform(content, relPath) {
  let c = content;
  // 0) Drop references to excluded personal tooling (Obsidian vault sync) so the
  //    public snapshot has no dangling references to files that aren't shipped.
  //    Scoped per-file to avoid breaking shell line-continuations.
  if (relPath.endsWith(".ps1")) {
    c = c.replace(/^.*obsidian-(?:trades-)?sync\.js.*$\r?\n?/gm, "");
  }
  if (relPath === "tests/run-all.sh") {
    // Remove the whole 2-line run_test block for the excluded obsidian-sync test.
    c = c.replace(/run_test "Obsidian sync \(offline\)" \\\r?\n\s*"node '[^"]*test-obsidian-sync\.js'"\r?\n?/g, "");
  }
  // 1) PowerShell project-root assignment -> derive from script location (path-agnostic).
  c = c.replace(/\$proj\s*=\s*"C:\\Users\\admin\\[^"]*agent-trader"/g, "$proj = Split-Path -Parent $PSScriptRoot");
  // 2) Generic absolute-path literals -> placeholder (case-insensitive drive letter).
  c = c.split(ABS_PATH).join("<PROJECT_ROOT>");
  c = c.split(ABS_PATH_BASH).join("<DEV_ROOT>");
  c = c.replace(/[A-Za-z]:\\Users\\admin/g, "<USER_HOME>");
  c = c.replace(/\/[A-Za-z]\/Users\/admin/g, "<USER_HOME>");
  // 3) PII / infra redaction.
  c = c.replace(/_HUGO\b/g, ""); // env var names: TELEGRAM_CHAT_ID_HUGO -> TELEGRAM_CHAT_ID
  c = c.replace(/Hugo Gil Pican[çc]o/gi, "the maintainer");
  c = c.replace(/\bGO Hugo\b/gi, "approved");
  c = c.replace(/\bHugo\b/gi, "the maintainer");
  c = c.replace(/Pican[çc]o/g, "");
  c = c.replace(/Carouge,?\s*Gen[èe]ve,?\s*Suisse romande/gi, "");
  c = c.replace(/\b(Carouge|Gen[èe]ve|Suisse romande)\b/gi, "");
  c = c.replace(/Integr?AI/gi, "");
  c = c.replace(/72\.62\.92\.204/g, "<VPS_IP>");
  c = c.replace(/agent\.ia\.young@gmail\.com/gi, "<EMAIL>");
  c = c.replace(/agentiayoung/gi, "<GH_USER>");
  c = c.replace(/https?:\/\/hc-ping\.com\/[^\s"'`]+/g, "<HEALTHCHECK_URL>");
  c = c.replace(/https?:\/\/healthchecks\.io\/[0-9a-f-]+/g, "<HEALTHCHECK_URL>");
  c = c.replace(/association-reverse-sound[^\s"'`]*/gi, "");
  // Last: fill the intentional OWNER placeholder in public docs with the real public
  // handle (done AFTER redaction so it is not re-scrubbed).
  c = c.replace(/OWNER/g, GH_HANDLE);
  return c;
}

// ── FORBIDDEN PATTERNS (post-build scan; any hit ABORTS) ─────────────────────
const FORBIDDEN = [
  /Hugo/i, /Pican/i, /Carouge/i, /Gen[èe]ve/i, /Integr?AI/i,
  /72\.62\.92\.204/, /C:\\Users\\admin/i, /\/c\/Users\/admin/i,
  /hc-ping\.com/i, /healthchecks\.io\/[0-9a-f]/i, /agent\.ia\.young/i,
  /association-reverse/i, /BYBIT_API_KEY\s*=\s*[A-Za-z0-9]{8,}/, /BYBIT_API_SECRET\s*=\s*\S{8,}/,
  /TELEGRAM_BOT_TOKEN\s*=\s*\d{6,}:[A-Za-z0-9_-]{20,}/,
];
const TEXT_EXT = new Set([".js", ".ts", ".py", ".md", ".sh", ".ps1", ".bat", ".json", ".yml", ".yaml", ".txt", ".pine", ".xml", ".example", ".gitignore", ".dockerignore"]);
function isText(f) { return TEXT_EXT.has(path.extname(f)) || /(^|\/)\.[^.]+$/.test(f) || path.basename(f).startsWith("."); }

let copied = 0, skipped = 0;
function rmrf(p) { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function copyFile(srcAbs, relPath) {
  const dst = path.join(OUT, relPath);
  ensureDir(path.dirname(dst));
  if (isText(srcAbs)) {
    let out = transform(fs.readFileSync(srcAbs, "utf-8"), relPath);
    if (BANNER_FILES[relPath]) out = BANNER_FILES[relPath](out);
    fs.writeFileSync(dst, out);
  } else {
    fs.copyFileSync(srcAbs, dst); // binary -> verbatim (rare; none expected in allowlist)
  }
  copied++;
}

function walkCopy(dirRel, excludes) {
  const srcDir = path.join(ROOT, dirRel);
  if (!fs.existsSync(srcDir)) { console.warn(`  ! allow-dir absent: ${dirRel}`); return; }
  for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (excludes.includes(ent.name)) { skipped++; continue; }
    const rel = path.posix.join(dirRel.split(path.sep).join("/"), ent.name);
    const abs = path.join(srcDir, ent.name);
    if (ent.isDirectory()) {
      if (["node_modules", ".git", ".venv", "__pycache__", "dist-public"].includes(ent.name)) { skipped++; continue; }
      walkCopy(rel, excludes);
    } else {
      if (!TRACKED.has(rel)) { skipped++; continue; } // git-tracked only
      copyFile(abs, rel);
    }
  }
}

function scan() {
  const hits = [];
  (function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(abs); continue; }
      if (!isText(abs)) continue;
      const rel = path.relative(OUT, abs);
      const lines = fs.readFileSync(abs, "utf-8").split(/\r?\n/);
      lines.forEach((ln, i) => {
        for (const re of FORBIDDEN) if (re.test(ln)) hits.push(`${rel}:${i + 1}  /${re.source}/  ${ln.trim().slice(0, 90)}`);
      });
    }
  })(OUT);
  return hits;
}

// ── BUILD ────────────────────────────────────────────────────────────────────
console.log("export-public: building clean snapshot ->", OUT);
rmrf(OUT);
ensureDir(OUT);

for (const { dir, exclude } of ALLOW_DIRS) walkCopy(dir, exclude);
for (const f of ALLOW_FILES) {
  const abs = path.join(ROOT, f);
  if (fs.existsSync(abs)) copyFile(abs, f);
  else console.warn(`  ! allow-file absent: ${f}`);
}
// Copy everything under ./public/ to the dist ROOT (recursively).
(function walkPublic(dirRel) {
  const srcDir = path.join(PUBLIC_SRC, dirRel);
  if (!fs.existsSync(srcDir)) { console.warn("  ! ./public/ absent"); return; }
  for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const rel = dirRel ? path.posix.join(dirRel, ent.name) : ent.name;
    if (ent.isDirectory()) walkPublic(rel);
    else copyFile(path.join(PUBLIC_SRC, rel), rel);
  }
})("");

console.log(`  copied: ${copied} files, skipped: ${skipped} entries`);

const hits = scan();
if (hits.length) {
  console.error(`\n  !! SCAN ANTI-FUITE: ${hits.length} occurrence(s) interdite(s) -> BUILD ABORTE`);
  hits.slice(0, 40).forEach((h) => console.error("   " + h));
  if (hits.length > 40) console.error(`   ... +${hits.length - 40} autres`);
  console.error("\n  Corriger transform()/ALLOWLIST puis re-lancer. dist-public laisse en l'etat pour inspection.");
  process.exit(1);
}
console.log("\n  OK: scan anti-fuite 0 occurrence. Snapshot propre.");
console.log("  Revue manuelle requise avant tout `git init` + push (action explicite).");
