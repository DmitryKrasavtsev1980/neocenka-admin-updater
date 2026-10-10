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
import { sleep, keepAliveSleep, retry } from '../utils/delays';
import { createBackgroundTab, closeTab, waitForTabLoad, navigateTab } from '../utils/tab-manager';
import { parseAvitoAd } from '../parsers/avito-parse';
import { parseCianAd } from '../parsers/cian-parse';
import { checkAvitoAdHtml } from '../parsers/avito-check';
import { checkCianAdHtml } from '../parsers/cian-check';
import { ModemClient, DEFAULT_MODEM_SETTINGS, type ModemSettings } from './modem-client';

export const DEFAULT_API_URL = 'https://54.neocenka.ru/api';

const DEFAULT_SETTINGS: Settings = {
  apiUrl: DEFAULT_API_URL,
  source: 'avito',
  pollIntervalSec: 120,
  batchSize: 10,
  checkDelayMs: 55000,
  parseDelayMs: 50000,
  dailyCap: 1200,
  autoEnqueue: true,
  modemHost: DEFAULT_MODEM_SETTINGS.host,
  modemEnabled: true,
  modemMethod: 'dataswitch',
};

/**
 * Согласованный темп по площадкам (neocenka-extension#8, 2026-10-04).
 *
 * Ограничение — на IP, не на число воркеров, поэтому темп задан жёстко и
 * НЕ читается из настроек: раньше в дефолтах стояло 12 с / 18 с, и ЦИАН
 * банил IP за полчаса. Дельта ±25% от `jitter()` — попадаем в
 * ЦИАН 41–69 с (цель 45–60 с), Авито 26–44 с (цель 30–40 с).
 */
export const SOURCE_TEMPO = {
  avito: { checkDelayMs: 35_000, parseDelayMs: 35_000, dailyCap: 2000 },
  cian: { checkDelayMs: 55_000, parseDelayMs: 50_000, dailyCap: 1200 },
} as const satisfies Record<string, { checkDelayMs: number; parseDelayMs: number; dailyCap: number }>;

/** Дневной счётчик обработанных карточек — для `dailyCap` */
const DAILY_KEY = 'dailyUsage';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Сколько карточек сегодня уже обработано */
export async function getDailyUsed(): Promise<{ date: string; count: number }> {
  const stored = await chrome.storage.local.get(DAILY_KEY);
  const usage = stored[DAILY_KEY] as { date: string; count: number } | undefined;
  if (!usage || usage.date !== today()) return { date: today(), count: 0 };
  return usage;
}

async function bumpDailyUsed(): Promise<number> {
  const usage = await getDailyUsed();
  const count = usage.count + 1;
  await chrome.storage.local.set({ [DAILY_KEY]: { date: today(), count } });
  return count;
}

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
  /** До какого момента паузимся из-за WAF/капчи (epoch ms) */
  private cooldownUntil = 0;
  private consecutiveWaf = 0;
  private modemSettings: ModemSettings = DEFAULT_MODEM_SETTINGS;

  constructor(settings: Partial<Settings> = {}) {
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    // Темп — всегда из SOURCE_TEMPO, настройками не переопределяется:
    // скорость — вопрос бана IP, а не удобства.
    const tempo = SOURCE_TEMPO[this.settings.source] ?? SOURCE_TEMPO.avito;
    this.settings.checkDelayMs = tempo.checkDelayMs;
    this.settings.parseDelayMs = tempo.parseDelayMs;
    this.settings.dailyCap = tempo.dailyCap;
    this.modemSettings = {
      host: this.settings.modemHost,
      enabled: this.settings.modemEnabled,
      method: this.settings.modemMethod,
    };
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
        await this.waitCooldown();
        if (this.shouldStop) break;

        const claimed = await this.processBatch();
        if (!this.shouldStop && claimed > 0 && Date.now() >= this.cooldownUntil) {
          // очередь ещё не пуста — берём следующую порцию
          await keepAliveSleep(this.jitter(this.settings.parseDelayMs));
          continue;
        }
        if (!this.shouldStop && Date.now() >= this.cooldownUntil) {
          await this.ensureQueue();
          await keepAliveSleep(this.jitter(this.settings.pollIntervalSec * 1000));
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

  /** ±25% джиттер, чтобы паузы не выглядели машинно-равномерными */
  private jitter(ms: number): number {
    return Math.round(ms * (0.75 + Math.random() * 0.5));
  }

  /** Ждать, пока истечёт WAF-кулдаун (прерываемо через shouldStop) */
  private async waitCooldown() {
    while (!this.shouldStop && Date.now() < this.cooldownUntil) {
      const left = this.cooldownUntil - Date.now();
      await keepAliveSleep(Math.min(left, 30_000));
    }
  }

  /**
   * Взять порцию в аренду, распарсить, закрыть строки очереди.
   * Возвращает число обработанных строк.
   */
  private async processBatch(): Promise<number> {
    // Дневной кап: площадка банит по IP за объём за сутки, а не за скорость.
    // Достигли — не берём даже claim, чтобы не держать строки в аренде,
    // и не дёргаем ensureQueue (он бы завёл новую задачу впустую).
    // Уходим в cooldownUntil до полуночи — его уже крутит waitCooldown().
    const used = await getDailyUsed();
    if (used.count >= this.settings.dailyCap) {
      const midnight = new Date();
      midnight.setHours(24, 0, 0, 0);
      this.cooldownUntil = Math.max(this.cooldownUntil, midnight.getTime());
      console.log(`[Updater] Daily cap reached (${used.count}/${this.settings.dailyCap}) — idle until ${midnight.toISOString()}`);
      return 0;
    }

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
        await bumpDailyUsed();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Updater] Ad ${ad.id} (queue ${ad.queue_id}) failed:`, msg);
        await apiClient.release(ad.queue_id, this.browserId, msg).catch(() => {});
        this.errors++;
        this.processed++;
        await bumpDailyUsed();

        // WAF/капча площадки — не долбим дальше: меняем IP и/или уходим в откат.
        if (msg === 'waf_block' || msg === 'captcha') {
          this.consecutiveWaf++;
          // остальные строки батча отпускаем, не трогая площадку
          for (const rest of inFlight) {
            await apiClient.release(rest, this.browserId, `paused: ${msg}`).catch(() => {});
          }
          inFlight.clear();

          // Смена IP — только под глобальным локом: модем один на всех, без
          // лока сосед второй раз рвёт соединение и сжигает попытки строк.
          let outcome: 'rotated' | 'busy' | 'failed' = 'failed';
          if (this.modemSettings.enabled) {
            outcome = await this.rotateIpWithLock();
          }

          // После смены IP (или пока его крутит сосед) — короткая пауза:
          // адрес свежий, можно работать. Без смены — растущий откат.
          const backoffMin = outcome === 'failed' ? Math.min(30, 5 * this.consecutiveWaf) : 1;
          this.cooldownUntil = Date.now() + backoffMin * 60_000;
          console.warn(
            `[Updater] ${msg} — strike ${this.consecutiveWaf}, ` +
            (outcome === 'rotated'
              ? 'IP rotated, resuming shortly'
              : outcome === 'busy'
                ? 'IP rotation busy (neighbor holds lock), resuming shortly'
                : `pausing ${backoffMin} min`)
          );
          if (outcome !== 'failed') this.consecutiveWaf = 0;
          break;
        }
      } finally {
        inFlight.delete(ad.queue_id);
      }

      this.reportProgress();
      await this.sendHeartbeat([...inFlight]);
      await keepAliveSleep(this.jitter(this.settings.checkDelayMs));
    }

    await this.sendHeartbeat();
    return ads.length;
  }

  /**
   * Смена IP под глобальным локом.
   *
   * Модем один, внешний адрес один на всех воркеров: пока один крутит IP,
   * у остальных обрываются запросы и сгорают попытки строк. Поэтому крутит
   * тот, кто первый взял лок, а остальные в это время простаивают.
   *
   * - 'rotated' — мы сменили IP, можно сразу работать дальше;
   * - 'busy'    — лок держит сосед, он уже крутит — просто отходим;
   * - 'failed'  — лок не взялся / модем не ответил, нужен откат.
   */
  private async rotateIpWithLock(): Promise<'rotated' | 'busy' | 'failed'> {
    let acquired = false;
    try {
      acquired = await apiClient.acquireIpLock(this.browserId);
    } catch (err) {
      console.warn('[Updater] IP lock acquire failed:', err);
      return 'failed';
    }

    if (!acquired) {
      return 'busy';
    }

    try {
      const r = await new ModemClient(this.modemSettings).rotateIp();
      if (!r.ok) {
        console.warn(`[Updater] IP rotate failed: ${r.error}`);
        return 'failed';
      }
      return 'rotated';
    } finally {
      // Отпускаем всегда: упавший воркер не должен держать лок до TTL (180 с).
      await apiClient.releaseIpLock(this.browserId).catch(() => {});
    }
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
    await keepAliveSleep(this.settings.parseDelayMs);

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
      const resp = await apiClient.heartbeat(
        this.browserId,
        SOURCE_DOMAIN[this.settings.source],
        {
          processed: this.processed,
          matched: this.matched,
          errors: this.errors,
        },
        queueIds
      );
      // Сервер отдаёт конфиг — мержим в settings (темп НЕ трогаем, он залочен)
      if (resp?.config) {
        this.applyRemoteConfig(resp.config);
      }
    } catch (err) {
      console.warn('[Updater] Heartbeat failed:', err);
    }
  }

  /**
   * Применить конфиг с сервера (storage/app/update_config.json).
   * Темп парсинга (checkDelayMs / parseDelayMs / dailyCap) НЕ переопределяется —
   * это защита от бана, всегда из SOURCE_TEMPO.
   */
  private applyRemoteConfig(config: Record<string, unknown>) {
    const allowed = ['source', 'batchSize', 'pollIntervalSec', 'autoEnqueue'] as const;
    let changed = false;
    for (const key of allowed) {
      if (config[key] !== undefined && (this.settings as any)[key] !== config[key]) {
        (this.settings as any)[key] = config[key];
        changed = true;
      }
    }
    if (changed) {
      // Перезаписываем задержки из SOURCE_TEMPO (страховка)
      const tempo = SOURCE_TEMPO[this.settings.source] ?? SOURCE_TEMPO.avito;
      this.settings.checkDelayMs = tempo.checkDelayMs;
      this.settings.parseDelayMs = tempo.parseDelayMs;
      this.settings.dailyCap = tempo.dailyCap;
      // Сохраняем в chrome.storage — чтобы пережил перезапуск
      chrome.storage.local.get('settings').then(({ settings: stored }) => {
        chrome.storage.local.set({
          settings: {
            ...(stored || {}),
            source: this.settings.source,
            batchSize: this.settings.batchSize,
            pollIntervalSec: this.settings.pollIntervalSec,
            autoEnqueue: this.settings.autoEnqueue,
          },
        });
      }).catch(() => {});
      console.log('[Updater] Config updated from server:', {
        source: this.settings.source,
        batchSize: this.settings.batchSize,
        pollIntervalSec: this.settings.pollIntervalSec,
        autoEnqueue: this.settings.autoEnqueue,
      });
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
