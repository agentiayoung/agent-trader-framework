import sys, json, re
t = json.load(sys.stdin).get("result", "")
if not t or t == "NOTFOUND":
    print("  NO DATA"); sys.exit()
def g(l):
    i = t.find(l)
    return t[i+len(l):].lstrip("\n").split("\n")[0] if i >= 0 else "?"
m = re.search(r"Trades rentables\n([\d.,]+)%\n(\d+)/(\d+)", t)
dd = re.search(r"Baisse maximale\n[\d.,−-]+\nUSDT\n([\d.,]+)%", t)
wr = m.group(1) if m else "?"
tr = m.group(3) if m else "?"
print(f"  WR={wr}%  trades={tr}  PF={g('Facteur de profit')}  PnL={g('P&L total')}  DD={dd.group(1) if dd else '?'}%")
