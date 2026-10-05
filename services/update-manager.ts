/**
 * Оркестратор обновления объявлений
 *
 * Цикл поверх очереди update_queue:
 *   claim (аренда 10 мин) → парс карточки → complete | release → heartbeat
 *
 * Логика мержа повторяет пользовательское расширение:
 * - Дедупликация фото по ID из URL
 * - Удаление битых URL старого формата Avito
 * - Дедупликация истории цен по день+цена
 * - Сложная логика updated (active→now, иначе из парсера)
 * - Пересчёт photos_count
 */

import type {
  ClaimedAd,
  AdUpdateData,
  PriceHistoryItem,
  ParseResult,
  Settings,
  SourceDomain,
} from '../types';
import { apiClient } from './api-client';
import { sleep, retry } from '../utils/delays';
import { createBackgroundTab, closeTab, waitForTabLoad, navigateTab } from '../utils/tab-manager';
import { parseAvitoAd } from '../parsers/avito-parse';
import { parseCianAd } from '../parsers/cian-parse';
import { checkAvitoAdHtml } from '../parsers/avito-check';
import { checkCianAdHtml } from '../parsers/cian-check';

export const DEFAULT_API_URL = 'https://54.neocenka.ru/api';

const DEFAULT_SETTINGS: Settings = {
  apiUrl: DEFAULT_API_URL,
  source: 'avito',
  pollIntervalSec: 60,
  batchSize: 50,
  checkDelayMs: 2000,
  parseDelayMs: 3000,
  autoEnqueue: true,
};

const SOURCE_DOMAIN: Record<Settings['source'], SourceDomain> = {
  avito: 'avito.ru',
  cian: 'cian.ru',
};

/** Устойчивый id воркера — живёт между перезапусками расширения */
export async function getBrowserId(): Promise<string> {
  const stored = await chrome.storage.local.get('browserId');
  if (stored.browserId) return stored.browserId as string;
  const browserId = `updater-${Math.random().toString(36).slice(2, 10)}`;
  await chrome.storage.local.set({ browserId });
  return browserId;
}

/**
 * Извлечь ID фото из URL (дедупликация)
 */
function extractPhotoId(url: string): string {
  const match = url.match(/\/img\/(\d+)/) || url.match(/\/(\d{10,})/);
  return match ? match[1] : url.split('?')[0];
}

/**
 * Проверить, битый ли URL старого формата Avito CDN
 */
function isBrokenAvitoUrl(url: string): boolean {
  return typeof url === 'string' && /https?:\/\/\d+\.img\.avito\.st\/image\/1\//.test(url);
}

/**
 * Дедупликация истории цен по день+цена
 */
function mergePriceHistory(existing: PriceHistoryItem[], newEntries: PriceHistoryItem[]): PriceHistoryItem[] {
  const toDayPriceKey = (date: string, price: number) => {
    const d = new Date(date);
    const day = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    return `${day}|${price}`;
  };

  const existingKeys = new Set(
    existing.map(h => toDayPriceKey(h.date, h.price ?? h.new_price ?? 0))
  );

  const merged: PriceHistoryItem[] = [...existing];
  for (const entry of newEntries) {
    const price = entry.price ?? entry.new_price ?? 0;
    const key = toDayPriceKey(entry.date, price);
    if (!existingKeys.has(key)) {
      merged.push(entry);
      existingKeys.add(key);
    }
  }

  return merged.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}

/**
 * Определить updated по логике пользовательского расширения
 */
function resolveUpdated(
  parsed: ParseResult,
  mergedHistory: PriceHistoryItem[]
): string {
  if (parsed.status === 'active') {
    return new Date().toISOString();
  }
  if (parsed.updated) {
    return parsed.updated;
  }
  if (mergedHistory.length > 0) {
    return mergedHistory[mergedHistory.length - 1].date;
  }
  return new Date().toISOString();
}

export class UpdateManager {
  private settings: Settings;
  private browserId = '';
  private isRunning = false;
  private shouldStop = false;
  private tabId: number | null = null;
  private processed = 0;
  private matched = 0;
  private errors = 0;
  private onUpdate: ((stats: { processed: number; matched: number; errors: number }) => void) | null = null;

  constructor(settings: Partial<Settings> = {}) {
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
  }

  onProgress(callback: (stats: { processed: number; matched: number; errors: number }) => void) {
    this.onUpdate = callback;
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.shouldStop = false;
    this.processed = 0;
    this.matched = 0;
    this.errors = 0;

    try {
      apiClient.setBaseUrl(this.settings.apiUrl);
      this.browserId = await getBrowserId();

      const healthy = await apiClient.healthCheck();
      if (!healthy) {
        throw new Error('API server is not available');
      }

      const baseUrl = this.settings.source === 'avito' ? 'https://www.avito.ru/' : 'https://www.cian.ru/';
      this.tabId = await createBackgroundTab(baseUrl);
      await waitForTabLoad(this.tabId, 15000);

      console.log(`[Updater] Started as ${this.browserId}, source=${this.settings.source}, tab ${this.tabId}`);

      while (!this.shouldStop) {
        const claimed = await this.processBatch();
        if (!this.shouldStop && claimed > 0) {
          // очередь ещё не пуста — берём следующую порцию без паузы
          continue;
        }
        if (!this.shouldStop) {
          await this.ensureQueue();
          await sleep(this.settings.pollIntervalSec * 1000);
        }
      }
    } catch (err) {
      console.error('[Updater] Fatal error:', err);
    } finally {
      if (this.tabId) {
        await closeTab(this.tabId);
        this.tabId = null;
      }
      this.isRunning = false;
      console.log(`[Updater] Stopped. Processed: ${this.processed}, Matched: ${this.matched}, Errors: ${this.errors}`);
    }
  }

  stop() {
    this.shouldStop = true;
  }

  /**
   * Взять порцию в аренду, распарсить, закрыть строки очереди.
   * Возвращает число обработанных строк.
   */
  private async processBatch(): Promise<number> {
    const source = SOURCE_DOMAIN[this.settings.source];
    const ads = await apiClient.claim(this.browserId, source, this.settings.batchSize);

    if (ads.length === 0) {
      console.log('[Updater] Queue empty');
      return 0;
    }

    console.log(`[Updater] Claimed ${ads.length} ads`);

    // Строки, которые мы сейчас держим. Пока батч в работе, аренду надо
    // продлевать — иначе через 10 минут их отберёт соседний воркер.
    const inFlight = new Set(ads.map(a => a.queue_id));

    for (const ad of ads) {
      if (this.shouldStop) {
        // возвращаем незакрытые строки, чтобы их подхватил другой воркер
        await apiClient.release(ad.queue_id, this.browserId, 'worker stopped').catch(() => {});
        inFlight.delete(ad.queue_id);
        continue;
      }

      try {
        const update = await this.processAd(ad);
        await apiClient.complete(ad.queue_id, this.browserId, update ?? {});
        if (update) this.matched++;
        this.processed++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Updater] Ad ${ad.id} (queue ${ad.queue_id}) failed:`, msg);
        await apiClient.release(ad.queue_id, this.browserId, msg).catch(() => {});
        this.errors++;
        this.processed++;
      } finally {
        inFlight.delete(ad.queue_id);
      }

      this.reportProgress();
      await this.sendHeartbeat([...inFlight]);
      await sleep(this.settings.checkDelayMs);
    }

    await this.sendHeartbeat();
    return ads.length;
  }

  /**
   * Очередь закончилась — при autoEnqueue просим сервер сложить туда всё заново.
   */
  private async ensureQueue() {
    if (!this.settings.autoEnqueue || this.shouldStop) return;
    try {
      const result = await apiClient.createTask({
        name: `Авто-обновление ${this.settings.source}`,
        source: SOURCE_DOMAIN[this.settings.source],
        filter_data: { update_all: true },
      });
      console.log(`[Updater] Enqueued task #${result.task.id}, ads: ${result.ads_found}`);
    } catch (err) {
      console.warn('[Updater] Enqueue failed:', err);
    }
  }

  /**
   * Обработать одно объявление.
   *
   * Сначала идёт check-фаза (fetch без вкладки): она ловит снятые карточки
   * и неизменённые цены, чтобы не открывать страницу в браузере вообще.
   * Вкладка нужна только когда действительно что-то поменялось.
   */
  private async processAd(ad: ClaimedAd): Promise<AdUpdateData | null> {
    // ─── Check-фаза: дёшево, без вкладки ─────────────────────
    const checkFn = this.settings.source === 'avito' ? checkAvitoAdHtml : checkCianAdHtml;
    const check = await checkFn(ad.url);

    if (check.status === 'archived') {
      // карточку сняли — вкладка не нужна
      console.log(`[Ad ${ad.id}] archived (check), tab not opened`);
      return { status: 'archived', updated: new Date().toISOString() };
    }

    if (check.status === 'error') {
      throw new Error(check.error || 'check error');
    }

    // Цена из check достоверна и совпала с тем, что уже в базе —
    // полный парсинг ничего не даст. Возвращаем null, тогда закроем
    // строку одним лишь обновлением parsed_at.
    // Но если статус в базе отличается (например, снятое снова ожило) —
    // перечитываем карточку целиком.
    const priceKnown = check.price !== null && ad.price !== null;
    const priceUnchanged = priceKnown && Number(check.price) === Number(ad.price);
    const statusMatches = ad.status === 'active';
    if (priceUnchanged && statusMatches) {
      console.log(`[Ad ${ad.id}] price unchanged (${check.price}), tab not opened`);
      return null;
    }

    // ─── Полный парсинг: цена изменилась или её не удалось прочитать ───
    if (!this.tabId) return null;

    await navigateTab(this.tabId, ad.url);
    await sleep(this.settings.parseDelayMs);

    const parseFn = this.settings.source === 'avito' ? parseAvitoAd : parseCianAd;
    const parseResult = await retry(() => parseFn(this.tabId!), 3, 3000);

    if (parseResult.status === 'error') {
      throw new Error(parseResult.error || 'parse error');
    }

    // --- Дедупликация фото по ID (как в пользовательском расширении) ---
    const existingPhotos = ad.photos || [];
    const newPhotosFromParser = parseResult.photos || [];

    const hasNewValidPhotos = newPhotosFromParser.some(p => !isBrokenAvitoUrl(p));
    const existingPhotosFiltered = hasNewValidPhotos
      ? existingPhotos.filter(p => !isBrokenAvitoUrl(p))
      : existingPhotos;

    const existingPhotoIds = new Set(existingPhotosFiltered.map(p => extractPhotoId(p)));
    const newPhotos = newPhotosFromParser.filter(p => {
      const id = extractPhotoId(p);
      return !existingPhotoIds.has(id);
    });
    const mergedPhotos = [...existingPhotosFiltered, ...newPhotos];

    // --- Дедупликация истории цен по день+цена ---
    const existingHistory = ad.price_history || [];
    const mergedHistory = mergePriceHistory(existingHistory, parseResult.price_history);

    // --- updated и price_per_meter ---
    const updated = resolveUpdated(parseResult, mergedHistory);

    return {
      price: parseResult.price ?? undefined,
      price_per_meter: parseResult.price_per_meter ?? undefined,
      status: parseResult.status,
      photos: mergedPhotos.length > 0 ? mergedPhotos : undefined,
      price_history: mergedHistory.length > 0 ? mergedHistory : undefined,
      seller_name: parseResult.seller_name ?? undefined,
      seller_type: parseResult.seller_type ?? undefined,
      updated,
    };
  }

  private async sendHeartbeat(queueIds: number[] = []) {
    try {
      await apiClient.heartbeat(
        this.browserId,
        SOURCE_DOMAIN[this.settings.source],
        {
          processed: this.processed,
          matched: this.matched,
          errors: this.errors,
        },
        queueIds
      );
    } catch (err) {
      console.warn('[Updater] Heartbeat failed:', err);
    }
  }

  private reportProgress() {
    if (this.onUpdate) {
      this.onUpdate({
        processed: this.processed,
        matched: this.matched,
        errors: this.errors,
      });
    }
  }

  getStats() {
    return {
      isRunning: this.isRunning,
      processed: this.processed,
      matched: this.matched,
      errors: this.errors,
      browserId: this.browserId,
    };
  }
}
