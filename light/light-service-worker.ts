/**
 * Service Worker расширения «Лёгкая проверка» (dist-light).
 *
 * Отдельное расширение от полного парсинга — своя независимая жизнь SW:
 * смерть воркера полного парсинга не убивает лёгкую проверку и наоборот.
 * Задачи берутся из общей очереди (kind=light, атомарный клейм) — можно
 * гнать любое число копий на разных модемах без дублей.
 *
 * Дежурный режим: lightCheckAuto → будильник поднимает воркер после гибели
 * MV3-воркера и перезапускает проверку, пока пользователь не нажал «Стоп».
 */

import { LightChecker, LightProgress } from '../services/light-checker';
import { apiClient } from '../services/api-client';

const lightChecker = new LightChecker();

/**
 * id этого профиля браузера = browser_id в очереди. Стабильный,
 * генерируется один раз — строки арендуются за конкретным воркером.
 */
async function getWorkerId(): Promise<string> {
  const stored = await chrome.storage.local.get('lightWorkerId');
  if (stored.lightWorkerId) return stored.lightWorkerId;
  const id = 'lc-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  await chrome.storage.local.set({ lightWorkerId: id });
  return id;
}

async function applySettings(): Promise<void> {
  const stored = await chrome.storage.local.get('settings');
  const apiUrl = stored.settings?.apiUrl;
  if (apiUrl) apiClient.setBaseUrl(String(apiUrl).replace(/\/$/, '') + '/api');
}

async function startChecker(): Promise<{ started: true } | { error: string }> {
  if (lightChecker.getProgress().running) {
    return { error: 'уже работает' };
  }
  await applySettings();
  const id = await getWorkerId();
  lightChecker.setInstanceId(id);

  // Дежурный режим: проверка включена — будильник поднимает её после
  // гибели MV3-воркера (кнопка «Стоп» гасит флаг).
  await chrome.storage.local.set({ lightCheckAuto: true });

  lightChecker.onProgress((stats: LightProgress) => {
    chrome.action.setBadgeText({ text: String(stats.checked) });
    chrome.action.setBadgeBackgroundColor({ color: '#F59E0B' });
  });

  lightChecker.start().then(() => {
    chrome.action.setBadgeText({ text: '' });
  });

  return { started: true };
}

// ── Сообщения от popup ─────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = async () => {
    switch (message.type) {
      case 'LIGHT_START':
        return await startChecker();

      case 'LIGHT_STOP':
        await chrome.storage.local.set({ lightCheckAuto: false });
        lightChecker.stop();
        return { stopped: true };

      case 'LIGHT_STATUS': {
        const id = await getWorkerId();
        return { ...lightChecker.getProgress(), workerId: id };
      }

      case 'GET_SETTINGS': {
        const stored = await chrome.storage.local.get('settings');
        return stored.settings || {};
      }

      case 'SAVE_SETTINGS': {
        const current = await chrome.storage.local.get('settings');
        await chrome.storage.local.set({
          settings: { ...(current.settings || {}), ...(message.settings || {}) },
        });
        await applySettings();
        return { saved: true };
      }

      default:
        return { error: 'Unknown message type' };
    }
  };
  handler().then(sendResponse);
  return true;
});

// ── Будильник: дежурный подъём после гибели MV3-воркера ─────────────
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'light-duty') return;
  const stored = await chrome.storage.local.get('lightCheckAuto');
  if (!stored.lightCheckAuto || lightChecker.getProgress().running) return;
  const result = await startChecker();
  if ('started' in result) {
    console.log('[LightCheck] duty-restart by alarm');
  }
});

chrome.alarms.create('light-duty', { periodInMinutes: 1 });

console.log('[LightCheck] service worker loaded');
