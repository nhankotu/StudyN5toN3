import { handler } from '../netlify/functions/api.js';

// Serve the frontend as static files and forward only /api/* to the shared API.
export default async function vercelHandler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const rewrittenPath = req.query?.__route ?? url.searchParams.get('__route');
  const path = rewrittenPath == null ? url.pathname : `/api/${Array.isArray(rewrittenPath) ? rewrittenPath.join('/') : rewrittenPath}`;
  const queryStringParameters = Object.fromEntries(url.searchParams);
  delete queryStringParameters.__route;
  const body = req.body == null ? null : typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  try {
    const result = await handler({ httpMethod: req.method, path, queryStringParameters, headers: req.headers, body }, {});
    res.writeHead(result.statusCode, result.headers || {});
    res.end(result.body);
  } catch (error) {
    console.error('Vercel API error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, message: 'Lỗi máy chủ nội bộ.' }));
  }
}
