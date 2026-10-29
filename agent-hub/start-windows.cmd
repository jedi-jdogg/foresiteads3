@echo off
rem Double-click to start the Agent Hub on Windows.
rem First run: installs packages and creates .env. Pulls the latest version on each start when installed from GitHub.
setlocal
cd /d "%~dp0"
title Agent Hub

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org, then double-click this file again.
  start https://nodejs.org/en/download
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -p "typeof process.loadEnvFile"') do set LOADENV=%%v
if not "%LOADENV%"=="function" (
  echo Your Node.js is too old. Install the LTS version from https://nodejs.org, then try again.
  start https://nodejs.org/en/download
  pause
  exit /b 1
)

rem Update from GitHub when this folder came from a git clone. Fast-forward only, so a local edit is never overwritten.
if exist "..\.git" (
  git -C .. pull --ff-only --quiet 2>nul && (echo Checked for updates.) || (echo Could not check for updates. Running the installed version.)
)

if not exist "node_modules\" (
  echo Installing packages (first run only)...
  call npm ci --no-audit --no-fund
)

if not exist ".env" (
  copy /y .env.example .env >nul
  echo Created .env. Add your API keys in the Connect tab once the console opens.
)

set PORT=4747
for /f "tokens=2 delims==" %%p in ('findstr /b "HUB_PORT=" .env 2^>nul') do set PORT=%%p
if not defined HUB_NO_OPEN start "" /b cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:%PORT%/#connect"
echo Agent Hub running at http://localhost:%PORT%. Close this window to stop it.
node bin\hub.js serve
pause
