@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
if "%~1"=="" exit /b 2
if not "%~2"=="" exit /b 2
"%~dp0..\node\node.exe" "%~dp0..\dist\autostart\task-launcher.js" "%~1"
exit /b %errorlevel%
