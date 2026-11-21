#!/bin/bash
set -euo pipefail

# Переходим в папку, где лежит этот файл
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "================================================"
echo "   Установка Kapsula на macOS"
echo "================================================"
echo ""

# Подхватываем стандартные пути Homebrew / nvm / fnm / volta
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:$HOME/.local/bin:$PATH"
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck source=/dev/null
  source "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
fi

pause_on_error() {
  echo ""
  echo "Что-то пошло не так. Нажми Enter, чтобы закрыть окно."
  read -r _
}
trap 'pause_on_error' ERR

# 1. Проверяем инструменты сборки Apple (нужны один раз для офлайн-OCR)
if ! xcode-select -p >/dev/null 2>&1; then
  echo "-> Нужны базовые инструменты macOS (Command Line Tools)."
  echo "   Сейчас откроется окно Apple — нажми «Установить», дождись окончания и снова дважды кликни этот файл."
  xcode-select --install >/dev/null 2>&1 || true
  echo ""
  echo "Нажми Enter, чтобы закрыть окно."
  read -r _
  exit 0
fi

# 2. Проверяем Node.js (Vite 8 требует 20.19+, 22.12+ или 23+)
NEED_NODE=0
if ! command -v node >/dev/null 2>&1; then
  NEED_NODE=1
else
  NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0]) || 0' 2>/dev/null || echo 0)"
  NODE_MINOR="$(node -p 'Number(process.versions.node.split(".")[1]) || 0' 2>/dev/null || echo 0)"
  if ! { [ "$NODE_MAJOR" -eq 20 ] && [ "$NODE_MINOR" -ge 19 ]; } && \
     ! { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -ge 12 ]; } && \
     ! [ "$NODE_MAJOR" -ge 23 ]; then
    NEED_NODE=1
  fi
fi

if [ "$NEED_NODE" -eq 1 ]; then
  if command -v brew >/dev/null 2>&1; then
    echo "-> Устанавливаю свежий Node.js через Homebrew..."
    brew install node || brew upgrade node
    export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
    hash -r 2>/dev/null || true
  else
    echo "-> На Mac нужен свежий Node.js (версия 20.19+, 22.12+ или новее)."
    echo "   Открываю страницу загрузки Node.js — скачай и установи LTS-версию, затем снова дважды кликни этот файл."
    open "https://nodejs.org/" >/dev/null 2>&1 || true
    echo ""
    echo "Нажми Enter, чтобы закрыть окно."
    read -r _
    exit 0
  fi
fi

echo "-> Node.js найден: $(node -v)"
echo ""

# 3. Если папку перенесли с Windows вместе с Windows node_modules — чистим их перед установкой
if [ -f "$SCRIPT_DIR/node_modules/electron/dist/electron.exe" ] || [ -d "$SCRIPT_DIR/node_modules/@esbuild/win32-x64" ]; then
  echo "-> Обнаружены зависимости от Windows — заменяю на нативные для macOS..."
  rm -rf "$SCRIPT_DIR/node_modules"
fi

echo "-> [1/3] Устанавливаю зависимости (займёт 1-2 минуты при первом запуске)..."
if [ -f "$SCRIPT_DIR/package-lock.json" ]; then
  npm ci || npm install
else
  npm install
fi

echo ""
echo "-> [2/3] Собираю Kapsula под твой Mac..."
npm run pack:mac

# 4. Находим собранный Kapsula.app
APP_SRC=""
for candidate in \
  "$SCRIPT_DIR/release/mac-arm64/Kapsula.app" \
  "$SCRIPT_DIR/release/mac-universal/Kapsula.app" \
  "$SCRIPT_DIR/release/mac/Kapsula.app" \
  "$SCRIPT_DIR/release/mac-x64/Kapsula.app"; do
  if [ -d "$candidate" ]; then
    APP_SRC="$candidate"
    break
  fi
done

if [ -z "$APP_SRC" ]; then
  echo "Ошибка: не удалось найти собранный Kapsula.app в папке release/."
  exit 1
fi

echo ""
echo "-> [3/3] Устанавливаю в «Программы» и снимаю карантин Apple..."
osascript -e 'tell application "Kapsula" to quit' >/dev/null 2>&1 || true
# Ждём до 5 секунд завершения фонового сохранения и синхронизации перед заменой .app
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if ! pgrep -x Kapsula >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

TARGET_APP="/Applications/Kapsula.app"
rm -rf "$TARGET_APP"
ditto "$APP_SRC" "$TARGET_APP"
xattr -cr "$TARGET_APP"

echo ""
echo "================================================"
echo "   Готово! Kapsula установлена в «Программы»"
echo "   Запускаю приложение..."
echo "================================================"
open "$TARGET_APP"

sleep 2
