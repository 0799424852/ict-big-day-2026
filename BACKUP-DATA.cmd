@echo off
setlocal
cd /d "%~dp0"
node maintenance.mjs --backup
pause
