"""Where is the web pod's per-request floor? The same tiny requests, one at a time and twelve at once,
signed in and not. Read-only GETs as the synthetic MEMBER account (BENCH_EMAIL / BENCH_PASSWORD from the
environment, never printed); signs out at the end.

usage: python pod_request_floor.py [rounds=30] [parallel=12]
"""
import http.client, json, os, ssl, statistics, sys, threading, time
HOST = "uctintelligence.com"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
ROUNDS = int(sys.argv[1]) if len(sys.argv) > 1 else 30
PAR = int(sys.argv[2]) if len(sys.argv) > 2 else 12
ctx = ssl.create_default_context()

def conn():
    return http.client.HTTPSConnection(HOST, timeout=30, context=ctx)

def get(c, path, cookie=None):
    h = {"User-Agent": UA, "Accept": "application/json"}
    if cookie: h["Cookie"] = cookie
    t = time.perf_counter()
    c.request("GET", path, headers=h)
    r = c.getresponse(); body = r.read()
    return (time.perf_counter() - t) * 1000.0, r.status, len(body), r.getheader("Server-Timing") or ""

email, pw = os.environ.get("BENCH_EMAIL"), os.environ.get("BENCH_PASSWORD")
assert email and pw, "BENCH_EMAIL / BENCH_PASSWORD are not set"
c0 = conn()
c0.request("POST", "/api/auth/login", body=json.dumps({"email": email, "password": pw}),
           headers={"User-Agent": UA, "Content-Type": "application/json"})
r = c0.getresponse(); r.read()
assert r.status == 200, f"sign-in answered {r.status}"
cookie = "; ".join(v.split(";", 1)[0] for k, v in r.getheaders() if k.lower() == "set-cookie")
PATHS = [("not signed in, trivial", "/api/health", None),
         ("signed in, identity only", "/api/auth/me", cookie),
         ("signed in + paid gate, tiny", "/api/delisted/NVDA", cookie),
         ("signed in + paid gate, tiny", "/api/signature/rs-themes", cookie)]
def q(xs, p):
    xs = sorted(xs); return xs[min(len(xs) - 1, int(len(xs) * p))]
try:
    print(f"ONE AT A TIME ({ROUNDS} each, one kept-alive connection):")
    for label, path, ck in PATHS:
        c = conn(); get(c, path, ck)                      # the handshake is thrown away
        xs = []; st = 0
        for _ in range(ROUNDS):
            ms, st, n, _t = get(c, path, ck); xs.append(ms); time.sleep(0.05)
        print(f"   {label:30s} {path:28s} status {st} | median {statistics.median(xs):5.0f} ms  p90 {q(xs, .9):5.0f}  max {max(xs):5.0f}")
        c.close()
    print(f"{PAR} AT ONCE ({ROUNDS // 3} rounds, {PAR} kept-alive connections fired together):")
    for label, path, ck in PATHS:
        cs = [conn() for _ in range(PAR)]
        for c in cs: get(c, path, ck)
        xs = []
        for _ in range(max(3, ROUNDS // 3)):
            out = [None] * PAR; go = threading.Event()
            def one(i):
                go.wait(); out[i] = get(cs[i], path, ck)[0]
            ts = [threading.Thread(target=one, args=(i,)) for i in range(PAR)]
            for t in ts: t.start()
            go.set()
            for t in ts: t.join()
            xs.extend(out); time.sleep(0.3)
        print(f"   {label:30s} {path:28s} | median {statistics.median(xs):5.0f} ms  p90 {q(xs, .9):5.0f}  max {max(xs):5.0f}")
        for c in cs: c.close()
finally:
    try:
        c0.request("POST", "/api/auth/logout", body="{}", headers={"User-Agent": UA, "Content-Type": "application/json", "Cookie": cookie}); c0.getresponse().read()
    except Exception: pass
