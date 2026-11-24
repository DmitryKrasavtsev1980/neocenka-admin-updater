import { defineConfig } from 'vite';
import { resolve } from 'path';
import { copyFileSync, mkdirSync, readdirSync } from 'fs';

/**
 * Сборка расширения «Лёгкая проверка» (dist-light).
 *
 * Отдельный бандл от полного парсинга (dist/): два независимых расширения
 * со своими service worker'ами — масштабируемая модель: лёгкую проверку
 * можно гнать на нескольких модемах, не трогая воркеры полного парсинга.
 */
function copyStaticFiles() {
  return {
    name: 'copy-static-files',
    writeBundle() {
      copyFileSync(resolve(__dirname, 'manifest.light.json'), resolve(__dirname, 'dist-light/manifest.json'));
      mkdirSync(resolve(__dirname, 'dist-light/light'), { recursive: true });
      copyFileSync(resolve(__dirname, 'light/light-popup.html'), resolve(__dirname, 'dist-light/light/light-popup.html'));
      copyFileSync(resolve(__dirname, 'popup/styles.css'), resolve(__dirname, 'dist-light/light/styles.css'));
      mkdirSync(resolve(__dirname, 'dist-light/icons'), { recursive: true });
      const iconsDir = resolve(__dirname, 'icons');
      if (readdirSync(iconsDir).length > 0) {
        readdirSync(iconsDir).forEach((file: string) => {
          copyFileSync(resolve(iconsDir, file), resolve(__dirname, 'dist-light/icons', file));
        });
      }
    },
  };
}

export default defineConfig({
  build: {
    outDir: 'dist-light',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        'light/light-popup': resolve(__dirname, 'light/light-popup.ts'),
        'light/light-service-worker': resolve(__dirname, 'light/light-service-worker.ts'),
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
