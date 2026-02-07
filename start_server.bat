@echo off
setlocal

cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo [Plex Collector] ERROR: Virtual environment not found.
  echo Run Install.bat once first.
  goto :fail
)

echo [Plex Collector] Starting server on http://127.0.0.1:8787
".venv\Scripts\python.exe" -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8787 --reload
if %errorlevel% neq 0 (
  echo [Plex Collector] ERROR: Server exited unexpectedly.
  goto :fail
)

endlocal
exit /b 0

:fail
echo.
echo Press any key to close this window...
pause >nul
endlocal
exit /b 1
