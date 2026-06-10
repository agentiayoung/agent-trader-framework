#!/usr/bin/env python3
"""
validate_pine.py — Linter statique Pine Script v6 pour agent-trader.

Vérifie les règles obligatoires de PINE_RULES.md sur chaque .pine de
tradingview/strategies/. Ce N'EST PAS un compilateur : la compilation réelle
se fait dans TradingView (Pine Editor / MCP tradingview-desktop). Ce script
attrape les erreurs de conformité structurelle avant le test manuel.

Usage:
    python tradingview/scripts/validate_pine.py
Exit code 0 si tous les fichiers passent, 1 sinon.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

STRAT_DIR = Path(__file__).resolve().parent.parent / "strategies"

# Fonctions techniques qui DOIVENT être préfixées ta.
TA_FUNCS = ["sma", "ema", "rsi", "atr", "highest", "lowest", "crossover",
            "crossunder", "stdev", "barssince"]


def check_file(path: Path) -> list[str]:
    errs: list[str] = []
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()

    # 1. //@version=6 en 1re ligne
    if not lines or lines[0].strip() != "//@version=6":
        errs.append("ligne 1 != '//@version=6'")

    # 2. Header strategy(...) avec params obligatoires
    for token in ["process_orders_on_close", "default_qty_type",
                  "commission_value", "slippage", "initial_capital"]:
        if token not in text:
            errs.append(f"header: '{token}' manquant")
    if not re.search(r"commission_value\s*=\s*0\.05", text):
        errs.append("commission_value != 0.05")

    # 3. Pas de security()
    if re.search(r"\bsecurity\s*\(", text) or "request.security" in text:
        errs.append("security() interdit")

    # 4. Fonctions techniques préfixées ta. (hors commentaires)
    code = "\n".join(l.split("//")[0] for l in lines)
    for fn in TA_FUNCS:
        # match fn( non précédé de . ou lettre (donc pas ta.fn ni motfn)
        if re.search(rf"(?<![.\w]){fn}\s*\(", code):
            errs.append(f"'{fn}(' sans préfixe ta.")

    # 5. input typé, jamais input() seul
    if re.search(r"(?<![.\w])input\s*\(", code):
        errs.append("input() générique interdit (utiliser input.int/float/bool/time)")

    # 6. Kill switch
    if "strategy.close_all" not in text:
        errs.append("kill switch (strategy.close_all) manquant")
    if "Kill Switch" not in text:
        errs.append("input Kill Switch manquant")

    # 7. SL/TP via strategy.exit
    if "strategy.exit" not in text:
        errs.append("aucun strategy.exit (SL/TP)")

    # 8. Labels signaux + plots linebr
    if "label.style_label_up" not in text or "label.style_label_down" not in text:
        # 04 est long-only -> seulement label_up admis
        if "04_price_channels" not in path.name:
            errs.append("labels ▲/▼ manquants")
        elif "label.style_label_up" not in text:
            errs.append("label ▲ manquant")
    if "plot.style_linebr" not in text:
        errs.append("plots SL/TP plot.style_linebr manquants")

    # 9. Groupes inputs
    for grp in ["📈 Entrée", "🛡️ Risque", "👁️ Affichage"]:
        if grp not in text:
            errs.append(f"groupe input '{grp}' manquant")

    # 10. Backtest window + webhook + garde-fou
    if 'timestamp("2025-01-01")' not in text:
        errs.append("from_date timestamp(2025-01-01) manquant")
    if "WEBHOOK" not in text:
        errs.append("commentaire webhook manquant")
    if "strategy.closedtrades < 200" not in text:
        errs.append("garde-fou <200 trades manquant")

    # Hard limit 200 lignes
    if len(lines) > 200:
        errs.append(f"{len(lines)} lignes > 200")

    return errs


def main() -> int:
    # Bibliothèque de référence = fichiers numérotés NN_*.pine uniquement.
    # Les .pine héités d'autres sessions (UPPERCASE) ne sont pas concernés.
    files = sorted(f for f in STRAT_DIR.glob("*.pine")
                   if re.match(r"\d{2}_", f.name))
    if not files:
        print("Aucun .pine de bibliothèque (NN_*.pine) trouvé dans", STRAT_DIR)
        return 1

    all_ok = True
    for f in files:
        errs = check_file(f)
        nlines = len(f.read_text(encoding="utf-8").splitlines())
        if errs:
            all_ok = False
            print(f"❌ {f.name} ({nlines} lignes)")
            for e in errs:
                print(f"     - {e}")
        else:
            print(f"✅ {f.name} ({nlines} lignes) — 10/10 conforme")

    print()
    print("RÉSULTAT :", "TOUS CONFORMES ✅" if all_ok else "ÉCHECS DÉTECTÉS ❌")
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
