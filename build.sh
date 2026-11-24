#!/bin/bash
# Скрипт сборки расширений: dist/ (полный парсинг) + dist-light/ (лёгкая проверка)

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
echo "Building with Vite (full parse -> dist/)..."
npx vite build

echo ""
echo "=== Light Check Extension Build ==="
echo "Building with Vite (light check -> dist-light/)..."
npx vite build --config vite.config.light.ts

# Проверка результата
echo ""
echo "=== Build contents ==="
find dist dist-light -type f | sort

echo ""
echo "=== Build complete ==="
echo "Full parse extension ready in dist/"
echo "Light check extension ready in dist-light/"
echo ""
echo "To install:"
echo "1. Open chrome://extensions"
echo "2. Enable Developer Mode"
echo "3. Click 'Load unpacked' and select dist/ (full parse) or dist-light/ (light check)"
