#!/bin/sh
# Sample the pod's thread report at intervals after a boot: what is still busy, and for how long.
# usage: sh boot-watch.sh <output directory>
OUT="$1"; HERE="$(cd "$(dirname "$0")" && pwd)"
for label in a b c d e f; do
  up=$(curl -s -m 15 -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36" https://uctintelligence.com/api/health | python -c "import sys,json; print(int(json.load(sys.stdin).get('uptime_seconds', -1)))" 2>/dev/null)
  PYTHONIOENCODING=utf-8 python "$HERE/pod-thread-profile.py" 30 250 "$OUT/boot-$label.json" > "$OUT/boot-$label.txt" 2>&1
  python - "$OUT/boot-$label.json" "$up" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8")); n = d["n"]; loc = d["by_loc"]
skip = (":_worker", "threading.py", ":_loop", ":_delayed", "selectors", "queue.py", ":wait", ":_warm_loop", ":loop", ":_run_forever", "main.py:606:run")
busy = {k: v for k, v in loc.items() if not any(x in k for x in skip)}
lat = sorted(d.get("lat", []))
tot = sum(busy.values()) / n
print(f"uptime {sys.argv[2]:>5}s | busy thread-samples per sample {tot:5.2f} | report median {round(lat[len(lat)//2])} ms p90 {round(lat[int(len(lat)*0.9)])} | " + "; ".join(f"{v/n:.2f} {k.split(' @ ')[0]}@{k.split(':')[-1]}" for k, v in sorted(busy.items(), key=lambda kv: -kv[1])[:6]))
PY
  sleep 100
done
