import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { handler } from './netlify/functions/api.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 8000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon'
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // 1. Chuyển tiếp các request /api/* vào Netlify Function handler
  if (pathname.startsWith('/api/') || pathname === '/api') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      const queryStringParameters = {};
      url.searchParams.forEach((val, key) => { queryStringParameters[key] = val; });

      const event = {
        httpMethod: req.method,
        path: pathname,
        queryStringParameters,
        headers: req.headers,
        body: body || null
      };

      try {
        const response = await handler(event, {});
        res.writeHead(response.statusCode, response.headers || {});
        res.end(response.body);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, message: err.message }));
      }
    });
    return;
  }

  // 2. Phục vụ static files (Frontend)
  let filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
  
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Không tìm thấy tệp yêu cầu (404 Not Found).');
    return;
  }

  if (fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Lỗi đọc tệp: ' + err.message);
  }
});

server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 Nihongo Study Web App đang chạy tại:`);
  console.log(`👉 http://localhost:${PORT}`);
  console.log(`MongoDB URI: ${process.env.MONGODB_URI ? 'ĐÃ ĐƯỢC THIẾT LẬP ✓' : 'CHƯA THIẾT LẬP (Hãy điền vào file .env)'}`);
  console.log(`======================================================\n`);
});
