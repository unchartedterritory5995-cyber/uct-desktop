"""The web pod's admin cache health read (the RS envelope store's counters since boot).

Signs in as the synthetic admin account (SMOKE_EMAIL / SMOKE_PASSWORD from the environment, never
printed), reads GET /api/health/cache once, signs out. Read-only.
"""
import http.cookiejar, json, os, urllib.request
BASE = "https://uctintelligence.com"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
def call(path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, method="POST" if body is not None else "GET",
                                 headers={"User-Agent": UA, "Content-Type": "application/json", "Accept": "application/json"})
    with opener.open(req, timeout=30) as r:
        return json.loads(r.read().decode() or "null")
email, pw = os.environ.get("SMOKE_EMAIL"), os.environ.get("SMOKE_PASSWORD")
assert email and pw, "SMOKE_EMAIL / SMOKE_PASSWORD are not set"
call("/api/auth/login", {"email": email, "password": pw})
try:
    out = call("/api/health/cache")
    st = out.get("rs_envelope_store")
    print("rs_envelope_store:", json.dumps(st))
    if st and st.get("free_bytes") is not None:
        print("volume free at the last sweep: %.1f GB | rows kept: %.1f MB of a %.0f MB cap" % (st["free_bytes"] / 1e9, (st.get("kept_bytes") or 0) / 1e6, st["cap_bytes"] / 1e6))
    h = call("/api/health")
    print("uptime", h.get("uptime_seconds"))
finally:
    try: call("/api/auth/logout", {})
    except Exception: pass
