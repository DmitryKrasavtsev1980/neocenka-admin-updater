/**
 * Service Worker для standalone-расширения обновления объявлений
 */

import { UpdateManager, DEFAULT_API_URL } from '../services/update-manager';
import type { Settings } from '../types';

let manager: UpdateManager | null = null;

// Загрузка настроек
async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get('settings');
  return {
    // дефолты — потом докладываем сохранённые, чтобы новые поля не терялись
    apiUrl: DEFAULT_API_URL,
    source: 'avito',
    pollIntervalSec: 60,
    batchSize: 50,
    checkDelayMs: 2000,
    parseDelayMs: 3000,
    autoEnqueue: true,
    ...(stored.settings || {}),
  };
}

// Сохранение настроек — с мержем, чтобы popup не затирал apiUrl/autoEnqueue
async function saveSettings(settings: Partial<Settings>) {
  const current = await loadSettings();
  await chrome.storage.local.set({ settings: { ...current, ...settings } });
}

// Обработка сообщений от popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = async () => {
    switch (message.type) {
      case 'START': {
        if (manager?.getStats().isRunning) {
          return { error: 'Already running' };
        }

        const settings = await loadSettings();
        if (message.source) settings.source = message.source;

        manager = new UpdateManager(settings);
        manager.onProgress((stats) => {
          // Обновляем badge
          chrome.action.setBadgeText({ text: String(stats.processed) });
          chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });

          // Отправляем обновление в popup
          chrome.runtime.sendMessage({ type: 'PROGRESS', ...stats }).catch(() => {});
        });

        // Запускаем в фоне
        manager.start().then(() => {
          chrome.action.setBadgeText({ text: '' });
          chrome.runtime.sendMessage({ type: 'COMPLETED', ...manager!.getStats() }).catch(() => {});
        });

        return { started: true };
      }

      case 'STOP': {
        manager?.stop();
        return { stopped: true };
      }

      case 'STATUS': {
        const stats = manager?.getStats() || {
          isRunning: false,
          processed: 0,
          matched: 0,
          errors: 0,
        };
        return stats;
      }

      case 'GET_SETTINGS': {
        return await loadSettings();
      }

      case 'SAVE_SETTINGS': {
        await saveSettings(message.settings);
        return { saved: true };
      }

      default:
        return { error: 'Unknown message type' };
    }
  };

  handler().then(sendResponse);
  return true; // Асинхронный ответ
});

// Alarms для.periodic checks (если popup закрыт)
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'periodic-check') {
    const settings = await loadSettings();
    if (!manager?.getStats().isRunning) {
      // Автозапуск если включено
      const stored = await chrome.storage.local.get('autoStart');
      if (stored.autoStart) {
        chrome.runtime.sendMessage({ type: 'START', source: settings.source });
      }
    }
  }
});

console.log('[Updater] Service worker loaded');
