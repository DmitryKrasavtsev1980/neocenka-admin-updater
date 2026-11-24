const DEFAULT_API_URL = "https://54.neocenka.ru/api";
class ApiClient {
  constructor(baseUrl = DEFAULT_API_URL) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }
  setBaseUrl(url) {
    this.baseUrl = url.replace(/\/$/, "");
  }
  async request(path, init) {
    const response = await fetch(`${this.baseUrl}${path}`, init);
    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    }
    return response.json();
  }
  // ─── Задачи ───────────────────────────────────────────────
  /**
   * Создать задачу на обновление. Без saved_filter_id и filter_data —
   * складывает в очередь ВСЕ объявления (update_all).
   * kind: 'full' (полный парсинг, дефолт) | 'light' (лёгкая проверка).
   */
  async createTask(params) {
    return this.request("/update/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params)
    });
  }
  async listTasks() {
    return this.request("/update/tasks");
  }
  async getTaskStatus(id) {
    return this.request(`/update/tasks/${id}`);
  }
  async deleteTask(id) {
    return this.request(`/update/tasks/${id}`, { method: "DELETE" });
  }
  // ─── Очередь воркера ──────────────────────────────────────
  /**
   * Взять порцию объявлений в аренду (10 минут).
   * source: 'avito.ru' | 'cian.ru'; null/'' — не фильтровать.
   * kind: 'full' (полный парсинг, дефолт) | 'light' (лёгкая проверка) —
   * воркеры берут работу только своего kind, клейм атомарный (N воркеров
   * одного kind не дублируют карточки).
   */
  async claim(browserId, source, limit, kind = "full") {
    const data = await this.request("/update/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        browser_id: browserId,
        source: source ?? void 0,
        limit: Math.min(Math.max(limit, 1), 100),
        kind
      })
    });
    return data.data || [];
  }
  /**
   * Завершение строк ЛЁГКОЙ проверки (kind=light) батчем.
   * Семантика как у lightcheck-report, но с жизненным циклом очереди:
   * active → обновить, closed → закрыть, не определено → вернуть в очередь,
   * изменение цены → сервер отдаёт карточку в полный парсинг сам.
   */
  async completeLight(browserId, results) {
    return this.request("/update/complete-light", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ browser_id: browserId, results })
    });
  }
  /**
   * Отметить строку очереди обработанной и записать данные в ads.
   * id — это queue_id, НЕ ad.id.
   */
  async complete(queueId, browserId, data) {
    return this.request(`/update/complete/${queueId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ browser_id: browserId, ...data })
    });
  }
  /**
   * Вернуть строку в очередь (ошибка парсинга). После 3 попыток — failed.
   */
  async release(queueId, browserId, error) {
    return this.request(`/update/release/${queueId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ browser_id: browserId, error })
    });
  }
  /**
   * Пульс воркера: продлевает аренду строк, которые он ещё держит,
   * и отчитывается по счётчикам. queue_ids обязательны для длинного парсинга —
   * иначе через 10 минут строку отберёт сосед.
   */
  async heartbeat(browserId, source, stats, queueIds = []) {
    return this.request("/update/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        browser_id: browserId,
        source: source ?? void 0,
        queue_ids: queueIds,
        ...stats
      })
    });
  }
  /** Сводка по очереди: счётчики, кто держит аренды, протухшие */
  async getQueueStats() {
    const data = await this.request("/update/queue-stats");
    return data.data;
  }
  // ─── Лок на смену IP ─────────────────────────────────────
  //
  // Пока один воркер крутит IP модема, у остальных на этом же модеме
  // обрываются запросы и сгорают попытки строк. Лок — per-modem:
  // воркеры на другом модеме работают, их лок не касается.
  /**
   * Попытаться взять лок на смену IP.
   * true — лок наш (или протух и перехвачен), false — его держит сосед.
   * modem — слот модема (A/B); без него общий лок (один модем).
   */
  async acquireIpLock(browserId, modem) {
    const data = await this.request("/update/ip-lock/acquire", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ browser_id: browserId, modem: modem || void 0 })
    });
    return data.acquired === true;
  }
  /** Отпустить лок. Чужой лок сервер не трогает — безопасно звать всегда. */
  async releaseIpLock(browserId, modem) {
    await this.request("/update/ip-lock/release", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ browser_id: browserId, modem: modem || void 0 })
    });
  }
  /** Кто сейчас держит лок и сколько ему осталось */
  async getIpLock(modem) {
    const qs = modem ? `?modem=${encodeURIComponent(modem)}` : "";
    const data = await this.request(`/update/ip-lock${qs}`);
    return data.data;
  }
  /**
   * Сообщить о бане/капче площадки. Сервер отключает источник на N часов
   * и переключает остальных воркеров на соседний.
   */
  async reportBan(browserId, source, reason) {
    return this.request("/update/report-ban", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ browser_id: browserId, source: source ?? void 0, reason })
    });
  }
  /** Сообщить, что воркер упёрся в дневной кап площадки */
  async reportDailyCap(browserId, source, used, cap) {
    return this.request("/update/report-daily-cap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ browser_id: browserId, source: source ?? void 0, used, cap })
    });
  }
  /** Проверить доступность API */
  async healthCheck() {
    try {
      const response = await fetch(`${this.baseUrl}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }
}
const apiClient = new ApiClient();
const PORTION = 30;
const CARD_DELAY_MS = 5e3;
const HEARTBEAT_MS = 6e4;
const IDLE_WAIT_MS = 5 * 6e4;
class LightChecker {
  constructor() {
    this.running = false;
    this.stopFlag = false;
    this.tabId = null;
    this.instanceId = "";
    this.progress = {
      running: false,
      stage: "остановлен",
      checked: 0,
      total: 0,
      sources: { avito: { checked: 0, total: 0 }, cian: { checked: 0, total: 0 } },
      blocked: 0,
      closed: 0,
      repriced: 0,
      source: "avito"
    };
    this.onUpdate = null;
  }
  onProgress(cb) {
    this.onUpdate = cb;
  }
  getProgress() {
    return { ...this.progress };
  }
  /**
   * id этого профиля браузера — он же browser_id очереди: по нему
   * строки арендуются за воркером и видны в мониторинге.
   */
  setInstanceId(id) {
    this.instanceId = id;
    this.progress.instanceId = id;
  }
  stop() {
    this.stopFlag = true;
    this.progress.stage = "остановка...";
    this.publish();
  }
  publish() {
    this.progress.running = this.running;
    if (this.instanceId) this.progress.instanceId = this.instanceId;
    if (this.onUpdate) this.onUpdate(this.getProgress());
    chrome.runtime.sendMessage({ type: "LIGHT_PROGRESS", ...this.getProgress() }).catch(() => {
    });
  }
  /**
   * Дежурный цикл: claim → проверка → complete-light. Пустая очередь —
   * тихое ожидание с пульсом (пульс продлевает аренду строк и держит
   * service worker живым — иначе MV3 убивает его после 30 с бездействия).
   */
  async start() {
    if (this.running) return { ok: false, error: "уже работает" };
    this.running = true;
    this.stopFlag = false;
    this.progress = {
      ...this.progress,
      running: true,
      stage: "старт",
      checked: 0,
      total: 0,
      sources: { avito: { checked: 0, total: 0 }, cian: { checked: 0, total: 0 } },
      blocked: 0,
      closed: 0,
      repriced: 0
    };
    this.publish();
    try {
      while (!this.stopFlag) {
        this.progress.stage = "жду задачи в очереди...";
        this.publish();
        let batch = [];
        try {
          batch = await apiClient.claim(this.instanceId, null, PORTION, "light");
        } catch (e) {
          this.progress.stage = "ошибка связи: " + (e?.message || e);
          this.publish();
          await this.sleep(IDLE_WAIT_MS);
          continue;
        }
        if (!batch.length) {
          this.progress.stage = "ожидание задач в очереди…";
          this.publish();
          await this.sleep(IDLE_WAIT_MS);
          continue;
        }
        this.progress.total += batch.length;
        for (const b of batch) {
          const src = b.source === "cian.ru" ? "cian" : "avito";
          this.progress.sources[src].total = (this.progress.sources[src].total ?? 0) + 1;
        }
        this.progress.stage = `проверяю порцию ${batch.length}...`;
        this.publish();
        const results = await this.checkPortion(batch);
        await this.report(results);
        const streak = results.filter((r) => r.status === "blocked").length;
        if (streak >= 3 && !this.stopFlag) {
          this.progress.stage = "плотный блок — пауза 2 мин";
          this.publish();
          await this.sleep(12e4);
        }
      }
    } catch (e) {
      this.progress.stage = "ошибка: " + (e?.message || e);
    }
    this.running = false;
    this.progress.stage = "остановлено";
    this.publish();
    await this.closeTab();
    return { ok: true };
  }
  /**
   * Портция: каждую карточку открыть в рабочей вкладке и вытащить данные.
   * Пульс каждые ~60 с продлевает аренду необработанных строк — порция в 30
   * карточек при 5 с/карточку живёт ~2.5 мин, аренда 10 мин не протухает.
   */
  async checkPortion(batch) {
    const results = [];
    const tabId = await this.openTab(batch[0].url);
    let lastBeat = Date.now();
    for (const item of batch) {
      if (this.stopFlag) break;
      if (Date.now() - lastBeat > HEARTBEAT_MS) {
        lastBeat = Date.now();
        const held = batch.filter((b) => !results.some((r) => r.queue_id === b.queue_id)).map((b) => b.queue_id);
        apiClient.heartbeat(this.instanceId, null, {
          processed: this.progress.checked,
          matched: this.progress.closed,
          errors: this.progress.blocked
        }, held).catch(() => {
        });
      }
      try {
        await chrome.tabs.update(tabId, { url: item.url });
        await this.waitLoad(tabId);
        await new Promise((r) => setTimeout(r, 1500));
        const res = await chrome.scripting.executeScript({
          target: { tabId },
          func: extractCard
        });
        const data = res?.[0]?.result ?? { status: "unknown", price: null, date: null, updated: null, renovation: null, photos: [], history: [] };
        this.progress.checked++;
        const src = item.source === "cian.ru" ? "cian" : "avito";
        const sp = this.progress.sources[src];
        if (sp) sp.checked++;
        if (data.status === "closed") this.progress.closed++;
        if (data.status === "blocked") this.progress.blocked++;
        results.push({
          queue_id: item.queue_id,
          id: item.id,
          status: data.status,
          price: data.price ? Number(data.price) : null,
          updated: data.updated ?? null,
          renovation_type: data.renovation ?? null,
          price_history: data.history?.length ? data.history : null,
          photos: data.photos?.length ? data.photos : null,
          ...data.status === "blocked" ? { error: "paused: blocked" } : {},
          ...data.status === "unknown" ? { error: "light: unknown" } : {}
        });
      } catch (e) {
        results.push({
          queue_id: item.queue_id,
          id: item.id,
          status: "unknown",
          error: "light: " + (e?.message || "extract failed")
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
  async report(results) {
    if (!results.length) return;
    try {
      const resp = await apiClient.completeLight(this.instanceId, results);
      if (resp?.changed_ids?.length) {
        this.progress.repriced += resp.changed_ids.length;
      }
    } catch (e) {
      this.progress.stage = "ошибка отправки, строки вернутся в очередь";
    }
    this.publish();
  }
  /** Пауза с пульсом: держит SW живым и продлевает аренду строк */
  async sleep(ms) {
    const step = 3e4;
    const deadline = Date.now() + ms;
    while (!this.stopFlag && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, Math.min(step, deadline - Date.now())));
      if (!this.stopFlag) {
        apiClient.heartbeat(this.instanceId, null, {
          processed: this.progress.checked,
          matched: this.progress.closed,
          errors: this.progress.blocked
        }).catch(() => {
        });
        this.publish();
      }
    }
  }
  /**
   * Вкладка карточки живёт между порциями (tabId в storage) — переиспользуем,
   * чтобы каждая порция не плодила вкладки.
   */
  async openTab(url) {
    if (this.tabId != null) return this.tabId;
    const stored = await chrome.storage.local.get("lightTabId");
    const saved = stored.lightTabId;
    if (saved != null) {
      try {
        await chrome.tabs.get(saved);
        this.tabId = saved;
        return saved;
      } catch {
      }
    }
    const t = await chrome.tabs.create({ url, active: false });
    this.tabId = t.id;
    await chrome.storage.local.set({ lightTabId: t.id });
    return t.id;
  }
  async closeTab() {
    const id = this.tabId;
    this.tabId = null;
    await chrome.storage.local.remove("lightTabId").catch(() => {
    });
    if (id != null) {
      await chrome.tabs.remove(id).catch(() => {
      });
    }
  }
  waitLoad(tabId) {
    return new Promise((resolve) => {
      const done = () => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      };
      const listener = (id, info) => {
        if (id === tabId && info.status === "complete") done();
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(done, 12e3);
    });
  }
}
async function extractCard() {
  const body = document.body ? document.body.innerText.replace(/\s+/g, " ") : "";
  const isCian = /cian\.ru/.test(location.host);
  const out = { status: "unknown", price: null, date: null, updated: null, renovation: null, photos: [], history: [] };
  if (/доступ ограничен|проблема с ip|отключите VPN|отключите AdBlock|проверьте, что вы не робот|обнаружен подозрительный трафик|cian_waf|rate limit/i.test(body)) {
    out.status = "blocked";
    return out;
  }
  const MON = { янв: 1, фев: 2, мар: 3, апр: 4, мая: 5, май: 5, июн: 6, июл: 7, авг: 8, сен: 9, окт: 10, ноя: 11, дек: 12 };
  const ruDate = (s) => {
    const m = String(s || "").match(/(\d{1,2})\s+([а-я]{3})[^0-9]*(\d{4})?/i);
    if (!m) return null;
    const mo = MON[m[2].toLowerCase()];
    if (!mo) return null;
    let y = m[3] ? +m[3] : (/* @__PURE__ */ new Date()).getFullYear();
    if (!m[3] && mo > (/* @__PURE__ */ new Date()).getMonth() + 1) y -= 1;
    return y + "-" + String(mo).padStart(2, "0") + "-" + String(m[1]).padStart(2, "0");
  };
  let status = "unknown";
  if (isCian) {
    const unpub = !!document.querySelector('[data-name="OfferUnpublished"]');
    if (unpub || /Объявление снято|снято с публикации|объявление удалено|объявление не найдено|страница не найдена/i.test(body)) status = "closed";
    else if (/Сравнить|Пожаловаться|Обновлено:/i.test(body)) status = "active";
  } else {
    if (/Объявление закрыто|Объявление истекло/i.test(body)) status = "closed";
    else if (/Добавить в избранное|Сравнить/i.test(body)) status = "active";
  }
  out.status = status;
  let price = null;
  for (const sel of ['[itemprop="price"]', '[data-testid="price-amount"]', '[data-marker*="price"]']) {
    const el = document.querySelector(sel);
    if (el) {
      price = (el.getAttribute("content") || el.textContent || "").trim();
      if (price) break;
    }
  }
  if (price) {
    const m = price.match(/[\d\s]{3,}/);
    price = m ? m[0].replace(/\s/g, "") : null;
  }
  out.price = price;
  if (isCian) {
    const dm = body.match(/Обновлено:\s*(\d{1,2}\s+[а-я]{3}[^,]*,?\s*\d{1,2}:\d{2})/i);
    if (dm) {
      out.updated = ruDate(dm[1]);
      out.date = dm[1].trim();
    }
    for (const el of Array.from(document.querySelectorAll('[data-name="ObjectFactoidsItem"], [data-testid="OfferSummaryInfoItem"]'))) {
      const t = (el.textContent || "").trim();
      const m = t.match(/^(Ремонт|Отделка)\s*:?\s*(.+)$/i);
      if (!m) continue;
      const v = m[2].toLowerCase().replace(/ё/g, "е");
      if (/без\s*отделк|без\s*ремонт|предчистов|чернов|требует\s*ремонт/.test(v)) out.renovation = "without";
      else if (/космет/.test(v)) out.renovation = "cosmetic";
      else if (/дизайнер/.test(v)) out.renovation = "designer";
      else if (/евро/.test(v)) out.renovation = "euro";
      else if (/чистов|под\s*ключ/.test(v)) out.renovation = "cosmetic";
      break;
    }
    const seen = /* @__PURE__ */ new Set();
    for (const img of Array.from(document.querySelectorAll('#photos img[src*="images.cdn-cian.ru/images/"], [class*="photo_gallery_container"] img[src*="images.cdn-cian.ru/images/"]'))) {
      const src = (img.src || "").split("?")[0];
      const idm = src.match(/\/(\d+)-/);
      const key = idm ? idm[1] : src;
      if (seen.has(key)) continue;
      seen.add(key);
      out.photos.push(src);
      if (out.photos.length >= 40) break;
    }
    const parseHist = () => {
      const rows = [];
      for (const tr of Array.from(document.querySelectorAll("table tr"))) {
        const c = Array.from(tr.children).map((td) => (td.textContent || "").trim());
        if (c.length < 2) continue;
        const d = ruDate(c[0]);
        const pm = (c[1] || "").match(/([\d\s]{3,})/);
        if (!d || !pm) continue;
        rows.push({ date: d, price: parseInt(pm[1].replace(/\s/g, ""), 10) });
      }
      return rows;
    };
    out.history = parseHist();
    if (out.history.length === 0) {
      const w = document.querySelector('[data-testid="price-history-widget"]');
      if (w) {
        w.click();
        await new Promise((r) => setTimeout(r, 1500));
        out.history = parseHist();
      }
    }
  } else {
    const de = document.querySelector('[data-marker="item-date"], time');
    if (de) out.date = (de.getAttribute("datetime") || de.textContent || "").trim().slice(0, 30);
  }
  return out;
}
const lightChecker = new LightChecker();
async function getWorkerId() {
  const stored = await chrome.storage.local.get("lightWorkerId");
  if (stored.lightWorkerId) return stored.lightWorkerId;
  const id = "lc-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  await chrome.storage.local.set({ lightWorkerId: id });
  return id;
}
async function applySettings() {
  const stored = await chrome.storage.local.get("settings");
  const apiUrl = stored.settings?.apiUrl;
  if (apiUrl) apiClient.setBaseUrl(String(apiUrl).replace(/\/$/, "") + "/api");
}
async function startChecker() {
  if (lightChecker.getProgress().running) {
    return { error: "уже работает" };
  }
  await applySettings();
  const id = await getWorkerId();
  lightChecker.setInstanceId(id);
  await chrome.storage.local.set({ lightCheckAuto: true });
  lightChecker.onProgress((stats) => {
    chrome.action.setBadgeText({ text: String(stats.checked) });
    chrome.action.setBadgeBackgroundColor({ color: "#F59E0B" });
  });
  lightChecker.start().then(() => {
    chrome.action.setBadgeText({ text: "" });
  });
  return { started: true };
}
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = async () => {
    switch (message.type) {
      case "LIGHT_START":
        return await startChecker();
      case "LIGHT_STOP":
        await chrome.storage.local.set({ lightCheckAuto: false });
        lightChecker.stop();
        return { stopped: true };
      case "LIGHT_STATUS": {
        const id = await getWorkerId();
        return { ...lightChecker.getProgress(), workerId: id };
      }
      case "GET_SETTINGS": {
        const stored = await chrome.storage.local.get("settings");
        return stored.settings || {};
      }
      case "SAVE_SETTINGS": {
        const current = await chrome.storage.local.get("settings");
        await chrome.storage.local.set({
          settings: { ...current.settings || {}, ...message.settings || {} }
        });
        await applySettings();
        return { saved: true };
      }
      default:
        return { error: "Unknown message type" };
    }
  };
  handler().then(sendResponse);
  return true;
});
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "light-duty") return;
  const stored = await chrome.storage.local.get("lightCheckAuto");
  if (!stored.lightCheckAuto || lightChecker.getProgress().running) return;
  const result = await startChecker();
  if ("started" in result) {
    console.log("[LightCheck] duty-restart by alarm");
  }
});
chrome.alarms.create("light-duty", { periodInMinutes: 1 });
console.log("[LightCheck] service worker loaded");
