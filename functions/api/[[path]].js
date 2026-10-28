import { handler } from '../../netlify/functions/api.js';

/**
 * Cloudflare Pages Function Adapter
 * Chuyển tiếp request từ Cloudflare Pages Functions (/api/*) vào Netlify API handler.
 * Tự động phân giải mongodb+srv:// thành direct connection string qua Cloudflare DoH
 * vì môi trường Edge/workerd không hỗ trợ dns.resolveSrv() đầy đủ.
 */

let resolvedMongoUri = null; // Cache URI đã phân giải để không gọi DoH mỗi request

/**
 * Phân giải mongodb+srv:// sang mongodb:// trực tiếp qua Cloudflare DNS-over-HTTPS (1.1.1.1)
 */
async function resolveSrvToDirectUri(srvUri) {
  try {
    const match = srvUri.match(/^mongodb\+srv:\/\/([^:]+):([^@]+)@([^/?]+)(\/[^?]*)?(\?.*)?$/);
    if (!match) return srvUri;
    const [, user, pass, host, pathPart = '', queryPart = ''] = match;

    console.log(`[CF Adapter] Phân giải SRV cho host: ${host}`);

    // 1. Phân giải SRV records
    const srvUrl = `https://cloudflare-dns.com/dns-query?name=_mongodb._tcp.${host}&type=SRV`;
    const srvRes = await fetch(srvUrl, { headers: { accept: 'application/dns-json' } });
    if (!srvRes.ok) {
      console.error(`[CF Adapter] DoH SRV request failed: HTTP ${srvRes.status}`);
      return srvUri;
    }
    const srvData = await srvRes.json();
    console.log(`[CF Adapter] SRV response:`, JSON.stringify(srvData.Answer || []));

    if (!srvData.Answer || !srvData.Answer.length) {
      console.error('[CF Adapter] Không tìm thấy SRV records');
      return srvUri;
    }

    const hosts = srvData.Answer.map(ans => {
      const parts = String(ans.data).trim().split(/\s+/);
      const port = parts[2] || '27017';
      const target = (parts[3] || '').replace(/\.$/, '');
      return target ? `${target}:${port}` : null;
    }).filter(Boolean);

    if (!hosts.length) {
      console.error('[CF Adapter] SRV records trống sau khi parse');
      return srvUri;
    }
    console.log(`[CF Adapter] Đã phân giải được ${hosts.length} host: ${hosts.join(', ')}`);

    // 2. Phân giải TXT record để lấy replicaSet, authSource
    let txtParams = 'tls=true&ssl=true';
    try {
      const txtUrl = `https://cloudflare-dns.com/dns-query?name=${host}&type=TXT`;
      const txtRes = await fetch(txtUrl, { headers: { accept: 'application/dns-json' } });
      if (txtRes.ok) {
        const txtData = await txtRes.json();
        if (txtData.Answer && txtData.Answer.length) {
          const txtRaw = txtData.Answer
            .map(a => String(a.data).replace(/^"|"$/g, '').replace(/"\s+"/g, ''))
            .join('&');
          if (txtRaw) txtParams += `&${txtRaw}`;
          console.log(`[CF Adapter] TXT params: ${txtParams}`);
        }
      }
    } catch (e) {
      console.warn('[CF Adapter] TXT lookup error (non-fatal):', e.message);
    }

    // 3. Xây dựng direct URI
    const queryClean = queryPart.replace(/^\?/, '');
    // Loại bỏ retryWrites nếu có (sẽ thêm lại từ queryClean)
    const directUri = `mongodb://${encodeURIComponent(decodeURIComponent(user))}:${encodeURIComponent(decodeURIComponent(pass))}@${hosts.join(',')}${pathPart}?${txtParams}${queryClean ? '&' + queryClean : ''}`;
    
    const maskedDirect = directUri.replace(/\/\/([^:]+):([^@]+)@/, '//$1:****@');
    console.log(`[CF Adapter] ✅ Direct URI (${hosts.length} hosts): ${maskedDirect}`);
    return directUri;
  } catch (err) {
    console.error('[CF Adapter] DoH resolve error:', err.message);
    return srvUri;
  }
}

export async function onRequest(context) {
  const { request, env } = context;

  // 1. Đồng bộ biến môi trường từ Cloudflare Pages context vào process.env
  //    Gán trực tiếp các biến quan trọng (Object.entries có thể không hoạt động trên proxy env)
  const envKeys = ['MONGODB_URI', 'INITIAL_ADMIN_PASSWORD', 'PORT'];
  for (const key of envKeys) {
    if (env[key] !== undefined && env[key] !== null) {
      process.env[key] = String(env[key]).trim();
    }
  }
  // Fallback: thử Object.entries cho các biến khác
  try {
    if (env && typeof env === 'object') {
      for (const [key, val] of Object.entries(env)) {
        if (typeof val === 'string' && !process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  } catch {}

  // 2. Phân giải mongodb+srv:// sang direct URI (chỉ làm 1 lần, cache lại)
  const rawUri = process.env.MONGODB_URI;
  if (rawUri && rawUri.startsWith('mongodb+srv://')) {
    if (!resolvedMongoUri) {
      console.log('[CF Adapter] Lần đầu: phân giải mongodb+srv:// qua Cloudflare DoH...');
      resolvedMongoUri = await resolveSrvToDirectUri(rawUri);
    }
    process.env.MONGODB_URI = resolvedMongoUri;
  }

  // 3. Chuyển đổi Request thành event chuẩn Netlify handler
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
