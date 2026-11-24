/**
 * Service Worker для standalone-расширения обновления объявлений
 */

import { UpdateManager, DEFAULT_API_URL } from '../services/update-manager';
import type { Settings } from '../types';

let manager: UpdateManager | null = null;

/**
 * Запуск воркера. Вызывается и из popup (через onMessage), и из будильника.
 *
 * ВАЖНО: нельзя звать через chrome.runtime.sendMessage из самого SW —
 * onMessage в этом же контексте НЕ срабатывает, и после гибели MV3-воркера
 * автоперезапуск молча не срабатывал (расширение выглядело «отключённым»).
 */
async function startWorker(source?: Settings['source']): Promise<{ started: true } | { error: string }> {
  if (manager?.getStats().isRunning) {
    return { error: 'Already running' };
  }

  const settings = await loadSettings();
  if (source) settings.source = source;

  // Запомнить, что воркер должен жить: по этому флагу будильник
  // поднимает его после гибели service worker'а.
  await chrome.storage.local.set({ autoStart: true });

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

// Загрузка настроек
async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get('settings');
  return {
    // дефолты — потом докладываем сохранённые, чтобы новые поля не терялись
    apiUrl: DEFAULT_API_URL,
    source: 'avito',
    pollIntervalSec: 120,
    batchSize: 10,
    // Задержки и дневной кап ниже — только для отображения: UpdateManager
    // всё равно перетирает их из SOURCE_TEMPO, чтобы темп нельзя было
    // разогнать сохранёнными настройками (см. neocenka-extension#8).
    checkDelayMs: 55000,
    parseDelayMs: 50000,
    dailyCap: 1200,
    autoEnqueue: true,
    modemHost: 'http://192.168.8.1',
    modemEnabled: true,
    modemMethod: 'dataswitch',
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
        return await startWorker(message.source);
      }

      case 'STOP': {
        manager?.stop();
        await chrome.storage.local.set({ autoStart: false });
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
    // Залипший воркер: isRunning=true, но тишина в цикле > 5 мин.
    // Раньше будильник видел isRunning и не перезапускал — воркер вис мёртвым
    // грузом до ручного STOP/START (или loadUnpacked).
    if (manager?.getStats().isRunning) {
      const idleMs = Date.now() - (manager.getStats().lastActivityAt || 0);
      if (idleMs < 5 * 60_000) return;
      console.warn(`[Updater] Worker stuck (idle ${Math.round(idleMs / 1000)}s) — force restart`);
      manager.stop();
      // Ждём unwind (tempoSleep теперь чанками по 20 с — STOP отзывчивый)
      await new Promise((r) => setTimeout(r, 25_000));
      if (manager?.getStats().isRunning) {
        console.warn('[Updater] Worker still running after stop — dropping reference');
        manager = null;
      }
    }
    if (manager?.getStats().isRunning) return;

    // Автозапуск если включено. Зовём startWorker напрямую —
    // sendMessage из SW не попадает в собственный onMessage.
    const stored = await chrome.storage.local.get('autoStart');
    if (stored.autoStart) {
      const settings = await loadSettings();
      const result = await startWorker(settings.source);
      if ('started' in result) {
        console.log('[Updater] Worker restarted by alarm');
      }
    }
  }
});

// MV3 убивает service worker при простое (~30 с), а вместе с ним умирает
// и in-memory UpdateManager — воркер молча останавливался. Будим SW по
// будильнику и по нему же перезапускаем воркер, если autoStart включён.
// Минимальный период alarms — 1 минута.
chrome.alarms.create('periodic-check', { periodInMinutes: 1 });

console.log('[Updater] Service worker loaded');
