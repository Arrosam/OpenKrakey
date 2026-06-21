@echo off
rem krakey - launcher for an OpenKrakey install (Windows).
rem
rem Anchored to this install dir (the parent of this script's folder) so an
rem Agent's agents\ and config\ always resolve here, wherever you run krakey
rem from. install.ps1 adds this folder to your user PATH.
setlocal
for %%I in ("%~dp0..") do set "ROOT=%%~fI"

if not exist "%ROOT%\node_modules\tsx\package.json" goto :nodeps

pushd "%ROOT%"
node --import tsx "packages\cli\src\bin.ts" %*
set "CODE=%ERRORLEVEL%"
popd
exit /b %CODE%

:nodeps
echo krakey: dependencies are not installed in %ROOT% 1>&2
echo Run install.ps1 in that folder, or run: npm install 1>&2
exit /b 1
