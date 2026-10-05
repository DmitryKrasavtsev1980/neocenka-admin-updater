import { defineConfig } from 'vite';
import { resolve } from 'path';
import { copyFileSync, mkdirSync } from 'fs';

// Плагин для копирования статических файлов
function copyStaticFiles() {
  return {
    name: 'copy-static-files',
    writeBundle() {
      const { copyFileSync, mkdirSync, readdirSync } = require('fs');

      // Копируем manifest.json
      copyFileSync(resolve(__dirname, 'manifest.json'), resolve(__dirname, 'dist/manifest.json'));

      // Копируем popup файлы
      mkdirSync(resolve(__dirname, 'dist/popup'), { recursive: true });
      copyFileSync(resolve(__dirname, 'popup/popup.html'), resolve(__dirname, 'dist/popup/popup.html'));
      copyFileSync(resolve(__dirname, 'popup/styles.css'), resolve(__dirname, 'dist/popup/styles.css'));

      // Копируем иконки
      mkdirSync(resolve(__dirname, 'dist/icons'), { recursive: true });
      const iconsDir = resolve(__dirname, 'icons');
      if (readdirSync(iconsDir).length > 0) {
        readdirSync(iconsDir).forEach((file: string) => {
          copyFileSync(resolve(iconsDir, file), resolve(__dirname, 'dist/icons', file));
        });
      }
    },
  };
}

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        'popup/popup': resolve(__dirname, 'popup/popup.ts'),
        'background/service-worker': resolve(__dirname, 'background/service-worker.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name].[ext]',
      },
    },
    target: 'es2020',
    sourcemap: false,
    minify: false,
  },
  plugins: [copyStaticFiles()],
});
