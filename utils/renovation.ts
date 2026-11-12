/**
 * MVP-4 (admin#37): тип ремонта/отделки с площадки → renovation_type.
 *
 * Источники:
 *  - Avito: hydration, блок «О квартире» → {"title":"Отделка"|"Тип ремонта", "description": "..."}
 *  - Cian: DOM-фактойды [data-name="ObjectFactoidsItem"] («Отделка» → «Предчистовая»)
 *          или inline JSON "decoration":"preFine" (enum).
 *
 * Маппинг в enum ads.renovation_type:
 *  without ← без отделки / без ремонта / предчистовая / черновая
 *  cosmetic ← косметический / чистовая / под ключ
 *  designer ← дизайнерский
 *  euro ← евро / евроремонт
 * Неизвестное значение → null (сырое кладём в source_metadata.renovation_raw).
 */

export type RenovationType = 'without' | 'cosmetic' | 'designer' | 'euro';

/** Текстовое значение площадки → renovation_type */
export function mapRenovationLabel(raw: string | null | undefined): RenovationType | null {
  if (!raw) return null;
  const s = String(raw).toLowerCase().replace(/ё/g, 'е').trim();
  if (!s) return null;
  if (/без\s*отделк|без\s*ремонт|предчистов|чернов/.test(s)) return 'without';
  if (/космет/.test(s)) return 'cosmetic';
  if (/дизайнер/.test(s)) return 'designer';
  if (/евро/.test(s)) return 'euro';
  if (/чистов|под\s*ключ/.test(s)) return 'cosmetic';
  return null;
}

/** Cian decoration (inline JSON enum) → текстовое значение */
export const CIAN_DECORATION: Record<string, string> = {
  without: 'Без отделки',
  rough: 'Черновая',
  preFine: 'Предчистовая',
  fine: 'Чистовая',
  cosmetic: 'Косметический',
  designer: 'Дизайнерский',
  euro: 'Евро',
};

/** Значение из Cian (DOM-текст или decoration enum) → renovation_type */
export function mapCianRenovation(raw: string | null | undefined): RenovationType | null {
  if (!raw) return null;
  const text = CIAN_DECORATION[raw] ?? raw;
  return mapRenovationLabel(text);
}
