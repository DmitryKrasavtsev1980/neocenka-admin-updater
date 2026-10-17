/**
 * Быстрая проверка объявления Avito через fetch HTML
 * Порт из extension/src/background/service-worker.ts (checkAvitoAdHtml)
 */

import type { CheckResult } from '../types';

/**
 * Проверить объявление Avito через fetch (без открытия вкладки)
 * Используется в фоновой вкладке avito.ru для CORS
 */
export async function checkAvitoAdHtml(url: string): Promise<CheckResult> {
  try {
    const target = url.replace(/^http:\/\//i, 'https://');
    const response = await fetch(target, { credentials: 'include' });

    // 404/410 — сразу archived
    if (response.status === 404 || response.status === 410) {
      return { status: 'archived', price: null, priceChanged: false, statusChanged: true };
    }

    // Редирект на другое объявление
    if (response.url !== url) {
      const origId = url.match(/\/(\d{10,})/)?.[1];
      const newId = response.url.match(/\/(\d{10,})/)?.[1];
      if (origId && newId && origId !== newId) {
        return { status: 'archived', price: null, priceChanged: false, statusChanged: true };
      }
    }

    const html = await response.text();

    // Мягкий рейт-лимит Avito: «Доступ ограничен: проблема с IP».
    // Это не бан и не капча в чистом виде — площадка просит переждать
    // и/или решить капчу по кнопке «Продолжить». Относим к ip_block,
    // чтобы воркер замедлился и не сжигал попытки в no_data.
    if (html.includes('Доступ ограничен') || html.includes('проблема с IP')) {
      return { status: 'error', price: null, priceChanged: false, statusChanged: false, error: 'ip_block' };
    }

    // Проверка на закрытое/удалённое объявление — ловим заранее,
    // чтобы не открывать вкладку и не сжигать parseDelay на мёртвой карточке
    if (
      html.includes('Объявление закрыто') ||
      html.includes('closedItem') ||
      html.includes('не найдено') ||
      html.includes('страница не найдена') ||
      html.includes('объявление удалено') ||
      html.includes('снято с публикации') ||
      html.includes('Объявление истекло') ||
      html.includes('объявление не посмотреть') ||
      html.includes('"isDeleted":true')
    ) {
      return { status: 'archived', price: null, priceChanged: false, statusChanged: true };
    }

    // Попытка извлечь цену из JSON-LD или hydration data
    let price: number | null = null;

    // Способ 1: из JSON в hydration data
    const jsonMatch = html.match(/JSON\.parse\("(.+?)"\)/);
    if (jsonMatch) {
      try {
        const unescaped = jsonMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        const parsed = JSON.parse(unescaped);
        const item = parsed?.['*']?.loaderData?.['realty/Detail']?.buyerItem?.item;
        if (item?.price?.value) {
          price = item.price.value;
        }
      } catch { /* ignore parse errors */ }
    }

    // Способ 2: из мета-тега
    if (price === null) {
      const metaMatch = html.match(/<meta\s+property="product:price:amount"\s+content="(\d+)"/);
      if (metaMatch) {
        price = parseInt(metaMatch[1], 10);
      }
    }

    // Способ 3: из JSON-LD
    if (price === null) {
      const ldMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/);
      if (ldMatch) {
        try {
          const ld = JSON.parse(ldMatch[1]);
          if (ld.offers?.price) {
            price = Number(ld.offers.price);
          }
        } catch { /* ignore */ }
      }
    }

    // Определяем статус
    let status: 'active' | 'archived' = 'active';
    if (html.includes('"isActive":false') || html.includes('"isClosed":true') ||
        html.includes('"isDeleted":true') || html.includes('"isExpired":true')) {
      status = 'archived';
    }

    return {
      status,
      price,
      priceChanged: false, // Сравнение с текущей ценой происходит на уровне вызывающего кода
      statusChanged: status === 'archived',
    };
  } catch (err) {
    return {
      status: 'error',
      price: null,
      priceChanged: false,
      statusChanged: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
