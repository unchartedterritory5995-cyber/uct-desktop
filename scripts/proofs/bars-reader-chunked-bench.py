"""A chunked one-step read (G rows per sqlite step): the reader's own time, and a bystander's, against
row by row and against one big step. Sandbox data only. A prototype: nothing in the repo changes.

usage: python get_bars_chunked.py <repo> <sandbox data dir> [chunk=512] [readers=8]
"""
import json
import os
import statistics
import sys
import threading
import time

repo, data_dir = sys.argv[1], sys.argv[2]
CHUNK = int(sys.argv[3]) if len(sys.argv) > 3 else 512
READERS = int(sys.argv[4]) if len(sys.argv) > 4 else 8
assert "data-indinstant" in data_dir.lower(), "sandbox data dir only"
os.environ["DATA_DIR"] = data_dir
sys.path.insert(0, repo)
sys.setswitchinterval(0.0005)

from api.services import bars_sqlite as b  # noqa: E402

rows_reader = getattr(b, "_get_bars_rows", None) or b.ROW_READER
P = b._PACK_PRICES
scale, limit = str(b._PACK_SCALE), str(1 << 53)
whole = ", ".join(f"CAST({x} AS INTEGER) AS {x}_a" for x in P)
frac = ", ".join(f"({x} - {x}_a) * {scale} AS {x}_p" for x in P)
mid = ", ".join(f"CAST({x}_p AS INTEGER) AS {x}_b" for x in P)
rest = ", ".join(f"({x}_p - {x}_b) * {scale} AS {x}_q" for x in P)
cells = ", ".join(f"{x}_a, {x}_b, CAST({x}_q AS INTEGER)" for x in P)
exact = " AND ".join(f"({x} IS NULL OR (typeof({x}) = 'real' AND abs({x}) < {limit} AND {x}_q = CAST({x}_q AS INTEGER)))" for x in P)
CHUNKED_SQL = (
    f"SELECT json_group_array(json_array(ts, {cells}, v)),"
    f" min(({exact}) AND typeof(v) IN ('integer', 'null')), count(*) "
    f"FROM (SELECT *, {rest} FROM (SELECT *, {mid} FROM (SELECT *, {frac} FROM ("
    f"SELECT ts, o, h, l, c, v, {whole}, (row_number() OVER (ORDER BY ts DESC) - 1) / ? AS g FROM ("
    "SELECT ts, o, h, l, c, v FROM ohlcv WHERE ticker=? AND tf=? ORDER BY ts DESC LIMIT ?))))) GROUP BY g"
)
INV = b._PACK_INV


def chunked(ticker, tf, max_bars):
    out = []
    for text, ok, count in b._conn().execute(CHUNKED_SQL, (CHUNK, ticker.upper(), tf, max_bars)):
        if ok != 1:
            return None
        for ts, oa, ob, oc, ha, hb, hc, la, lb, lc, ca, cb, cc, v in json.loads(text):
            out.append((ts,
                        None if oa is None else oa + (ob + oc * INV) * INV,
                        None if ha is None else ha + (hb + hc * INV) * INV,
                        None if la is None else la + (lb + lc * INV) * INV,
                        None if ca is None else ca + (cb + cc * INV) * INV,
                        v))
    out.sort(key=lambda r: r[0])
    return out


SYMS = [t for t, n in b._conn().execute("SELECT ticker, count(*) n FROM ohlcv WHERE tf='D' GROUP BY ticker ORDER BY n DESC LIMIT 24").fetchall()]
b.packed_reads_proven()
same = all(chunked(s, "D", n) == rows_reader(s, "D", n) for s in SYMS[:8] for n in (1, 60, 511, 512, 513, 5000, 12000))
print(f"chunk {CHUNK} rows per step | identical to the row reader on 8 symbols x 7 sizes: {same}")
READ = {"row by row": rows_reader, "one step": b.get_bars_packed, f"{CHUNK} a step": chunked}

stop = False


def busy():
    x = 0
    while not stop:
        x = (x * 31 + 7) % 1000003


def reader_times(label):
    print(f"-- the reader's own time for 5,000 daily bars, {label}")
    for name, fn in READ.items():
        times = []
        for _ in range(3):
            for s in SYMS[:4]:
                t = time.perf_counter()
                fn(s, "D", 5000)
                times.append((time.perf_counter() - t) * 1000.0)
        print(f"   {name:12s} median {statistics.median(times):8.2f} ms   max {max(times):8.2f} ms")


reader_times("alone")
th = [threading.Thread(target=busy, daemon=True) for _ in range(8)]
for t in th:
    t.start()
reader_times("beside eight busy threads")
stop = True
for t in th:
    t.join()

PAYLOAD = {"sym": "NVDA", "values": list(range(200)), "name": "x" * 200}
print(f"-- a bystander's small request while {READERS} background threads read back to back")
for name, fn in READ.items():
    halt = threading.Event()
    reads = [0] * READERS

    def loop(i, fn=fn):
        k = i
        while not halt.is_set():
            fn(SYMS[k % len(SYMS)], "D", 5000)
            reads[i] += 1
            k += 1

    ths = [threading.Thread(target=loop, args=(i,), daemon=True) for i in range(READERS)]
    for t in ths:
        t.start()
    total = []
    t_end = time.perf_counter() + 5.0
    while time.perf_counter() < t_end:
        due = time.perf_counter() + 0.01
        time.sleep(0.01)
        for _ in range(8):
            json.loads(json.dumps(PAYLOAD))
        total.append((time.perf_counter() - due) * 1000.0)
    halt.set()
    for t in ths:
        t.join(timeout=10)
    total.sort()
    n = len(total)
    print(f"   {name:12s} readers did {sum(reads):5d} reads | bystander median {total[n // 2]:6.2f} ms  p90 {total[int(n * 0.9)]:6.2f}  p99 {total[int(n * 0.99)]:6.2f}  max {total[-1]:6.2f}")
