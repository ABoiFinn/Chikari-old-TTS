@echo off
cd /d "%~dp0"
if not exist venv\Scripts\python.exe (
    echo Setup hasn't been run yet.
    echo Right-click install.ps1 and choose "Run with PowerShell" first.
    pause
    exit /b 1
)
echo Starting the local reader server...
echo Keep this window open while you're reading. Close it when you're done.
echo.
venv\Scripts\python.exe server.py
pause
