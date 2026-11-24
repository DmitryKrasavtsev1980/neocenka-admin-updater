/**
 * LightChecker — лёгкая проверка статусов объявлений (без аккаунта).
 *
 * Масштабируемая модель (обсуждена с владельцем 24.11.2026):
 *   очередь update_queue (kind=light) → атомарный claim → быстрая проверка
 *   карточки (~2 с) → complete-light батчем.
 *
 *   - снятые закрываются (общий AdCloseService, финальный снимок);
 *   - активные освежаются (цена/ремонт/фото/история пишутся сразу);
 *   - изменённые по цене → сервер сам отдаёт в очередь ПОЛНОГО парсинга
 *     (kind=full: страховка + продавец/полные фото);
 *   - блок площадки / не загрузилась → строка возвращается в очередь.
 *
 * Очередь кормят: актуализация областей (kind=light), досып поддержки
 * (update:enqueue-support) и авто-досып воркера. Воркер просто ждёт задачи —
 * можно гнать сколько угодно воркеров на разных модемах: клейм атомарный,
 * дублей не будет. Управление — из popup (LIGHT_START/STOP).
 */

import { apiClient } from './api-client';
import type { ClaimedAd, LightResult } from '../types';

const PORTION = 30;
const CARD_DELAY_MS = 5000;
/** Пульс во время проверки: продлевает аренду строк + держит SW живым */
const HEARTBEAT_MS = 60_000;
/** Пауза когда очередь пуста (дежурный режим «ждёт задачи») */
const IDLE_WAIT_MS = 5 * 60_000;

export interface SourceProgress {
  checked: number;
  total: number;
}

export interface LightProgress {
  running: boolean;
  stage: string;
  checked: number;
  total: number;
  sources: Record<string, SourceProgress>;
  blocked: number;
  closed: number;
  repriced: number;
  source: string;
  /** id профиля браузера — он же browser_id в очереди */
  instanceId?: string;
}

export class LightChecker {
  private running = false;
  private stopFlag = false;
  private tabId: number | null = null;
  private instanceId = '';
  private progress: LightProgress = {
    running: false, stage: 'остановлен', checked: 0, total: 0,
    sources: { avito: { checked: 0, total: 0 }, cian: { checked: 0, total: 0 } },
    blocked: 0, closed: 0, repriced: 0, source: 'avito',
  };
  private onUpdate: ((p: LightProgress) => void) | null = null;

  onProgress(cb: (p: LightProgress) => void) {
    this.onUpdate = cb;
  }

  getProgress(): LightProgress {
    return { ...this.progress };
  }

  /**
   * id этого профиля браузера — он же browser_id очереди: по нему
   * строки арендуются за воркером и видны в мониторинге.
   */
  setInstanceId(id: string) {
    this.instanceId = id;
    this.progress.instanceId = id;
  }

  stop() {
    this.stopFlag = true;
    this.progress.stage = 'остановка...';
    this.publish();
  }

  private publish() {
    this.progress.running = this.running;
    if (this.instanceId) this.progress.instanceId = this.instanceId;
    if (this.onUpdate) this.onUpdate(this.getProgress());
    chrome.runtime.sendMessage({ type: 'LIGHT_PROGRESS', ...this.getProgress() }).catch(() => {});
  }

  /**
   * Дежурный цикл: claim → проверка → complete-light. Пустая очередь —
   * тихое ожидание с пульсом (пульс продлевает аренду строк и держит
   * service worker живым — иначе MV3 убивает его после 30 с бездействия).
   */
  async start(): Promise<{ ok: boolean; error?: string }> {
    if (this.running) return { ok: false, error: 'уже работает' };
    this.running = true;
    this.stopFlag = false;
    this.progress = {
      ...this.progress,
      running: true,
      stage: 'старт',
      checked: 0, total: 0,
      sources: { avito: { checked: 0, total: 0 }, cian: { checked: 0, total: 0 } },
      blocked: 0, closed: 0, repriced: 0,
    };
    this.publish();

    try {
      while (!this.stopFlag) {
        this.progress.stage = 'жду задачи в очереди...';
        this.publish();

        let batch: ClaimedAd[] = [];
        try {
          // source=null — воркер берёт обе площадки: extractCard сам
          // определяет сайт по URL.
          batch = await apiClient.claim(this.instanceId, null, PORTION, 'light');
        } catch (e: any) {
          this.progress.stage = 'ошибка связи: ' + (e?.message || e);
          this.publish();
          await this.sleep(IDLE_WAIT_MS);
          continue;
        }

        if (!batch.length) {
          this.progress.stage = 'ожидание задач в очереди…';
          this.publish();
          await this.sleep(IDLE_WAIT_MS);
          continue;
        }

        this.progress.total += batch.length;
        for (const b of batch) {
          const src = b.source === 'cian.ru' ? 'cian' : 'avito';
          this.progress.sources[src].total = (this.progress.sources[src].total ?? 0) + 1;
        }
        this.progress.stage = `проверяю порцию ${batch.length}...`;
        this.publish();

        const results = await this.checkPortion(batch);
        await this.report(results);

        // Волна блоков: пауза только при плотной серии.
        const streak = results.filter((r) => r.status === 'blocked').length;
        if (streak >= 3 && !this.stopFlag) {
          this.progress.stage = 'плотный блок — пауза 2 мин';
          this.publish();
          await this.sleep(120_000);
        }
      }
    } catch (e: any) {
      this.progress.stage = 'ошибка: ' + (e?.message || e);
    }

    this.running = false;
    this.progress.stage = 'остановлено';
    this.publish();
    await this.closeTab();
    return { ok: true };
  }

  /**
   * Портция: каждую карточку открыть в рабочей вкладке и вытащить данные.
   * Пульс каждые ~60 с продлевает аренду необработанных строк — порция в 30
   * карточек при 5 с/карточку живёт ~2.5 мин, аренда 10 мин не протухает.
   */
  private async checkPortion(batch: ClaimedAd[]): Promise<LightResult[]> {
    const results: LightResult[] = [];
    const tabId = await this.openTab(batch[0].url);
    let lastBeat = Date.now();
    for (const item of batch) {
      if (this.stopFlag) break;

      if (Date.now() - lastBeat > HEARTBEAT_MS) {
        lastBeat = Date.now();
        const held = batch.filter((b) => !results.some((r) => r.queue_id === b.queue_id))
          .map((b) => b.queue_id);
        apiClient
          .heartbeat(this.instanceId, null, {
            processed: this.progress.checked,
            matched: this.progress.closed,
            errors: this.progress.blocked,
          }, held)
          .catch(() => {});
      }

      try {
        await chrome.tabs.update(tabId, { url: item.url });
        await this.waitLoad(tabId);
        await new Promise((r) => setTimeout(r, 1500));
        const res = await chrome.scripting.executeScript({
          target: { tabId },
          func: extractCard,
        });
        const data: CardExtract = res?.[0]?.result ?? { status: 'unknown', price: null, date: null, updated: null, renovation: null, photos: [], history: [] };

        this.progress.checked++;
        const src = item.source === 'cian.ru' ? 'cian' : 'avito';
        const sp = this.progress.sources[src];
        if (sp) sp.checked++;
        if (data.status === 'closed') this.progress.closed++;
        if (data.status === 'blocked') this.progress.blocked++;

        results.push({
          queue_id: item.queue_id,
          id: item.id,
          status: data.status,
          price: data.price ? Number(data.price) : null,
          updated: data.updated ?? null,
          renovation_type: data.renovation ?? null,
          price_history: data.history?.length ? data.history : null,
          photos: data.photos?.length ? data.photos : null,
          ...(data.status === 'blocked' ? { error: 'paused: blocked' } : {}),
          ...(data.status === 'unknown' ? { error: 'light: unknown' } : {}),
        });
      } catch (e: any) {
        results.push({
          queue_id: item.queue_id,
          id: item.id,
          status: 'unknown',
          error: 'light: ' + (e?.message || 'extract failed'),
        });
      }
      this.publish();
      await new Promise((r) => setTimeout(r, CARD_DELAY_MS));
    }
    return results;
  }

  /**
   * Батч → сервер (complete-light): строки закрываются/возвращаются,
   * изменённые по цене сами уходят в полный парсинг.
   */
  private async report(results: LightResult[]) {
    if (!results.length) return;
    try {
      const resp = await apiClient.completeLight(this.instanceId, results);
      if (resp?.changed_ids?.length) {
        this.progress.repriced += resp.changed_ids.length;
      }
    } catch (e) {
      // Связь упала — строки протухнут по аренде (10 мин) и достанутся снова.
      this.progress.stage = 'ошибка отправки, строки вернутся в очередь';
    }
    this.publish();
  }

  /** Пауза с пульсом: держит SW живым и продлевает аренду строк */
  private async sleep(ms: number) {
    const step = 30_000;
    const deadline = Date.now() + ms;
    while (!this.stopFlag && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, Math.min(step, deadline - Date.now())));
      if (!this.stopFlag) {
        apiClient
          .heartbeat(this.instanceId, null, {
            processed: this.progress.checked,
            matched: this.progress.closed,
            errors: this.progress.blocked,
          })
          .catch(() => {});
        this.publish();
      }
    }
  }

  /**
   * Вкладка карточки живёт между порциями (tabId в storage) — переиспользуем,
   * чтобы каждая порция не плодила вкладки.
   */
  private async openTab(url: string): Promise<number> {
    if (this.tabId != null) return this.tabId;
    const stored = await chrome.storage.local.get('lightTabId');
    const saved = stored.lightTabId as number | undefined;
    if (saved != null) {
      try {
        await chrome.tabs.get(saved);
        this.tabId = saved;
        return saved;
      } catch { /* вкладка закрыта — создадим новую */ }
    }
    const t = await chrome.tabs.create({ url, active: false });
    this.tabId = t.id!;
    await chrome.storage.local.set({ lightTabId: t.id });
    return t.id!;
  }

  private async closeTab() {
    const id = this.tabId;
    this.tabId = null;
    await chrome.storage.local.remove('lightTabId').catch(() => {});
    if (id != null) {
      await chrome.tabs.remove(id).catch(() => {});
    }
  }

  private waitLoad(tabId: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      };
      const listener = (id: number, info: any) => {
        if (id === tabId && info.status === 'complete') done();
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(done, 12000);
    });
  }
}

/** Результат лёгкой проверки карточки (data-server#49: полные данные). */
interface CardExtract {
  status: string;
  price: string | null;
  date: string | null;
  updated: string | null;
  renovation: string | null;
  photos: string[];
  history: Array<{ date: string; price: number }>;
}

/**
 * Функция, выполняемая НА СТРАНИЦЕ карточки (и avito, и cian).
 * Собирает всё, что доступно лёгкой проверке (data-server#49):
 *  - Cian: цена, дата «Обновлено» (ISO), ремонт из фактойдов, фото-ссылки,
 *    история цен (DOM-виджет раскрывается кликом — работает и на закрытой
 *    карточке, API price-estimator не отвечает);
 *  - Avito: цена/дата (фото/история — из hydration, фаза 2).
 */
async function extractCard(this: any): Promise<CardExtract> {
  const body = document.body ? document.body.innerText.replace(/\s+/g, ' ') : '';
  const isCian = /cian\.ru/.test(location.host);
  const out: CardExtract = { status: 'unknown', price: null, date: null, updated: null, renovation: null, photos: [], history: [] };
  if (/доступ ограничен|проблема с ip|отключите VPN|отключите AdBlock|проверьте, что вы не робот|обнаружен подозрительный трафик|cian_waf|rate limit/i.test(body)) {
    out.status = 'blocked';
    return out;
  }
  // Русская дата («9 сен, 12:07» / «5 авг 2026») -> YYYY-MM-DD.
  const MON: Record<string, number> = { янв: 1, фев: 2, мар: 3, апр: 4, мая: 5, май: 5, июн: 6, июл: 7, авг: 8, сен: 9, окт: 10, ноя: 11, дек: 12 };
  const ruDate = (s: string): string | null => {
    const m = String(s || '').match(/(\d{1,2})\s+([а-я]{3})[^0-9]*(\d{4})?/i);
    if (!m) return null;
    const mo = MON[m[2].toLowerCase()];
    if (!mo) return null;
    let y = m[3] ? +m[3] : new Date().getFullYear();
    if (!m[3] && mo > new Date().getMonth() + 1) y -= 1;
    return y + '-' + String(mo).padStart(2, '0') + '-' + String(m[1]).padStart(2, '0');
  };
  let status = 'unknown';
  if (isCian) {
    // Точный маркер снятой карточки + точные фразы. Широкие «удалено|неактивно»
    // убраны — ловили текст в описаниях и давали ложные архивации.
    const unpub = !!document.querySelector('[data-name="OfferUnpublished"]');
    if (unpub || /Объявление снято|снято с публикации|объявление удалено|объявление не найдено|страница не найдена/i.test(body)) status = 'closed';
    else if (/Сравнить|Пожаловаться|Обновлено:/i.test(body)) status = 'active';
  } else {
    // «Объявление не посмотреть» — НЕ снятие (бывает при временных проблемах).
    if (/Объявление закрыто|Объявление истекло/i.test(body)) status = 'closed';
    else if (/Добавить в избранное|Сравнить/i.test(body)) status = 'active';
  }
  out.status = status;
  let price: string | null = null;
  for (const sel of ['[itemprop="price"]', '[data-testid="price-amount"]', '[data-marker*="price"]']) {
    const el = document.querySelector(sel);
    if (el) {
      price = ((el as HTMLElement).getAttribute('content') || el.textContent || '').trim();
      if (price) break;
    }
  }
  if (price) {
    const m = price.match(/[\d\s]{3,}/);
    price = m ? m[0].replace(/\s/g, '') : null;
  }
  out.price = price;
  if (isCian) {
    // Дата «Обновлено: 9 сен, 12:07» -> ISO (дата площадки, важна при закрытии).
    const dm = body.match(/Обновлено:\s*(\d{1,2}\s+[а-я]{3}[^,]*,?\s*\d{1,2}:\d{2})/i);
    if (dm) { out.updated = ruDate(dm[1]); out.date = dm[1].trim(); }
    // Ремонт из фактойдов: «РемонтБез ремонта» / «ОтделкаКосметический».
    for (const el of Array.from(document.querySelectorAll('[data-name="ObjectFactoidsItem"], [data-testid="OfferSummaryInfoItem"]'))) {
      const t = (el.textContent || '').trim();
      const m = t.match(/^(Ремонт|Отделка)\s*:?\s*(.+)$/i);
      if (!m) continue;
      const v = m[2].toLowerCase().replace(/ё/g, 'е');
      if (/без\s*отделк|без\s*ремонт|предчистов|чернов|требует\s*ремонт/.test(v)) out.renovation = 'without';
      else if (/космет/.test(v)) out.renovation = 'cosmetic';
      else if (/дизайнер/.test(v)) out.renovation = 'designer';
      else if (/евро/.test(v)) out.renovation = 'euro';
      else if (/чистов|под\s*ключ/.test(v)) out.renovation = 'cosmetic';
      break;
    }
    // Фото-ссылки (на закрытой карточке галереи нет — вернётся пусто).
    const seen = new Set<string>();
    for (const img of Array.from(document.querySelectorAll('#photos img[src*="images.cdn-cian.ru/images/"], [class*="photo_gallery_container"] img[src*="images.cdn-cian.ru/images/"]'))) {
      const src = (((img as HTMLImageElement).src) || '').split('?')[0];
      const idm = src.match(/\/(\d+)-/);
      const key = idm ? idm[1] : src;
      if (seen.has(key)) continue;
      seen.add(key);
      out.photos.push(src);
      if (out.photos.length >= 40) break;
    }
    // История цен: DOM-виджет раскрывается кликом (работает и на закрытой
    // карточке — финальная история). API price-estimator не отвечает (CORS).
    const parseHist = (): Array<{ date: string; price: number }> => {
      const rows: Array<{ date: string; price: number }> = [];
      for (const tr of Array.from(document.querySelectorAll('table tr'))) {
        const c = Array.from(tr.children).map(td => (td.textContent || '').trim());
        if (c.length < 2) continue;
        const d = ruDate(c[0]);
        const pm = (c[1] || '').match(/([\d\s]{3,})/);
        if (!d || !pm) continue;
        rows.push({ date: d, price: parseInt(pm[1].replace(/\s/g, ''), 10) });
      }
      return rows;
    };
    out.history = parseHist();
    if (out.history.length === 0) {
      const w = document.querySelector('[data-testid="price-history-widget"]') as HTMLElement | null;
      if (w) {
        w.click();
        await new Promise(r => setTimeout(r, 1500));
        out.history = parseHist();
      }
    }
  } else {
    const de = document.querySelector('[data-marker="item-date"], time');
    if (de) out.date = ((de as HTMLElement).getAttribute('datetime') || de.textContent || '').trim().slice(0, 30);
  }
  return out;
}
