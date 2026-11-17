import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const page = fileURLToPath(new URL('../app/index.html', import.meta.url));

export async function startServer() {
  const html = await readFile(page);
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(html);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://localhost:${server.address().port}`;
  return { url, close: () => new Promise(r => server.close(r)) };
}
