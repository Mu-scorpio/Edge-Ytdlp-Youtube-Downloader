@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul 2>&1

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "DIST=%ROOT%\dist"
set "PACKAGE_NAME=edge-ytdlp-youtube-downloader"
set "STAGING=%DIST%\%PACKAGE_NAME%"
set "ARCHIVE=%DIST%\%PACKAGE_NAME%.zip"

if not exist "%ROOT%\manifest.json" (
  echo [ERROR] manifest.json not found.
  exit /b 1
)

echo Building release package: %PACKAGE_NAME%.zip

if not exist "%DIST%" mkdir "%DIST%"
if exist "%STAGING%" rmdir /s /q "%STAGING%"
if exist "%ARCHIVE%" del /f /q "%ARCHIVE%"
mkdir "%STAGING%"
mkdir "%STAGING%\icons"
mkdir "%STAGING%\docs"
mkdir "%STAGING%\docs\screenshots"

set "FILES=manifest.json background.js content.js page-bridge.js content.css popup.html popup.js popup.css options.html options.js options.css native-host.py setup-native-host.bat README.md CHANGELOG.md LICENSE"
for %%F in (%FILES%) do (
  if not exist "%ROOT%\%%F" (
    echo [ERROR] Missing release file: %%F
    exit /b 1
  )
  copy /y "%ROOT%\%%F" "%STAGING%\%%F" >nul
)

for %%I in (icon16.png icon32.png icon48.png icon128.png) do (
  if not exist "%ROOT%\icons\%%I" (
    echo [ERROR] Missing icon: icons\%%I
    exit /b 1
  )
  copy /y "%ROOT%\icons\%%I" "%STAGING%\icons\%%I" >nul
)

for %%S in (hero.png watch.png popup.png search.png) do (
  if not exist "%ROOT%\docs\screenshots\%%S" (
    echo [ERROR] Missing screenshot: docs\screenshots\%%S
    exit /b 1
  )
  copy /y "%ROOT%\docs\screenshots\%%S" "%STAGING%\docs\screenshots\%%S" >nul
)

powershell -NoProfile -Command "Compress-Archive -Path (Join-Path '%STAGING%' '*') -DestinationPath '%ARCHIVE%' -CompressionLevel Optimal"
if errorlevel 1 (
  echo [ERROR] Failed to create ZIP.
  exit /b 1
)

rmdir /s /q "%STAGING%"
echo Created: %ARCHIVE%
exit /b 0
