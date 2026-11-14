"""The bar store's reader: row by row vs one step, alone and beside busy threads. Sandbox data only.

usage: python get_bars_bench.py <repo> <sandbox data dir>
"""
import os
import statistics
import sys
import threading
import time

repo, data_dir = sys.argv[1], sys.argv[2]
assert "data-indinstant" in data_dir.lower(), "sandbox data dir only"
os.environ["DATA_DIR"] = data_dir
sys.path.insert(0, repo)
sys.setswitchinterval(0.0005)            # what the web process runs with (PY_SWITCH_INTERVAL_MS default)

from api.services import bars_sqlite as b  # noqa: E402

rows_reader = getattr(b, "_get_bars_rows", None) or b.ROW_READER
conn = b._conn()
# the series with the most rows per timeframe in the sandbox
deep = {}
for tf in ("D", "5", "1"):
    r = conn.execute("SELECT ticker, count(*) n FROM ohlcv WHERE tf=? GROUP BY ticker ORDER BY n DESC LIMIT 6", (tf,)).fetchall()
    deep[tf] = r
    print("deepest", tf, [(t, n) for t, n in r[:3]])
print("one-step read proven on this sqlite:", b.packed_reads_proven())

CASES = [("D", 60), ("D", 400), ("D", 5000), ("D", 12000), ("5", 5000), ("1", 20000), ("1", 50000)]
stop = False


def busy():
    x = 0
    while not stop:
        x = (x * 31 + 7) % 1000003


def bench(label):
    print(f"-- {label}")
    for tf, n in CASES:
        syms = [t for t, cnt in deep.get(tf, []) if cnt >= min(n, 200)][:4]
        if not syms:
            continue
        for name, fn in (("row by row", rows_reader), ("one step  ", b.get_bars_packed)):
            times = []
            got = 0
            same = True
            for _ in range(3):
                for s in syms:
                    t = time.perf_counter()
                    out = fn(s, tf, n)
                    times.append((time.perf_counter() - t) * 1000.0)
                    got = len(out) if out is not None else -1
                    if fn is b.get_bars_packed and out is not None:
                        same = same and (out == rows_reader(s, tf, n))
            print(f"   tf {tf:>2} ask {n:>6} got {got:>6}  {name}  median {statistics.median(times):8.2f} ms   max {max(times):8.2f} ms" + ("" if fn is rows_reader else f"   identical: {same}"))


bench("alone")
threads = [threading.Thread(target=busy, daemon=True) for _ in range(8)]
for t in threads:
    t.start()
bench("beside eight busy threads")
stop = True
