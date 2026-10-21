@echo off
setlocal
chcp 65001 >nul 2>&1
title Install Auto-Start

echo ==========================================
echo  SenseNova Multi-Key Proxy - Auto-Start
echo ==========================================
echo.

set "PROXY_DIR=%~dp0"
set "PROXY_JS=%PROXY_DIR%sensenova-multikey-proxy.js"
set "VBS=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\zhaoyu-sensenova-duokey.vbs"

if not exist "%PROXY_JS%" (
    echo [ERROR] sensenova-multikey-proxy.js not found next to this script.
    pause
    exit /b 1
)

echo [1/4] Removing the "from the internet" mark from all files...
echo       (this is what stops Windows from asking "Unknown publisher")
powershell -NoProfile -Command "try { $n = 0; Get-ChildItem -LiteralPath '%PROXY_DIR%' -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object { try { Unblock-File -LiteralPath $_.FullName -ErrorAction Stop; $n++ } catch {} }; Write-Host ('      unblocked ' + $n + ' file(s)') -ForegroundColor Green } catch { Write-Host '      unblock skipped (not fatal)' -ForegroundColor Yellow }"

echo [2/4] Writing startup launcher...
echo       -^> %VBS%
> "%VBS%" echo Set WshShell = CreateObject("WScript.Shell")
>> "%VBS%" echo WshShell.CurrentDirectory = "%PROXY_DIR%"
>> "%VBS%" echo WshShell.Run "node ""%PROXY_JS%""", 0, False

if not exist "%VBS%" (
    echo [ERROR] Failed to write the startup launcher.
    pause
    exit /b 1
)
echo       launcher written OK (it is a .vbs created locally, so it never carries the internet mark)

echo [3/4] Starting the proxy now (so you do not have to reboot)...
if not exist "%PROXY_DIR%logs" mkdir "%PROXY_DIR%logs"
start "SenseNova Proxy" /min cmd /c "cd /d "%PROXY_DIR%" ^&^& node sensenova-multikey-proxy.js > logs\proxy-run.log 2^>^&1"

echo [4/4] Verifying...
timeout /t 3 /nobreak >nul
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:15722/health' -UseBasicParsing -TimeoutSec 5; Write-Host ('      proxy OK: ' + $r.Content) -ForegroundColor Green } catch { Write-Host '      proxy not responding yet (check logs\proxy-run.log)' -ForegroundColor Yellow }"

echo.
echo ==========================================
echo  DONE. The proxy will now start with Windows,
echo  and Windows should stop asking for permission.
echo.
echo  Remove auto-start: run uninstall-autostart.bat
echo  Stop it now:       run stop-proxy.bat
echo  Just fix popups:   run unblock-files.bat
echo ==========================================
echo.
pause