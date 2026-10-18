@echo off
rem Textbook - Windows launcher.
rem Keep this file ASCII-only: cmd.exe reads it with the OEM code page.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.5 or newer is required.
  echo Download it from https://nodejs.org/ and run this file again.
  pause
  exit /b 1
)

if "%PORT%"=="" set PORT=9621
if "%TEXTBOOK_DATA_DIR%"=="" set TEXTBOOK_DATA_DIR=%~dp0data

echo.
echo   Textbook  http://127.0.0.1:%PORT%/
echo   Data      %TEXTBOOK_DATA_DIR%
echo   Stop      press Ctrl+C
echo.
start "" cmd /c "timeout /t 2 >nul & start http://127.0.0.1:%PORT%/"
node --experimental-sqlite server\index.js
pause
