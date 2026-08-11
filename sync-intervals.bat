@echo off
cd /d "%~dp0"

echo ============================================================
echo   PrivatePlanner - intervals.icu -^> Supabase sync
echo ============================================================
echo.

call node scripts/sync-intervals.mjs

echo.
pause
