"""What does the sign-in check every request runs cost, alone and beside busy threads?
A sandbox auth.db in a temp directory (the real schema, one synthetic user); nothing else is opened.

usage: python auth-chain-cost.py <repo>
"""
import os, statistics, sys, tempfile, threading, time
repo = sys.argv[1]
d = tempfile.mkdtemp(prefix="auth_chain_cost_")
os.environ["AUTH_DB_PATH"] = os.path.join(d, "auth.db")
os.environ.pop("PYTEST_CURRENT_TEST", None)
sys.path.insert(0, repo)
sys.setswitchinterval(0.0005)
from api.services import auth_db, auth_service  # noqa: E402
assert auth_db._DB_PATH.startswith(d), auth_db._DB_PATH
auth_db.init_db()
u = auth_service.create_user("probe@uctintelligence.internal", "Not-A-Real-Password-1", "probe")
tok = auth_service.create_session(u["id"])
auth_service.comp_user_access("probe@uctintelligence.internal", True)

# count the sqlite statements one check runs
seen = []
real_get = auth_db.get_connection
def counting():
    c = real_get(); c.set_trace_callback(lambda s: seen.append(s)); return c
auth_service.get_connection = counting
auth_service.validate_session(tok); auth_service.get_user_plan(u["id"])
auth_service.validate_session(tok); seen.clear()
user = auth_service.validate_session(tok); plan = auth_service.get_user_plan(user["id"])
auth_service.get_connection = real_get
print("statements for one check (session, then plan):", len(seen), "(plus the pool's own 2 on checkout and 2 on return, per connection, which the trace does not see after reset)")
for s in seen: print("     ", s[:90])

def check():
    user = auth_service.validate_session(tok)
    return auth_service.get_user_plan(user["id"])
def med(n=200):
    xs = []
    for _ in range(n):
        t = time.perf_counter(); check(); xs.append((time.perf_counter() - t) * 1000.0)
    xs.sort()
    return statistics.median(xs), xs[int(len(xs) * 0.9)], xs[-1]
stop = False
def busy():
    x = 0
    while not stop: x = (x * 31 + 7) % 1000003
print("one sign-in check (session + plan), median / p90 / max ms:")
print("   alone                    %.2f / %.2f / %.2f" % med())
for k in (4, 8, 16, 30):
    stop = False
    th = [threading.Thread(target=busy, daemon=True) for _ in range(k)]
    for t in th: t.start()
    print("   beside %2d busy threads   %.1f / %.1f / %.1f" % ((k,) + med(60)))
    stop = True
    for t in th: t.join()
