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

export interface SourceProgress {
  checked: number;
  total: number;
}

export interface LightProgress {
  running: boolean;
  stage: string;
  checked: number;      // всего проверено (оба источника)
  total: number;        // всего в пулах (оба источника)
  sources: Record<string, SourceProgress>;  // avito/cian отдельно
  blocked: number;
  closed: number;
  repriced: number;
  source: string;
  /** id профиля браузера (см. setInstanceId): свой протухший прогресс vs чужой. */
  instanceId?: string;
}

const API_MONITOR = '/api/monitor';
const PORTION = 150;
const CARD_DELAY_MS = 5000;

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

  constructor(private apiUrl: string = 'https://54.neocenka.ru') {}

  /**
   * id этого профиля браузера (генерируется service-worker'ом, живёт в
   * chrome.storage.local). Публикуется в сквозной прогресс: по нему popup
   * отличает «идёт в другом профиле» от «мой SW упал и прогресс протух».
   */
  setInstanceId(id: string) {
    this.instanceId = id;
    this.progress.instanceId = id;
  }

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
    if (this.instanceId) this.progress.instanceId = this.instanceId;
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

  /**
   * Длинная пауза дольными сердцебиениями вместо одного setTimeout.
   *
   * MV3 убивает service worker после ~30 с бездействия — тихий setTimeout
   * на 5 минут убивал и LightChecker, и проверка «отжималась» (кнопка в
   * popup снова показывала «остановлен»). Publish каждые 30 с держит SW
   * живым (fetch сбрасывает таймер бездействия) и не даёт серверной
   * stale-защите (5 мин) засчитать прогресс мёртвым.
   */
  private async sleep(ms: number) {
    const step = 30_000;
    const deadline = Date.now() + ms;
    while (!this.stopFlag && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, Math.min(step, deadline - Date.now())));
      if (!this.stopFlag) this.publish();
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
      sources: { avito: { checked: 0, total: 0 }, cian: { checked: 0, total: 0 } },
      blocked: 0, closed: 0, repriced: 0, source: sources[0],
    };
    this.publish();

    try {
      // ДЕЖУРНАЯ схема: работаем, пока пользователь не нажал «Стоп».
      // Пустой пул — это НЕ завершение: карточки «протухают» по мере
      // обновления, новые появляются — ждём и опрашиваем снова (раньше
      // пул пустовал → break → «проверка завершилась», и это путало:
      // непонятно, подхватит ли расширение новые объявления).
      while (!this.stopFlag) {
        let gotAny = false;
        for (const src of sources) {
          if (this.stopFlag) break;
          this.progress.source = src;
          const size = PORTION;
          const d = await this.apiGet(
            `${API_MONITOR}/lightcheck-urls?limit=${size}&source=${src}&stale_days=1`
          ).catch(() => null);
          const items: Array<{ id: number; url: string }> = d?.items || [];
          this.progress.sources[src] = this.progress.sources[src] || { checked: 0, total: 0 };
          if (d?.total) {
            this.progress.sources[src].total = d.total;
            this.progress.total = Object.values(this.progress.sources)
              .reduce((a, sp) => a + (sp.total || 0), 0);
          }
          if (!items.length) {
            this.progress.stage = `${src}: жду новые карточки…`;
            this.publish();
            continue;
          }
          gotAny = true;
          this.progress.stage = `${src}: проверяю порцию ${items.length}...`;
          this.publish();

          const rows = await this.checkPortion(items);
          // Обратная запись СРАЗУ — сервер знает свежесть каждой карточки.
          await this.report(rows);
          this.tally(rows);
          this.progress.stage = `${src}: проверено ${this.progress.checked}`;
          this.publish();

          // Волна блоков: пауза только при плотной серии.
          const streak = rows.filter((r) => r.status === 'blocked').length;
          if (streak >= 3) {
            this.progress.stage = 'плотный блок — пауза 2 мин';
            this.publish();
            await this.sleep(120000);
          }
        }
        if (!gotAny && !this.stopFlag) {
          // Оба пула пусты — тихое ожидание с опросом каждые 5 минут,
          // статус «работает» не снимается (кнопка «Запустить» остаётся
          // заблокированной, пока пользователь не нажмёт «Стоп»).
          this.progress.stage = 'ожидание новых карточек…';
          this.publish();
          await this.sleep(5 * 60 * 1000);
        }
      }
    } catch (e: any) {
      this.progress.stage = 'ошибка: ' + (e?.message || e);
    }
    this.running = false;
    this.progress.stage = 'остановлено';
    this.publish();
    await this.closeTab();
    return { ok: true, ...this.progress };
  }

  /**
   * Вкладка карточки живёт между перезапусками SW: tabId храним в
   * chrome.storage.local, при старте переиспользуем живую вкладку (иначе
   * каждый duty-restart плодил бы новую), при завершении — закрываем.
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

  private tally(_rows: Array<{ status: string }>) {
    // Счётчики уже обновлены по карточкам в checkPortion (живой прогресс).
  }

  /** Порция: открыть каждую карточку в рабочей вкладке и вытащить данные. */
  private async checkPortion(items: Array<{ id: number; url: string }>) {
    const rows: Array<{ id: number; url: string } & CardExtract> = [];
    const tabId = await this.openTab(items[0].url);
    for (const it of items) {
      if (this.stopFlag) break;
      try {
        await chrome.tabs.update(tabId, { url: it.url });
        await this.waitLoad(tabId);
        await new Promise((r) => setTimeout(r, 1500));
        const res = await chrome.scripting.executeScript({
          target: { tabId },
          func: extractCard,
        });
        const data: CardExtract = res?.[0]?.result || { status: 'unknown', price: null, date: null, updated: null, renovation: null, photos: [], history: [] };
        rows.push({ id: it.id, url: it.url, ...data });
        // Живой прогресс в popup после каждой карточки (по источникам).
        this.progress.checked++;
        const sp = this.progress.sources[this.progress.source];
        if (sp) sp.checked++;
        if (data.status === 'closed') this.progress.closed++;
        if (data.status === 'blocked') this.progress.blocked++;
        this.publish();
      } catch {
        rows.push({ id: it.id, url: it.url, status: 'unknown', price: null, date: null, updated: null, renovation: null, photos: [], history: [] });
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
   * Результаты -> сервер (полные данные, data-server#49):
   *  - active: цена/ремонт/фото/история пишутся сразу (сервер решает, что изменилось);
   *  - closed: сервер закрывает через общий механизм с финальным снимком карточки.
   * ИЗМЕНЕНИЯ ЦЕН -> очередь полного парсинга: дифф делает СЕРВЕР (его снимок =
   * сама база) и возвращает changed_ids — воркеры подхватят их сами.
   */
  private async report(rows: Array<{ id: number; url: string } & CardExtract>) {
    const send = rows.filter((r) => r.status === 'active' || r.status === 'closed');
    if (!send.length) return;
    const resp = await this.apiPost(`${API_MONITOR}/lightcheck-report`, {
      results: send.map((r) => ({
        id: r.id,
        status: r.status,
        price: r.price ? Number(r.price) : null,
        updated: r.updated ?? null,
        renovation_type: r.renovation ?? null,
        price_history: r.history?.length ? r.history : null,
        photos: r.photos?.length ? r.photos : null,
      })),
    }).catch(() => null);
    // Дифф цен делает СЕРВЕР (снимок = сама база) — changed_ids идёт в очередь
    // ПОЛНОГО парсинга (explicit, FIFO): страховка + продавец/полные фото.
    const changed: number[] = (resp?.changed_ids as number[] | undefined) || [];
    if (changed.length) {
      await this.apiPost('/api/update/tasks', {
        filter_data: { ids: changed },
        name: 'Light-чек: изменения цен (авто)',
      }).catch(() => null);
      this.progress.repriced += changed.length;
    }
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
