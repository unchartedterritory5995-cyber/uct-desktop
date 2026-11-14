"""How many rows per sqlite step should the chunked read take? The reader's own time beside busy
threads, and what a bystander's small request waits while 8 readers read back to back.
Sandbox data only.  usage: python get_bars_chunk_size_bench.py <repo> <sandbox data dir>
"""
import json, os, statistics, sys, threading, time
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
CHUNKS = (512, 1024, 2048, 4096)
for k in (8, 30):
    stop = False
    th = [threading.Thread(target=busy, daemon=True) for _ in range(k)]
    for t in th: t.start()
    for rows in (600, 5000):
        line = f"   beside {k:2d} busy threads, {rows:5d} rows (the chunked read alone):"
        for c in CHUNKS:
            b._PACK_CHUNK_ROWS = c
            times = []
            for _ in range(3):
                for s in SYMS[:6]:
                    t = time.perf_counter(); b.get_bars_packed(s, "D", rows); times.append((time.perf_counter() - t) * 1000.0)
            line += f"  {c}/step {statistics.median(times):7.1f} ms"
        print(line)
    stop = True
    for t in th: t.join()
PAYLOAD = {"sym": "NVDA", "values": list(range(200)), "name": "x" * 200}
print("   a bystander's small request while 8 threads read 5,000 rows back to back:")
for c in CHUNKS:
    b._PACK_CHUNK_ROWS = c
    halt = threading.Event(); reads = [0] * 8
    def loop(i):
        j = i
        while not halt.is_set():
            b.get_bars_packed(SYMS[j % len(SYMS)], "D", 5000); reads[i] += 1; j += 1
    ths = [threading.Thread(target=loop, args=(i,), daemon=True) for i in range(8)]
    for t in ths: t.start()
    total = []; t_end = time.perf_counter() + 5.0
    while time.perf_counter() < t_end:
        due = time.perf_counter() + 0.01; time.sleep(0.01)
        for _ in range(8): json.loads(json.dumps(PAYLOAD))
        total.append((time.perf_counter() - due) * 1000.0)
    halt.set()
    for t in ths: t.join(timeout=10)
    total.sort(); n = len(total)
    print(f"      {c:5d}/step  readers did {sum(reads):5d} reads | bystander median {total[n//2]:6.2f} ms  p90 {total[int(n*0.9)]:6.2f}  p99 {total[int(n*0.99)]:6.2f}  max {total[-1]:6.2f}")
