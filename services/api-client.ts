/**
 * HTTP-клиент для общения с data-server API
 *
 * Работает поверх очереди update_queue:
 *   claim → complete/release (+ heartbeat)
 * Аренда строки — 10 минут, три неудачные попытки → status=failed.
 */

import type {
  ClaimedAd,
  AdUpdateData,
  QueueStats,
  SourceDomain,
  UpdateTaskDto,
  UpdateTaskStatus,
} from '../types';

// data-server региона (HTTPS + домен — иначе fetch уходит в блок по host_permissions)
const DEFAULT_API_URL = 'https://54.neocenka.ru/api';

class ApiClient {
  private baseUrl: string;

  constructor(baseUrl: string = DEFAULT_API_URL) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  setBaseUrl(url: string) {
    this.baseUrl = url.replace(/\/$/, '');
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
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
   */
  async createTask(params: {
    name?: string;
    source?: SourceDomain;
    filter_data?: Record<string, unknown>;
    saved_filter_id?: number;
  }): Promise<{ success: boolean; task: UpdateTaskDto; ads_found: number }> {
    return this.request('/update/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
  }

  async listTasks(): Promise<{ data: UpdateTaskDto[] }> {
    return this.request('/update/tasks');
  }

  async getTaskStatus(id: number): Promise<{ task: UpdateTaskStatus }> {
    return this.request(`/update/tasks/${id}`);
  }

  async deleteTask(id: number): Promise<{ success: boolean }> {
    return this.request(`/update/tasks/${id}`, { method: 'DELETE' });
  }

  // ─── Очередь воркера ──────────────────────────────────────

  /**
   * Взять порцию объявлений в аренду (10 минут).
   * source: 'avito.ru' | 'cian.ru'; null/'' — не фильтровать.
   */
  async claim(
    browserId: string,
    source: SourceDomain | null,
    limit: number
  ): Promise<ClaimedAd[]> {
    const data = await this.request<{ data: ClaimedAd[] }>('/update/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        browser_id: browserId,
        source: source ?? undefined,
        limit: Math.min(Math.max(limit, 1), 100),
      }),
    });
    return data.data || [];
  }

  /**
   * Отметить строку очереди обработанной и записать данные в ads.
   * id — это queue_id, НЕ ad.id.
   */
  async complete(
    queueId: number,
    browserId: string,
    data: AdUpdateData
  ): Promise<{ success: boolean; ad_id: number }> {
    return this.request(`/update/complete/${queueId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ browser_id: browserId, ...data }),
    });
  }

  /**
   * Вернуть строку в очередь (ошибка парсинга). После 3 попыток — failed.
   */
  async release(
    queueId: number,
    browserId: string,
    error?: string
  ): Promise<{ success: boolean }> {
    return this.request(`/update/release/${queueId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ browser_id: browserId, error }),
    });
  }

  /**
   * Пульс воркера: продлевает аренду строк, которые он ещё держит,
   * и отчитывается по счётчикам. queue_ids обязательны для длинного парсинга —
   * иначе через 10 минут строку отберёт сосед.
   */
  async heartbeat(
    browserId: string,
    source: SourceDomain | null,
    stats: { processed: number; matched: number; errors: number },
    queueIds: number[] = []
  ): Promise<{ success: boolean; extended: number }> {
    return this.request('/update/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        browser_id: browserId,
        source: source ?? undefined,
        queue_ids: queueIds,
        ...stats,
      }),
    });
  }

  /** Сводка по очереди: счётчики, кто держит аренды, протухшие */
  async getQueueStats(): Promise<QueueStats> {
    const data = await this.request<{ data: QueueStats }>('/update/queue-stats');
    return data.data;
  }

  /** Проверить доступность API */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }
}

export const apiClient = new ApiClient();
