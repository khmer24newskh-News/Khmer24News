@echo off
setlocal EnableDelayedExpansion
title Khmer24 Business Intelligence
cd /d "%~dp0"

rem ---------- locate a Python interpreter ----------
set "PY="
where py >nul 2>&1 && set "PY=py -3"
if not defined PY ( where python >nul 2>&1 && set "PY=python" )
if not defined PY goto :nopython

rem ---------- virtual environment (created once) ----------
if not exist ".venv\Scripts\python.exe" (
  echo [1/4] Creating virtual environment...
  %PY% -m venv .venv
  if errorlevel 1 goto :venvfail
) else (
  echo [1/4] Virtual environment found.
)
set "VPY=.venv\Scripts\python.exe"

rem ---------- dependencies (reinstalled only when requirements.txt changes) ----------
for %%F in (requirements.txt) do set "STAMP=%%~tF"
set "INSTALLED="
if exist ".deps-ok" set /p INSTALLED=<".deps-ok"
if not "!INSTALLED!"=="!STAMP!" (
  echo [2/4] Installing dependencies...
  "%VPY%" -m pip install --disable-pip-version-check --quiet -r requirements.txt
  if errorlevel 1 goto :pipfail
  >".deps-ok" echo !STAMP!
) else (
  echo [2/4] Dependencies are up to date.
)

rem ---------- config file ----------
if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo [3/4] Created .env from .env.example - add your Telegram token and chat id.
) else (
  echo [3/4] .env found.
)

rem ---------- run ----------
echo [4/4] Starting server on http://127.0.0.1:5000
echo.
echo ============================================================
echo   Open:  http://127.0.0.1:5000
echo   To stop: close this window or press Ctrl+C
echo ============================================================
echo.
"%VPY%" app.py
goto :done

:nopython
echo [ERROR] Python 3.11+ was not found on PATH.
echo         Install it from https://www.python.org/downloads/windows/
echo         and tick "Add python.exe to PATH" during setup.
goto :fail

:venvfail
echo [ERROR] Failed to create .venv.
goto :fail

:pipfail
echo [ERROR] Failed to install dependencies. Check your internet connection.
goto :fail

:fail
echo.
pause
exit /b 1

:done
echo.
echo Server stopped.
pause
endlocal
