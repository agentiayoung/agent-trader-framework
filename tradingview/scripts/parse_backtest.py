#!/usr/bin/env python3
"""Parse les scrapes du Strategy Tester (CSV/raw_*.json) -> backtest_results.csv."""
import json, re, glob, os, csv

CSV_DIR = os.path.join(os.path.dirname(__file__), "..", "CSV")


def num(s):
    if s is None:
        return None
    s = s.replace("−", "-").replace(" ", "").replace("\xa0", "")
    s = s.replace(" ", "").replace(" ", "").replace("USDT", "")
    s = s.replace("%", "").strip()
    # milliers "1,80K" -> on ignore K/M pour les ratios
    s = s.replace(",", ".")
    m = re.match(r"-?\d+(\.\d+)?", s)
    return float(m.group(0)) if m else None


def grab(t, label, after_lines=1):
    """Renvoie la valeur (ligne) après le label."""
    idx = t.find(label)
    if idx < 0:
        return None
    rest = t[idx + len(label):].lstrip("\n").split("\n")
    return rest[after_lines - 1] if len(rest) >= after_lines else None


def parse(t):
    r = {}
    # P&L total (1re occurrence)
    r["pnl_usdt"] = num(grab(t, "P&L total\n"))
    # Profit factor
    r["profit_factor"] = num(grab(t, "Facteur de profit\n"))
    # Win rate + trades (Trades rentables\n43,18%\n342/792)
    m = re.search(r"Trades rentables\n([\d.,]+)%\n(\d+)/(\d+)", t)
    if m:
        r["win_rate_pct"] = num(m.group(1))
        r["wins"] = int(m.group(2))
        r["total_trades"] = int(m.group(3))
    # Sharpe
    r["sharpe"] = num(grab(t, "Ratio de Sharpe\n"))
    # Max drawdown (Baisse maximale\n742,49\nUSDT\n0,74%)
    m = re.search(r"Baisse maximale\n[\d.,−-]+\nUSDT\n([\d.,]+)%", t)
    if m:
        r["max_dd_pct"] = num(m.group(1))
    # Avg P&L
    r["avg_pnl_usdt"] = num(grab(t, "P&L moyen\n"))
    return r


def main():
    rows = []
    for f in sorted(glob.glob(os.path.join(CSV_DIR, "raw_*.json"))):
        name = os.path.basename(f)[4:].replace(".json", "")
        try:
            t = json.load(open(f, encoding="utf-8")).get("result", "")
        except Exception:
            t = ""
        if not t or t == "NOTFOUND":
            rows.append({"strategy": name, "status": "NO DATA (0 trades / non rendu)"})
            continue
        r = parse(t)
        r["strategy"] = name
        r["status"] = "OK"
        rows.append(r)

    cols = ["strategy", "status", "total_trades", "win_rate_pct", "profit_factor",
            "pnl_usdt", "max_dd_pct", "sharpe", "avg_pnl_usdt"]
    out = os.path.join(CSV_DIR, "backtest_results.csv")
    with open(out, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=cols)
        w.writeheader()
        for r in rows:
            w.writerow({c: r.get(c, "") for c in cols})

    # affichage console
    print(f"{'strategy':<28}{'trades':>8}{'WR%':>8}{'PF':>8}{'PnL':>10}{'DD%':>8}{'Sharpe':>9}")
    for r in rows:
        if r.get("status") != "OK":
            print(f"{r['strategy']:<28}  {r['status']}")
            continue
        print(f"{r['strategy']:<28}{r.get('total_trades',''):>8}{r.get('win_rate_pct',''):>8}"
              f"{r.get('profit_factor',''):>8}{r.get('pnl_usdt',''):>10}{r.get('max_dd_pct',''):>8}{r.get('sharpe',''):>9}")
    print("\nCSV ->", out)


if __name__ == "__main__":
    main()
