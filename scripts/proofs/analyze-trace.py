"""Summarise a Chromium trace from recordTrace(): which thread is the bottleneck and why.

Usage: python scripts/proofs/analyze-trace.py proof-output/trace-....json [--json out.json]

Prints, for the trace window:
  * busy % of the busiest threads (task time, which includes time blocked in driver calls)
  * the GPU main thread's self time by event (presents vs raster)
  * presents per second, paints per renderer per second, compositor draws per second
  * the top JavaScript functions by time across renderers (file:line from the minified bundle)
  * IndexedDB callback counts and endless-animation signals
"""
import collections
import json
import sys


def load(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)['traceEvents']


def main():
    path = sys.argv[1]
    ev = load(path)
    tname, pname = {}, {}
    for e in ev:
        if e.get('ph') == 'M':
            if e.get('name') == 'thread_name':
                tname[(e['pid'], e['tid'])] = e['args']['name']
            elif e.get('name') == 'process_name':
                pname[e['pid']] = e['args'].get('name')
    ts = [e['ts'] for e in ev if 'ts' in e and e.get('ph') == 'X']
    span = (max(ts) - min(ts)) / 1e6
    out = {'trace': path, 'seconds': round(span, 2)}

    busy = collections.Counter()
    for e in ev:
        if e.get('ph') == 'X' and e.get('name') in ('ThreadControllerImpl::RunTask', 'ThreadPool_RunTask'):
            busy[(e['pid'], e['tid'])] += e.get('dur', 0)
    rows = sorted(((us / 1e6 / span * 100, pname.get(k[0], '?'), tname.get(k, '?')) for k, us in busy.items()), reverse=True)
    out['busiest'] = [{'busyPct': round(r[0], 1), 'process': r[1], 'thread': r[2]} for r in rows[:12]]

    def self_times(thread_key):
        xs = sorted((e for e in ev if (e.get('pid'), e.get('tid')) == thread_key and e.get('ph') == 'X' and 'dur' in e), key=lambda e: (e['ts'], -e['dur']))
        stack, st, cnt = [], collections.Counter(), collections.Counter()
        for e in xs:
            while stack and stack[-1][1] <= e['ts']:
                stack.pop()
            if stack:
                st[stack[-1][0]['name']] -= e['dur']
            st[e['name']] += e['dur']
            cnt[e['name']] += 1
            stack.append((e, e['ts'] + e['dur']))
        return st, cnt

    gpu = [k for k, v in tname.items() if v == 'CrGpuMain']
    if gpu:
        st, cnt = self_times(gpu[0])
        out['gpuMainSelf'] = [{'pct': round(us / 1e6 / span * 100, 1), 'count': cnt[n], 'event': n} for n, us in st.most_common(8)]
        out['presentsPerSec'] = round(cnt.get('DXGISwapChainImageBacking::Present', 0) / span, 1)

    rmain = {k for k, v in tname.items() if v == 'CrRendererMain'}
    comp = {k for k, v in tname.items() if v == 'Compositor'}
    paints, draws, fn, fncount = collections.Counter(), collections.Counter(), collections.Counter(), collections.Counter()
    idb, anim_iter = 0, 0
    for e in ev:
        k = (e.get('pid'), e.get('tid'))
        n = e.get('name')
        if k in rmain:
            if n == 'Paint':
                paints[k] += 1
            if n == 'FunctionCall' and e.get('ph') == 'X':
                d = (e.get('args') or {}).get('data') or {}
                key = f"{d.get('functionName') or '(anon)'} {str(d.get('url', '')).split('/')[-1].split('?')[0]}:{d.get('lineNumber')}"
                fn[key] += e.get('dur', 0)
                fncount[key] += 1
                if key.startswith('b.onsuccess') or 'onsuccess' in key:
                    idb += 1
            if n == 'EventDispatch':
                d = (e.get('args') or {}).get('data') or {}
                if d.get('type') == 'animationiteration':
                    anim_iter += 1
        if k in comp and n == 'ProxyImpl::ScheduledActionDraw':
            draws[k] += 1
    out['paintsPerRendererPerSec'] = sorted(round(v / span, 1) for v in paints.values())
    out['compositorDrawsPerSec'] = sorted(round(v / span, 1) for v in draws.values())
    out['topJs'] = [{'ms': round(us / 1000), 'calls': fncount[k], 'fn': k} for k, us in fn.most_common(12)]
    out['indexedDbCallbacksPerSec'] = round(idb / span, 1)
    out['animationIterationsPerSec'] = round(anim_iter / span, 2)

    if '--json' in sys.argv:
        with open(sys.argv[sys.argv.index('--json') + 1], 'w', encoding='utf-8') as f:
            json.dump(out, f, indent=2)
    print(f"trace {path}  {out['seconds']} s")
    print('busiest threads:')
    for r in out['busiest'][:8]:
        print(f"  {r['busyPct']:5.1f}%  {r['process'][:20]:20} {r['thread']}")
    if gpu:
        print(f"GPU main self time (presents/s {out['presentsPerSec']}):")
        for r in out['gpuMainSelf']:
            print(f"  {r['pct']:5.1f}%  x{r['count']:6}  {r['event'][:80]}")
    print('paints per renderer per s:', out['paintsPerRendererPerSec'])
    print('compositor draws per s:', out['compositorDrawsPerSec'])
    print('IndexedDB callbacks per s (all renderers):', out['indexedDbCallbacksPerSec'], ' animationiteration per s:', out['animationIterationsPerSec'])
    print('top JS:')
    for r in out['topJs'][:10]:
        print(f"  {r['ms']:7} ms  x{r['calls']:6}  {r['fn'][:100]}")


if __name__ == '__main__':
    main()
