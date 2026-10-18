/**
 * Локальный HTTP/HTTPS-прокси с привязкой исходящего трафика к адаптеру модема.
 *
 * Зачем: Chrome нельзя прибить к сетевому адаптеру напрямую. Прокси слушает
 * 127.0.0.1:<port> и открывает исходящие соединения с localAddress = IP адаптера
 * модема — весь трафик браузера уходит через нужный свисток.
 *
 * Запуск (из Windows, не из WSL):
 *   node proxy.js --port 8881 --iface 192.168.8.103
 *   node proxy.js --port 8882 --iface 192.168.8.107
 *
 * Chrome:
 *   chrome.exe --proxy-server=127.0.0.1:8882 ...
 *
 * Проверка:
 *   curl.exe -x http://127.0.0.1:8882 https://api.ipify.org
 *
 * Поддерживает CONNECT (HTTPS) и обычный HTTP. Без зависимостей — Node stdlib.
 */

const http = require('http');
const net = require('net');
const { URL } = require('url');

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}

const PORT = Number(arg('port', process.env.PROXY_PORT || '8881'));
const IFACE = arg('iface', process.env.PROXY_IFACE || '');
const VERBOSE = args.includes('--verbose') || process.env.PROXY_VERBOSE === '1';

if (!IFACE) {
  console.error('Укажи IP адаптера модема: node proxy.js --port 8881 --iface 192.168.8.103');
  process.exit(1);
}

const log = (...m) => {
  if (VERBOSE) console.log(...m);
};

/**
 * TCP-прокси для CONNECT (HTTPS): клиент шлёт «CONNECT host:port»,
 * дальше в обе стороны идёт сырой туннель. Исходящий сокет — на IFACE.
 */
function tunnel(clientSocket, head, host, port) {
  const upstream = net.connect({ host, port, localAddress: IFACE }, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });

  upstream.on('error', (err) => {
    log(`[tunnel] upstream error ${host}:${port}:`, err.message);
    clientSocket.destroy();
  });
  clientSocket.on('error', () => upstream.destroy());
  upstream.on('close', () => clientSocket.destroy());
  clientSocket.on('close', () => upstream.destroy());
}

const server = http.createServer((req, res) => {
  // Обычный HTTP (absolute URI в request-line)
  let target;
  try {
    target = new URL(req.url);
  } catch {
    res.writeHead(400);
    return res.end('Bad request');
  }

  if (target.protocol !== 'http:') {
    res.writeHead(400);
    return res.end('Only http:// via plain request; use CONNECT for https');
  }

  log(`[http] ${req.method} ${req.url}`);
  const upstreamReq = http.request(
    {
      hostname: target.hostname,
      port: target.port || 80,
      path: target.pathname + target.search,
      method: req.method,
      headers: req.headers,
      localAddress: IFACE,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
      upstreamRes.pipe(res);
    }
  );

  upstreamReq.on('error', (err) => {
    log('[http] upstream error:', err.message);
    if (!res.headersSent) res.writeHead(502);
    res.end('Bad gateway');
  });

  req.pipe(upstreamReq);
});

// CONNECT для HTTPS
server.on('connect', (req, clientSocket, head) => {
  const [host, portStr] = req.url.split(':');
  const port = Number(portStr) || 443;
  log(`[connect] ${host}:${port}`);
  tunnel(clientSocket, head, host, port);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[proxy] http://127.0.0.1:${PORT} → iface ${IFACE}`);
});
