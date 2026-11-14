"""How long does the web pod take to answer a trivial request, with the connection already open?

Unauthenticated, read-only. Each host gets ONE kept-alive HTTPS connection; the first request on it
(which pays the TLS handshake) is thrown away.

usage: python pod_latency.py [n=30] [gap_ms=150]
"""
import http.client
import ssl
import sys
import time

N = int(sys.argv[1]) if len(sys.argv) > 1 else 30
GAP = (int(sys.argv[2]) if len(sys.argv) > 2 else 150) / 1000.0
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
TARGETS = [
    ("through the CDN  ", "uctintelligence.com", "/api/health"),
    ("through the CDN  ", "uctintelligence.com", "/api/ready"),
    ("straight to host ", "web-production-05cb6.up.railway.app", "/api/health"),
]


def series(host, path):
    conn = http.client.HTTPSConnection(host, timeout=30, context=ssl.create_default_context())
    out = []
    try:
        for i in range(N + 1):
            t0 = time.perf_counter()
            conn.request("GET", path, headers={"User-Agent": UA, "Accept": "application/json", "Connection": "keep-alive"})
            r = conn.getresponse()
            first = time.perf_counter() - t0
            r.read()
            if i:
                out.append(first * 1000)
            time.sleep(GAP)
    finally:
        conn.close()
    return sorted(out)


for label, host, path in TARGETS:
    try:
        v = series(host, path)
    except Exception as e:
        print(f"{label} {path:14s} FAILED {type(e).__name__}: {str(e)[:80]}")
        continue
    n = len(v)
    print(f"{label} {path:14s} n={n}  min {v[0]:.0f}  median {v[n // 2]:.0f}  p90 {v[int(n * 0.9)]:.0f}  max {v[-1]:.0f} ms"
          f"   over 250 ms: {sum(1 for x in v if x > 250)}  over 500 ms: {sum(1 for x in v if x > 500)}")
