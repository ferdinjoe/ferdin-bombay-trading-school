@echo off
rem =========================================================================
rem  Lecture launcher  --  double-click to open the course deck with live tape.
rem
rem  Serves the BTS folder over http and opens the Week 1 Day 2 deck, because
rem  the live 3-second quote pull needs an http origin to reach the public
rem  CORS relays (a file:// origin works less reliably). No install, no build:
rem  it reuses the desk's static server with the course folder as the root.
rem  Override the port with BTS_PORT, e.g.  set BTS_PORT=8952  then run this.
rem =========================================================================

setlocal
set "HERE=%~dp0"
set "PORT=%BTS_PORT%"
if "%PORT%"=="" set "PORT=8952"
set "URL=http://127.0.0.1:%PORT%/lectures/week1-day2-dow-theory.html"

where node.exe >nul 2>nul
if errorlevel 1 goto :fallback

rem A second double-click is harmless: the server exits quietly when the port
rem is already taken, and the browser just opens the deck that is running.
start "BTS lecture server" /min node "%HERE%..\market-structure-desk\tools\serve.js" %PORT% "%HERE%.."
ping -n 10 127.0.0.1 >nul
start "" "%URL%"

echo.
echo   Week 1 Day 2 - Dow Theory  ^>  %URL%
echo.
echo   Leave the minimized "BTS lecture server" window open while you teach;
echo   closing it stops the live tape. The "tape: on" button at the bottom
echo   right of the deck starts and stops the 3-second quote poll.
echo   This window may be closed now.
echo.
ping -n 9 127.0.0.1 >nul
goto :end

:fallback
echo.
echo   Node was not found on PATH, so the deck opens straight from file://.
echo   Slides, speaker notes and the handout print still work. The live tape
echo   may stay dark: quote relays answer an http origin more reliably.
echo.
echo   Opening: %HERE%week1-day2-dow-theory.html
start "" "%HERE%week1-day2-dow-theory.html"
ping -n 9 127.0.0.1 >nul

:end
endlocal
