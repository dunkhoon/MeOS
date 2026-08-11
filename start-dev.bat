@echo off
cd /d "%~dp0"

echo ============================================================
echo   PrivatePlanner - dev (web + sync server)
echo   URL: http://localhost:5173
echo ============================================================
echo.

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm not found. Install Node.js LTS from https://nodejs.org
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo [SETUP] First run - installing dependencies...
  call npm install
  if errorlevel 1 ( echo [ERROR] Install failed. & pause & exit /b 1 )
  echo.
)

echo [cleanup] Freeing ports 5173 / 5174 / 9797 from previous runs...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr LISTENING ^| findstr /C:":5173 " /C:":5174 " /C:":9797 "') do taskkill /F /PID %%p >nul 2>&1

echo [RUN] Starting web + sync server. Open http://localhost:5173
echo       Press Ctrl+C in this window to stop.
echo.

call npm run dev

echo.
echo [INFO] Dev stopped.
pause
