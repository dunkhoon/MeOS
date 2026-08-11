@echo off
cd /d "%~dp0"

echo ============================================================
echo   MeOS - sync (Supabase Edge Function)
echo ============================================================
echo.

call node scripts/sync-intervals.mjs

echo.
pause
