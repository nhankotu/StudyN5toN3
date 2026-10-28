import { handler } from '../netlify/functions/api.js';

export default async function vercelHandler(req, res) {
  // Chuẩn hóa queryStringParameters
  const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
  const queryStringParameters = {};
  url.searchParams.forEach((val, key) => {
    queryStringParameters[key] = val;
  });

  // req.body trên Vercel có thể đã được parse thành object
  let bodyStr = null;
  if (req.body !== undefined && req.body !== null) {
    bodyStr = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  }

  const event = {
    httpMethod: req.method,
    path: url.pathname,
    queryStringParameters,
    headers: req.headers,
    body: bodyStr
  };

  try {
    const response = await handler(event, {});
    
    // Ghi headers
    if (response.headers) {
      for (const [k, v] of Object.entries(response.headers)) {
        res.setHeader(k, v);
      }
    }
    
    res.status(response.statusCode || 200);
    res.send(response.body ?? '');
  } catch (err) {
    res.status(500).json({ ok: false, message: 'Lỗi Vercel API: ' + err.message });
  }
}
