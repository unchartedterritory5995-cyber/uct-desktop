@echo off
rem Task Scheduler entry for the weekly fault check (scripts/nightly/faults-weekly.mjs), Saturdays.
rem Runs under the heavy lock so it never runs while a render or test suite holds the PC.
cd /d C:\Users\Patrick\uct-desktop
if not exist proof-output\faults mkdir proof-output\faults
python C:\Users\Patrick\uct-clips\tools\heavy_lock.py --label "desktop weekly fault check" run -- "C:\Program Files\nodejs\node.exe" scripts\nightly\faults-weekly.mjs >> proof-output\faults\task-output.txt 2>&1
