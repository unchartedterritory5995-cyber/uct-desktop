# Prototype results (Task 12)

Run 2026-11-09 after the US close, 4:05-4:38 pm ET, against production https://uctintelligence.com, as the synthetic member account. Shell commit `1241c70`, packaged unsigned, Electron 45.2.3. Compared with Chrome 156 in an app window (`--app`).

## How the rows were measured

Playwright starts both browsers with popup blocking and background throttling switched off, and turns on focus emulation, which keeps a minimized page "visible". The first run's P2 and P4 passes in both targets were therefore false and are discarded. P2, P4 and P6 come from `scripts/proofs/clean-proofs.mjs`, which starts the real app with only a debugging port and observes it over the DevTools protocol. Its Chrome result shows the runner can fail: Chrome opened 0 of 6 windows without a click and throttled the minimized page. The other rows do not depend on those switches and come from `scripts/proofs/run-proofs.mjs`.

## Results

| Row | Electron | Chrome app window | Evidence |
|---|---|---|---|
| P1 Portals | PASS | PASS | Synchronous window, resize, `availHeight`, `new win.ResizeObserver`, style sync and key events all worked. |
| P2 Launch restore | PASS | FAIL | Windows opened with no click: Electron 6 of 6, Chrome 0 of 6. With one click: Electron 6, Chrome 1. |
| Placement | PASS at 100% only | FAIL without permission, PASS with it | Electron: 8 of 8 displays within 8 px. Chrome, no permission: windows forced onto the current display, up to 1,340 px off. Chrome after Window Management permission: 8 of 8. Every display is at 100%, so 150% is INCONCLUSIVE. |
| P4 Background (after hours) | PASS | FAIL | Opener minimized for 10 s, blank child window. Electron: child 601 frames (593 before), opener timer 100 of 100 ticks, `hidden` false. Chrome: child 599 frames, opener timer 9 of 100 ticks, `hidden` true. |
| P4 CPU, memory, 4/8/12 charts at 09:30-10:00 ET | INCONCLUSIVE | INCONCLUSIVE | Not run. It needs the market open on the owner's monitors. Occluded and other-monitor states and real charts were also not measured. |
| P6 `/api/alerts` | PASS | PASS | Authenticated 200 JSON. |
| P6 500 API calls | PASS | PASS | 500 of 500 returned 200, 0 Cloudflare challenges. Electron user agent includes `UCTIntelligence/0.0.1` and `Electron/45.2.3`. |
| P6 30-minute stream | INCONCLUSIVE | Not run | The Electron run was stopped by the system within about 8 minutes because the PC was low on memory. No result was recorded. |
| P7 subset | PASS | PASS | `navigator.locks` and IndexedDB across windows worked. Renderer `Notification` permission: Electron granted without a prompt, Chrome not granted. No service worker registration exists, so Web Push failure mode was not exercised. |
| P18 Server load | MEASURED | MEASURED | API responses per minute on idle `/charts`: Electron 308, Chrome 294.5. An earlier run of the same row read 53 and 64.5, and the difference is unexplained, so use these only to compare the two targets. |
| P20 Route change | PASS | PASS | Board popped, five routes visited, window stayed open, all 5 widgets returned when it closed. |
| Quit order | MEASURED | Not applicable | before-quit +0 ms, close main +1, close child +1, closed child +14, closed main +29, will-quit +30, quit +30. |
| Relaunch restore | PASS | Not applicable | After quitting with a board popped, a relaunch offered Restore and all 5 widgets returned. |
| Device limit | INCONCLUSIVE | INCONCLUSIVE | Not run. It needs a real account on phone, browser and app. |

## G1 Technical: INCONCLUSIVE, no failure so far

Met: P1, 6 of 6 windows with no gesture, 100% placement, zero challenges over 500 calls, authenticated `/api/alerts`, child painting and opener timers with the opener minimized.

Still open, and G1 holds until they close:

1. The 30-minute stream.
2. Placement at 150%.
3. CPU and memory at most 1.25x Chrome, measured at the open.

## G2 recommendation: hold

The difference half is supported. The installed web app cannot reopen a board without a click, throttles a minimized main window to about a tenth of its timer rate, and needs a permission grant to place windows across monitors.

The demand half has no data yet: paying member count, multi-monitor and pop-out usage, and the survey. Do not start Stage 3 until those are in and the owner decides.
