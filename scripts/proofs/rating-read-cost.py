"""What does the rating read of one cold RS compute cost, alone and beside busy threads?
(`rs_history.read_fields([sym])` + `rs_history.rating_series(sym, limit=1320)`: what `_rs_rating` and
`_rs_rating_view` do.) A sandbox screener.db in a temp directory with the real screener schema and a
synthetic rating history; nothing else is opened.

usage: python rating-read-cost.py <repo>
"""
import os, statistics, sys, tempfile, threading, time, sqlite3
repo = sys.argv[1]
d = tempfile.mkdtemp(prefix="rating_read_cost_")
os.environ["SCREENER_DB_PATH"] = os.path.join(d, "screener.db")
os.environ["RS_HISTORY_ENABLED"] = "1"
sys.path.insert(0, repo)
sys.setswitchinterval(0.0005)
from api.services.screener import snapshot_db, rs_history  # noqa: E402
assert snapshot_db.get_db_path().startswith(d)
snapshot_db.init_db()
from datetime import date, timedelta
conn = snapshot_db.connect()
conn.execute(rs_history._SQL); conn.execute(rs_history._INDEX_SQL)
TICK = ["NVDA", "AAPL", "MSFT"] + [f"T{i:04d}" for i in range(400)]
day = date(2021, 1, 4); sessions = []
while len(sessions) < 1300:
    if day.weekday() < 5: sessions.append(day.isoformat())
    day += timedelta(days=1)
cols = [r[1] for r in conn.execute(f"PRAGMA table_info({rs_history.TABLE})").fetchall()]
rows = []
for si, s in enumerate(sessions):
    for ti, t in enumerate(TICK[:60] if si < 1200 else TICK):
        rec = {c: None for c in cols}
        rec.update(ticker=t, session=s, ibd=(si * 7 + ti * 13) % 99 + 1, fast=50)
        rows.append(tuple(rec[c] for c in cols))
conn.executemany(f"INSERT OR REPLACE INTO {rs_history.TABLE} ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})", rows)
conn.commit(); conn.close()
n_tables = sqlite3.connect(snapshot_db.get_db_path()).execute("SELECT count(*), sum(length(sql)) FROM sqlite_master").fetchone()
print("screener.db objects / schema bytes:", n_tables, "| rating rows:", len(rows))

def read():
    a = rs_history.read_fields(["NVDA"])
    b = rs_history.rating_series("NVDA", upto=sessions[-1], limit=1320)
    return a, b
a, b = read()
assert a["NVDA"]["ibd"] is not None and len(b) == 1300, (a, len(b))
def med(n=120):
    xs = []
    for _ in range(n):
        t = time.perf_counter(); read(); xs.append((time.perf_counter() - t) * 1000.0)
    xs.sort(); return statistics.median(xs), xs[int(len(xs) * .9)], xs[-1]
stop = False
def busy():
    x = 0
    while not stop: x = (x * 31 + 7) % 1000003
print("the rating read of one cold RS compute, median / p90 / max ms:")
print("   alone                    %.2f / %.2f / %.2f" % med())
for k in (4, 8, 16, 30):
    stop = False
    th = [threading.Thread(target=busy, daemon=True) for _ in range(k)]
    for t in th: t.start()
    print("   beside %2d busy threads   %.1f / %.1f / %.1f" % ((k,) + med(40)))
    stop = True
    for t in th: t.join()
