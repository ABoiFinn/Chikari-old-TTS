@echo off
cd /d "%~dp0"
if not exist venv\Scripts\pythonw.exe (
    echo Setup hasn't been run yet.
    echo Right-click install.ps1 and choose "Run with PowerShell" first.
    pause
    exit /b 1
)
start "" venv\Scripts\pythonw.exe server.py
