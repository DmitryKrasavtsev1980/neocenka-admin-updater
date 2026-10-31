/**
 * Проверка входа в аккаунт площадки по cookie.
 *
 * Avito: cookie `auth` на .avito.ru есть только у залогиненной сессии.
 * Проверяем cookie, а не HTML: при ip_block страница отдаёт
 * «Доступ ограничен: проблема с IP», и по ней вход не определить.
 *
 * 'unknown' — проверить не удалось (нет разрешения cookies / не avito):
 * ведём себя как раньше, ничего не меняем.
 */
export async function checkSourceLogin(source: string): Promise<'in' | 'out' | 'unknown'> {
  if (source !== 'avito') return 'unknown';
  try {
    const cookie = await chrome.cookies.get({ url: 'https://www.avito.ru/', name: 'auth' });
    return cookie?.value ? 'in' : 'out';
  } catch {
    return 'unknown';
  }
}
