# Resume here (desktop speed and reliability work)

Last updated 2026-11-10 ~14:20 CT by an agent session. Read this first after a restart or a switch.

## Plans (local, not in this repo)

- **THE PLAN (single authority, v1.2):** `C:\Users\Patrick\reports\UCT desktop app FINAL plan - speed and reliability.md` (backup beside it)
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
