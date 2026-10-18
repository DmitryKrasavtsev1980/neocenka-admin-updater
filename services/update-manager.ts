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
import { createBackgroundTab, closeTab, waitForTabLoad, navigateTab, injectScript, injectScriptMainWorld } from '../utils/tab-manager';
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
 *
 * Семантика полей (2026-10-18):
 * - checkDelayMs  — ГРАФИК ЗАПРОСОВ: пауза перед следующим navigate/fetch
 *   к площадке. Единственное, что реально снимает рейт-лимит.
 * - parseDelayMs  — НЕ пауза между запросами, а ожидание hydration уже
 *   загруженной вкладки после navigate+probe. Запрос к площадке уже ушёл,
 *   поэтому тут можно ждать мало — иначе живая карточка платила
 *   parseDelay+checkDelay (70 с / 105 с) впустую.
 * - dailyCap      — потолок карточек в сутки с одного IP. Avito душит
 *   флуд-контроль именно за объём, а не за скорость: кап 2000 при 35 с
 *   давал шторм ~2400/день и постоянный ip_block.
 */
export const SOURCE_TEMPO = {
  avito: { checkDelayMs: 50_000, parseDelayMs: 8_000, dailyCap: 1000 },
  cian: { checkDelayMs: 65_000, parseDelayMs: 10_000, dailyCap: 1000 },
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
  /**
   * Множитель темпа. 1.0 — штатный SOURCE_TEMPO; после бана растёт ×1.5
   * (макс. 3.0) и держится, пока площадка не отдохнула 30 минут без WAF.
   */
  private tempoMultiplier = 1.0;
  private lastWafAt = 0;
  /** Последняя ошибка для heartbeat; null = воркер здоров (сервер сбрасывает last_error) */
  private lastError: string | null = null;
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
      await this.loadTempo();

      const healthy = await apiClient.healthCheck();
      if (!healthy) {
        throw new Error('API server is not available');
      }

      // Сначала heartbeat — сервер назначает источник (разводит браузеры
      // по площадкам). Иначе оба успеют урвать Авито до первого ответа.
      await this.sendHeartbeat();

      // Вкладки от прошлого запуска SW (утечка после chrome.runtime.reload):
      // без уборки их копится по 3 и каждая жрёт память/запросы.
      await this.cleanupStaleTabs();

      const baseUrl = this.settings.source === 'avito' ? 'https://www.avito.ru/' : 'https://www.cian.ru/';
      this.tabId = await createBackgroundTab(baseUrl);
      await waitForTabLoad(this.tabId, 15000);

      console.log(`[Updater] Started as ${this.browserId}, source=${this.settings.source}, tab ${this.tabId}`);

      while (!this.shouldStop) {
        await this.waitCooldown();
        if (this.shouldStop) break;

        const claimed = await this.processBatch();
        if (!this.shouldStop && claimed > 0 && Date.now() >= this.cooldownUntil) {
          // очередь ещё не пуста — берём следующую порцию.
          // Пауза между батчами = график запросов, то есть checkDelay.
          await this.tempoSleep(this.settings.checkDelayMs);
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

  /**
   * Закрыть вкладки площадки, оставшиеся от прошлого запуска.
   *
   * После chrome.runtime.reload() / падения SW вкладки avito/cian не
   * закрываются сами и копятся (видели по 3 штуки вместо 1). Popup и
   * chrome:// не трогаем — только домен текущей площадки.
   */
  private async cleanupStaleTabs() {
    try {
      const domain = SOURCE_DOMAIN[this.settings.source];
      const tabs = await chrome.tabs.query({});
      let closed = 0;
      for (const tab of tabs) {
        if (!tab.id || tab.id === this.tabId) continue;
        const url = tab.url || '';
        if (!url.includes(domain)) continue;
        await closeTab(tab.id).catch(() => {});
        closed++;
      }
      if (closed > 0) {
        console.log(`[Updater] Closed ${closed} stale ${domain} tab(s)`);
      }
    } catch (err) {
      console.warn('[Updater] cleanupStaleTabs failed:', err);
    }
  }

  /** ±25% джиттер, чтобы паузы не выглядели машинно-равномерными */
  private jitter(ms: number): number {
    return Math.round(ms * (0.75 + Math.random() * 0.5));
  }

  /**
   * Пауза между запросами к площадке: базовый SOURCE_TEMPO × tempoMultiplier.
   * Множитель переживает перезапуск (chrome.storage) и откатывается к 1.0,
   * когда площадка 30 минут не подавала WAF/капчу.
   */
  private async tempoSleep(baseMs: number, useJitter = true) {
    // Откат, если после последнего бана прошло достаточно
    if (this.tempoMultiplier > 1 && this.lastWafAt && Date.now() - this.lastWafAt > 30 * 60_000) {
      this.tempoMultiplier = 1;
      await this.persistTempo();
      console.log('[Updater] Tempo reset to 1.0 after 30 min without WAF');
    }
    const ms = baseMs * this.tempoMultiplier;
    await keepAliveSleep(useJitter ? this.jitter(ms) : ms);
  }

  private async persistTempo() {
    try {
      await chrome.storage.local.set({
        tempoState: { multiplier: this.tempoMultiplier, lastWafAt: this.lastWafAt },
      });
    } catch {
      /* storage недоступен — не критично */
    }
  }

  private async loadTempo() {
    try {
      const stored = await chrome.storage.local.get('tempoState');
      const s = stored.tempoState as { multiplier?: number; lastWafAt?: number } | undefined;
      if (s && typeof s.multiplier === 'number') {
        this.tempoMultiplier = Math.min(3, Math.max(1, s.multiplier));
        this.lastWafAt = s.lastWafAt ?? 0;
        if (this.tempoMultiplier > 1) {
          console.log(`[Updater] Restored tempo multiplier ×${this.tempoMultiplier.toFixed(2)}`);
        }
      }
    } catch {
      /* ignore */
    }
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
      // Разово сообщаем серверу (там cooldown 20 ч на источник — не спамит)
      apiClient
        .reportDailyCap(
          this.browserId,
          SOURCE_DOMAIN[this.settings.source],
          used.count,
          this.settings.dailyCap
        )
        .catch((e) => console.warn('[Updater] reportDailyCap failed:', e));
      return 0;
    }

    const source = SOURCE_DOMAIN[this.settings.source];
    const ads = await apiClient.claim(this.browserId, source, this.settings.batchSize);

    if (ads.length === 0) {
      console.log('[Updater] Queue empty');
      // Пульс нужен и на пустой очереди: без него воркер не подтянет
      // remote-конфиг (autoEnqueue / source) и будет жить со старыми
      // настройками до следующего обработанного объявления.
      await this.sendHeartbeat();
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
        // Карточка закрыта без ошибки — гасим залипший last_error
        this.lastError = null;
        // Успех прерывает серию обрывов: следующий ip_block/captcha начнётся с strike 1
        this.consecutiveWaf = 0;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Updater] Ad ${ad.id} (queue ${ad.queue_id}) failed:`, msg);
        await apiClient.release(ad.queue_id, this.browserId, msg).catch(() => {});
        this.errors++;
        this.processed++;
        this.lastError = msg.slice(0, 200);
        await bumpDailyUsed();

        // WAF/капча площадки — не долбим дальше: меняем IP и/или уходим в откат.
        if (msg === 'waf_block' || msg === 'captcha') {
          this.consecutiveWaf++;
          // Замедляем темп: следующие запросы к площадке будут реже.
          this.tempoMultiplier = Math.min(3, this.tempoMultiplier * 1.5);
          this.lastWafAt = Date.now();
          await this.persistTempo();

          // Серверу — чтобы отключить источник и переключить соседние воркеры
          const banReason = `${msg} (strike ${this.consecutiveWaf}, tempo ×${this.tempoMultiplier.toFixed(2)})`;
          this.lastError = banReason;
          apiClient
            .reportBan(
              this.browserId,
              SOURCE_DOMAIN[this.settings.source],
              banReason
            )
            .catch((e) => console.warn('[Updater] reportBan failed:', e));

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
            `[Updater] ${msg} — strike ${this.consecutiveWaf}, tempo ×${this.tempoMultiplier.toFixed(2)}, ` +
            (outcome === 'rotated'
              ? 'IP rotated, resuming shortly'
              : outcome === 'busy'
                ? 'IP rotation busy (neighbor holds lock), resuming shortly'
                : `pausing ${backoffMin} min`)
          );
          if (outcome !== 'failed') this.consecutiveWaf = 0;
          break;
        }

        // Мягкий рейт-лимит Avito («Доступ ограничен: проблема с IP»).
        // Это не бан: площадка просит переждать. Не reportBan и не отключаем
        // источник — иначе Avito ляжет на 3 часа из-за обычного флуд-контроля.
        if (msg === 'ip_block') {
          this.consecutiveWaf++;
          this.tempoMultiplier = Math.min(3, this.tempoMultiplier * 1.5);
          this.lastWafAt = Date.now();
          await this.persistTempo();
          this.lastError = `ip_block (strike ${this.consecutiveWaf}, tempo ×${this.tempoMultiplier.toFixed(2)})`;

          for (const rest of inFlight) {
            await apiClient.release(rest, this.browserId, 'paused: ip_block').catch(() => {});
          }
          inFlight.clear();

          // Флуд-контроль Avito снимается за 10–20 минут тишины.
          // Раньше 2–10 мин — воркер возвращался слишком рано и нарывался снова.
          const backoffMin = Math.min(20, 10 + 5 * this.consecutiveWaf);
          this.cooldownUntil = Date.now() + backoffMin * 60_000;
          console.warn(
            `[Updater] ip_block — strike ${this.consecutiveWaf}, tempo ×${this.tempoMultiplier.toFixed(2)}, pausing ${backoffMin} min`
          );
          break;
        }
      } finally {
        inFlight.delete(ad.queue_id);
      }

      this.reportProgress();
      await this.sendHeartbeat([...inFlight]);
      await this.tempoSleep(this.settings.checkDelayMs);
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
   * Очередь закончилась — при autoEnqueue просим сервер досыпать устаревшее.
   *
   * Сервер берёт только объявления внутри областей «В работе» (in_progress):
   * если таких областей нет, ads_found = 0 и задача не создаётся. Раньше
   * update_all сваливал ВСЕ объявления — на 123k карточках это была просто
   * свалка в очередь, не привязанная к конвейеру областей.
   */
  private async ensureQueue() {
    if (!this.settings.autoEnqueue || this.shouldStop) return;
    try {
      const result = await apiClient.createTask({
        name: `Авто-обновление ${this.settings.source}`,
        source: SOURCE_DOMAIN[this.settings.source],
        filter_data: { update_all: true, mode: 'stale', stale_days: 3 },
      });
      if (!result?.task || !result.ads_found) {
        console.log('[Updater] Досыпать нечего (нет областей «В работе» или очередь актуальна)');
        return;
      }
      console.log(`[Updater] Enqueued task #${result.task.id}, ads: ${result.ads_found}`);
    } catch (err) {
      console.warn('[Updater] Enqueue failed:', err);
    }
  }

  /**
   * Вкладка парсинга: создать заново, если её закрыли (reload расширения,
   * ручная чистка, краш). Без этого navigateTab падает в «No tab with id»
   * и все карточки под полный парс уходят в ошибку до перезапуска воркера.
   */
  private async ensureTab(): Promise<number | null> {
    const baseUrl = this.settings.source === 'avito' ? 'https://www.avito.ru/' : 'https://www.cian.ru/';
    if (this.tabId !== null) {
      try {
        await chrome.tabs.get(this.tabId);
        return this.tabId;
      } catch {
        this.tabId = null;
      }
    }
    try {
      this.tabId = await createBackgroundTab(baseUrl);
      await waitForTabLoad(this.tabId, 15000);
      console.log(`[Updater] Tab recreated: ${this.tabId}`);
      return this.tabId;
    } catch (err) {
      console.warn('[Updater] ensureTab failed:', err);
      return null;
    }
  }

  /**
   * Быстрая проба уже загруженной вкладки — ловит мёртвые карточки и
   * рейт-лимит БЕЗ второго запроса к площадке и без ожидания parseDelay.
   * Раньше это делала отдельная check-фаза (fetch), которая на avito вообще
   * не видит цену, а на cian в 74% случаев не мешала полному парсингу —
   * и при этом била по площадке лишним запросом.
   */
  private async probePage(tabId: number, expectedUrl: string): Promise<'ok' | 'archived' | 'ip_block' | 'captcha' | 'waf_block'> {
    // Avito на интерстишле может не отдать из MAIN world — пробуем оба.
    let probe = await injectScriptMainWorld(tabId, () => ({
      title: document.title || '',
      text: document.body?.innerText?.substring(0, 800) || '',
      url: location.href || '',
    })).catch(() => null);
    if (!probe || (!probe.title && !probe.text)) {
      probe = await injectScript(tabId, () => ({
        title: document.title || '',
        text: document.body?.innerText?.substring(0, 800) || '',
        url: location.href || '',
      })).catch(() => null);
    }
    const bodyText = probe?.text || '';
    const title = probe?.title || '';
    const finalUrl = probe?.url || '';

    if (this.settings.source === 'avito') {
      if (bodyText.includes('Доступ ограничен') || bodyText.includes('проблема с IP') || title.includes('Доступ ограничен')) {
        return 'ip_block';
      }
    } else {
      if (bodyText.includes('подозрительный трафик') || bodyText.includes('cian_waf_block') || title === 'Ошибка - Циан') {
        return 'waf_block';
      }
    }
    if (bodyText.includes('капч') || bodyText.includes('captcha') || title.includes('captcha')) {
      return 'captcha';
    }
    if (
      bodyText.includes('не найдено') ||
      bodyText.includes('страница не найдена') ||
      bodyText.includes('объявление удалено') ||
      bodyText.includes('объявление закрыто') ||
      bodyText.includes('снято с публикации') ||
      bodyText.includes('объявление истекло') ||
      bodyText.includes('объявление не посмотреть') ||
      bodyText.includes('объявление не найдено') ||
      title.includes('404') ||
      title.includes('не найдено')
    ) {
      return 'archived';
    }

    // Avito на архивной карточке не показывает «не найдено», а редиректит
    // на каталог/главную (…/kvartiry?f=… или www.avito.ru/). Тогда hydration
    // не находится, parse падает в no_data и жжёт попытки. Ловим по URL.
    if (finalUrl && expectedUrl) {
      const expectedId = expectedUrl.match(/(\d{6,})\/?$/)?.[1] || null;
      const finalId = finalUrl.match(/(\d{6,})\/?$/)?.[1] || null;
      if (expectedId && finalId !== expectedId) {
        return 'archived';
      }
      // каталог с фильтрами / голая главная вместо карточки
      if (
        finalUrl.includes('?f=') ||
        /^https?:\/\/(?:www\.)?avito\.ru\/?$/.test(finalUrl) ||
        (this.settings.source === 'avito' && !finalId && expectedId)
      ) {
        return 'archived';
      }
    }

    return 'ok';
  }

  /**
   * Обработать одно объявление.
   *
   * active  — полный парсинг через вкладку (как просили: «всегда полностью»).
   * archived — лёгкий fetch без вкладки: карточка уже мертва, грузить
   *   страницу в браузере бессмысленно и это жжёт флуд-контроль площадки.
   *   Если fetch увидел, что объявление ожило — уходим в полный парс.
   */
  private async processAd(ad: ClaimedAd): Promise<AdUpdateData | null> {
    // Уже знаем, что объявление в архиве — дешёвая проверка без браузера.
    if (ad.status === 'archived') {
      const checkFn = this.settings.source === 'avito' ? checkAvitoAdHtml : checkCianAdHtml;
      const recheck = await checkFn(ad.url).catch(() => null);

      if (recheck?.status === 'error' && recheck.error) {
        // ip_block/captcha/waf — воркер замедлится, попытку не жжём
        throw new Error(recheck.error);
      }
      if (recheck?.status === 'archived') {
        console.log(`[Ad ${ad.id}] archived (check fetch), no tab`);
        return { status: 'archived', updated: new Date().toISOString() };
      }
      // active или молчит — похоже ожило. Уходим в полный парс.
      console.log(`[Ad ${ad.id}] archived → reactivated?, full parse`);
    }

    const tabId = await this.ensureTab();
    if (tabId === null) return null;

    await navigateTab(tabId, ad.url);

    // Быстрая проба до parseDelay: мёртвую карточку закрываем сразу,
    // а ip_block/captcha/waf_block кидаем наверх, чтобы воркер замедлился.
    const probe = await this.probePage(tabId, ad.url);
    if (probe === 'archived') {
      console.log(`[Ad ${ad.id}] archived (probe), no parseDelay`);
      return { status: 'archived', updated: new Date().toISOString() };
    }
    if (probe !== 'ok') {
      throw new Error(probe);
    }

    // Короткий settle hydration: страница уже загружена (probe её читал),
    // запрос к площадке уже ушёл. Ждать тут полный checkDelay — двойная
    // задержка на живой карточке (70 с / 105 с) без выгоды для банов.
    await this.tempoSleep(this.settings.parseDelayMs, false);

    const parseFn = this.settings.source === 'avito' ? parseAvitoAd : parseCianAd;
    const parseResult = await retry(() => parseFn(tabId), 3, 3000);

    if (parseResult.status === 'error') {
      // no_data — часто мёртвая карточка, которую HTML-check видит лучше,
      // чем hydration-парсер. Переспрашиваем дёшево и закрываем как archived,
      // чтобы не жечь строку в failed и дневной кап. Check здесь — только
      // запасной путь для no_data, не фаза на каждой карточке.
      if (parseResult.error === 'no_data') {
        // Сначала смотрим, не улетела ли вкладка с карточки (редирект Avito
        // на каталог) — это archived, а не «страница битая».
        const probeAgain = await this.probePage(tabId, ad.url).catch(() => 'ok');
        if (probeAgain === 'archived') {
          console.log(`[Ad ${ad.id}] no_data → archived via probe redirect`);
          return { status: 'archived', updated: new Date().toISOString() };
        }
        if (probeAgain !== 'ok') {
          throw new Error(probeAgain);
        }
        const checkFn = this.settings.source === 'avito' ? checkAvitoAdHtml : checkCianAdHtml;
        const recheck = await checkFn(ad.url).catch(() => null);
        if (recheck?.status === 'archived') {
          console.log(`[Ad ${ad.id}] no_data → archived via check fallback`);
          return { status: 'archived', updated: new Date().toISOString() };
        }
        // Повторная проверка увидела капчу/IP-блок — это не no_data,
        // отдаём настоящий код, чтобы воркер замедлился, а не жёг попытки.
        if (recheck?.status === 'error' && recheck.error) {
          throw new Error(recheck.error);
        }
      }
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
          // Явно шлём строку (пустую — чтобы сервер СБРОСИЛ залипший last_error).
          // beat() на сервере пишет только не-null значения, поэтому без этой
          // строки сообщение о дневной капче висело бы вечно.
          last_error: this.lastError ?? '',
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
      // Смена площадки — чистый лист: откат ЦИАНа не должен тормозить Авито
      if (this.tempoMultiplier > 1) {
        this.tempoMultiplier = 1;
        this.lastWafAt = 0;
        this.persistTempo();
      }
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
