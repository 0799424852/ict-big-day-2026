@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto missing
node -e "if(Number(process.versions.node.split('.')[0])<24)process.exit(1)"
if errorlevel 1 goto missing
node start.mjs --trial
pause
exit /b
:missing
echo Install Node.js 24 LTS or newer from https://nodejs.org/en/download then reopen this file.
pause
