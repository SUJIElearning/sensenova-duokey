@echo off
setlocal
chcp 65001 >nul 2>&1
cd /d "%~dp0"

REM ============================================================
REM  SenseNova Multi-Key Proxy launcher
REM
REM  Keys are read from (in priority order):
REM    1) environment variables below (uncomment and fill)
REM    2) ~/.dsh/.credentials.yaml  -> refs.SENSENOVA_API_KEY_*
REM ============================================================
REM set "SENSENOVA_API_KEY_1=sk-your-first-key"
REM set "SENSENOVA_API_KEY_2=sk-your-second-key"
REM ============================================================

echo ==========================================
echo  SenseNova Multi-Key Proxy
echo ==========================================
echo.

echo [1/4] Cleaning old proxy on port 15722...
powershell -NoProfile -Command "try { $c = Get-NetTCPConnection -LocalPort 15722 -State Listen -ErrorAction SilentlyContinue; if ($c) { foreach ($conn in $c) { Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue }; Write-Host '    cleaned old proxy' } else { Write-Host '    port is free' } } catch { Write-Host ('    check failed: ' + $_.Exception.Message) }"

echo [2/4] Waiting for port release...
timeout /t 2 /nobreak >nul

echo [3/4] Starting proxy...
if not exist "logs" mkdir "logs"
start "SenseNova Proxy" /min cmd /c "node sensenova-multikey-proxy.js > logs\proxy-run.log 2>&1"

echo [4/4] Verifying...
timeout /t 3 /nobreak >nul
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:15722/health' -UseBasicParsing -TimeoutSec 5; Write-Host ''; Write-Host ('OK! HTTP ' + $r.StatusCode) -ForegroundColor Green; Write-Host $r.Content } catch { Write-Host ''; Write-Host ('FAILED: ' + $_.Exception.Message) -ForegroundColor Red }"

echo.
echo Done. You can close this window; the proxy keeps running.
echo Status: http://127.0.0.1:15722/status
echo.
pause