"""What the SERVER said about each RS request in a capture (its own Server-Timing), and what the
browser waited beyond that. One line per capture, so a before and an after read side by side.

usage: python server_stage_report.py <run.json> [<run.json> ...]
"""
import json, re, sys

def q(xs, p):
    xs = sorted(xs)
    return round(xs[min(len(xs) - 1, int(len(xs) * p))]) if xs else None

for path in sys.argv[1:]:
    o = json.load(open(path, encoding="utf-8"))
    cold, disk, cache, bars = [], [], [], []
    for f in o["flips"]:
        for r in f.get("res", []):
            u, st = r["u"], r.get("st") or ""
            dur = r["e"] - r["s"]
            if u.startswith("/api/bars/"):
                bars.append({"dur": dur, "ttfb": r.get("ttfb")})
            if "/api/signature/columns" not in u:
                continue
            m = re.search(r"rs\((\w+)\)=(\d+)", st)
            if not m:
                continue
            stages = {k: int(v) for k, v in re.findall(r"rs-(\w+)=(\d+)", st)}
            rec = {"total": int(m.group(2)), "ttfb": r.get("ttfb") or 0, "dur": dur, **stages}
            {"cold": cold, "disk": disk, "cache": cache}.get(m.group(1), cold).append(rec)
    name = path.replace("\\", "/").split("/")[-1]
    print(f"{name} | {o.get('list', {}).get('name')} | {o.get('startedUtc', '')[:19]}Z")
    for label, rows in (("computed (cold)", cold), ("read from the file (disk)", disk), ("from memory (cache)", cache)):
        if not rows:
            print(f"   RS {label}: none"); continue
        wait = [x["ttfb"] - x["total"] for x in rows]
        print(f"   RS {label}: n={len(rows)} | server total median {q([x['total'] for x in rows], .5)} p90 {q([x['total'] for x in rows], .9)} max {max(x['total'] for x in rows)} ms"
              f" | bars median {q([x.get('bars', 0) for x in rows], .5)} p90 {q([x.get('bars', 0) for x in rows], .9)} max {max(x.get('bars', 0) for x in rows)}"
              f" | rating median {q([x.get('rating', 0) for x in rows], .5)} | compute median {q([x.get('compute', 0) for x in rows], .5)} p90 {q([x.get('compute', 0) for x in rows], .9)}"
              f" | waited beyond the server's own time: median {q(wait, .5)} p90 {q(wait, .9)} max {max(wait)}")
    if bars:
        print(f"   /api/bars: n={len(bars)} median {q([b['dur'] for b in bars], .5)} p90 {q([b['dur'] for b in bars], .9)} max {max(b['dur'] for b in bars)} ms")
