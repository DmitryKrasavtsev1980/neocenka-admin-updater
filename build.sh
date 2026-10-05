#!/bin/bash
# Скрипт сборки расширения

set -e

echo "=== Admin Updater Extension Build ==="

# Очистка
rm -rf dist
mkdir -p dist/popup dist/background dist/icons

# Копирование манифеста
cp manifest.json dist/

# Копирование HTML, CSS и иконок
cp popup/popup.html dist/popup/
cp popup/styles.css dist/popup/
cp icons/*.png dist/icons/

# Сборка TypeScript -> JavaScript
echo "Compiling TypeScript..."
npx tsc --noEmit

# Сборка через Vite (popup + service worker)
echo "Building with Vite..."
npx vite build

# Проверка результата
echo ""
echo "=== Build contents ==="
find dist -type f | sort

echo ""
echo "=== Build complete ==="
echo "Extension ready in dist/"
echo ""
echo "To install:"
echo "1. Open chrome://extensions"
echo "2. Enable Developer Mode"
echo "3. Click 'Load unpacked' and select the dist/ folder"
