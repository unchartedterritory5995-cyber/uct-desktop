# Resume here (desktop speed and reliability work)

Last updated 2026-11-10 by an agent session. Read this first after a restart.

## Plans (local, not in this repo)

- **THE PLAN (single authority):** `C:\Users\Patrick\reports\UCT desktop app FINAL plan - speed and reliability.md` (backup beside it)
- History: `UCT desktop app speed and reliability plan.md`; Charts analysis log: `UCT desktop charts speed analysis.md`
- Overall program: `C:\Users\Patrick\reports\UCT desktop app implementation plan v2.md`

## Owner decisions on 2026-11-10

- Speed bar is the hardware floor ("instant, smooth, no lag, whatever it takes").
- **Tray residency:** closing the window hides the desk; the app keeps running. Supersedes v2's "close = quit". Updates install on a real Quit, or after hours with no window open for 10 minutes. Never interrupts.
- Stack upgrades are allowed when a proof shows they move a target.

## Code on branch `wip/speed-reliability` (NOT yet tested or built)

Written while a load proof was using the PC, so `npm run check` has not run on it yet.

| File | What |
|---|---|
| `src/main/updates.ts` + test | Task 28 updater client: install on quit, never downgrade, drop a pulled release, fail-closed signature check, 3 repeated failures, min shell version (fails open) |
| `src/main/event-log.ts` + test | Black box: JSON-lines lifecycle log, unclean-exit detection, crash dumps local only, last 40 events in Copy Diagnostics |
| `src/main/market-hours.ts` + test | One market-hours definition (moved out of recovery.ts), DST-tested |
| `src/main/residency.ts` + test | Tray: close hides, Open/Quit/Start with Windows, after-hours idle install |
| `src/main/index.ts`, `windows/main-window.ts` | Wiring: tray, `hidden` window state to the site, hidden start, crash/hang/load-failure logging |
| `scripts/proofs/load-proofs.mjs` | Reports every window's state when a step fails |

## Review fixes (second commit on the branch)

An independent review found the branch did not compile and had five behaviour bugs; all fixed (see the plan's "Independent review" section). **The tray is OFF in production builds** (`TRAY_RESIDENCY_ENABLED` in `config.ts`) until Task 22 and the updater exist; a dev build turns it on with `UCT_DESKTOP_TRAY=1`. Today's load numbers are unusable (overlapping runs); a clean run started 12:55 CT.

## Next steps, in order

1. `npm run check` (typecheck, vitest, build). Fix what fails. Never build while a proof is running: proofs launch `release/win-unpacked`.
2. Read the load proof results (`proof-output/results-load-electron.json`, `-chrome.json`). Runs that overlapped other work are in `proof-output/contaminated/`. Compare CPU, memory and frame p95 at 4/8/12 charts; G1 floor is 1.25x Chrome, owner bar is 20% below Chrome. Record in `docs/PROTOTYPE-RESULTS.md`. Then Task 22.
3. Prove the tray on the real app: close hides all windows, reopen under 50 ms, `--hidden` start stays hidden (including offline), Quit runs the before-quit handshake, single-instance reopen.
4. Version 0.1.3, build installer, release to Bracco (private release on `uct-large-files`, DM via the UCT bot).
5. Plan Phase E in order: E1 local-first boot, E3 shared data stream, E4 frame-locked updates.

## Known facts that cost time before

- Playwright launches add popup and throttling switches: popup and background proofs under it are false passes. Use `clean-proofs.mjs`.
- The shared bench account can be changed by other sessions; restore via `/api/workspace/doc/restore`.
- Website: precompressed assets are live (`9bccdaab5c`) but Cloudflare decompresses them, so members save nothing until the Cloudflare setting changes. Never drop `no-transform`.
- Session-only scheduled jobs die with a crash or restart.
