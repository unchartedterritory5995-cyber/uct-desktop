# Resume here (desktop speed and reliability work)

Last updated 2026-11-12 ~08:00 CT by an agent session. Read this first after a restart or a switch.

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

## NEXT SESSION START HERE (2026-11-12 ~08:00 CT: precompile, hot-thread probe, flow dates, 0.1.11 ready)

- **Website on master (deploying ~08:25 CT):** `e6a35fe8a3` boot probe adds `hot=<thread group> <cpu%>` to every `[boot-probe]` line (window 300 -> 420 s): read it with `railway logs --service web --lines 200 --filter "boot-probe"` after a deploy to name the post-deploy CPU hogs (13:24 UTC deploy: CPU 150-430% for 5 min, loop free => background threads). `7f649c5598` Dockerfile.web precompiles /app/api (`compileall`): every boot compiled ~1,060 modules / 523k lines (4.2 s locally; pod import 6.8-8.1 s). Check `/api/health` boot import_s drop.
- **Local, NOT pushed (restarts flow-worker => push AFTER the close, ~15:05 CT):** `833b8f78c2` on branch `speed/flow-dates-skipscan` in speed-4: `/api/flow/dates` skip-scan (p50 2.8 s / p95 5.9 s in the beacon -> ~53 index seeks). `git push origin speed/flow-dates-skipscan:master` after rebasing on origin/master.
- **Desktop 0.1.11 ready** (version bumped, pushed, `npm run check` green). Launch A/B 3x3 on a settled server: candles median 1292 vs 1433 ms (0.1.10), best 996 vs 1168, opens on the last page. The classifier refuses `release.mjs publish` (Create Public Surface): **owner runs** `node scripts/release.mjs publish --stage=100`.
- Nightly manual run 43168843821: all 6 shards ran and published; the gate step is red = 236 NEW vs a 3-day-old baseline (119 attributed to others, 116 unattributed): accumulated debt, now visible again.
- `/api/admin/perf` 24 h (tiny sample, pre-launch): slowest routes `/api/flow/dates` (fixed above), `/api/live/massive/*` p50 1.15 s (the beacon groups every subpath: split it before fixing; flow-worker file => after close). Desktop `/charts` ttfb p75 5.3 s = the 02:25-02:55 UTC cookie KEY_LOAD stall era (not reproduced today: html 455-860 ms).
- Waiting on the owner: Cloudflare fallback page during the deploy gap + edge cache for shared data at 9:30 (both Cloudflare config).

## NEXT SESSION START HERE (2026-11-12 ~02:30 CT: deploy gap cut, nightly + gate faster)

- **Deploy gap, after `5d6fc5d9ce`**: pod serving at 11.3 s (was 19.8; `flow_gap_autofill.startup_check` = 7.45 s moved to a thread), first 200 at uptime 14 s (was 28-39). Previous pod's shutdown 0.8 s (not a factor). Remaining gap ~48 s = ~34 s Railway (old stop -> new process; volume move, varies 12-35 s, not ours) + 14 s ours. Next ours: imports 6.8 s, L6485 2.2 s (diffuse). `/api/health` `boot` shows it every deploy.
- **Nightly full-suite record completes again** (`95ef430b10`: vitest 4 -> 6 shards, 19-36 min each; collect-profile cap 15). Manual run 43168843821 all shards green, publishing. **Deploy gate 4 -> 6 Agent shards** (`d3f75945e8`): ~38 -> ~32-33 min end to end.
- Owner 2026-11-12: "we are still very actively building ... keep rolling hard and fast" -> NO deploy batching; shrink the gap instead.

- ⛔⛔ **EVERY WEB DEPLOY IS A 40-75 s OUTAGE FOR MEMBERS** (deploy-watch.mjs, 1 s samples): 05:33 UTC 40 s of 502 (old pod stopped :00, new process :12, first 200 :40); 06:00 UTC 74 s (old stopped :02, new process ~:37, first 200 1:16). Then 2-5 min at 3-6x latency while warmers run (ready stages: hot_tier 58 s, rs/scanner 162 s, dashboard 288 s). Cause: Railway runs one pod per volume (no overlap); the July "old pod is gone" finding. Controllable: process start -> serving (28-39 s). `95bfb9b9ba` adds boot marks: read `/api/health` `boot` {import_s, to_serving_s, slowest} after it deploys and cut the slowest segments. Same push: `ServerUpdatingBanner` (lib/serverGap.js): 2 gateway errors in 15 s -> one "Updating UCT" banner, health poll, then every SWR key revalidates. Owner decision worth asking: batch deploys outside regular hours (each deploy = an outage).
- `95c96629e6` LIVE: /api/auth/me + preferences start at entry parse (lib/bootFetch.js), prefs only for the same member, one use, 10 s. `5f0a081a32`: my rails (swallowedFetch idiom, persistence manifest key, stash-sourcemaps shebang).
- Desktop (main, not released): **reopen the last page** (`last-page.ts`, plain route words only, never login/share/query); on "/" the Charts code + maintenance waited for sign-in. A/B was too noisy (server warm-ups); last round new 1.75-2.0 s vs old 1.85-4.6 s. Re-measure on a settled server, then release 0.1.11.
- Full frontend suite run 2026-11-12 (first in 3 days; nightly report runs all cancelled): 77,561 tests, 52 failed in ~45 files; mine fixed; the rest are other features' ratchets (breadth scan deck, study, terminal, notebook, lab, hub screener mocks `barsBeforeUrl`, pineRuntimeFrontend control bytes, 36 undeclared persistence keys).
- Open: deploy-watch.mjs for the next gaps; launch comparison; market-day results after 15:30 ET 11/12.

## Earlier: 2026-11-11 late night: launch speed, soak, faults, readable errors

- **0.1.10 PUBLISHED AT 0% (not yet rolled out)**: instant window (shown ~0.34 s from process start vs 0.46-0.59 s), preconnect at ready (page request ~90 ms sooner), candles median ~1.9 s vs ~2.1 s (launch-cold A/B 5+5), main window reopens where the member left it (`main-window.json`, own store). The old ready-to-show wait left the window HIDDEN 15-20 s in 2 of 10 old-style launches. The auto-mode classifier refused `release.mjs stage v0.1.10 100` (Production Deploy): **owner runs it** (`node scripts/release.mjs stage v0.1.10 100` in uct-desktop). Verified first: 4 launches of release-out/v0.1.10, candles 1.3-2.6 s.
- **Scheduled tasks NOT registered** (classifier: Unauthorized Persistence) although the owner said yes to both: weekly fault check (Sat 10:00 CT, `scripts/nightly/run-faults.cmd`) and the one-time market day (2026-11-12 08:10 CT, `scripts/nightly/run-market-day.cmd`: soak to 15:30 ET, then 12-chart quick + profile under live ticks). Owner runs the two `schtasks /create` lines, or allows them.
- Weekly fault check trial: **14/14 PASS** (F-renderer candles back 1.6 s, F-gpu 301 frames/5 s no reload, F-slow, F-deploy notice after 500 s no reload, F-session sign-in page; recovery R-*; blackbox B-*). The trial ran 0.1.5: nightly + weekly read release-share (stuck at 0.1.5); now `members-build.mjs` picks the newest release-out/v*/.
- Soak (`soak.mjs`) tried for 6 min: memory/CPU/frames OK; chart liveness needs site `687c9bb007`+ (newestBar probe), live now.
- **Proof windows: display 2 top half only** (owner delegated). Display 3 = owner's UCT app + TC2000. `startApp(..., {bounds: topHalf(d)})` opens straight there (UCT_PROOF_WINDOW_BOUNDS, debug runs only).
- **OPEN FINDING (not reproduced after 02:55 UTC)**: 02:25-02:55 UTC, 15+ launches had the FIRST page request wait 2-10 s on `COOKIE_PERSISTENT_STORE_KEY_LOAD` (net-log), network process idle, server 80 ms. Ruled out: DPAPI (0-2 ms), proxy detection (--no-proxy-server same), main-thread stalls, unclean exit, fresh build. Catch it with `node scripts/proofs/launch-trace.mjs --n=6 --end=clean --netlog`. Black box now logs `launch-timing`, `launch-navigation`, `main-stall`. A 2nd document ~15 s in was seen only in old late-show runs (window hidden).
- ⛔ The EnableCookieEncryption fuse is ONE-WAY: a profile used by an encrypted build is signed out by an unencrypted one. Not shipped.
- Website (all on master): `2097d8a460` candles mark + beacon `candles` (live), `687c9bb007` newestBar probe, `7f3b179a49` error reports keep own-chunk positions (client + server, 5/5 mutations), `0c2661462e` tools/resolve_client_error.mjs (REFUSES today: a local rebuild does not reproduce prod chunk names; next: production keeps hidden maps, admin-only), `2883272798` YouTube API no longer loads at boot on every page (budget PASS 2,254,882/2,260,793).
- **Readable errors finished (`381b572a65`)**: production builds hidden source maps, stashed in app/dist/.maps (842 maps, 85 MB, image only; shipped JS byte-identical, budget unchanged), read only via admin `GET /api/admin/client-errors/sourcemap/{chunk}`. `node tools/resolve_client_error.mjs <stack-file>` (SMOKE_* env) maps a report's `/assets/<chunk>.js:L:C` to src file:line from production's own maps. Verify end to end once deployed (a real report from a build after `7f3b179a49`).
- DONE by the owner 2026-11-11 ~22:15 CT: **0.1.10 staged to 100%** (feed verified), **weekly fault check registered** (first run Sat 11/14 10:00 CT), **market day registered** (11/12 08:10 CT). Automation cannot run `release.mjs stage` or `schtasks /create`: hand the owner the `!` commands.
- My mistake, fixed: resolve_client_error's first cleanup followed the node_modules junction and emptied speed-4/app/node_modules (reinstalled from lockfile; the tool now rmdirs the link first and verifies).
- Pre-existing master reds seen locally (not mine): StockChart firstVisitFraming / focusWarmStep / smoke; notebook ChartEmbed.touchTargets, ChartPlanPanel.asOfDay, frozenWorkspace.
- NEXT: (1) after the market day read proof-output/market-day/ (soak summary; 12-chart under ticks + profile -> pick 3.1-3.5); (2) production hidden source maps (admin-only) so resolve_client_error answers; (3) `/api/admin/perf` candles p50/p95 desktop vs browser after a trading day; (4) owner restarts the app -> 0.1.10 once staged.

## Earlier: 2026-11-11 evening, Step 10 verified live

- Step 10 LIVE (production `bfae0e3fb6`, 15:44 CT; web serving it 15:50 CT). The first gate run on `660cd3a382` failed only on GitHub's artifact upload ("Failed to CreateArtifact", all 95+95 test files green); the next gate shipped it.
- **Early Hints verified:** the site sends `Link:` preloads; Cloudflare answers with a 103 at ~79 ms; entry + 2 vendor chunks + CSS arrive with `initiatorType: early-hints`, 0 KB on the critical path, no double fetches. Fresh visit medians (7 runs): 103 at 79 ms, real HTML 168 ms, entry script done 182 ms (14 ms after the HTML; before: 102 ms after it), load 465 ms. Load's tail is the signed-out landing page's YouTube iframe_api + `/api/auth/me`, not hints.
- ⛔ **Chrome's `responseStart` is the 103's first byte once hints exist**; the real page is `finalResponseHeadersStart`. `first-visit-timing.mjs` now prints both. The same trap was in the beacon: fixed in `c2f53f536a` (ttfb = finalResponseHeadersStart; failures = 5xx/408/429 only, a signed-out 401 is an answer). Mutation-checked 5/5.
- **Beacon verified end to end:** a 25 s visit -> POST /api/perf/beacon 200 -> `GET /api/admin/perf` showed loads 1 (that one test visit, recorded before the ttfb fix, ttfb 89 = the 103). Read via `scratchpad read_perf.py` (smoke@ admin, SMOKE_* from User env).
- Beacon fix live 17:35 CT (production `2cbeb0b6d0`); a real report after it stored ttfb = the real page (no 103 on that visit).
- ⚠️ **FINDING, not yet worked: the first visits right after a deploy stall 6.7-8.5 s** (17:36-17:37 CT, ~1-2 min after web went SUCCESS; even the 103 waited 6.7 s), then everything is normal (103 ~111 ms, HTML 189 ms, load 445 ms). Every deploy does this to whoever arrives first. Candidate next speed item: trace where the wait is (Railway switchover vs the new pod's first requests) and warm the pod before it takes traffic.
- First real member reports (/live-massive, /charts) show API p50 ~0.7-1.9 s, p95 ~3 s on many routes; unknown how much overlaps the deploy restart. Read again after a normal trading day before acting.
- NEXT: after a trading day read `/api/admin/perf` (member pages, desktop vs browser, API p95, countries); next Wednesday's `/api/admin/measurement-window/latest` heavy_jobs for the next rush candidate.
- Owner's app: 0.1.9 downloaded 13:10 CT, still 0.1.7 until Restart is clicked or the app quits; then check the black box for `os-restart-registered`.
- Waiting on the owner: Microsoft ID-check email; Massive licensing email; optional member count.

## Status 2026-11-11 ~13:00 CT (newest): RELEASE TOOL + SHUTDOWN SAFETY SHIPPED IN 0.1.9

- **Release only through `node scripts/release.mjs`**: `publish [--stage=N] [--dry]` (refuses unless on main, clean, pushed, higher version, `npm run check` green, no secret pattern in dist; reads the feed back anonymously and fails on any mismatch), `stage vX N`, `halt vX`, `status`. Rules in `scripts/release-lib.mjs`, tested and mutation-checked (12/12).
- **Measured:** stage/halt reach every app within ~5 minutes (GitHub edge caches the latest.yml redirect, Age ~260 s). Proven live on v0.1.9: published at 0% -> a 0.1.7 app saw update-none; staged to 100% -> 1 min later still none (cache), 6 min later update-available + the prompt.
- **Windows Update safety (0.1.9):** session-end -> `updates.hold()` + `updateHub.sessionEnding()`, so nothing installs during a shutdown; `os-restart.ts` registers with Restart Manager (`--restarted-by-windows`, flags NO_CRASH|NO_HANG) so Windows reopens UCT after an update reboot; skipped in debug/proof runs. Verify on the owner's installed app after it updates: black box should show `os-restart-registered`.
- Feed now: 0.1.9 at 100%.

## Status 2026-11-11 ~12:30 CT: CODE SIGNING IN MICROSOFT REVIEW

- Azure (portal signed in as the SHARED unchartedterritory5995 account, owner's choice), directory **Patrick** (unchartedterritory5995gmail.onmicrosoft.com), subscription **Azure subscription** fe3a0166-9385-4719-8484-c4b2cf7497c4 (pay-as-you-go).
- Microsoft.CodeSigning registered. Artifact Signing account **uctintelligence**, resource group **uct-signing**, East US, Basic ($9.99/mo), endpoint `https://eus.codesigning.azure.net/`. Owner has the Identity Verifier role on it.
- Identity validation: Organization, Public, **Uncharted Territory LLC** (Minnesota, active), emails patrick@ / contact@uctintelligence.com (Cloudflare Email Routing -> the shared Gmail). Subject preview `CN=Uncharted Territory LLC, O=Uncharted Territory LLC, S=Minnesota, C=US`. Status In Progress (submitted ~12:25 CT). NEXT: status goes Action Required -> owner does the photo-ID check (AU10TIX + Microsoft Authenticator, link expires in 7 days) -> Microsoft reviews 1-20 business days.
- After Completed: create certificate profile (Public Trust) on uctintelligence; give the signing identity the Artifact Signing Certificate Profile Signer role; sign from this PC with an interactive Azure login (no stored secret); electron-builder `win.azureSignOptions` {publisherName: 'Uncharted Territory LLC', endpoint, certificateProfileName, codeSigningAccountName: 'uctintelligence'}; then wire `createSignatureVerifier` (expectedPublisher 'Uncharted Territory LLC') and keep accepting the unsigned->signed transition for one release.
- Note: a click on Microsoft's 'Review and accept the latest terms of use' banner accepted the updated Artifact Signing terms in one step (owner told).

## Status 2026-11-11 ~10:20 CT: ONE-CLICK UPDATES LIVE

- **Feed:** PUBLIC repo `unchartedterritory5995-cyber/uct-desktop-releases` (owner created it 2026-11-11; release files only). electron-builder `publish: github` writes `app-update.yml`; releases are tagged `vX.Y.Z` with the exe, `.blockmap` and `latest.yml`. Release flow: bump version, `npm run build && npx electron-builder --win nsis --publish never --config.directories.output=release-next`, secret-scan `dist/`, `gh release create vX.Y.Z <exe> <blockmap> latest.yml -R unchartedterritory5995-cyber/uct-desktop-releases`, check `releases/latest/download/latest.yml` anonymously. Pull a bad version: delete its release (the app then reports withdrawn and nothing installs).
- **Shell:** `src/main/app-update.ts` (hub) + `updates.ts` controller + index.ts wiring; capability `app-update` (getAppUpdate / onAppUpdate / restartToUpdate). Restart = the NORMAL quit first, then `quitAndInstall(true, true)` at will-quit. Updates off in debug runs unless `UCT_PROOF_UPDATES=1`; `UCT_DESKTOP_UPDATES=0` turns them off. Unsigned: sha512 checked, no publisher; wire `createSignatureVerifier` when Azure signing lands.
- **Website:** `AppUpdateToast.jsx` in DesktopBridgeSync (desktop-only chunk), master `508b3b5ab8`, held by the Wednesday 09:00-11:00 ET freeze, promotes 11:05 ET.
- **Proven on the owner's installed app** (`update-e2e.mjs --installed --via-bridge --expect=0.1.7`): found 15:09:58, downloaded 15:10:01 (blockmap delta), Restart 15:10:04.34, closed 15:10:04.48, reopened as 0.1.7 15:10:22 (18 s). The proof's first "closed after 301 s" was the DevTools socket hanging; it now watches processes.
- Releases: 0.1.6 (first with updates), 0.1.7 (version bump, the first delivered by the updater). Owner's PC on 0.1.7. Bracco DM'd 0.1.7 (msg 1570095421697818808), his last manual install.
- Market-hours page-cost 09:47 ET: /live-massive busy 0.4%, /options-flow 0.3%, rAF 0 (light table 17 min after the open).
- DONE 10:10 CT: toast live in production (site build index-BxiemL39.js); 0.1.8 published; `update-proof --toast` on the 0.1.7 build: downloaded 0.1.8, prompt "A new version of the UCT app is ready. Restart to update / Later" shown, nothing installed. Owner's app (0.1.7) will offer 0.1.8 on its next check. NEXT: full member rollout needs Azure signing (then wire createSignatureVerifier).

## Status 2026-11-11 ~07:20 CT

- Owner said yes to all three (07:50 ET). **0.1.5 sent to Bracco** by bot DM (msg 1570059379561201755); the message discloses the new anonymous crash reports (0.1.3's said nothing is sent).
- **Nightly speed check LIVE**: Task Scheduler `UCT Desktop Nightly Speed Check`, daily 23:40 CT, `scripts/nightly/run-nightly.cmd` under the heavy lock -> `perf-nightly.mjs`. Members' build (release-share); monitors tried 2,4,0,5 (5 usually has the trading platform maximized, so the window is undrawn). Baseline = median of the last 7 passing nights; over a limit -> recheck; posts to ops (`DISCORD_WEBHOOK_URL`, read from Railway at send time via the linked `uct-dashboard` dir, never stored) only when seen twice; first night, then every 7th of a lasting slowdown. 3 blind nights in a row -> one notice. Intended heavier page: `node scripts/nightly/perf-nightly.mjs --accept`. Output `proof-output/nightly/`. Fired once via Start-ScheduledTask 07:12: pass, baseline seeded (busy 0.7-1.5%, rAF 0 on all five pages).
- Market-hours page-cost on /live-massive and /options-flow: one-off waiter fires 09:47 ET on display 2 (`--measure=60`), output `proof-output/results-page-cost-market-2026-11-11.json`.
- Auto-update: `updates.ts` rules exist and are tested, but nothing is wired until signing (Step 7, Azure). Website changes reach every member without a reinstall.
- Heredoc trap hit three more times today: a backslash-n or a Windows path inside a bash heredoc loses its backslash. Write JS/Python files with the Write tool.

## Status 2026-11-11 ~00:10 CT

- VERIFIED LIVE: /charts idle rAF 60->0; /dashboard idle layouts 60->0; new-member first minute main thread max 65%->8% (pack worker); recovery after a network drop: auth +2 ms, streams +117 ms, banner clears +513 ms (`recovery-proof.mjs` 4/4; it failed on the old build). CDN 1,121/1,121 Brotli both variants.
- Shell **0.1.5** released privately (`desktop-0.1.5`; adds site-events: first_signin, desk_restored), proofs blackbox/telemetry/recovery all pass on it. NOT sent to Bracco (owner OK needed); send 0.1.5, not 0.1.4. Website half: `speed-18-site-events` commit, pushing behind another session's deploy.
- Proof runs with `MSYS_NO_PATHCONV=1` need `UCT_PROOF_EXE` as a Windows path (`cygpath -w`).
- NEXT: market-hours page-cost on /live-massive and /options-flow (opens windows on display 5 during trading: ask the owner first); telemetry first_signin/desk_restored need a bridge method (contract change + shell 0.1.5); Step 9 nightly perf gate (standing scheduled task: owner OK); Step 7 updater (Azure).

## Status 2026-11-10 ~22:40 CT

- DONE: CDN compression live (Chrome first visit /charts 6.75 -> 2.42 MB); telemetry door live + proof 4/4; shell **0.1.4 released privately** (`desktop-0.1.4` on uct-large-files, SHA-256 77383C45...0C50), **not yet sent to Bracco: ask the owner first**.
- DEPLOYING: website `793bb7bacf` (overlays rest when still via `watchChartView`; integrity tool checks the Origin variant) plus `3e6a399402` idle mode and `ea1f37f8ca` bytes. After it lands: `MSYS_NO_PATHCONV=1 node scripts/proofs/page-cost.mjs electron --warm=90 --display=5 /charts` must show rAF/s near 0.
- NEXT: (1) find the /dashboard 60 layouts/s CSS cause (`cold-layout-probe.mjs`, run with the window on display 5; it lacks placement, add it); (2) pack ingest off the main thread (cold first minute 65-95% busy); (3) market-hours page-cost on /live-massive and /options-flow; (4) add the Origin note to CLAUDE.md rule 9 with the next website push.
- Proof windows: ALWAYS on an uncovered display. The primary display may be under a full-screen window, and then nothing draws.

## Session 2026-11-10 late night

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
