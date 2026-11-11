@echo off
rem Task Scheduler entry for the nightly speed check (scripts/nightly/perf-nightly.mjs).
rem Runs under the heavy lock so it never measures while a render or test suite holds the PC.
cd /d C:\Users\Patrick\uct-desktop
if not exist proof-output\nightly mkdir proof-output\nightly
python C:\Users\Patrick\uct-clips\tools\heavy_lock.py --label "desktop nightly speed check" run -- "C:\Program Files\nodejs\node.exe" scripts\nightly\perf-nightly.mjs >> proof-output\nightly\task-output.txt 2>&1
