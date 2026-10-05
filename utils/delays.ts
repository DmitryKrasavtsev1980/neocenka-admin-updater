/**
 * Утилиты для задержек и retry
 */

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Сон, который не даёт MV3 убить service worker.
 *
 * Chrome гасит SW после ~30 с бездействия extension API — вместе с ним
 * умирает и in-memory UpdateManager, и воркер молча останавливается.
 * Каждые 20 с дёргаем chrome.runtime.getPlatformInfo: это сбрасывает
 * idle-таймер, но не добавляет нагрузки на площадки.
 */
export async function keepAliveSleep(ms: number): Promise<void> {
  const CHUNK = 20000;
  const end = Date.now() + ms;

  while (Date.now() < end) {
    const left = end - Date.now();
    await sleep(Math.min(CHUNK, left));

    if (left > CHUNK && typeof chrome !== 'undefined' && chrome.runtime) {
      try {
        chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError);
      } catch {
        /* расширение выгружается — выходим и без пинга */
      }
    }
  }
}

export async function retry<T>(
  fn: () => Promise<T>,
  maxAttempts: number = 3,
  delayMs: number = 3000
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxAttempts) {
        await sleep(delayMs);
      }
    }
  }

  throw lastError;
}
