@echo off
cd /d "%~dp0"

echo ============================================================
echo   MeOS - Desktop (Electron + web)
echo ============================================================
echo.
echo Starting Vite dev server + Electron window...
echo Close the Electron window to stop everything.
echo.

if not exist "node_modules\electron\" (
  echo [SETUP] Installing dependencies...
  call npm install
  if errorlevel 1 ( echo [ERROR] Install failed. & pause & exit /b 1 )
)

echo [cleanup] Freeing ports 5173 / 5174 from previous runs...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr LISTENING ^| findstr /C:":5173 " /C:":5174 "') do taskkill /F /PID %%p >nul 2>&1

call npm run desktop:dev

echo.
echo [INFO] Desktop app stopped.
pause
