@echo off
rem Task Scheduler entry for the nightly chart speed + memory canary (scripts/nightly/chart-canary.mjs), weekdays 17:30.
rem The canary queues for the heavy lock itself (normal priority, up to 75 min) and writes D:\uct-history\canary\.
cd /d C:\Users\Patrick\uct-desktop
if not exist D:\uct-history\canary mkdir D:\uct-history\canary
"C:\Program Files\nodejs\node.exe" scripts\nightly\chart-canary.mjs --trigger=scheduled >> D:\uct-history\canary\task-output.txt 2>&1
