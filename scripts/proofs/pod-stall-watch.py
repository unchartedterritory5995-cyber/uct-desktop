"""One small signed-in request per second against production for N seconds, with the pod's uptime:
when do ALL requests stall, and for how long? Synthetic MEMBER account (BENCH_EMAIL / BENCH_PASSWORD
from the environment, never printed); signs out at the end. Read-only GETs.

usage: python pod-stall-watch.py <seconds> <out.json>
"""
import http.client, json, os, ssl, sys, time
HOST = "uctintelligence.com"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
SECS, OUT = int(sys.argv[1]), sys.argv[2]
ctx = ssl.create_default_context()
conn = lambda: http.client.HTTPSConnection(HOST, timeout=30, context=ctx)
email, pw = os.environ.get("BENCH_EMAIL"), os.environ.get("BENCH_PASSWORD")
assert email and pw, "BENCH_EMAIL / BENCH_PASSWORD are not set"
c0 = conn()
c0.request("POST", "/api/auth/login", body=json.dumps({"email": email, "password": pw}), headers={"Content-Type": "application/json", "User-Agent": UA})
r = c0.getresponse(); r.read()
assert r.status == 200, f"login {r.status}"
cookie = "; ".join(v.split(";", 1)[0] for k, v in r.getheaders() if k.lower() == "set-cookie")
rows = []
c = conn()
t_end = time.time() + SECS
try:
    while time.time() < t_end:
        t = time.time()
        row = {"at": t}
        for name, path, ck in (("health", "/api/health", None), ("delisted", "/api/delisted/NVDA", cookie)):
            h = {"User-Agent": UA}
            if ck: h["Cookie"] = ck
            s = time.perf_counter()
            try:
                c.request("GET", path, headers=h); resp = c.getresponse(); body = resp.read()
                row[name] = round((time.perf_counter() - s) * 1000)
                if name == "health":
                    try: row["uptime"] = json.loads(body).get("uptime_seconds")
                    except Exception: pass
            except Exception as e:
                row[name] = None; row["err"] = type(e).__name__; c = conn()
        rows.append(row)
        time.sleep(max(0, 1 - (time.time() - t)))
finally:
    try:
        c0 = conn(); c0.request("POST", "/api/auth/logout", body="{}", headers={"Content-Type": "application/json", "Cookie": cookie, "User-Agent": UA}); c0.getresponse().read()
    except Exception: pass
json.dump(rows, open(OUT, "w"))
slow = [r for r in rows if (r.get("delisted") or 0) > 1000 or (r.get("health") or 0) > 1000]
print(f"{len(rows)} samples, uptime {rows[0].get('uptime')} -> {rows[-1].get('uptime')} s | over 1 s: {len(slow)}")
d = sorted(r["delisted"] for r in rows if r.get("delisted")); h = sorted(r["health"] for r in rows if r.get("health"))
print(f"delisted median {d[len(d)//2]} p90 {d[int(len(d)*.9)]} max {d[-1]} | health median {h[len(h)//2]} p90 {h[int(len(h)*.9)]} max {h[-1]}")
for r in slow: print(f"   uptime {r.get('uptime')} s: health {r.get('health')} ms, delisted {r.get('delisted')} ms {r.get('err','')}")
