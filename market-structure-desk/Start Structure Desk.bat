@echo off
rem =========================================================================
rem  Structure Desk launcher  --  double-click to open the trading desk.
rem
rem  Starts the bundled Node static server (no install, no build) and opens
rem  http://127.0.0.1:8931/ in your default browser.
rem  If Node is not on PATH it falls back to opening index.html from disk.
rem  Override the port with SD_PORT, e.g.  set SD_PORT=8941  then run this.
rem =========================================================================

set "APP_DIR=%~dp0"
set "PORT=%SD_PORT%"
if "%PORT%"=="" set "PORT=8931"
set "URL=http://127.0.0.1:%PORT%/"

where node.exe >nul 2>nul
if errorlevel 1 goto :fallback

rem A second double-click is harmless: serve.js exits quietly when the port
rem is already taken, and the browser just opens the desk that is running.
start "Structure Desk server" /min node "%APP_DIR%tools\serve.js" %PORT%
ping -n 12 127.0.0.1 >nul
start "" "%URL%"

echo.
echo   Structure Desk  ^>  %URL%
echo.
echo   Leave the minimized "Structure Desk server" window open while you use
echo   the desk. Closing it stops the feed. This window may be closed now.
echo.
ping -n 9 127.0.0.1 >nul
goto :end

:fallback
echo.
echo   Node was not found on PATH, so the desk opens straight from file://
echo   instead of a local server. Structure tools and pasted OHLCV work;
echo   live quotes still depend on the public relays reaching Yahoo.
echo.
echo   Opening: %APP_DIR%index.html
start "" "%APP_DIR%index.html"
ping -n 9 127.0.0.1 >nul

:end
endlocal
