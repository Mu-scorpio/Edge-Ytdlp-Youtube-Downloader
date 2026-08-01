@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul 2>&1
title YT-DLP Edge Native Host Setup

rem Usage:
rem   setup-native-host.bat <32-char-extension-id>
rem   setup-native-host.bat <extension-id> --skip-tools
rem   setup-native-host.bat <extension-id> --python "C:\Path\python.exe"

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

set "EXTENSION_ID="
set "PYTHON_PATH="
set "SKIP_TOOLS=0"
set "MISSING="

:parse_args
if "%~1"=="" goto args_done
if /i "%~1"=="--skip-tools" set "SKIP_TOOLS=1" & shift & goto parse_args
if /i "%~1"=="/skip-tools" set "SKIP_TOOLS=1" & shift & goto parse_args
if /i "%~1"=="--python" goto parse_python
if /i "%~1"=="/python" goto parse_python
if defined EXTENSION_ID (
  echo [ERROR] Unknown argument: %~1
  exit /b 1
)
set "EXTENSION_ID=%~1"
shift
goto parse_args

:parse_python
if "%~2"=="" (
  echo [ERROR] Missing path after --python
  exit /b 1
)
set "PYTHON_PATH=%~2"
shift
shift
goto parse_args

:args_done
if not defined EXTENSION_ID (
  echo.
  echo Usage:
  echo   %~nx0 ^<32-char-extension-id^>
  echo   %~nx0 ^<extension-id^> --skip-tools
  echo   %~nx0 ^<extension-id^> --python "C:\Path\python.exe"
  echo.
  echo Get the extension ID from edge://extensions after loading this folder.
  echo.
  exit /b 1
)

call :validate_extension_id
if errorlevel 1 exit /b 1

echo.
echo === YT-DLP Edge Native Host Setup ===
echo Extension folder: %ROOT%
echo Extension ID:     %EXTENSION_ID%
echo.

if not exist "%ROOT%\native-host.py" (
  echo [ERROR] native-host.py not found in:
  echo   %ROOT%
  echo Unpack the ZIP first, then run this .bat from that folder.
  exit /b 1
)

rem --- Python ---
if defined PYTHON_PATH (
  if not exist "%PYTHON_PATH%" (
    echo [ERROR] Python not found: %PYTHON_PATH%
    exit /b 1
  )
) else (
  call :find_python
)

if not defined PYTHON_PATH if "%SKIP_TOOLS%"=="0" (
  echo [WARN] Python 3.9+ not found. Trying winget...
  call :install_python_winget
  call :refresh_path
  call :find_python
)

if not defined PYTHON_PATH (
  echo [ERROR] Python 3.9+ is required.
  echo   Install: winget install -e --id Python.Python.3.12
  echo   Or pass: %~nx0 %EXTENSION_ID% --python "C:\Path\to\python.exe"
  exit /b 1
)
echo [OK] Python: %PYTHON_PATH%

rem --- Tools ---
if "%SKIP_TOOLS%"=="1" (
  echo [WARN] Skipping tool auto-install [--skip-tools].
) else (
  echo.
  echo --- Installing download dependencies ---
  call :install_ytdlp
  call :install_winget_pkg OpenJS.NodeJS.LTS "Node.js LTS" node
  call :install_winget_pkg Gyan.FFmpeg FFmpeg ffmpeg
)

rem --- Summary ---
echo.
echo --- Dependency summary ---
echo [OK] Python: ready
call :check_ytdlp
if errorlevel 1 set "MISSING=!MISSING! yt-dlp"
where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js: missing
  set "MISSING=!MISSING! Node.js"
) else (
  echo [OK] Node.js: ready
)
where ffmpeg >nul 2>&1
if errorlevel 1 (
  echo [ERROR] FFmpeg: missing - optional but recommended
  set "MISSING=!MISSING! FFmpeg"
) else (
  echo [OK] FFmpeg: ready
)

rem --- Write launcher ---
echo.
echo --- Register Native Messaging Host ---
set "LAUNCHER=%ROOT%\native-host.cmd"
set "HOST_PY=%ROOT%\native-host.py"
set "MANIFEST=%ROOT%\com.local.ytdlp_downloader.json"

> "%LAUNCHER%" (
  echo @echo off
  echo set "PYTHONUTF8=1"
  echo "%PYTHON_PATH%" "%HOST_PY%"
)
if not exist "%LAUNCHER%" (
  echo [ERROR] Cannot write native-host.cmd
  exit /b 1
)
echo [OK] Launcher: %LAUNCHER%

set "LAUNCHER_JSON=%LAUNCHER:\=\\%"
> "%MANIFEST%" (
  echo {
  echo   "name": "com.local.ytdlp_downloader",
  echo   "description": "Local yt-dlp bridge for Edge",
  echo   "path": "%LAUNCHER_JSON%",
  echo   "type": "stdio",
  echo   "allowed_origins": [
  echo     "chrome-extension://%EXTENSION_ID%/"
  echo   ]
  echo }
)
if not exist "%MANIFEST%" (
  echo [ERROR] Cannot write Native Host JSON
  exit /b 1
)
echo [OK] Manifest: %MANIFEST%

set "REG_KEY=HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.local.ytdlp_downloader"
reg add "%REG_KEY%" /ve /t REG_SZ /d "%MANIFEST%" /f >nul
if errorlevel 1 (
  echo [ERROR] Cannot write registry key: %REG_KEY%
  exit /b 1
)
echo [OK] Registry: %REG_KEY%

echo.
echo === Setup complete ===
echo Extension ID: %EXTENSION_ID%
echo Next steps:
echo   1. Open edge://extensions and reload this extension
echo   2. Refresh any open YouTube tabs
echo   3. Click the extension icon and confirm the bridge is connected
if defined MISSING (
  echo.
  echo Still missing:!MISSING!
  echo Use Install missing tools in the extension popup, or install manually.
)
echo.
echo Unregister: reg delete "%REG_KEY%" /f
echo Bridge log: %LOCALAPPDATA%\YT-DLP-Edge\bridge.log
echo.
exit /b 0

rem ===================== helpers =====================

:validate_extension_id
set "ID=%EXTENSION_ID%"
set "LEN=0"
:len_loop
if not "!ID:~%LEN%,1!"=="" (
  set /a LEN+=1
  goto len_loop
)
if not "%LEN%"=="32" (
  echo [ERROR] Extension ID must be exactly 32 characters [a-p]. Got length %LEN%: %ID%
  exit /b 1
)
echo(%ID%| findstr /r /c:"^[a-p][a-p]*$" >nul
if errorlevel 1 (
  echo [ERROR] Extension ID must only contain letters a-p: %ID%
  exit /b 1
)
exit /b 0

:find_python
set "PYTHON_PATH="
for %%C in (py python python3) do (
  if not defined PYTHON_PATH (
    where %%C >nul 2>&1
    if not errorlevel 1 (
      for /f "delims=" %%P in ('where %%C 2^>nul') do (
        if not defined PYTHON_PATH (
          call :python_version_ok "%%P"
          if not errorlevel 1 set "PYTHON_PATH=%%P"
        )
      )
    )
  )
)
exit /b 0

:python_version_ok
set "CAND=%~1"
set "VER="
set "MAJ="
set "MIN="
for /f "tokens=2 delims= " %%V in ('"%CAND%" --version 2^>^&1') do (
  if not defined VER set "VER=%%V"
)
if not defined VER exit /b 1
for /f "tokens=1,2 delims=." %%A in ("%VER%") do (
  set "MAJ=%%A"
  set "MIN=%%B"
)
if not defined MAJ exit /b 1
if not defined MIN set "MIN=0"
if !MAJ! GTR 3 exit /b 0
if !MAJ! LSS 3 exit /b 1
if !MIN! GEQ 9 exit /b 0
exit /b 1

:refresh_path
set "MACHINE_PATH="
set "USER_PATH="
for /f "tokens=2*" %%A in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul') do set "MACHINE_PATH=%%B"
for /f "tokens=2*" %%A in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "USER_PATH=%%B"
if defined MACHINE_PATH if defined USER_PATH set "PATH=%MACHINE_PATH%;%USER_PATH%" & exit /b 0
if defined MACHINE_PATH set "PATH=%MACHINE_PATH%" & exit /b 0
if defined USER_PATH set "PATH=%USER_PATH%"
exit /b 0

:install_python_winget
where winget >nul 2>&1
if errorlevel 1 (
  echo [WARN] winget not found; cannot auto-install Python.
  exit /b 1
)
echo [..] Installing Python 3.12 via winget...
winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements --disable-interactivity
call :refresh_path
exit /b 0

:install_ytdlp
echo [..] Installing/upgrading yt-dlp[default]...
"%PYTHON_PATH%" -m pip install --user --upgrade "yt-dlp[default]"
if errorlevel 1 (
  echo [ERROR] yt-dlp install failed.
  echo   Try: py -m pip install --user --upgrade "yt-dlp[default]"
  exit /b 1
)
echo [OK] yt-dlp[default] installed/upgraded.
exit /b 0

:install_winget_pkg
set "PKG_ID=%~1"
set "PKG_NAME=%~2"
set "PKG_CMD=%~3"
where %PKG_CMD% >nul 2>&1
if not errorlevel 1 (
  echo [OK] %PKG_NAME% already installed.
  exit /b 0
)
where winget >nul 2>&1
if errorlevel 1 (
  echo [WARN] %PKG_NAME% missing and winget not found.
  exit /b 1
)
echo [..] Installing %PKG_NAME% via winget [%PKG_ID%]...
winget install -e --id %PKG_ID% --accept-package-agreements --accept-source-agreements --disable-interactivity
call :refresh_path
where %PKG_CMD% >nul 2>&1
if errorlevel 1 (
  echo [WARN] %PKG_NAME% may need a new terminal or logoff to appear in PATH.
  exit /b 1
)
echo [OK] %PKG_NAME% installed.
exit /b 0

:check_ytdlp
where yt-dlp >nul 2>&1
if not errorlevel 1 (
  echo [OK] yt-dlp: ready
  exit /b 0
)
where yt-dlp.exe >nul 2>&1
if not errorlevel 1 (
  echo [OK] yt-dlp: ready
  exit /b 0
)
"%PYTHON_PATH%" -c "import yt_dlp" >nul 2>&1
if not errorlevel 1 (
  echo [OK] yt-dlp: ready via python -m yt_dlp
  exit /b 0
)
echo [ERROR] yt-dlp: missing
exit /b 1
