#!/usr/bin/env node
"use strict";
// ═══════════════════════════════════════════════════════════════════
// obsidian-trades-sync.js — projette trades.jsonl en notes Obsidian datées
// (deuxième cerveau trading). DÉTERMINISTE, zéro LLM — même philosophie
// qu'obsidian-sync.js. Appelé en fin de routine (run-routine.ps1) + à la main.
//
// 1 entrée journal → 1 note `02-Projets/Agent-Trader/Trades/<id>.md`
// (markdown construit par trade-note.js, pur/testé). Le bloc NOTES-MANUELLES
// d'une note existante est PRÉSERVÉ (annotations Hugo jamais écrasées).
//
// Vault : OBSIDIAN_VAULT_PATH ou ../../../tools/obsidian (parité obsidian-sync).
// No-op gracieux si le vault est absent. Sortie JSON {written, updated,
// unchanged, skipped} (idempotent : pas de réécriture si contenu identique).
//
// Usage : node trade-journal/obsidian-trades-sync.js
// ═══════════════════════════════════════════════════════════════════

const fs = require("fs");
const path = require("path");
const { buildTradeNote, mergeManualBlock } = require("./trade-note.js");

const DIR = __dirname;
const FILE = path.join(DIR, "trades.jsonl");
const VAULT = process.env.OBSIDIAN_VAULT_PATH || path.join(DIR, "..", "..", "..", "tools", "obsidian");
const OUT_DIR = path.join(VAULT, "02-Projets", "Agent-Trader", "Trades");

function main() {
  if (!fs.existsSync(VAULT)) {
    console.log(JSON.stringify({ skipped: "vault introuvable", vault: VAULT }));
    return;
  }
  let trades = [];
  try {
    trades = fs.readFileSync(FILE, "utf-8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  } catch (e) {
    console.log(JSON.stringify({ skipped: "trades.jsonl illisible: " + e.message }));
    return;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  let written = 0, updated = 0, unchanged = 0, skipped = 0;
  for (const t of trades) {
    const note = buildTradeNote(t);
    if (!note) { skipped++; continue; }
    const dest = path.join(OUT_DIR, note.relpath);
    let existing = null;
    try { existing = fs.readFileSync(dest, "utf-8"); } catch (e) {}
    const content = mergeManualBlock(note.content, existing);
    if (existing === content) { unchanged++; continue; }
    fs.writeFileSync(dest, content);
    existing === null ? written++ : updated++;
  }
  console.log(JSON.stringify({ written, updated, unchanged, skipped, dir: OUT_DIR }));
}

main();
