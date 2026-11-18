/**
 * LightChecker — лёгкая проверка статусов объявлений (без аккаунта).
 *
 * Схема (обсуждена с владельцем 18.11.2026):
 *   порция карточек с сервера (области «В работе», avito/cian)
 *   -> проверка статуса/цены со страницы (быстро, ~2с)
 *   -> НЕМЕДЛЕННАЯ обратная запись (POST light-check-report:
 *      активным updated=now, снятым status=archived)
 *   -> изменения цен/статусов -> очередь полного парсинга (ids)
 *
 * Блок/капча — волна проходит сама: пауза только при ПЛОТНОМ блоке
 * (несколько подряд без просвета). Управление — из popup (LIGHT_START/STOP).
 */

export interface LightProgress {
  running: boolean;
  stage: string;
  checked: number;
  total: number;
  blocked: number;
  closed: number;
  repriced: number;
  source: string;
}

const API_MONITOR = '/api/monitor';
const PORTION = 150;
const CARD_DELAY_MS = 5000;

export class LightChecker {
  private running = false;
  private stopFlag = false;
  private tabId: number | null = null;
  private progress: LightProgress = {
    running: false, stage: 'остановлен', checked: 0, total: 0,
    blocked: 0, closed: 0, repriced: 0, source: 'avito',
  };
  private onUpdate: ((p: LightProgress) => void) | null = null;

  constructor(private apiUrl: string = 'https://54.neocenka.ru') {}

  onProgress(cb: (p: LightProgress) => void) {
    this.onUpdate = cb;
  }

  getProgress(): LightProgress {
    return { ...this.progress };
  }

  stop() {
    this.stopFlag = true;
    this.progress.stage = 'остановка...';
    this.publish();
  }

  private lastPublishAt = 0;

  private publish() {
    this.progress.running = this.running;
    if (this.onUpdate) this.onUpdate(this.getProgress());
    chrome.runtime.sendMessage({ type: 'LIGHT_PROGRESS', ...this.getProgress() }).catch(() => {});
    // Сквозной статус на сервер: popup ЛЮБОГО профиля видит прогресс
    // (throttle — раз в 3 секунды, события каждую карточку).
    const now = Date.now();
    if (now - this.lastPublishAt > 3000 || !this.progress.running) {
      this.lastPublishAt = now;
      this.apiPost(`${API_MONITOR}/lightcheck-progress`, { progress: this.getProgress() }).catch(() => {});
    }
  }

  /** Глобальный статус с сервера (если проверка идёт в другом профиле). */
  static async fetchGlobal(apiUrl: string = 'https://54.neocenka.ru'): Promise<LightProgress | null> {
    try {
      const r = await fetch(apiUrl + API_MONITOR + '/lightcheck-progress');
      const d = await r.json();
      return d?.progress || null;
    } catch {
      return null;
    }
  }

  private async apiGet(path: string): Promise<any> {
    const r = await fetch(this.apiUrl + path);
    return r.json();
  }

  private async apiPost(path: string, body: any): Promise<any> {
    const r = await fetch(this.apiUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return r.json();
  }

  /**
   * Запуск проверки: сначала avito, потом cian (budget — на каждый).
   */
  async start(sources: string[] = ['avito', 'cian'], budget = 100000) {
    if (this.running) return { error: 'уже работает' };
    this.running = true;
    this.stopFlag = false;
    this.progress = {
      running: true, stage: 'старт', checked: 0, total: 0,
      blocked: 0, closed: 0, repriced: 0, source: sources[0],
    };
    this.publish();

    try {
      for (const src of sources) {
        this.progress.source = src;
        let processed = 0;
        while (processed < budget && !this.stopFlag) {
          const size = Math.min(PORTION, budget - processed);
          const d = await this.apiGet(
            `${API_MONITOR}/lightcheck-urls?limit=${size}&source=${src}`
          ).catch(() => null);
          const items: Array<{ id: number; url: string }> = d?.items || [];
          if (d?.total) this.progress.total = d.total;
          if (!items.length) {
            this.progress.stage = `${src}: пул пройден`;
            break;
          }
          this.progress.stage = `${src}: проверяю порцию ${items.length}...`;
          this.publish();

          const rows = await this.checkPortion(items);
          // Обратная запись СРАЗУ — сервер знает свежесть каждой карточки.
          await this.report(rows);
          this.tally(rows);
          processed += rows.length;
          this.progress.stage = `${src}: проверено ${this.progress.checked}`;
          this.publish();

          // Волна блоков: пауза только при плотной серии.
          const streak = rows.filter((r) => r.status === 'blocked').length;
          if (streak >= 3) {
            this.progress.stage = 'плотный блок — пауза 2 мин';
            this.publish();
            await new Promise((r) => setTimeout(r, 120000));
          }
        }
      }
    } catch (e: any) {
      this.progress.stage = 'ошибка: ' + (e?.message || e);
    }
    this.running = false;
    this.progress.stage += ' — завершено';
    this.publish();
    return { ok: true, ...this.progress };
  }

  private tally(_rows: Array<{ status: string }>) {
    // Счётчики уже обновлены по карточкам в checkPortion (живой прогресс).
  }

  /** Порция: открыть каждую карточку в рабочей вкладке и вытащить статус/цену. */
  private async checkPortion(items: Array<{ id: number; url: string }>) {
    const rows: Array<{ id: number; url: string; status: string; price: string | null }> = [];
    if (!this.tabId) {
      const t = await chrome.tabs.create({ url: items[0].url, active: false });
      this.tabId = t.id!;
    }
    for (const it of items) {
      if (this.stopFlag) break;
      try {
        await chrome.tabs.update(this.tabId, { url: it.url });
        await this.waitLoad(this.tabId);
        await new Promise((r) => setTimeout(r, 1500));
        const res = await chrome.scripting.executeScript({
          target: { tabId: this.tabId },
          func: extractCard,
        });
        const data = res?.[0]?.result || { status: 'unknown', price: null };
        rows.push({ id: it.id, url: it.url, ...data });
        // Живой прогресс в popup после каждой карточки.
        this.progress.checked++;
        if (data.status === 'closed') this.progress.closed++;
        if (data.status === 'blocked') this.progress.blocked++;
        this.publish();
      } catch {
        rows.push({ id: it.id, url: it.url, status: 'unknown', price: null });
      }
      await new Promise((r) => setTimeout(r, CARD_DELAY_MS));
    }
    return rows;
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

  /**
   * Результаты -> сервер; ИЗМЕНЕНИЯ (цена/снятие) -> очередь полного парсинга.
   * Дифф цен делает СЕРВЕР (его снимок = сама база) и возвращает changed_ids —
   * воркеры полного парсинга подхватят их сами (explicit-направление, FIFO).
   */
  private async report(rows: Array<{ id: number; url: string; status: string; price: string | null }>) {
    const send = rows.filter((r) => r.status === 'active' || r.status === 'closed');
    if (!send.length) return;
    const resp = await this.apiPost(`${API_MONITOR}/lightcheck-report`, {
      results: send.map((r) => ({
        id: r.id,
        status: r.status,
        price: r.price ? Number(r.price) : null,
      })),
    }).catch(() => null);
    const changed: number[] = resp?.changed_ids || [];
    if (changed.length) {
      await this.apiPost('/api/update/tasks', {
        filter_data: { ids: changed },
        name: 'Light-чек: изменения цен/снятие (авто)',
      }).catch(() => null);
      this.progress.repriced += changed.length;
    }
  }
}

/** Функция, выполняемая НА СТРАНИЦЕ карточки (и avito, и cian). */
function extractCard(this: any): { status: string; price: string | null } {
  const body = document.body ? document.body.innerText.replace(/\s+/g, ' ') : '';
  const isCian = /cian\.ru/.test(location.host);
  if (/доступ ограничен|проблема с ip|отключите VPN|отключите AdBlock|проверьте, что вы не робот/i.test(body)) {
    return { status: 'blocked', price: null };
  }
  let status = 'unknown';
  if (isCian) {
    if (/Объявление снято|снято с публикации|удалено|неактивно/i.test(body)) status = 'closed';
    else if (/Сравнить|Пожаловаться|Обновлено:/i.test(body)) status = 'active';
  } else {
    if (/Объявление закрыто|Объявление истекло|Объявление не посмотреть/i.test(body)) status = 'closed';
    else if (/Добавить в избранное|Сравнить/i.test(body)) status = 'active';
  }
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
  return { status, price };
}
