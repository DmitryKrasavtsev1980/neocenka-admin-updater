// open-url.js <port> <url-file> — открыть URL из файла в новой вкладке.
const fs = require('fs');
const [port, file] = process.argv.slice(2);
const url = fs.readFileSync(file, 'utf8').trim();
(async () => {
  await fetch(`http://127.0.0.1:${port}/json/new?url=${encodeURIComponent(url)}`, { method: 'PUT' });
  console.log('открыто:', url.slice(0, 80) + '...');
})();
