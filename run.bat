@echo off
setlocal

echo.
echo  ============================================
echo    Trading Dashboard  -  Local Launcher
echo  ============================================
echo.

:: Change to the directory where this batch file lives
cd /d "%~dp0"

:: Ensure Python 3.11 is at the front of PATH
set "PATH=%LOCALAPPDATA%\Programs\Python\Python311;%LOCALAPPDATA%\Programs\Python\Python311\Scripts;%PATH%"

echo  [1/2]  Checking Python dependencies...
pip install -r requirements.txt
if errorlevel 1 (
    echo.
    echo  ERROR: pip install failed.  Make sure Python 3.9+ is on your PATH.
    pause
    exit /b 1
)

echo.
echo  [2/2]  Starting server on http://localhost:5000
echo         Press Ctrl+C to stop.
echo.

:: Open browser after a short delay (runs in background)
start "" cmd /c "timeout /t 3 /nobreak >nul && start http://localhost:5000"

python app.py

pause
