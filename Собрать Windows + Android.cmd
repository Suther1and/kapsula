@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ================================================
echo    Сборка Kapsula: Windows (.exe) + Android (.apk)
echo ================================================
echo.

taskkill /IM Kapsula.exe /F >nul 2>&1

if not exist "%~dp0node_modules" (
  echo -^> [1/3] Устанавливаю зависимости...
  call npm install
  if errorlevel 1 goto :fail
)

echo -^> [2/3] Собираю Kapsula для Windows...
call npm run pack:win
if errorlevel 1 goto :fail

echo.
echo -^> [3/3] Собираю Kapsula для Android (Fold)...
call npm run pack:android
if errorlevel 1 goto :fail

echo.
echo ================================================
echo    Готово! Оба файла собраны в папке release\:
echo    - Windows: release\win-unpacked\Kapsula.exe
echo    - Android: release\Kapsula-1.0.0-android-release.apk
echo ================================================
explorer "%~dp0release"
pause
exit /b 0

:fail
echo.
echo Что-то пошло не так. Смотри сообщение выше.
pause
exit /b 1
