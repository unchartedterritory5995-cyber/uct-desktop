"""While N background threads read bars back to back, how long does a small unrelated request-like
task wait? Row by row vs one step. Sandbox data only.

usage: python get_bars_bystander.py <repo> <sandbox data dir> [readers=8]
"""
import json
import os
import statistics
import sys
import threading
import time

repo, data_dir = sys.argv[1], sys.argv[2]
READERS = int(sys.argv[3]) if len(sys.argv) > 3 else 8
assert "data-indinstant" in data_dir.lower(), "sandbox data dir only"
os.environ["DATA_DIR"] = data_dir
sys.path.insert(0, repo)
sys.setswitchinterval(0.0005)

from api.services import bars_sqlite as b  # noqa: E402

rows_reader = getattr(b, "_get_bars_rows", None) or b.ROW_READER
SYMS = [t for t, n in b._conn().execute("SELECT ticker, count(*) n FROM ohlcv WHERE tf='D' GROUP BY ticker ORDER BY n DESC LIMIT 24").fetchall()]
b.packed_reads_proven()
PAYLOAD = {"sym": "NVDA", "values": list(range(200)), "name": "x" * 200}


def scenario(label, reader):
    stop = threading.Event()
    reads = [0] * READERS

    def read_loop(i):
        k = i
        while not stop.is_set():
            reader(SYMS[k % len(SYMS)], "D", 5000)
            reads[i] += 1
            k += 1

    threads = [threading.Thread(target=read_loop, args=(i,), daemon=True) for i in range(READERS)]
    for t in threads:
        t.start()
    # the bystander: a small request (wake up, parse and render a little JSON, ~0.3 ms of Python), 200 times
    waits, works = [], []
    t_end = time.perf_counter() + 6.0
    while time.perf_counter() < t_end:
        due = time.perf_counter() + 0.01
        time.sleep(0.01)
        t0 = time.perf_counter()
        for _ in range(8):
            json.loads(json.dumps(PAYLOAD))
        t1 = time.perf_counter()
        waits.append((t0 - due) * 1000.0)
        works.append((t1 - t0) * 1000.0)
    stop.set()
    for t in threads:
        t.join(timeout=10)
    total = [w + k for w, k in zip(waits, works)]
    total.sort()
    n = len(total)
    print(f"{label:11s} readers finished {sum(reads):5d} reads in 6 s | bystander (wake + a small piece of work): "
          f"median {total[n // 2]:6.2f} ms  p90 {total[int(n * 0.9)]:6.2f}  p99 {total[int(n * 0.99)]:6.2f}  max {total[-1]:6.2f}   ({n} requests)")


print(f"{READERS} background readers, each reading 5,000 daily bars back to back")
scenario("nobody", lambda *a: time.sleep(0.005))
scenario("row by row", rows_reader)
scenario("one step", b.get_bars_packed)
