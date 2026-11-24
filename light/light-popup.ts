/**
 * Popup расширения «Лёгкая проверка» (dist-light).
 *
 * Минимальный пульт: статус/прогресс дежурного воркера, старт/стоп,
 * канал модема (proxy-слот переключается на лету — право "proxy").
 */

// Module-скоуп: файл живёт в одном TS-программном пространстве с popup.ts
export {};

interface SlotMeta {
  operator: string;
  proxyPort: number;
}

const SLOT_META: Record<string, SlotMeta> = {
  A: { operator: 'билайн', proxyPort: 8881 },
  B: { operator: 'MegaFon', proxyPort: 8882 },
  C: { operator: 'Tele2', proxyPort: 8883 },
};

const statusDot = document.getElementById('statusDot')!;
const statusText = document.getElementById('statusText')!;
const checkedEl = document.getElementById('checked')!;
const closedEl = document.getElementById('closed')!;
const repricedEl = document.getElementById('repriced')!;
const stageEl = document.getElementById('lightStage')!;
const startBtn = document.getElementById('lightStartBtn') as HTMLButtonElement;
const stopBtn = document.getElementById('lightStopBtn') as HTMLButtonElement;
const workerIdEl = document.getElementById('workerId')!;
const proxyAddrEl = document.getElementById('proxyAddr')!;
const slotChips = document.getElementById('slotChips')!;
const lightAvito = document.getElementById('lightAvito')!;
const lightCian = document.getElementById('lightCian')!;
const barAvito = document.getElementById('lightBarAvito') as HTMLElement;
const barCian = document.getElementById('lightBarCian') as HTMLElement;

function send<T = any>(message: Record<string, unknown>): Promise<T> {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, (r) => resolve(r as T)));
}

// ─── Прогресс ─────────────────────────────────────────────────────
function updateLight(p: {
  running?: boolean;
  stage?: string;
  checked?: number;
  closed?: number;
  repriced?: number;
  sources?: Record<string, { checked: number; total: number }>;
  workerId?: string;
}) {
  if (p.running !== undefined) {
    statusDot.className = `status-dot ${p.running ? 'running' : ''}`;
    statusText.textContent = p.running ? 'Работает...' : 'Остановлен';
    startBtn.disabled = p.running;
    stopBtn.disabled = !p.running;
  }
  if (p.stage !== undefined) stageEl.textContent = p.stage;
  if (p.checked !== undefined) checkedEl.textContent = String(p.checked);
  if (p.closed !== undefined) closedEl.textContent = String(p.closed);
  if (p.repriced !== undefined) repricedEl.textContent = String(p.repriced);
  if (p.workerId) workerIdEl.textContent = p.workerId;

  const renderSrc = (key: string, label: HTMLElement, bar: HTMLElement) => {
    const sp = p.sources?.[key];
    if (!sp) return;
    label.textContent = `${sp.checked} из ${sp.total || '?'}`;
    bar.style.width = sp.total ? Math.min(100, Math.round((sp.checked / sp.total) * 100)) + '%' : '0%';
  };
  renderSrc('avito', lightAvito, barAvito);
  renderSrc('cian', lightCian, barCian);
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'LIGHT_PROGRESS') updateLight(message);
});

// ─── Канал модема (proxy-слот) ────────────────────────────────────
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

async function applyProxy(slot: string): Promise<void> {
  const meta = SLOT_META[slot];
  const proxyApi = (chrome as any).proxy;
  if (!meta || !proxyApi?.settings?.set) return;
  await new Promise<void>((resolve) => {
    proxyApi.settings.set(
      {
        value: {
          mode: 'fixed_servers',
          rules: { singleProxy: { host: '127.0.0.1', port: meta.proxyPort } },
        },
        scope: 'regular',
      },
      () => resolve()
    );
  });
}

function renderSlotChips(currentPort: string) {
  slotChips.innerHTML = '';
  for (const [slot, meta] of Object.entries(SLOT_META)) {
    const active = currentPort.endsWith(':' + meta.proxyPort);
    const chip = document.createElement('button');
    chip.className = `slot-chip ${active ? 'active' : ''}`;
    chip.textContent = `${slot} · ${meta.operator}`;
    chip.title = `Переключить канал на слот ${slot} (127.0.0.1:${meta.proxyPort})`;
    chip.addEventListener('click', async () => {
      await applyProxy(slot);
      const addr = await getProxyAddress();
      proxyAddrEl.textContent = addr;
      renderSlotChips(addr);
    });
    slotChips.appendChild(chip);
  }
}

// ─── Инициализация ────────────────────────────────────────────────
startBtn.addEventListener('click', () => {
  send({ type: 'LIGHT_START' }).then(() => {
    updateLight({ running: true, stage: 'запуск...' });
  });
});

stopBtn.addEventListener('click', () => {
  send({ type: 'LIGHT_STOP' }).then(() => {
    updateLight({ running: false, stage: 'остановлен' });
  });
});

(async () => {
  const status = await send({ type: 'LIGHT_STATUS' });
  if (status) updateLight(status);
  const addr = await getProxyAddress();
  proxyAddrEl.textContent = addr;
  renderSlotChips(addr);
})();

console.log('[LightCheck] Popup loaded');
