/**
 * Полный парсер страницы объявления CIAN
 */

import type { ParseResult, PriceHistoryItem } from '../types';
import { injectScript } from '../utils/tab-manager';

/**
 * Парсинг страницы объявления CIAN (инжектируется в ISOLATED world)
 */
function parseCianDetailPage() {
  const result: any = {};

  // Статус
  const unpublished = document.querySelector('[data-name="OfferUnpublished"]');
  if (unpublished) {
    result.status = 'archived';
    return result;
  }
  result.status = 'active';

  // Цена
  const priceEl = document.querySelector('[data-testid="price-amount"]');
  if (priceEl) {
    const priceText = priceEl.textContent?.replace(/[^\d]/g, '') || '';
    result.price = priceText ? parseInt(priceText, 10) : null;
  }

  // Фото
  const photos: string[] = [];
  const photoContainer = document.querySelector('#photos') ||
    document.querySelector('[class*="photo_gallery_container"]');
  if (photoContainer) {
    const imgs = photoContainer.querySelectorAll('img[src*="images.cdn-cian.ru/images/"]');
    for (const img of Array.from(imgs)) {
      const src = (img as HTMLImageElement).src;
      // Извлекаем ID фото из URL
      const idMatch = src.match(/\/images\/(\d+)-/);
      const photoId = idMatch ? idMatch[1] : src;
      if (!photos.includes(photoId)) {
        photos.push(src.split('?')[0]); // Убираем query params
      }
    }
  }
  result.photos = photos;

  // Дата обновления
  const dateEl = document.querySelector('[data-testid="metadata-updated-date"]');
  if (dateEl) {
    result.updatedDateText = dateEl.textContent?.trim() || null;
  }

  // История цены из DOM
  const priceHistory: any[] = [];
  const historyRows = document.querySelectorAll('tr[class*="history-event"]');
  for (const row of Array.from(historyRows)) {
    const cells = row.querySelectorAll('td');
    if (cells.length >= 2) {
      const dateText = cells[0].textContent?.trim() || '';
      const priceText = cells[1].textContent?.replace(/[^\d]/g, '') || '';
      if (dateText && priceText) {
        priceHistory.push({ date: dateText, price: parseInt(priceText, 10) });
      }
    }
  }
  result.priceHistory = priceHistory;

  return result;
}

/**
 * Парсинг русской даты
 */
function parseRuDate(text: string): string | null {
  const months: Record<string, number> = {
    'января': 0, 'февраля': 1, 'марта': 2, 'апреля': 3,
    'мая': 4, 'июня': 5, 'июля': 6, 'августа': 7,
    'сентября': 8, 'октября': 9, 'ноября': 10, 'декабря': 11,
  };

  const lower = text.toLowerCase().trim();
  const now = new Date();

  const fullMatch = lower.match(/(\d{1,2})\s+(\w+)\s+(\d{4})/);
  if (fullMatch) {
    const month = months[fullMatch[2]];
    if (month !== undefined) {
      return new Date(parseInt(fullMatch[3]), month, parseInt(fullMatch[1])).toISOString();
    }
  }

  const shortMatch = lower.match(/(\d{1,2})\s+(\w+),?\s*(\d{1,2}):(\d{2})/);
  if (shortMatch) {
    const month = months[shortMatch[2]];
    if (month !== undefined) {
      const d = new Date(now.getFullYear(), month, parseInt(shortMatch[1]),
        parseInt(shortMatch[3]), parseInt(shortMatch[4]));
      return d.toISOString();
    }
  }

  return null;
}

/**
 * Полный парсинг страницы объявления CIAN
 */
export async function parseCianAd(tabId: number): Promise<ParseResult> {
  try {
    const rawData = await injectScript(tabId, parseCianDetailPage);
    if (!rawData) {
      return { status: 'error', price: null, price_per_meter: null, photos: [], price_history: [], seller_name: null, seller_type: null, updated: null, error: 'no_data' };
    }

    // Обработка ошибок
    const bodyText = await injectScript(tabId, () => document.body?.innerText?.substring(0, 500) || '');
    if (bodyText?.includes('капч') || bodyText?.includes('captcha')) {
      return { status: 'error', price: null, price_per_meter: null, photos: [], price_history: [], seller_name: null, seller_type: null, updated: null, error: 'captcha' };
    }
    if (bodyText?.includes('не найдено') || document.title.includes('404')) {
      return { status: 'archived', price: null, price_per_meter: null, photos: [], price_history: [], seller_name: null, seller_type: null, updated: null };
    }

    // Парсинг даты обновления
    let updated: string | null = null;
    if (rawData.updatedDateText) {
      updated = parseRuDate(rawData.updatedDateText);
    }

    // Конвертация истории цен
    const price_history: PriceHistoryItem[] = (rawData.priceHistory || []).map((h: any) => ({
      date: parseRuDate(h.date) || h.date,
      price: h.price,
    }));

    return {
      status: rawData.status || 'active',
      price: rawData.price || null,
      price_per_meter: null,
      photos: rawData.photos || [],
      price_history,
      seller_name: null,
      seller_type: null,
      updated,
    };
  } catch (err) {
    return {
      status: 'error',
      price: null,
      price_per_meter: null,
      photos: [],
      price_history: [],
      seller_name: null,
      seller_type: null,
      updated: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
