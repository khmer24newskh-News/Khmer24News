@echo off
setlocal
title Khmer24 - Daily Telegram Report
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo [ERROR] .venv is missing. Run run.bat once first.
  exit /b 1
)

rem Pass through any arguments, e.g.  telegram_daily.bat --dry-run
".venv\Scripts\python.exe" send_daily.py %*
set "RC=%errorlevel%"
if not "%RC%"=="0" (
  echo [FAILED] send_daily.py exited with code %RC%. Task Scheduler will report this as a failure.
)
exit /b %RC%
