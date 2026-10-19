/**
 * Popup — статус воркера + старт/стоп.
 * Настройки приходят с сервера (heartbeat → config), здесь только просмотр.
 */

const startBtn = document.getElementById('startBtn') as HTMLButtonElement;
const stopBtn = document.getElementById('stopBtn') as HTMLButtonElement;
const statusDot = document.getElementById('statusDot')!;
const statusText = document.getElementById('statusText')!;
const processedEl = document.getElementById('processed')!;
const matchedEl = document.getElementById('matched')!;
const errorsEl = document.getElementById('errors')!;
const logEl = document.getElementById('log')!;

// Элементы конфига
const cfgSource = document.getElementById('cfgSource')!;
const cfgModem = document.getElementById('cfgModem')!;
const cfgStreams = document.getElementById('cfgStreams')!;
const cfgTasks = document.getElementById('cfgTasks')!;
const cfgBatch = document.getElementById('cfgBatch')!;
const cfgPoll = document.getElementById('cfgPoll')!;
const cfgAuto = document.getElementById('cfgAuto')!;

// Потоки актуализации человеческими словами
const STREAM_LABELS: Record<string, string> = {
  maintain: 'Поддержание',
  deep: 'Новая область',
  bulk: 'Сплошная по базе',
};

function formatStreams(mix?: Record<string, number>) {
  if (!mix || Object.keys(mix).length === 0) return '—';
  return Object.entries(mix)
    .filter(([, n]) => n > 0)
    .map(([key, n]) => `${STREAM_LABELS[key] ?? key} ${n}`)
    .join(' · ');
}

function addLog(message: string, type: 'info' | 'error' | 'success' = 'info') {
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  logEl.appendChild(entry);
  logEl.scrollTop = logEl.scrollHeight;
}

function updateUI(stats: {
  isRunning: boolean;
  processed: number;
  matched: number;
  errors: number;
  streamMix?: Record<string, number>;
  taskNames?: string[];
}) {
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

function updateConfigInfo(settings: any) {
  if (!settings) return;
  cfgSource.textContent = settings.source === 'cian' ? 'CIAN' : 'Avito';
  cfgModem.textContent = settings.modemSlot ? `Слот ${settings.modemSlot}` : '—';
  cfgBatch.textContent = String(settings.batchSize ?? '—');
  cfgPoll.textContent = `${settings.pollIntervalSec ?? '—'} с`;
  cfgAuto.textContent = settings.autoEnqueue ? 'да' : 'нет';
}

// Загрузка настроек (просмотр)
chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (settings) => {
  updateConfigInfo(settings);
});

// Проверка статуса при открытии
chrome.runtime.sendMessage({ type: 'STATUS' }, (stats) => {
  if (stats) updateUI(stats);
});

// Запуск — настройки уже на сервере, просто стартуем
startBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (settings) => {
    chrome.runtime.sendMessage({ type: 'START', source: settings?.source || 'avito' }, (result) => {
      if (result?.error) {
        addLog(`Ошибка: ${result.error}`, 'error');
      } else {
        addLog('Запущен', 'success');
        updateUI({ isRunning: true, processed: 0, matched: 0, errors: 0 });
      }
    });
  });
});

// Остановка
stopBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'STOP' }, () => {
    addLog('Остановлен', 'info');
    updateUI({ isRunning: false, processed: 0, matched: 0, errors: 0 });
  });
});

// Слушаем обновления прогресса
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

console.log('[Updater] Popup loaded');
