@echo off
setlocal
chcp 65001 >nul 2>&1
title Uninstall Auto-Start

echo ==========================================
echo  SenseNova Multi-Key Proxy - Remove Auto-Start
echo ==========================================
echo.

set "VBS=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\zhaoyu-sensenova-duokey.vbs"

if exist "%VBS%" (
    del /f /q "%VBS%"
    echo [OK] Auto-start removed. The proxy will NOT start with Windows anymore.
) else (
    echo [--] Auto-start was not installed. Nothing to do.
)

echo.
echo Note: the proxy may still be running right now.
echo       Run stop-proxy.bat to stop it.
echo.
pause