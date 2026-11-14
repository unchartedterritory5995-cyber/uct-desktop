"""What one sqlite statement costs a thread, alone and beside busy threads (the web pod's switch interval).

CPython's sqlite3 gives the GIL up around every prepare, step and reset, and takes it back after.
Alone that is free. Beside busy threads the thread waits its turn each time, so a statement sqlite
answers in microseconds costs milliseconds, and a connection opened for one read (the open and its
PRAGMAs) costs more than the read. This prints each piece of a chart's rating read
(rs_history.read_fields for one ticker, rs_history.rating_series) so the round trips can be counted
before a read path is designed.

A sandbox screener.db in a temp directory with the real schema and a synthetic rating history;
nothing else is opened.

usage: python sqlite-statement-cost.py <repo>
"""
import os
import sqlite3
import statistics
import sys
import tempfile
import threading
import time
from datetime import date, timedelta

repo = sys.argv[1]
d = tempfile.mkdtemp(prefix="sqlite_statement_cost_")
os.environ["SCREENER_DB_PATH"] = os.path.join(d, "screener.db")
os.environ["RS_HISTORY_ENABLED"] = "1"
sys.path.insert(0, repo)
sys.setswitchinterval(0.0005)
from api.services.screener import rs_history, snapshot_db  # noqa: E402

assert snapshot_db.get_db_path().startswith(d)
snapshot_db.init_db()
conn = snapshot_db.connect()
conn.execute(rs_history._SQL)
conn.execute(rs_history._INDEX_SQL)
TICK = ["NVDA", "AAPL", "MSFT"] + [f"T{i:04d}" for i in range(400)]
day, sessions = date(2021, 1, 4), []
while len(sessions) < 1300:
    if day.weekday() < 5:
        sessions.append(day.isoformat())
    day += timedelta(days=1)
cols = [r[1] for r in conn.execute(f"PRAGMA table_info({rs_history.TABLE})").fetchall()]
rows = []
for si, s in enumerate(sessions):
    for ti, t in enumerate(TICK[:60] if si < 1200 else TICK):
        rec = {c: None for c in cols}
        rec.update(ticker=t, session=s, ibd=(si * 7 + ti * 13) % 99 + 1, fast=50)
        rows.append(tuple(rec[c] for c in cols))
conn.executemany(f"INSERT OR REPLACE INTO {rs_history.TABLE} ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})", rows)
conn.commit()
conn.close()

T = rs_history.TABLE
c = sqlite3.connect(snapshot_db.get_db_path(), timeout=5, isolation_level=None)   # one kept connection
c.row_factory = sqlite3.Row
c.execute("PRAGMA query_only=ON")
RC = ", ".join(rs_history._read_columns(c))
sess = rs_history._sessions_desc(c, 21)
ONE = rs_history.rating_series_one_step_sql(True)
pieces = {
    "open + 2 pragmas + close (a connection per read)": lambda: snapshot_db.connect().close(),
    "MAX(session)": lambda: c.execute(f"SELECT MAX(session) FROM {T}").fetchone(),
    "one row by key": lambda: c.execute(f"SELECT ticker, {RC} FROM {T} WHERE session = ? AND ticker IN (?)", (sess[0], "NVDA")).fetchall(),
    "table exists": lambda: rs_history._table_exists(c, T),
    "series: one sqlite step (1,300 rows as one)": lambda: c.execute(ONE, ("NVDA", sessions[-1], 1320)).fetchone(),
    "series: 1,300 rows fetched one by one": lambda: c.execute(rs_history.rating_series_sql(True), ("NVDA", sessions[-1], 1320)).fetchall(),
}


def med(fn, n):
    xs = []
    for _ in range(n):
        t = time.perf_counter()
        fn()
        xs.append((time.perf_counter() - t) * 1000.0)
    return statistics.median(xs)


stop = False


def busy():
    x = 0
    while not stop:
        x = (x * 31 + 7) % 1000003


print("%-50s %8s %8s %8s" % ("median ms", "alone", "8 busy", "30 busy"))
res = {k: [] for k in pieces}
for k in (0, 8, 30):
    stop = False
    th = [threading.Thread(target=busy, daemon=True) for _ in range(k)]
    for t in th:
        t.start()
    for name, fn in pieces.items():
        res[name].append(med(fn, 120 if k == 0 else 30))
    stop = True
    for t in th:
        t.join()
for name, v in res.items():
    print("%-50s %8.3f %8.2f %8.2f" % (name, *v))
