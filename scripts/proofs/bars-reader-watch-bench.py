"""The store's own reader (rows, watched) beside busy threads: the first watched batches at 8 and 32
rows against a first batch of 128. Sandbox data only.

usage: python get_bars_watch_bench.py <repo> <sandbox data dir>
"""
import os, statistics, sys, threading, time
repo, data_dir = sys.argv[1], sys.argv[2]
assert "data-indinstant" in data_dir.lower(), "sandbox data dir only"
os.environ["DATA_DIR"] = data_dir
sys.path.insert(0, repo)
sys.setswitchinterval(0.0005)
from api.services import bars_sqlite as b  # noqa: E402

SYMS = [t for t, n in b._conn().execute("SELECT ticker, count(*) n FROM ohlcv WHERE tf='D' GROUP BY ticker ORDER BY n DESC LIMIT 24").fetchall()]
b.packed_reads_proven()
stop = False
def busy():
    x = 0
    while not stop:
        x = (x * 31 + 7) % 1000003

def run(label, rows):
    out = {}
    for name, first in (("first watched batch 128 (as shipped)", ()), ("first watched batches 8, 32 (this change)", (8, 32))):
        b._WATCH_FIRST = first
        times = []
        for _ in range(4):
            for s in SYMS[:6]:
                t = time.perf_counter(); got = b.get_bars(s, "D", rows); times.append((time.perf_counter() - t) * 1000.0)
        want = b._get_bars_rows(SYMS[0], "D", rows)
        same = b.get_bars(SYMS[0], "D", rows) == want
        times.sort()
        print(f"   {label:28s} {rows:5d} rows | {name:42s} median {statistics.median(times):7.2f} ms  p90 {times[int(len(times)*0.9)]:7.2f}  max {times[-1]:7.2f} | same rows: {same}")

for rows in (600, 5000):
    run("alone", rows)
for k in (8, 30):
    stop = False
    th = [threading.Thread(target=busy, daemon=True) for _ in range(k)]
    for t in th: t.start()
    for rows in (600, 5000):
        run(f"beside {k} busy threads", rows)
    stop = True
    for t in th: t.join()
