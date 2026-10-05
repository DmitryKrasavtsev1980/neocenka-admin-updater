/**
 * Быстрая проверка объявления CIAN через fetch HTML
 */

import type { CheckResult } from '../types';

export async function checkCianAdHtml(url: string): Promise<CheckResult> {
  try {
    const response = await fetch(url, { credentials: 'include' });

    if (response.status === 404 || response.status === 410) {
      return { status: 'archived', price: null, priceChanged: false, statusChanged: true };
    }

    // Редирект — проверяем ID
    if (response.url !== url) {
      const origId = url.match(/\/(\d{7,})/)?.[1];
      const newId = response.url.match(/\/(\d{7,})/)?.[1];
      if (origId && newId && origId !== newId) {
        return { status: 'archived', price: null, priceChanged: false, statusChanged: true };
      }
    }

    const html = await response.text();

    // Проверка на снятое объявление
    if (html.includes('OfferUnpublished') || html.includes('снято с публикации')) {
      return { status: 'archived', price: null, priceChanged: false, statusChanged: true };
    }

    // Извлечение цены из JSON-LD
    let price: number | null = null;
    const ldMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/);
    if (ldMatch) {
      try {
        const ld = JSON.parse(ldMatch[1]);
        if (ld.offers?.price) {
          price = Number(ld.offers.price);
        }
      } catch { /* ignore */ }
    }

    // Fallback: regex по цене
    if (price === null) {
      const priceMatch = html.match(/"price"\s*:\s*(\d{5,})/);
      if (priceMatch) {
        price = parseInt(priceMatch[1], 10);
      }
    }

    return {
      status: 'active',
      price,
      priceChanged: false,
      statusChanged: false,
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
