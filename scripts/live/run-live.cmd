@echo off
rem Launcher used by start-live.ps1: runs `npm run dev` with both streams appended to the log and, when the
rem server process ends for any reason, appends an `==== exit code N` marker so a silent death leaves a
rem line in live.log (the watchdog and a human reading the log can tell "stopped" from "still running").
rem   run-live.cmd <log path>
rem `call` is required: a .cmd invoked from a batch file without it never returns here.
call npm run dev >> "%~1" 2>&1
echo ==== exit code %ERRORLEVEL% %DATE% %TIME% ==== >> "%~1"
