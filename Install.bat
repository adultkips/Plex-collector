@echo off
setlocal

cd /d "%~dp0"

set "PYTHON_CMD="
where py >nul 2>nul
if %errorlevel%==0 (
  set "PYTHON_CMD=py"
) else (
  where python >nul 2>nul
  if %errorlevel%==0 set "PYTHON_CMD=python"
)

if "%PYTHON_CMD%"=="" (
  echo [Plex Collector] ERROR: Python was not found on this PC.
  echo Install Python 3.11+ and ensure it is available in PATH.
  goto :fail
)

call :ensure_venv
if %errorlevel% neq 0 goto :fail

echo [Plex Collector] Installing/verifying dependencies...
".venv\Scripts\python.exe" -m pip install -r backend\requirements.txt
if %errorlevel% neq 0 (
  echo [Plex Collector] Dependency install failed. Recreating .venv and retrying once...
  call :recreate_venv
  if %errorlevel% neq 0 goto :fail
  ".venv\Scripts\python.exe" -m pip install -r backend\requirements.txt
  if %errorlevel% neq 0 (
    echo [Plex Collector] ERROR: Dependency install failed after retry.
    goto :fail
  )
)

echo.
echo [Plex Collector] Installation completed successfully.
echo [Plex Collector] Close this window and run start_server.bat to start the server.
echo.
echo Press any key to close this window...
pause >nul
endlocal
exit /b 0

:ensure_venv
set "STAMP=%COMPUTERNAME%_%USERNAME%"
if exist ".venv\Scripts\python.exe" (
  set "NEED_RECREATE="
  if exist ".venv\.machine_stamp" (
    set /p EXISTING_STAMP=<".venv\.machine_stamp"
    if not "%EXISTING_STAMP%"=="%STAMP%" set "NEED_RECREATE=1"
  ) else (
    set "NEED_RECREATE=1"
  )

  if defined NEED_RECREATE (
    echo [Plex Collector] Existing .venv belongs to another machine/user. Recreating...
    call :recreate_venv
    exit /b %errorlevel%
  )

  ".venv\Scripts\python.exe" -c "import sys; print(sys.version)" >nul 2>nul
  if %errorlevel% neq 0 (
    echo [Plex Collector] Existing .venv is invalid on this PC. Recreating...
    call :recreate_venv
    exit /b %errorlevel%
  )
  exit /b 0
)

call :recreate_venv
exit /b %errorlevel%

:recreate_venv
if exist ".venv" rmdir /s /q ".venv"
echo [Plex Collector] Creating virtual environment...
%PYTHON_CMD% -m venv .venv
if not exist ".venv\Scripts\python.exe" (
  echo [Plex Collector] ERROR: Failed to create virtual environment.
  exit /b 1
)
echo %COMPUTERNAME%_%USERNAME%>".venv\.machine_stamp"
exit /b 0

:fail
echo.
echo Press any key to close this window...
pause >nul
endlocal
exit /b 1
