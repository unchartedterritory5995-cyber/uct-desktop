import json, os, sys, time, zlib, tempfile, statistics
sys.path.insert(0, ".")
os.environ["RS_ENVELOPE_STORE"] = "1"
d = tempfile.mkdtemp(prefix="rs_store_measure_")
os.environ["RS_ENVELOPE_STORE_PATH"] = os.path.join(d, "rs.db")
from api.routers import signature as sig
from api.services import rs_benchmarks as rb
from api.services.signature import registry_defs as rd, rs_provider as rsp, rs_store
from api.services.cache import cache
from tests.test_rs_columns_provider import _long_daily, _fetcher
rd._BY_ID["rsLine"] = rd._rs_line_row(True, True); rd.RS_V2_ENABLED = True
for row in rd.RS_SPLIT_DEFS:
    rd._BY_ID[row["id"]] = row; rd._PROVIDERS[row["id"]] = sig.RS_SPLIT_PROVIDERS[row["id"]]
rsp._rs_data_generation = lambda now=None: "r-|e-"
rb._groups_for = lambda s: {"sector": "Technology", "industry": "Semiconductors"}
sig._rs_warm_bars = lambda *a, **k: None
for n in (1300, 5000):
    sig._fetch_bars_for_tf = _fetcher(_long_daily(n=n))
    cache.clear(); rsp.rs_core_reset()
    print(f"-- {n} daily bars")
    for def_id in ("rsLine", "rsRating", "rsPhases", "rsVsEma", "rsExit"):
        t = time.perf_counter(); rd.serve(def_id, "NVDA", "D", None); cold = (time.perf_counter() - t) * 1000
        ck = [k for k in cache.keys_with_prefix("sig:rs") if k.startswith(f"sig:{def_id}") or (def_id == "rsLine" and k.startswith("sig:rs5"))]
        env = cache.get(ck[-1]) if ck else None
        if env is None:
            print("   ", def_id, "no cache entry", cache.keys_with_prefix("sig:")[:6]); continue
        raw = json.dumps(env, separators=(",", ":")).encode()
        enc = []; dec = []
        for _ in range(5):
            t = time.perf_counter(); body = rs_store._encode(env); enc.append((time.perf_counter() - t) * 1000)
            t = time.perf_counter(); json.loads(zlib.decompress(body[2:])); dec.append((time.perf_counter() - t) * 1000)
        rs_store.flush()
        t = time.perf_counter(); got = rs_store.get(ck[-1]); rd_ms = (time.perf_counter() - t) * 1000
        print(f"   {def_id:9s} build {cold:7.1f} ms | json {len(raw)/1024:7.1f} KB -> kept {len(body)/1024:6.1f} KB | encode {statistics.median(enc):5.2f} ms | decode {statistics.median(dec):5.2f} ms | store.get {rd_ms:5.2f} ms hit={got is not None}")
print(rs_store.stats())
