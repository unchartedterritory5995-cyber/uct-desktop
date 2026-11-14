"""What does it cost to turn one columns-batch answer (five RS definitions, one symbol) into a response?
FastAPI's default path for a returned dict (jsonable_encoder, then json.dumps) against handing it a
JSONResponse. Synthetic 1,300-bar daily series; nothing is read from any data directory.
"""
import json, os, statistics, sys, time, tempfile
sys.path.insert(0, ".")
os.environ["RS_ENVELOPE_STORE"] = "0"
from fastapi.encoders import jsonable_encoder
from starlette.responses import JSONResponse
from api.routers import signature as sig
from api.services import rs_benchmarks as rb
from api.services.signature import registry_defs as rd, rs_provider as rsp
from api.services.cache import cache
from tests.test_rs_columns_provider import _long_daily, _fetcher
rd._BY_ID["rsLine"] = rd._rs_line_row(True, True); rd.RS_V2_ENABLED = True
for row in rd.RS_SPLIT_DEFS:
    rd._BY_ID[row["id"]] = row; rd._PROVIDERS[row["id"]] = sig.RS_SPLIT_PROVIDERS[row["id"]]
rsp._rs_data_generation = lambda now=None: "r-|e-"
rb._groups_for = lambda s: {"sector": "Technology", "industry": "Semiconductors"}
sig._rs_warm_bars = lambda *a, **k: None
sig._fetch_bars_for_tf = _fetcher(_long_daily(n=1300))
cache.clear(); rsp.rs_core_reset()
IDS = ("rsLine", "rsRating", "rsPhases", "rsVsEma", "rsExit")
def body():
    return {"sym": "NVDA", "tf": "D", "results": [{"status": 200, "envelope": sig._serve_columns(d, "NVDA", "D", None)} for d in IDS]}
b = body()            # cold
def med(fn, n=7):
    xs = []
    for _ in range(n):
        t = time.perf_counter(); fn(); xs.append((time.perf_counter() - t) * 1000.0)
    return statistics.median(xs)
enc = jsonable_encoder(b)
a = JSONResponse(content=enc).body
d = JSONResponse(content=b).body
print("serving the five answers from memory (the lane: validate + copy every column):  %.1f ms" % med(body))
print("jsonable_encoder (what FastAPI does to a returned dict):                         %.1f ms" % med(lambda: jsonable_encoder(b)))
print("json.dumps inside JSONResponse (what is left when a Response is returned):       %.1f ms" % med(lambda: JSONResponse(content=b)))
print("response bytes: %d | identical either way: %s" % (len(a), a == d))
