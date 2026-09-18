@echo off
REM ============================================================================
REM  MEDCORE - Vendor / Customer operations entry point (Windows)
REM
REM  Safe, idempotent operational commands for a clinic operator. This is a thin,
REM  friendly wrapper around the tested cross-platform scripts in install\ and the
REM  server CLIs, so the real logic lives in ONE place (install\medcorectl.mjs,
REM  install\bootstrap.mjs). Secrets are never printed by these commands.
REM
REM  Usage:  vendor.bat <command>
REM    install     Install / initialise MEDCORE on this machine (idempotent)
REM    start       Start the MEDCORE service
REM    stop        Stop the MEDCORE service
REM    restart     Restart the MEDCORE service
REM    status      Is MEDCORE running?
REM    health      Detailed health check
REM    backup      Create an encrypted backup
REM    restore     Restore a backup:  vendor.bat restore <id> --yes
REM    update      Safe update (pre-update backup, migrate, verify)
REM    logs        Show recent install/operation logs
REM    diagnostics Write a PHI-free support bundle
REM    license     License status/activation:  vendor.bat license status
REM    uninstall   Stop the service and explain safe removal
REM ============================================================================
setlocal
set "ROOT=%~dp0"
set "SERVER=%ROOT%server"
set "PIDFILE=%ROOT%install\medcore.pid"
if "%PORT%"=="" set "PORT=4000"

where node >nul 2>nul
if errorlevel 1 (
  echo [MEDCORE] Node.js is required but was not found on PATH.
  echo           The MEDCORE package includes a bundled Node runtime; run the
  echo           vendor installer, or install Node 22 LTS, then retry.
  exit /b 1
)

if "%~1"=="" goto :usage
set "CMD=%~1"
shift

if /I "%CMD%"=="install"     goto :install
if /I "%CMD%"=="start"       goto :start
if /I "%CMD%"=="stop"        goto :stop
if /I "%CMD%"=="restart"     goto :restart
if /I "%CMD%"=="status"      goto :ctl
if /I "%CMD%"=="health"      goto :ctl
if /I "%CMD%"=="backup"      goto :ctl
if /I "%CMD%"=="restore"     goto :ctl
if /I "%CMD%"=="update"      goto :ctl
if /I "%CMD%"=="diagnostics" goto :ctl
if /I "%CMD%"=="license"     goto :ctl
if /I "%CMD%"=="logs"        goto :logs
if /I "%CMD%"=="uninstall"   goto :uninstall
goto :usage

:install
echo [MEDCORE] Installing / initialising (idempotent)...
pushd "%SERVER%" && call npm ci --omit=dev && popd
node "%ROOT%install\bootstrap.mjs" %*
if errorlevel 1 ( echo [MEDCORE] Install failed. See install\logs. & exit /b 1 )
echo [MEDCORE] Install complete. Run: vendor.bat start
exit /b 0

:start
if exist "%PIDFILE%" (
  echo [MEDCORE] A MEDCORE process may already be running ^(pid file present^). Use: vendor.bat status
)
echo [MEDCORE] Starting service on port %PORT%...
pushd "%SERVER%"
start "MEDCORE" /b cmd /c "node dist\index.js > ""%ROOT%install\logs\service.log"" 2>&1 & echo !ERRORLEVEL!"
for /f "tokens=2" %%p in ('tasklist /fi "imagename eq node.exe" /nh ^| findstr node.exe') do set "LASTPID=%%p"
popd
> "%PIDFILE%" echo %LASTPID%
echo [MEDCORE] Started. Check: vendor.bat health
exit /b 0

:stop
if not exist "%PIDFILE%" ( echo [MEDCORE] No pid file; service may not be running. & exit /b 0 )
set /p PID=<"%PIDFILE%"
echo [MEDCORE] Stopping service ^(pid %PID%^)...
taskkill /pid %PID% /f >nul 2>nul
del "%PIDFILE%" >nul 2>nul
echo [MEDCORE] Stopped.
exit /b 0

:restart
call "%~f0" stop
call "%~f0" start
exit /b 0

:ctl
node "%ROOT%install\medcorectl.mjs" %CMD% %*
exit /b %errorlevel%

:logs
echo [MEDCORE] Recent logs in %ROOT%install\logs :
dir /b /o-d "%ROOT%install\logs" 2>nul
exit /b 0

:uninstall
echo [MEDCORE] Stopping service before removal...
call "%~f0" stop
echo [MEDCORE] To remove MEDCORE: take a final backup ^(vendor.bat backup^), then
echo           delete this folder. Your database and the state\ folder ^(backups,
echo           license^) are NOT deleted automatically so your data is preserved.
exit /b 0

:usage
echo MEDCORE vendor console
echo   Usage: vendor.bat ^<install^|start^|stop^|restart^|status^|health^|backup^|restore^|update^|logs^|diagnostics^|license^|uninstall^>
exit /b 1
