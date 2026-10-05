/**
 * Popup script для расширения обновления
 */

const startBtn = document.getElementById('startBtn') as HTMLButtonElement;
const stopBtn = document.getElementById('stopBtn') as HTMLButtonElement;
const statusDot = document.getElementById('statusDot')!;
const statusText = document.getElementById('statusText')!;
const processedEl = document.getElementById('processed')!;
const matchedEl = document.getElementById('matched')!;
const errorsEl = document.getElementById('errors')!;
const sourceSelect = document.getElementById('source') as HTMLSelectElement;
const pollIntervalInput = document.getElementById('pollInterval') as HTMLInputElement;
const batchSizeInput = document.getElementById('batchSize') as HTMLInputElement;
const autoEnqueueInput = document.getElementById('autoEnqueue') as HTMLInputElement;
const logEl = document.getElementById('log')!;

function addLog(message: string, type: 'info' | 'error' | 'success' = 'info') {
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  logEl.appendChild(entry);
  logEl.scrollTop = logEl.scrollHeight;
}

function updateUI(stats: { isRunning: boolean; processed: number; matched: number; errors: number }) {
  statusDot.className = `status-dot ${stats.isRunning ? 'running' : ''}`;
  statusText.textContent = stats.isRunning ? 'Работает...' : 'Остановлен';
  processedEl.textContent = String(stats.processed);
  matchedEl.textContent = String(stats.matched);
  errorsEl.textContent = String(stats.errors);
  startBtn.disabled = stats.isRunning;
  stopBtn.disabled = !stats.isRunning;
}

// Загрузка настроек
chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (settings) => {
  if (settings) {
    sourceSelect.value = settings.source || 'avito';
    pollIntervalInput.value = String(settings.pollIntervalSec || 60);
    batchSizeInput.value = String(settings.batchSize || 50);
    autoEnqueueInput.checked = settings.autoEnqueue !== false;
  }
});

// Проверка статуса при открытии
chrome.runtime.sendMessage({ type: 'STATUS' }, (stats) => {
  if (stats) updateUI(stats);
});

// Запуск
startBtn.addEventListener('click', () => {
  const batch = Math.min(100, Math.max(1, parseInt(batchSizeInput.value) || 50));
  batchSizeInput.value = String(batch);

  const settings = {
    source: sourceSelect.value as 'avito' | 'cian',
    pollIntervalSec: Math.min(300, Math.max(10, parseInt(pollIntervalInput.value) || 60)),
    batchSize: batch,
    autoEnqueue: autoEnqueueInput.checked,
  };

  chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings }, () => {
    chrome.runtime.sendMessage({ type: 'START', source: settings.source }, (result) => {
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
    });
  }
  if (message.type === 'COMPLETED') {
    updateUI({
      isRunning: false,
      processed: message.processed,
      matched: message.matched,
      errors: message.errors,
    });
    addLog(`Завершено: ${message.processed} обработано, ${message.matched} обновлено`, 'success');
  }
});

console.log('[Updater] Popup loaded');
