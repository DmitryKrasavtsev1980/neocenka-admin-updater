/**
 * Менеджер Chrome вкладок для парсинга
 */

import { sleep } from './delays';

/**
 * Создать фоновую вкладку
 */
export async function createBackgroundTab(url: string): Promise<number> {
  const tab = await chrome.tabs.create({ url, active: false });
  return tab.id!;
}

/**
 * Закрыть вкладку
 */
export async function closeTab(tabId: number): Promise<void> {
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    // Вкладка уже закрыта
  }
}

/**
 * Дождаться загрузки вкладки
 */
export async function waitForTabLoad(
  tabId: number,
  timeoutMs: number = 20000
): Promise<boolean> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') {
        await sleep(1000); // Дополнительная задержка после загрузки
        return true;
      }
    } catch {
      return false;
    }
    await sleep(300);
  }

  return false;
}

/**
 * Инжектировать скрипт в вкладку (ISOLATED world)
 */
export async function injectScript<T>(
  tabId: number,
  func: () => T,
  args?: unknown[]
): Promise<T | null> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: func as never,
      args: args as never[],
    });

    return results?.[0]?.result as T ?? null;
  } catch {
    return null;
  }
}

/**
 * Инжектировать скрипт в MAIN world (для доступа к window)
 */
export async function injectScriptMainWorld<T>(
  tabId: number,
  func: () => T,
  args?: unknown[]
): Promise<T | null> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: func as never,
      args: args as never[],
      world: 'MAIN',
    });

    return results?.[0]?.result as T ?? null;
  } catch {
    return null;
  }
}

/**
 * Навигировать вкладку на новый URL
 */
export async function navigateTab(tabId: number, url: string): Promise<void> {
  await chrome.tabs.update(tabId, { url });
  await waitForTabLoad(tabId);
}
