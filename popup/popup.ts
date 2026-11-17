/**
 * Popup — пульт воркера: маршрутизация (безопасность «кто куда ходит»),
 * настройки (сайт × модем) с сохранением на лету, старт/стоп.
 *
 * Сайт/слот/helper хранятся в chrome.storage.local.settings — те же поля
 * пишет apply-topology.js, но руками их теперь можно менять прямо здесь.
 */

interface SlotMeta {
  operator: string;
  helperPort: number;
  proxyPort: number;
}

// Штатная раскладка слотов (см. admin-updater/tools/modem-topology.json).
// Имена профилей Chrome исторические — верить именно слотам.
const SLOT_META: Record<string, SlotMeta> = {
  A: { operator: 'билайн', helperPort: 8891, proxyPort: 8881 },
  B: { operator: 'MegaFon', helperPort: 8892, proxyPort: 8882 },
  C: { operator: 'Tele2', helperPort: 8893, proxyPort: 8883 },
};

// --- элементы UI ---
const startBtn = document.getElementById('startBtn') as HTMLButtonElement;
const stopBtn = document.getElementById('stopBtn') as HTMLButtonElement;
const saveBtn = document.getElementById('saveBtn') as HTMLButtonElement;
const probeBtn = document.getElementById('probeBtn') as HTMLButtonElement;
const statusDot = document.getElementById('statusDot')!;
const statusText = document.getElementById('statusText')!;
const processedEl = document.getElementById('processed')!;
const matchedEl = document.getElementById('matched')!;
const errorsEl = document.getElementById('errors')!;
const logEl = document.getElementById('log')!;

const routeChain = document.getElementById('routeChain')!;
const modemLan = document.getElementById('modemLan')!;
const modemIp = document.getElementById('modemIp')!;
const modemHelper = document.getElementById('modemHelper')!;

const selSource = document.getElementById('selSource') as HTMLSelectElement;
const selModem = document.getElementById('selModem') as HTMLSelectElement;
const inpModemHost = document.getElementById('inpModemHost') as HTMLInputElement;

const cfgStreams = document.getElementById('cfgStreams')!;
const cfgTasks = document.getElementById('cfgTasks')!;
const cfgBatch = document.getElementById('cfgBatch')!;
const cfgPoll = document.getElementById('cfgPoll')!;
const cfgAuto = document.getElementById('cfgAuto')!;

let isRunning = false;

const STREAM_LABELS: Record<string, string> = {
  maintain: 'Поддержание',
  deep: 'Новая область',
  bulk: 'Сплошная по базе',
};

function send<T = any>(message: Record<string, unknown>): Promise<T> {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, (r) => resolve(r as T)));
}

function addLog(message: string, type: 'info' | 'error' | 'success' = 'info') {
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  logEl.appendChild(entry);
  logEl.scrollTop = logEl.scrollHeight;
}

function formatStreams(mix?: Record<string, number>) {
  if (!mix || Object.keys(mix).length === 0) return '—';
  return Object.entries(mix)
    .filter(([, n]) => n > 0)
    .map(([key, n]) => `${STREAM_LABELS[key] ?? key} ${n}`)
    .join(' · ');
}

function updateUI(stats: {
  isRunning: boolean;
  processed: number;
  matched: number;
  errors: number;
  streamMix?: Record<string, number>;
  taskNames?: string[];
}) {
  isRunning = stats.isRunning;
  statusDot.className = `status-dot ${stats.isRunning ? 'running' : ''}`;
  statusText.textContent = stats.isRunning ? 'Работает...' : 'Остановлен';
  processedEl.textContent = String(stats.processed);
  matchedEl.textContent = String(stats.matched);
  errorsEl.textContent = String(stats.errors);
  startBtn.disabled = stats.isRunning;
  stopBtn.disabled = !stats.isRunning;

  cfgStreams.textContent = formatStreams(stats.streamMix);
  cfgTasks.textContent = stats.taskNames && stats.taskNames.length > 0
    ? stats.taskNames.join('; ')
    : '—';
}

function updateServerConfig(settings: any) {
  if (!settings) return;
  cfgBatch.textContent = String(settings.batchSize ?? '—');
  cfgPoll.textContent = `${settings.pollIntervalSec ?? '—'} с`;
  cfgAuto.textContent = settings.autoEnqueue ? 'да' : 'нет';
}

// --- маршрутизация ---

/** Определяет слот по адресу proxy этого Chrome (8881/8882/8883 → A/B/C) */
function slotFromProxyAddress(hostPort: string): string | null {
  const m = hostPort.match(/:(\d{4})$/);
  if (!m) return null;
  for (const [slot, meta] of Object.entries(SLOT_META)) {
    if (meta.proxyPort === Number(m[1])) return slot;
  }
  return null;
}

/** Реальный proxy этого Chrome (флаг --proxy-server) */
async function getProxyAddress(): Promise<string> {
  const proxyApi = (chrome as any).proxy;
  if (!proxyApi?.settings?.get) return '—';
  return new Promise((resolve) => {
    proxyApi.settings.get({}, (cfg: any) => {
      const v = cfg?.value ?? {};
      const sp = v.rules?.singleProxy || v.rules?.proxyForHttp || v.rules?.proxyForHttps;
      resolve(sp ? `${sp.host}:${sp.port}` : v.mode || '—');
    });
  });
}

interface HelperStatus {
  ok: boolean;
  slot?: string;
  iface?: string;
  lastRotateAt?: string | null;
  lastError?: string | null;
  /** Публичный IP модема (probe из helper'а), может отсутствовать в старых версиях */
  internetIp?: string | null;
  internetOk?: boolean;
}

async function fetchHelperStatus(port: number): Promise<HelperStatus | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/status`, {
      signal: AbortSignal.timeout(5000),
    });
    return (await r.json()) as HelperStatus;
  } catch {
    return null;
  }
}

/** Статус выхода в интернет: ipify через proxy ЭТОГО Chrome (т.е. через его модем) */
async function probeOwnInternet(): Promise<string> {
  try {
    const r = await fetch('https://api.ipify.org?format=json', {
      signal: AbortSignal.timeout(12000),
    });
    const text = await r.text();
    try {
      const d = JSON.parse(text);
      return d.ip || 'неизвестный ответ';
    } catch {
      // Не JSON — скорее всего портал оператора (кончился баланс / captive)
      return '⚠️ вместо интернета — портал оператора (проверь баланс SIM)';
    }
  } catch {
    return '❌ нет выхода в интернет через этот модем';
  }
}

function renderChain(proxyAddr: string, slot: string | null, internet: string | null) {
  const meta = slot ? SLOT_META[slot] : null;
  const site = selSource.value === 'cian' ? 'cian.ru' : 'avito.ru';
  const slotPart = meta
    ? `слот ${slot} (${meta.operator})`
    : `слот ? (настрой слот)`;
  routeChain.textContent = `Chrome → proxy ${proxyAddr} → ${slotPart} → ${site}`;
  modemHelper.textContent = meta
    ? `127.0.0.1:${meta.helperPort}${inpModemHost.value ? ' (' + inpModemHost.value + ')' : ''}`
    : '—';
  if (internet !== null) modemIp.textContent = internet;
}

async function probeRouting() {
  const slot = selModem.value;
  const meta = SLOT_META[slot];
  modemIp.textContent = 'проверяю…';
  modemLan.textContent = 'проверяю…';

  const helper = await fetchHelperStatus(meta.helperPort);
  if (helper && helper.ok) {
    modemLan.textContent = `слот ${slot} (${meta.operator}), LAN ${helper.iface ?? '?'}`;
    if (helper.internetIp) {
      modemIp.textContent = helper.internetOk
        ? `${helper.internetIp}`
        : `⚠️ ${helper.internetIp} — похоже, не интернет`;
    }
  } else {
    modemLan.textContent = `helper ${meta.helperPort} недоступен`;
  }

  // Своя проверка через proxy — источник истины для этого браузера
  const internet = await probeOwnInternet();
  modemIp.textContent = internet;

  // Статусы всех слотов (по helper'ам: жив/мёртв)
  await renderSlotChips();
}

/** Плашки слотов A/B/C: helper жив? интернет модема виден? */
async function renderSlotChips() {
  let html = '<div class="slot-chips">';
  for (const [slot, meta] of Object.entries(SLOT_META)) {
    const st = await fetchHelperStatus(meta.helperPort);
    let cls = 'chip-down';
    let label = 'нет связи';
    if (st?.ok) {
      if (st.internetOk === true) {
        cls = 'chip-ok';
        label = st.internetIp ?? 'интернет есть';
      } else if (st.internetOk === false) {
        cls = 'chip-warn';
        label = 'без интернета';
      } else {
        cls = 'chip-warn';
        label = 'жив, интернет не проверен';
      }
    }
    html += `<div class="slot-chip ${cls}"><b>${slot}</b> ${meta.operator}<br><small>${label}</small></div>`;
  }
  html += '</div>';
  const holder = document.getElementById('slotChips');
  if (holder) holder.innerHTML = html;
}

// --- настройки ---

function deriveHelperUrl(slot: string): string {
  return `http://127.0.0.1:${SLOT_META[slot]?.helperPort ?? 8891}`;
}

async function loadForm() {
  const settings = await send({ type: 'GET_SETTINGS' });
  if (settings) {
    selSource.value = settings.source === 'cian' ? 'cian' : 'avito';
    if (settings.modemSlot && SLOT_META[settings.modemSlot]) {
      selModem.value = settings.modemSlot;
    }
    inpModemHost.value = settings.modemHost || deriveHelperUrl(selModem.value);
    updateServerConfig(settings);
  }
  const proxyAddr = await getProxyAddress();
  const proxySlot = slotFromProxyAddress(proxyAddr);
  if (proxySlot && proxySlot !== selModem.value) {
    addLog(`Внимание: proxy этого Chrome (${proxyAddr}) = слот ${proxySlot}, а в настройках — ${selModem.value}`, 'error');
  }
  renderChain(proxyAddr, selModem.value, null);
  probeRouting();
}

saveBtn.addEventListener('click', async () => {
  const source = selSource.value === 'cian' ? 'cian' : 'avito';
  const slot = selModem.value;
  const modemHost = inpModemHost.value.trim() || deriveHelperUrl(slot);
  inpModemHost.value = modemHost;

  await send({
    type: 'SAVE_SETTINGS',
    settings: { source, modemSlot: slot, modemHost, sourcePinned: true, modemEnabled: true },
  });
  addLog(`Сохранено: ${source === 'cian' ? 'CIAN' : 'Avito'} × слот ${slot}`, 'success');

  const proxyAddr = await getProxyAddress();
  renderChain(proxyAddr, slot, null);

  // Настройки применяются к работающему воркеру сразу — перезапуск
  if (isRunning) {
    addLog('Перезапускаю воркер с новыми настройками…');
    await send({ type: 'STOP' });
    await send({ type: 'START', source });
    addLog('Воркер перезапущен', 'success');
  }
});

selModem.addEventListener('change', async () => {
  inpModemHost.value = deriveHelperUrl(selModem.value);
  const proxyAddr = await getProxyAddress();
  renderChain(proxyAddr, selModem.value, null);
  probeRouting();
});

selSource.addEventListener('change', async () => {
  const proxyAddr = await getProxyAddress();
  renderChain(proxyAddr, selModem.value, null);
});

probeBtn.addEventListener('click', () => {
  addLog('Проверяю маршрут…');
  probeRouting().then(() => addLog('Проверка завершена', 'success'));
});

// --- старт/стоп ---

startBtn.addEventListener('click', async () => {
  const source = selSource.value === 'cian' ? 'cian' : 'avito';
  const result = await send({ type: 'START', source });
  if (result?.error) {
    addLog(`Ошибка: ${result.error}`, 'error');
  } else {
    addLog(`Запущен: ${source === 'cian' ? 'CIAN' : 'Avito'} × слот ${selModem.value}`, 'success');
    updateUI({ isRunning: true, processed: 0, matched: 0, errors: 0 });
  }
});

stopBtn.addEventListener('click', async () => {
  await send({ type: 'STOP' });
  addLog('Остановлен', 'info');
  updateUI({ isRunning: false, processed: 0, matched: 0, errors: 0 });
});

// --- обновления от воркера ---

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'PROGRESS') {
    updateUI({
      isRunning: true,
      processed: message.processed,
      matched: message.matched,
      errors: message.errors,
      streamMix: message.streamMix,
      taskNames: message.taskNames,
    });
  }
  if (message.type === 'COMPLETED') {
    updateUI({
      isRunning: false,
      processed: message.processed,
      matched: message.matched,
      errors: message.errors,
      streamMix: message.streamMix,
      taskNames: message.taskNames,
    });
    addLog(`Завершено: ${message.processed} обработано, ${message.matched} обновлено`, 'success');
  }
});

// --- инициализация ---

send({ type: 'STATUS' }).then((stats) => {
  if (stats) updateUI(stats);
});
loadForm();

console.log('[Updater] Popup loaded');
