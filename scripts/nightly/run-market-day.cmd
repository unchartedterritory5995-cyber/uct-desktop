@echo off
rem One-time Task Scheduler entry: a trading day of measurement (scripts/nightly/market-day.mjs).
cd /d C:\Users\Patrick\uct-desktop
if not exist proof-output\market-day mkdir proof-output\market-day
"C:\Program Files\nodejs\node.exe" scripts\nightly\market-day.mjs >> proof-output\market-day\task-output.txt 2>&1
