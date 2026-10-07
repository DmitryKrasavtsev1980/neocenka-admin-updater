/**
 * Клиент Huawei HiLink (E3372) — смена IP через веб-интерфейс модема.
 *
 * Когда площадка банит IP (cian_waf_block, «Доступ ограничен: проблема с IP»),
 * один способ восстановиться — перевыпустить PDP-контекст: мобильный оператор
 * (MegaFon) при этом выдаёт новый внешний адрес.
 *
 * Два способа, от быстрого к радикальному:
 *   - 'dataswitch' — выкл/вкл передачу данных (API /api/dialup/mobile-dataswitch),
 *     ~30–40 с, прошивка переподключается и получает новый IP;
 *   - 'reboot' — перезагрузка модема (API /api/device/control, Control=1),
 *     ~60–90 с, тот же эффект, но дольше.
 *
 * Авторизация веб-интерфейса для этих методов не нужна — работает «из коробки»
 * на дефолтном E3372. Нужны только cookie SessionID и токен из <meta csrf_token>:
 * без них API отвечает 125003 (token mismatch).
 */

export interface ModemSettings {
  /** Адрес веб-интерфейса модема */
  host: string;
  /** Включить авто-смену IP при бане */
  enabled: boolean;
  /** Что делать: перевыпустить соединение или перезагрузить модем */
  method: 'dataswitch' | 'reboot';
}

export const DEFAULT_MODEM_SETTINGS: ModemSettings = {
  host: 'http://192.168.8.1',
  enabled: true,
  method: 'dataswitch',
};

export interface RotateResult {
  ok: boolean;
  oldIp?: string;
  newIp?: string;
  method: string;
  error?: string;
}

export class ModemClient {
  constructor(private settings: ModemSettings = DEFAULT_MODEM_SETTINGS) {}

  private get host(): string {
    return (this.settings.host || DEFAULT_MODEM_SETTINGS.host).replace(/\/+$/, '');
  }

  /**
   * Поднять сессию: GET / отдаёт cookie SessionID и <meta csrf_token>.
   * Токен нужен как заголовок __RequestVerificationToken на всех POST.
   */
  private async session(): Promise<string> {
    const res = await fetch(`${this.host}/`, { credentials: 'include' });
    if (!res.ok) throw new Error(`modem http ${res.status}`);
    const html = await res.text();
    const token = html.match(/csrf_token"\s+content="([^"]+)"/)?.[1];
    if (!token) throw new Error('modem: no csrf token in page');
    return token;
  }

  private async post(path: string, xml: string, token: string): Promise<string> {
    const res = await fetch(`${this.host}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'text/xml',
        '__RequestVerificationToken': token,
      },
      body: xml,
    });
    return await res.text();
  }

  /** WAN-адрес из самого модема (не завязываемся на внешние сервисы) */
  async getWanIp(): Promise<string | null> {
    try {
      const res = await fetch(`${this.host}/api/monitoring/status`, { credentials: 'include' });
      const text = await res.text();
      const ip = text.match(/<WanIPAddress>([^<]+)<\/WanIPAddress>/)?.[1];
      return ip && ip !== '0.0.0.0' ? ip : null;
    } catch {
      return null;
    }
  }

  /** Внешний IP снаружи (через ipify) — когда модем его не отдаёт */
  private async getPublicIp(): Promise<string | null> {
    try {
      const res = await fetch('https://api.ipify.org?format=json');
      const data = await res.json();
      return data?.ip || null;
    } catch {
      return null;
    }
  }

  async getIp(): Promise<string | null> {
    return (await this.getWanIp()) ?? (await this.getPublicIp());
  }

  /**
   * Сменить внешний IP.
   *
   * Если настроен быстрый 'dataswitch', но оператор отдал тот же адрес
   * (ip_unchanged) — автоматически эскалируем на 'reboot': тот же результат,
   * но гарантированно новый IP (проверено на MegaFon, 05.10.2026).
   */
  async rotateIp(): Promise<RotateResult> {
    const method = this.settings.method || 'dataswitch';

    const result = await this.rotateOnce(method);
    if (result.ok || method === 'reboot' || result.error !== 'ip_unchanged') {
      return result;
    }

    console.warn(`[Modem] ${method} left IP=${result.newIp ?? '?'} — escalating to reboot`);
    return await this.rotateOnce('reboot');
  }

  private async rotateOnce(method: 'dataswitch' | 'reboot'): Promise<RotateResult> {
    const oldIp = await this.getIp();
    console.log(`[Modem] Rotating IP via ${method}, current=${oldIp ?? '?'}`);

    try {
      const token = await this.session();

      if (method === 'reboot') {
        await this.post('/api/device/control', '<request><Control>1</Control></request>', token);
        // модем перезагружается — ждём, пока веб-интерфейс вернётся
        await this.waitHostUp(120_000);
      } else {
        // выкл → пауза → вкл: перевыпуск PDP-контекста
        await this.post('/api/dialup/mobile-dataswitch', '<request><dataswitch>0</dataswitch></request>', token);
        await this.sleep(12_000);
        const token2 = await this.session();
        await this.post('/api/dialup/mobile-dataswitch', '<request><dataswitch>1</dataswitch></request>', token2);
      }

      const newIp = await this.waitNewIp(oldIp, 90_000);
      const ok = !!newIp && newIp !== oldIp;
      if (!ok) {
        return { ok: false, oldIp: oldIp ?? undefined, newIp: newIp ?? undefined, method, error: 'ip_unchanged' };
      }
      console.log(`[Modem] IP rotated: ${oldIp} -> ${newIp}`);
      return { ok: true, oldIp: oldIp!, newIp, method };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Modem] rotate failed:', msg);
      return { ok: false, oldIp: oldIp ?? undefined, method, error: msg };
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** Дождаться, пока веб-интерфейс модема снова начнёт отвечать */
  private async waitHostUp(timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await fetch(`${this.host}/`, { credentials: 'include' });
        if (res.ok) return true;
      } catch {
        /* ещё не поднялся */
      }
      await this.sleep(3000);
    }
    return false;
  }

  /** Дождаться нового внешнего IP (или истечения таймаута) */
  private async waitNewIp(oldIp: string | null, timeoutMs: number): Promise<string | null> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await this.sleep(5000);
      const ip = await this.getIp();
      if (ip && ip !== oldIp) return ip;
    }
    return await this.getIp();
  }
}
