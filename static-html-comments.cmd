@echo off
rem Drag a folder or an .html file onto this file to review it.
rem Double-click with nothing dropped: opens the bundled demo.
rem Keep this file ASCII-only.
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on PATH. Install Node.js 16 or newer first.
  pause
  exit /b 1
)
if "%~1"=="" (
  node "%~dp0static-html-comments.js" "%~dp0demo"
) else (
  node "%~dp0static-html-comments.js" %*
)
if errorlevel 1 pause
