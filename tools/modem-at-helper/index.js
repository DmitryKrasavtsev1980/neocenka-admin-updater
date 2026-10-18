/**
 * Локальный AT-хелпер для Huawei E3372-325 (stick mode).
 *
 * Зачем: stick mode не имеет веб-API HiLink, смена IP — только через AT-порт.
 * Chrome-расширение к COM-портам доступа не имеет, поэтому хелпер держит
 * HTTP на 127.0.0.1 и дёргает AT+CFUN=0/1 (перезагрузка радио → оператор
 * выдаёт новый внешний адрес).
 *
 * Запуск (один процесс на модем):
 *   node index.js --slot A --com COM3 --port 8891
 *   node index.js --slot B --com COM4 --port 8892
 *
 * API:
 *   GET  /status  → { ok, slot, com, lastRotateAt, lastError }
 *   POST /rotate  → { ok, slot, durationMs }  или  { ok:false, error }
 *
 * Настройка в расширении (профиль модема A):
 *   modemMethod: 'at'
 *   modemHost:   'http://127.0.0.1:8891'
 *   modemSlot:   'A'
 */

const http = require('http');
const { SerialPort } = require('serialport');

// ── CLI ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}

const SLOT = arg('slot', 'A');
const COM = arg('com', process.env.MODEM_COM || '');
const PORT = Number(arg('port', process.env.MODEM_HELPER_PORT || (SLOT === 'B' ? 8892 : 8891)));
const BAUD = Number(arg('baud', '115200'));

if (!COM) {
  console.error('Укажи COM-порт: node index.js --slot A --com COM3 --port 8891');
  console.error('Посмотреть порты: Device Manager → Ports (COM & LPT) → Huawei Mobile Connect - PC UI');
  process.exit(1);
}

// ── состояние ────────────────────────────────────────────────────
let lastRotateAt = null;
let lastError = null;
let rotating = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Отправить AT-команду и собрать ответ до 'OK' / 'ERROR'.
 * E3372 на 115200, 8N1. Таймаут — чтобы не зависнуть на молчащем порту.
 */
function atCommand(port, cmd, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString();
      if (/\r\nOK\r\n/.test(buf) || /\r\nERROR/.test(buf) || /\r\n\+CME ERROR/.test(buf)) {
        cleanup();
        resolve(buf.trim());
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(buf.trim() || 'TIMEOUT');
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      port.off('data', onData);
    };
    port.on('data', onData);
    port.write(cmd + '\r');
  });
}

async function rotate() {
  if (rotating) {
    return { ok: false, error: 'already_rotating' };
  }
  rotating = true;
  const t0 = Date.now();
  try {
    const port = new SerialPort({ path: COM, baudRate: BAUD, autoOpen: false });

    await new Promise((resolve, reject) => {
      port.open((err) => (err ? reject(err) : resolve()));
    });

    try {
      // Пинг — убеждаемся, что порт жив
      const ping = await atCommand(port, 'AT');
      if (!/OK/.test(ping)) {
        throw new Error(`AT no response: ${ping}`);
      }

      // Радио в offline: соединение рвётся, оператор отдаёт новый IP
      await atCommand(port, 'AT+CFUN=0');
      await sleep(5000);

      // Радио обратно: регистрация + новый PDP-контекст
      await atCommand(port, 'AT+CFUN=1');

      // Ждём регистрацию (CREG: 1,1 / 1,5) до 60 с
      const deadline = Date.now() + 60_000;
      let reg = '';
      while (Date.now() < deadline) {
        await sleep(3000);
        reg = await atCommand(port, 'AT+CREG?');
        if (/,1[,)]|,5[,)]/.test(reg)) break;
      }

      lastRotateAt = new Date().toISOString();
      lastError = null;
      console.log(`[${SLOT}] rotated via ${COM} in ${Date.now() - t0}ms, CREG=${reg.split('\n').pop() || '?'}`);
      return { ok: true, slot: SLOT, durationMs: Date.now() - t0 };
    } finally {
      await new Promise((resolve) => port.close(() => resolve()));
    }
  } catch (err) {
    lastError = String(err && err.message ? err.message : err);
    console.error(`[${SLOT}] rotate failed:`, lastError);
    return { ok: false, error: lastError };
  } finally {
    rotating = false;
  }
}

// ── HTTP ─────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  if (req.method === 'GET' && req.url.startsWith('/status')) {
    return send(200, {
      ok: true,
      slot: SLOT,
      com: COM,
      port: PORT,
      rotating,
      lastRotateAt,
      lastError,
    });
  }

  if (req.method === 'POST' && req.url.startsWith('/rotate')) {
    const result = await rotate();
    return send(result.ok ? 200 : 500, result);
  }

  send(404, { ok: false, error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[${SLOT}] modem-at-helper on http://127.0.0.1:${PORT}, COM=${COM}, baud=${BAUD}`);
});
