@echo off
rem E2EE-Discord one-click installer for Vencord - Made by XO.ST
rem Double-click to install or update. Run "Install-E2EE-Discord.cmd -Uninstall" to remove.
title E2EE-Discord installer
setlocal
set "SCRIPT=%~dp0install-vencord.ps1"
if exist "%SCRIPT%" goto run

rem Downloaded on its own: fetch the installer script first
set "SCRIPT=%TEMP%\e2ee-discord-install-vencord.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol='Tls12'; Invoke-RestMethod 'https://raw.githubusercontent.com/xo907/e2ee-discord/main/install-vencord.ps1' -OutFile $env:TEMP\e2ee-discord-install-vencord.ps1"
if errorlevel 1 (
  echo Could not download the installer. Check your connection or get it from https://github.com/xo907/e2ee-discord
  pause
  exit /b 1
)

:run
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
