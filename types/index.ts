/**
 * Типы для standalone-расширения обновления объявлений
 */

// Источник: как в настройках UI
export type SourceKey = 'avito' | 'cian';

// Источник: как его ждёт сервер в update_tasks.source
export type SourceDomain = 'avito.ru' | 'cian.ru';

/** Одна строка ответа POST /api/update/claim */
export interface ClaimedAd {
  queue_id: number;
  id: number;
  url: string;
  price: number | null;
  status: string;
  photos: string[] | null;
  price_history: PriceHistoryItem[] | null;
  source: string | null;
  parsed_at: string | null;
}

// Результат быстрой проверки (фаза CHECK)
export interface CheckResult {
  status: 'active' | 'archived' | 'error';
  price: number | null;
  priceChanged: boolean;
  statusChanged: boolean;
  error?: string;
}

// Результат полного парсинга (фаза PARSE)
export interface ParseResult {
  status: 'active' | 'archived' | 'error';
  price: number | null;
  price_per_meter: number | null;
  photos: string[];
  price_history: PriceHistoryItem[];
  seller_name: string | null;
  seller_type: string | null;
  /**
   * Дата изменения объявления на площадке (не время нашего парсинга).
   * На сервере — колонка ads.updated, НЕ ads.updated_at (это Laravel-
   * таймстамп правки строки).
   */
  updated: string | null;
  error?: string;
}

// Запись истории цен
export interface PriceHistoryItem {
  date: string;
  price?: number;
  old_price?: number;
  new_price?: number;
}

// Данные для POST /api/update/complete/{queue_id} (без browser_id)
export interface AdUpdateData {
  price?: number;
  price_per_meter?: number;
  status?: string;
  photos?: string[];
  price_history?: PriceHistoryItem[];
  seller_name?: string;
  seller_type?: string;
  source_metadata?: Record<string, unknown>;
  updated?: string;
}

// Задача на обновление (POST /api/update/tasks → task)
export interface UpdateTaskDto {
  id: number;
  name: string;
  source: string | null;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  total: number;
  matched: number;
  processed: number;
  failed_count: number;
}

// Статус задачи (GET /api/update/tasks/{id})
export interface UpdateTaskStatus extends UpdateTaskDto {
  stats: {
    total: number;
    processed: number;
    failed_count: number;
    remaining: number;
  };
}

// Сводка по очереди (GET /api/update/queue-stats)
export interface QueueStats {
  counts: { pending: number; claimed: number; done: number; failed: number };
  workers: { browser_id: string; holding: number; lease_until: string | null }[];
  expired_claims: number;
  tasks: { processing: number; completed: number; failed: number };
}

// Состояние расширения
export interface ExtensionState {
  isRunning: boolean;
  source: SourceKey | null;
  processed: number;
  matched: number;
  errors: number;
  lastPollAt: string | null;
  currentBatch: ClaimedAd[];
}

// Настройки
export interface Settings {
  apiUrl: string;
  source: SourceKey;
  pollIntervalSec: number;
  /** Порция за один claim (сервер жмёт до 100) */
  batchSize: number;
  checkDelayMs: number;
  parseDelayMs: number;
  /** Задавать задачу «обновить всё», если очередь пуста */
  autoEnqueue: boolean;
  /** Адрес веб-интерфейса модема для смены IP при бане */
  modemHost: string;
  /** Сменять IP через модем, когда площадка банит */
  modemEnabled: boolean;
  /** 'dataswitch' — перевыпуск соединения (~30 с), 'reboot' — перезагрузка модема (~90 с) */
  modemMethod: 'dataswitch' | 'reboot';
}

/** Устойчивый id этого воркера — для аренды строк в update_queue */
export interface WorkerIdentity {
  browserId: string;
}

/**
 * Глобальный лок на смену IP (app_locks, ключ 'ip_rotate').
 * Модем один, внешний адрес один на всех воркеров — крутить его может только
 * кто-то один, остальные в это время простаивают.
 */
export interface IpLockState {
  name: string;
  holder: string | null;
  expires_at: string | null;
  /** Держит ли кто-нибудь лок прямо сейчас (и не протух ли он) */
  held: boolean;
  /** Наш ли это лок (в ответе acquire при успехе) */
  held_by_me?: boolean;
  ttl_seconds: number;
}
