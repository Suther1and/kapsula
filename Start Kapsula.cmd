@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist "%~dp0release\win-unpacked\Kapsula.exe" (
  start "" "%~dp0release\win-unpacked\Kapsula.exe"
  exit /b 0
)
echo Первая сборка Kapsula для Windows...
if not exist "%~dp0node_modules" (
  call npm install
  if errorlevel 1 (
    echo Ошибка установки зависимостей.
    pause
    exit /b 1
  )
)
call npm run pack:win
if errorlevel 1 (
  echo Ошибка сборки Kapsula.
  pause
  exit /b 1
)
start "" "%~dp0release\win-unpacked\Kapsula.exe"
