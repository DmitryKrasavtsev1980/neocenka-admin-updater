/**
 * Полный парсер страницы объявления Avito
 * Порт из extension/src/background/service-worker.ts
 */

import type { ParseResult, PriceHistoryItem } from '../types';
import { injectScriptMainWorld } from '../utils/tab-manager';

/**
 * Чтение данных из window.__staticRouterHydrationData (MAIN world)
 */
function readAvitoPageData() {
  try {
    const loaderData = (window as any).__staticRouterHydrationData;
    if (!loaderData) return null;

    const keys = Object.keys(loaderData);
    const key = keys.find(k => k.includes('realty/Detail'));
    if (!key) return null;

    const detail = loaderData[key]?.loaderData?.['realty/Detail'];
    if (!detail) return null;

    const buyerItem = detail.buyerItem;
    if (!buyerItem) return null;

    return {
      buyerItemJson: JSON.stringify(buyerItem),
      url: window.location.href,
      metaPrice: document.querySelector('meta[property="product:price:amount"]')?.getAttribute('content'),
    };
  } catch {
    return null;
  }
}

/**
 * Парсинг hydration data
 */
function parseAvitoHydrationData(buyerItemJson: string, metaPrice: string | null): Omit<ParseResult, 'error'> | null {
  try {
    const buyerItem = JSON.parse(buyerItemJson);
    const item = buyerItem.item;
    if (!item) return null;

    // Статус
    let status: 'active' | 'archived' = 'active';
    if (!item.isActive || item.isClosed || item.isDeleted || item.isExpired) {
      status = 'archived';
    }

    // Цена
    let price: number | null = null;
    if (item.price?.value) {
      price = item.price.value;
    } else if (item.formattedPrice?.string) {
      const priceStr = item.formattedPrice.string.replace(/[^\d]/g, '');
      price = priceStr ? parseInt(priceStr, 10) : null;
    } else if (metaPrice) {
      price = parseInt(metaPrice, 10);
    }

    // Цена за м2
    const price_per_meter = buyerItem.priceData?.normalizedPrice ?? null;

    // Фото
    const photos: string[] = [];
    const media = buyerItem.galleryInfo?.media || [];
    for (const m of media) {
      if (m.images) {
        // Берём максимальный размер
        const sizes = Object.keys(m.images);
        if (sizes.length) {
          const maxSize = sizes.sort((a, b) => {
            const [aw, ah] = a.split('x').map(Number);
            const [bw, bh] = b.split('x').map(Number);
            return (bw * bh) - (aw * ah);
          })[0];
          const url = m.images[maxSize];
          if (url && !photos.includes(url)) {
            photos.push(url);
          }
        }
      }
    }

    // Дата обновления
    let updated: string | null = null;
    if (item.finishTime) {
      updated = new Date(item.finishTime * 1000).toISOString();
    }

    // Продавец
    let seller_name: string | null = null;
    let seller_type: string | null = null;
    if (buyerItem.seller) {
      seller_name = buyerItem.seller.name || null;
      const label = buyerItem.seller.labels?.nominative || '';
      if (label.includes('Собственник')) {
        seller_type = 'owner';
      } else if (label.includes('Риелтор') || label.includes('Агент')) {
        seller_type = 'agent';
      } else if (buyerItem.seller.isCompany) {
        seller_type = 'developer';
      }
    }

    // История цены из hydration data
    const price_history: PriceHistoryItem[] = [];
    if (buyerItem.priceHistory?.records) {
      for (const rec of buyerItem.priceHistory.records) {
        price_history.push({
          date: new Date(rec.date * 1000).toISOString(),
          price: rec.price,
        });
      }
    }

    return {
      status,
      price,
      price_per_meter,
      photos,
      price_history,
      seller_name,
      seller_type,
      updated,
    };
  } catch {
    return null;
  }
}

/**
 * Парсинг русской даты ("вчера, 15:30", "25 мая 2026", etc.)
 */
function parseRuDate(text: string): string | null {
  const months: Record<string, number> = {
    'января': 0, 'февраля': 1, 'марта': 2, 'апреля': 3,
    'мая': 4, 'июня': 5, 'июля': 6, 'августа': 7,
    'сентября': 8, 'октября': 9, 'ноября': 10, 'декабря': 11,
    'янв': 0, 'фев': 1, 'мар': 2, 'апр': 3,
    'май': 4, 'июн': 5, 'июл': 6, 'авг': 7,
    'сен': 8, 'окт': 9, 'ноя': 10, 'дек': 11,
  };

  const lower = text.toLowerCase().trim();
  const now = new Date();

  // "вчера, HH:MM"
  const yesterdayMatch = lower.match(/вчера,?\s*(\d{1,2}):(\d{2})/);
  if (yesterdayMatch) {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    d.setHours(parseInt(yesterdayMatch[1]), parseInt(yesterdayMatch[2]), 0, 0);
    return d.toISOString();
  }

  // "сегодня, HH:MM"
  const todayMatch = lower.match(/сегодня,?\s*(\d{1,2}):(\d{2})/);
  if (todayMatch) {
    const d = new Date(now);
    d.setHours(parseInt(todayMatch[1]), parseInt(todayMatch[2]), 0, 0);
    return d.toISOString();
  }

  // "25 мая 2026" or "25 мая в 09:15"
  const fullMatch = lower.match(/(\d{1,2})\s+(\w+)\s+(\d{4})\s*(?:в\s*(\d{1,2}):(\d{2}))?/);
  if (fullMatch) {
    const month = months[fullMatch[2]];
    if (month !== undefined) {
      const d = new Date(parseInt(fullMatch[3]), month, parseInt(fullMatch[1]));
      if (fullMatch[4]) {
        d.setHours(parseInt(fullMatch[4]), parseInt(fullMatch[5] || '0'), 0, 0);
      }
      return d.toISOString();
    }
  }

  // "27 апр, 10:55"
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
 * Полный парсинг страницы объявления Avito
 */
export async function parseAvitoAd(tabId: number): Promise<ParseResult> {
  try {
    // Инжектируем чтение данных в MAIN world (5 попыток)
    let pageData = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      pageData = await injectScriptMainWorld(tabId, readAvitoPageData);
      if (pageData?.buyerItemJson) break;
      await new Promise(r => setTimeout(r, 3000));
    }

    if (!pageData?.buyerItemJson) {
      // Fallback: проверяем CAPTCHA или 404
      const bodyText = await injectScriptMainWorld(tabId, () => document.body?.innerText?.substring(0, 500) || '');
      if (bodyText?.includes('капч') || bodyText?.includes('captcha')) {
        return { status: 'error', price: null, price_per_meter: null, photos: [], price_history: [], seller_name: null, seller_type: null, updated: null, error: 'captcha' };
      }
      if (bodyText?.includes('не найдено') || bodyText?.includes('закрыто')) {
        return { status: 'archived', price: null, price_per_meter: null, photos: [], price_history: [], seller_name: null, seller_type: null, updated: null };
      }
      return { status: 'error', price: null, price_per_meter: null, photos: [], price_history: [], seller_name: null, seller_type: null, updated: null, error: 'no_data' };
    }

    const parsed = parseAvitoHydrationData(pageData.buyerItemJson, pageData.metaPrice ?? null);
    if (!parsed) {
      return { status: 'error', price: null, price_per_meter: null, photos: [], price_history: [], seller_name: null, seller_type: null, updated: null, error: 'parse_failed' };
    }

    return {
      ...parsed,
      price_history: parsed.price_history || [],
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
