/**
 * Локальный HiLink-хелпер смены IP для Huawei E3372 (прошивка HiLink, веб-API на 192.168.8.1).
 *
 * Зачем: у каждого модема свой LAN-адаптер с IP 192.168.8.x, но веб-морда обоих —
 * на 192.168.8.1. Маршруты неоднозначны, Chrome не умеет прибивать сокет к адаптеру,
 * поэтому смена IP идёт через этот хелпер: он слушает HTTP на 127.0.0.1 и сам
 * ходит в 192.168.8.1 с localAddress = IP нужного адаптера.
 *
 * Порядок смены IP:
 *   1) dataswitch off→on  (~30–40 с) — быстрый путь, но операторы часто держат адрес;
 *   2) если IP не изменился — reboot через /api/device/control (Control=1),
 *      модем перезагружается ~60–90 с и почти всегда получает новый адрес.
 *
 * Запуск (один процесс на модем, от Windows, НЕ из WSL):
 *   node index.js --slot A --iface 192.168.8.103 --port 8891
 *   node index.js --slot B --iface 192.168.8.107 --port 8892
 *
 * API (совместим с admin-updater modem-client method:'at'):
 *   GET  /status  → { ok, slot, iface, modemHost, lastRotateAt, lastError, ... }
 *   POST /rotate  → { ok, slot, method, oldIp, newIp, durationMs }
 *                   или { ok:false, error }
 *
 * IP определяется через api.ipify.org, привязанный к тому же адаптеру:
 * у MegaFon/beeline WAN — CGNAT (10.x), сравнивать нужно именно публичный адрес.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

// ── CLI ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}

const SLOT = arg('slot', 'A');
const IFACE = arg('iface', process.env.MODEM_IFACE || '');
const PORT = Number(arg('port', process.env.MODEM_HELPER_PORT || (SLOT === 'B' ? 8892 : 8891)));
const MODEM_HOST = arg('host', process.env.MODEM_HOST || 'http://192.168.8.1');

if (!IFACE) {
  console.error('Укажи IP адаптера модема: node index.js --slot A --iface 192.168.8.103 --port 8891');
  console.error('Посмотреть: ipconfig → Ethernet adapter с шлюзом 192.168.8.1');
  process.exit(1);
}

// ── состояние ────────────────────────────────────────────────────
let lastRotateAt = null;
let lastError = null;
let lastMethod = null;
let lastOldIp = null;
let lastNewIp = null;
let rotating = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * HTTP-запрос с привязкой исходящего сокета к адаптеру модема.
 * Без localAddress запрос в 192.168.8.1 уйдёт через «кто первый» из трёх default-роутов.
 */
function request(urlStr, { method = 'GET', headers = {}, body = null, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers,
        localAddress: IFACE,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error(`timeout ${timeoutMs}ms for ${urlStr}`));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** Cookie из Set-Cookie (нужен SessionID; у двух модемов на одном IP куки путаются, поэтому свой процесс на модем) */
function collectCookies(prevCookie, setCookieHeaders) {
  const jar = new Map();
  if (prevCookie) {
    for (const part of prevCookie.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k) jar.set(k, v.join('='));
    }
  }
  const list = setCookieHeaders || [];
  for (const raw of list) {
    const first = raw.split(';')[0];
    const [k, ...v] = first.trim().split('=');
    if (k) jar.set(k, v.join('='));
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function modemSession() {
  const t = Date.now();
  const res = await request(`${MODEM_HOST}/?_=${t}`, {
    headers: { Accept: 'text/html,*/*' },
  });
  const cookie = collectCookies('', res.headers['set-cookie']);
  const tokens = [...res.body.matchAll(/csrf_token"\s+content="([^"]+)"/g)].map((m) => m[1]);
  if (!tokens.length) throw new Error(`no csrf token in modem page (http ${res.status})`);
  return { token: tokens[0], cookie };
}

async function modemPost(path, xml, token, cookie) {
  const res = await request(`${MODEM_HOST}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml',
      __RequestVerificationToken: token,
      Cookie: cookie,
      'Content-Length': Buffer.byteLength(xml),
    },
    body: xml,
    timeoutMs: 20000,
  });
  return res.body;
}

/** Публичный IP через тот же адаптер (модемы на CGNAT, WAN 10.x не показателен) */
async function getPublicIp() {
  try {
    const res = await request('https://api.ipify.org?format=json', { timeoutMs: 12000 });
    const data = JSON.parse(res.body);
    return data && data.ip ? data.ip : null;
  } catch {
    return null;
  }
}

/** Веб-морда модема снова отвечает */
async function waitHostUp(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await request(`${MODEM_HOST}/`, { timeoutMs: 5000 });
      if (res.status === 200) return true;
    } catch {
      /* ещё перезагружается */
    }
    await sleep(3000);
  }
  return false;
}

async function waitNewIp(oldIp, timeoutMs) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    await sleep(5000);
    last = await getPublicIp();
    if (last && last !== oldIp) return last;
  }
  return last;
}

// ── смена IP ─────────────────────────────────────────────────────
async function rotateViaDataswitch(oldIp) {
  const { token, cookie } = await modemSession();
  await modemPost('/api/dialup/mobile-dataswitch', '<request><dataswitch>0</dataswitch></request>', token, cookie);
  await sleep(12_000);
  const s2 = await modemSession();
  await modemPost('/api/dialup/mobile-dataswitch', '<request><dataswitch>1</dataswitch></request>', s2.token, s2.cookie);
  const newIp = await waitNewIp(oldIp, 60_000);
  return newIp;
}

async function rotateViaReboot(oldIp) {
  const { token, cookie } = await modemSession();
  await modemPost('/api/device/control', '<request><Control>1</Control></request>', token, cookie);
  const up = await waitHostUp(120_000);
  if (!up) throw new Error('modem did not come back after reboot');
  // после ребута модем поднимает PPP/LTE ещё ~20–30 с
  await sleep(15_000);
  const newIp = await waitNewIp(oldIp, 90_000);
  return newIp;
}

async function rotate() {
  if (rotating) return { ok: false, error: 'already_rotating' };
  rotating = true;
  const t0 = Date.now();
  const oldIp = await getPublicIp();
  lastOldIp = oldIp;
  lastError = null;
  lastNewIp = null;

  try {
    console.log(`[${SLOT}] rotate start via ${MODEM_HOST} iface=${IFACE}, public=${oldIp ?? '?'}`);

    // быстрый путь
    let newIp = null;
    let method = 'dataswitch';
    try {
      newIp = await rotateViaDataswitch(oldIp);
    } catch (err) {
      console.warn(`[${SLOT}] dataswitch failed: ${err.message} — escalating to reboot`);
    }

    // эскалация: IP не сменился или dataswitch упал
    if (!newIp || newIp === oldIp) {
      method = 'reboot';
      console.log(`[${SLOT}] escalating to reboot (ip=${newIp ?? 'none'}, old=${oldIp ?? '?'})`);
      newIp = await rotateViaReboot(oldIp);
    }

    lastMethod = method;
    lastNewIp = newIp;
    lastRotateAt = new Date().toISOString();
    const ok = !!newIp && newIp !== oldIp;
    if (!ok) lastError = 'ip_unchanged';
    else lastError = null;

    const result = {
      ok,
      slot: SLOT,
      method,
      oldIp: oldIp ?? undefined,
      newIp: newIp ?? undefined,
      durationMs: Date.now() - t0,
    };
    if (!ok) result.error = 'ip_unchanged';
    console.log(`[${SLOT}] rotate done in ${result.durationMs}ms:`, result);
    return result;
  } catch (err) {
    lastError = String(err && err.message ? err.message : err);
    lastMethod = null;
    console.error(`[${SLOT}] rotate failed:`, lastError);
    return { ok: false, slot: SLOT, oldIp: oldIp ?? undefined, error: lastError };
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
      iface: IFACE,
      modemHost: MODEM_HOST,
      port: PORT,
      rotating,
      lastRotateAt,
      lastError,
      lastMethod,
      lastOldIp,
      lastNewIp,
    });
  }

  if (req.method === 'POST' && req.url.startsWith('/rotate')) {
    const result = await rotate();
    return send(result.ok ? 200 : 500, result);
  }

  send(404, { ok: false, error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[${SLOT}] modem-hilink-helper on http://127.0.0.1:${PORT}`);
  console.log(`[${SLOT}] modem=${MODEM_HOST} iface=${IFACE}`);
});
