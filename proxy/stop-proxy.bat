@echo off
setlocal
chcp 65001 >nul 2>&1
title Stop Proxy

echo ==========================================
echo  SenseNova Multi-Key Proxy - Stop
echo ==========================================
echo.

echo Looking for the process listening on port 15722...
powershell -NoProfile -Command "try { $c = Get-NetTCPConnection -LocalPort 15722 -State Listen -ErrorAction SilentlyContinue; if ($c) { $pids = $c | ForEach-Object { $_.OwningProcess } | Sort-Object -Unique; foreach ($p in $pids) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue; Write-Host ('    stopped PID ' + $p) } } else { Write-Host '    no proxy is running' } } catch { Write-Host ('    failed: ' + $_.Exception.Message) }"

echo.
echo Done. The proxy is stopped (auto-start, if installed, still applies on next boot).
echo.
pause