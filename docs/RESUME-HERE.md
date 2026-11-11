# Resume here (desktop speed and reliability work)

Last updated 2026-11-10 ~21:35 CT by an agent session. Read this first after a restart or a switch.

## Plans (local, not in this repo)

- **THE PLAN (single authority, v1.5):** `C:\Users\Patrick\reports\UCT desktop app FINAL plan - speed and reliability.md` (backup beside it)
- Measurements and findings log: `C:\Users\Patrick\reports\UCT desktop charts speed analysis.md` (sections 3a and 3b hold today's real-board numbers)
- History: `UCT desktop app speed and reliability plan.md`. Overall program: `UCT desktop app implementation plan v2.md`

## Owner decisions on 2026-11-10

- Speed bar is the hardware floor ("instant, smooth, no lag, whatever it takes"), for every member, not only this desk.
- **Tray residency:** closing the window hides the desk. Supersedes v2's "close = quit". Off in production until website idle mode (Task 22) and the updater exist.
- Stack upgrades allowed when a proof shows they move a target. Operate like a large-scale product (plan Step 9).

## What was measured today (real Charts widget pop-outs, `charts-load-proofs.mjs`)

- Cost scales with the **total number of live charts**: 4 charts = p95 17 ms (60 fps) on 3 of 4 monitors; 12 charts = p95 84-117 ms, 14-18% of frames over 50 ms, 2.4-3.1 GB, ~2 cores.
- Chrome is equally slow on the same board: the cost is website code, so fixes reach every member.
- CPU profile at 12 charts: the one renderer thread is 60% busy; chart drawing (Lightweight Charts), browser drawing work and garbage collection dominate; React re-renders are a small share.
- Graphics: 8 monitors on 2x GT 710 + Intel iGPU, end-of-life NVIDIA driver; monitor index 7 doubles p95 at 4 charts. Real but secondary.
- **Decision from the data: per-board renderer processes (plan E10) are now first in Step 3**, then cheaper charts, then "unseen charts do not draw".

## Code on branch `wip/speed-reliability` (pushed; NOT yet through `npm run check`)

| File | What |
|---|---|
| `src/main/event-log.ts` + test | Black box: scrubbed JSON-lines lifecycle log, unclean-exit detection, local crash dumps, last 40 events in Copy Diagnostics |
| `src/main/updates.ts` + test | Updater client logic (Task 28), not wired to electron-updater yet |
| `src/main/residency.ts` + test | Tray residency, off in production (`TRAY_RESIDENCY_ENABLED`, dev: `UCT_DESKTOP_TRAY=1`) |
| `src/main/market-hours.ts` + test | One market-hours and extended-session definition, DST-tested |
| `src/main/index.ts`, `windows/main-window.ts`, `config.ts`, `diagnostics.ts`, `store-fs.ts` | Wiring and the independent review's fixes |
| `scripts/proofs/charts-load-proofs.mjs` | Real-board load proof: `--dry`, `--quick=N --display=I`, `--profile=N` (CPU profile + redraw count); always restores the bench board |

## Session 2026-11-10 afternoon/evening (newest)

- **0.1.3 released to Bracco** (black box; tray off). `npm run check` green (256 tests, 8 mutants caught); `tray-proof.mjs` 6/6 on a dev build (control fails on production build, as it must); `blackbox-proof.mjs` 5/5 on the packaged app. Branch merged to `main`.
- **Root cause of slow charts found by Chromium tracing** (`charts-load-proofs.mjs --trace`, `analyze-trace.py`): GPU process main thread 90% busy, 78% in Present, 549 presents/s, from two endless CSS animations (clock dot in every chart widget, voice orb breath). Killing them: 12 widgets p95 34 -> 17 ms, p99 84 -> 18 ms, CPU -63%. **Fixed and LIVE: website `d750e6bc9b`.** Per-board processes (E10) tested: no gain, double memory, dropped.
- **Website branch `speed-5-anim` in `C:\Users\Patrick\uct-worktrees\speed-4`** (NOT yet on master, push was rejected by a race; rebase and push): `db9bc018e1` site-wide endless-animation rail + Model Book/Community finite; `66675d1cfc` Options Flow summary request bounded + rail covers inline styles; `01bed94be7` bars pack ingest one window at a time (Web Locks); plus uncommitted adaptive overlay loop (`components/chart/adaptiveFrameLoop.js` + StockChart wiring) pending its test run.
- Census tests on master (swallowedFetch, jsonFetcher, persistence, symbolLink, formatters, dataGrid) already fail from other sessions' drift; not ours.
- The intro film plays once a week per device (not every launch): no change needed.

## Session 2026-11-10 late night (newest, read this first)

- **Correction:** the website's desk idle mode (`dbccfdab56`) and the drawings-store byte cut (`46d873cdf8`) were NOT on master as the night notes said; they sat unpushed on `speed-7-idle`. Re-landed as `3e6a399402` + `ea1f37f8ca`. Always verify with `git merge-base --is-ancestor <sha> origin/master`.
- **Website master now carries, in one deploy batch:** `ff89106cb9` (CDN switch, integrity tool, CLAUDE.md rules), `2b201b5dc7` (telemetry door `POST /api/desktop/event` + hourly halt/digest job + ledger row `DESKTOP_TELEMETRY_ENABLED`), `3e6a399402` (desk idle mode), `ea1f37f8ca` (Notebook first open 2,241,882 B, budget 2,260,793). The deploy gate was stuck behind GitHub's 20-job limit for an hour.
- **Shell `main` = `b3207bd`** (desk-visibility + telemetry merged; not yet released). `src/main/telemetry.ts`: enum-only events (launch_ok, load_failed net_<n>, unclean_exit, renderer_crash, gpu_crash, site_unresponsive, update_installed), disk queue, stops on `enabled:false`, OFF for any run with a remote debugging port or inspector (all proofs) and `UCT_DESKTOP_TELEMETRY=0`. Not yet wired: first_signin, desk_restored, update_* (updater not wired).
- Proofs on the new packaged build: blackbox 5/5 (`UCT_PROOF_EXE=release/win-unpacked/...`; the script's default is the OLD `release-share` build), desk-visibility 4/4. **Still to run after deploy:** `node scripts/proofs/telemetry-proof.mjs` (needs SMOKE_EMAIL/SMOKE_PASSWORD; live server counts before/after).
- **After the deploy lands:** (1) CDN: `railway variables --service web --set ASSETS_NO_TRANSFORM_ENABLED=0`, confirm a fresh boot, `python tools/cdn_asset_integrity.py --bust` must be all intact and br/gzip, purge `/assets` at Cloudflare, re-measure. (2) telemetry proof. (3) bump shell to 0.1.4, `npm run pack:installer`, private release, ask the owner before DMing Bracco.

## Session 2026-11-10 night

- **Website, on master:** adaptive chart frame loops; bars-pack ingest one window at a time and only after the first chart; site-wide endless-animation rail; Options Flow summary bounded; desktop idle mode (`desk-visibility`, shell `9def6ac` on branch `desk-visibility`, needs merge + a shell release); drawings store off Notebook first open (-10.4 KB; budget NOT raised). Master's gate was red from another session's Screener change; fixed by re-pin `e477cddce5` (SAT-1 capture fixed by #1045).
- **Cloudflare:** token "UCT compression" (env `CLOUDFLARE_API_TOKEN`, User scope; Response Compression edit, Cache Purge, Zone + Zone Settings read; expires 2027-02-09). Root cause: the edge decompresses our precompressed assets and `no-transform` forbids re-compressing, so members got 1,114 files / 23.9 MB uncompressed. Compression Rule now: `/assets/*` brotli or gzip only, never zstd.
- **In flight:** commit `ff89106cb9` (switch `ASSETS_NO_TRANSFORM_ENABLED`, default on = no change; `tools/cdn_asset_integrity.py`; speed rules in CLAUDE.md). After it deploys: `railway variables --service web --set ASSETS_NO_TRANSFORM_ENABLED=0`, confirm a fresh boot, run `python tools/cdn_asset_integrity.py --bust` (must be 1,114/1,114 intact and compressed), then purge `/assets` at Cloudflare. Rollback: set it to 1, redeploy, purge.
- Owner-only still open: Azure signing, the reference PC, one monitor at 150% (a Windows setting Claude may not change), and three business answers.

## Next steps, in order

1. `npm run check` on the branch (typecheck, vitest, build). Fix what fails.
2. Prove the tray on a dev build; then version 0.1.3 with the black box (tray off), build the installer, release to Bracco (private release on `uct-large-files`, DM via the UCT bot).
3. Design per-board renderer processes (plan 3.0): how a board's widgets keep ticker links, live data, restore and docking across processes. Design first, then build, then measure with `charts-load-proofs.mjs`.
4. Then plan Step 3.1 onward (cheaper charts) with a profile that has source maps, so minified names resolve to files.

## Rules that cost time today

- Measure only the real member path: Charts widgets popped out by their own buttons. Never Terminal price-chart pop-outs.
- One measurement at a time: count running `proofs` node processes first and refuse if non-zero. Killing the first half of `a; b` starts `b`: stop the whole chain. A killed run skips its board restore: restore the bench board by hand from `boardVersionBefore` in its results file (`/api/workspace/doc/restore`).
- Never build while a proof runs: proofs launch `release/win-unpacked`.
- Edit source with the Edit tool or binary-mode writes: Python text-mode writes on Windows produced CRLF files and a raw newline inside a string literal.
- Playwright launches add popup and throttling switches: popup and background proofs under it are false passes; use `clean-proofs.mjs`.
- Website: precompressed assets are live (`9bccdaab5c`) but Cloudflare decompresses them; members save nothing until the Cloudflare setting changes. Never drop `no-transform`.
- Session-only scheduled jobs die with a crash or restart.
