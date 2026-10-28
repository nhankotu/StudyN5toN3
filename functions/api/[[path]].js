import { handler } from '../../netlify/functions/api.js';

/**
 * Cloudflare Pages Function Adapter
 * Chuyển tiếp request từ Cloudflare Pages Functions (/api/*) vào Netlify API handler
 */
export async function onRequest(context) {
  const { request, env } = context;

  // 1. Đồng bộ biến môi trường từ Cloudflare Pages context vào process.env
  if (env && typeof env === 'object') {
    for (const [key, val] of Object.entries(env)) {
      if (typeof val === 'string') {
        process.env[key] = val;
      }
    }
  }

  // Làm sạch chuỗi kết nối nếu có khoảng trắng vô tình copy vào
  if (process.env.MONGODB_URI) {
    process.env.MONGODB_URI = process.env.MONGODB_URI.trim();
  }

  // 2. Chuyển đổi Request thành event chuẩn của Lambda / Netlify handler
  const url = new URL(request.url);
  const pathname = url.pathname;

  const queryStringParameters = {};
  url.searchParams.forEach((val, key) => {
    queryStringParameters[key] = val;
  });

  const headers = {};
  if (request.headers && typeof request.headers.entries === 'function') {
    for (const [k, v] of request.headers.entries()) {
      headers[k.toLowerCase()] = v;
      headers[k] = v;
    }
  }

  let body = null;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    try {
      body = await request.text();
    } catch {
      body = null;
    }
  }

  const event = {
    httpMethod: request.method,
    path: pathname,
    queryStringParameters,
    headers,
    body
  };

  try {
    const response = await handler(event, context);
    const resBody = (response.statusCode === 204 || response.statusCode === 304) ? null : (response.body ?? '');
    
    return new Response(resBody, {
      status: response.statusCode || 200,
      headers: response.headers || { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, message: 'Lỗi xử lý API: ' + err.message }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
}
