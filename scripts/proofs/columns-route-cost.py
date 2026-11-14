"""One columns-batch request through the real route (five RS definitions from memory), the route as it
is against the framework's own path. In-process, synthetic bars, nothing read from a data directory."""
import json, os, statistics, sys, time
sys.path.insert(0, ".")
os.environ["RS_ENVELOPE_STORE"] = "0"
from fastapi import FastAPI
from fastapi.testclient import TestClient
from api.middleware.auth_middleware import get_current_user_with_plan
from api.routers import signature as sig
from api.services import rs_benchmarks as rb
from api.services.signature import registry_defs as rd, rs_provider as rsp
from api.services.cache import cache
from tests.test_rs_columns_provider import _long_daily, _fetcher
rd._BY_ID["rsLine"] = rd._rs_line_row(True, True); rd.RS_V2_ENABLED = True
for row in rd.RS_SPLIT_DEFS:
    rd._BY_ID[row["id"]] = row; rd._PROVIDERS[row["id"]] = sig.RS_SPLIT_PROVIDERS[row["id"]]
rd.SERVER_DEFS = tuple(rd.SERVER_DEFS) + tuple(rd.RS_SPLIT_DEFS)
rsp._rs_data_generation = lambda now=None: "r-|e-"
rb._groups_for = lambda s: {"sector": "Technology", "industry": "Semiconductors"}
sig._rs_warm_bars = lambda *a, **k: None
sig._fetch_bars_for_tf = _fetcher(_long_daily(n=1300))
sig.is_paid_user = lambda u: True
cache.clear(); rsp.rs_core_reset()
app = FastAPI(); app.include_router(sig.router)
app.dependency_overrides[get_current_user_with_plan] = lambda: {"id": 1, "plan": "pro", "role": "user"}
c = TestClient(app)
P = {"sym": "NVDA", "tf": "D", "asks": json.dumps([{"defId": d} for d in ("rsLine", "rsRating", "rsPhases", "rsVsEma", "rsExit")])}
c.get("/api/signature/columns-batch", params=P)          # cold: fills memory
def med(n=15):
    xs = []
    for _ in range(n):
        t = time.perf_counter(); r = c.get("/api/signature/columns-batch", params=P); xs.append((time.perf_counter() - t) * 1000.0)
    return statistics.median(xs), len(r.content)
new, size = med()
real = sig._columns_response
sig._columns_response = lambda body, sub: body
old, size2 = med()
sig._columns_response = real
print("one columns-batch request from memory, %d bytes, through the whole route in-process:" % size)
print("   the framework's own path (before): %.1f ms median" % old)
print("   a finished response (this change): %.1f ms median" % new)
