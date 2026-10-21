@echo off
setlocal
chcp 65001 >nul 2>&1
title Unblock Files

echo ==========================================
echo  SenseNova Multi-Key Proxy - Remove Network Mark
echo ==========================================
echo.
echo  Every file downloaded from the internet carries a hidden
echo  "from the internet" mark. That mark is what makes Windows
echo  show "Unknown publisher - do you want to run this software?"
echo  whenever a .bat is started.
echo.
echo  This tool removes that mark from every file in this folder.
echo.

set "PROXY_DIR=%~dp0"
echo Folder: %PROXY_DIR%
echo.

powershell -NoProfile -Command "try { $n = 0; $f = 0; Get-ChildItem -LiteralPath '%PROXY_DIR%' -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object { try { Unblock-File -LiteralPath $_.FullName -ErrorAction Stop; $n++ } catch { $f++ } }; Write-Host ('    unblocked: ' + $n + ' file(s)') -ForegroundColor Green; if ($f -gt 0) { Write-Host ('    skipped  : ' + $f + ' file(s)') -ForegroundColor Yellow } } catch { Write-Host ('    failed: ' + $_.Exception.Message) -ForegroundColor Red }"

echo.
echo ==========================================
echo  DONE.
echo.
echo  If auto-start still pops up on boot, your startup entry is
echo  probably pointing at start-proxy.bat directly. Remove it and
echo  run install-autostart.bat instead (it creates a .vbs launcher,
echo  which never carries the internet mark).
echo ==========================================
echo.
pause