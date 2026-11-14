"""What is the web pod busy with? Sample its own admin-only thread report many times and add it up.

Signs in as the synthetic admin account (SMOKE_EMAIL / SMOKE_PASSWORD from the environment, never
printed), reads GET /api/health/thread-stacks N times, signs out. Read-only: it creates nothing.

usage: python pod_thread_profile.py [samples=60] [gap_ms=250] [out.json]
"""
import http.cookiejar
import json
import os
import sys
import time
import urllib.request

BASE = "https://uctintelligence.com"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
N = int(sys.argv[1]) if len(sys.argv) > 1 else 60
GAP = (int(sys.argv[2]) if len(sys.argv) > 2 else 250) / 1000.0
OUT = sys.argv[3] if len(sys.argv) > 3 else None

jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def call(path, body=None, timeout=30):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, method="POST" if body is not None else "GET",
                                 headers={"User-Agent": UA, "Content-Type": "application/json", "Accept": "application/json"})
    t0 = time.perf_counter()
    with opener.open(req, timeout=timeout) as r:
        raw = r.read()
    return json.loads(raw or b"null"), (time.perf_counter() - t0) * 1000


email, pw = os.environ.get("SMOKE_EMAIL"), os.environ.get("SMOKE_PASSWORD")
if not email or not pw:
    sys.exit("SMOKE_EMAIL / SMOKE_PASSWORD are not in the environment")
call("/api/auth/login", {"email": email, "password": pw})
me, _ = call("/api/auth/me")
who = (me.get("user") or me)
if not str(who.get("email", "")).endswith("@uctintelligence.internal") or who.get("role") != "admin":
    sys.exit("not signed in as the synthetic admin account")

# a wait is not work: these are where an idle thread sits
IDLE = ("wait", "sleep", "select", "poll", "accept", "recv", "read", "get", "_worker", "run_forever", "acquire", "join", "monotonic")
by_loc, samples, lat, totals, callers = {}, {}, [], [], {}
try:
    for i in range(N):
        try:
            snap, ms = call("/api/health/thread-stacks")
        except Exception as e:  # a restart, a timeout: keep what we have
            print(f"sample {i}: {type(e).__name__}")
            time.sleep(GAP)
            continue
        lat.append(ms)
        totals.append(snap.get("total", 0))
        for loc, n in (snap.get("by_location") or {}).items():
            by_loc[loc] = by_loc.get(loc, 0) + n
        for k, st in (snap.get("samples") or {}).items():
            samples.setdefault(k, st)
            # the callers seen under each location, across samples (the report keeps one stack per location per call)
            callers.setdefault(k, {})
            sig = " < ".join(reversed(st[:-1]))[:260]
            callers[k][sig] = callers[k].get(sig, 0) + 1
        time.sleep(GAP)
finally:
    try:
        call("/api/auth/logout", {})
    except Exception:
        pass

lat.sort()
n = len(lat)
print(f"samples {n} | threads {min(totals)}..{max(totals)} | the report itself took: median {lat[n // 2]:.0f} ms, p90 {lat[int(n * 0.9)]:.0f} ms, max {lat[-1]:.0f} ms")


def idle(loc):
    fn = loc.rsplit(":", 1)[-1].lower()
    return any(fn == w or fn.startswith(w) or fn.endswith(w) for w in IDLE)


rows = sorted(by_loc.items(), key=lambda kv: -kv[1])
busy = [(k, v) for k, v in rows if not idle(k)]
print("\nthread-samples NOT in a plain wait (thread group @ file:line:function), per sample on average:")
for k, v in busy[:28]:
    print(f"  {v / n:6.2f}  {k}")
print("\nthe biggest groups of waiting threads:")
for k, v in [(k, v) for k, v in rows if idle(k)][:10]:
    print(f"  {v / n:6.2f}  {k}")
print()
print("callers seen under the bar store's reader and writer (times seen):")
for k in sorted(callers):
    if "bars_sqlite" not in k:
        continue
    print(" ", k)
    for sig, c in sorted(callers[k].items(), key=lambda kv: -kv[1])[:8]:
        print(f"     {c:3d}  {sig}")
if OUT:
    json.dump({"n": n, "by_loc": by_loc, "samples": samples, "lat": lat, "totals": totals, "callers": callers}, open(OUT, "w"), indent=1)
