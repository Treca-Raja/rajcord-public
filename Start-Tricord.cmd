@echo off
setlocal
cd /d "%~dp0"
call pnpm dev:desktop
if errorlevel 1 pause