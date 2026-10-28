import test from 'node:test';
import assert from 'node:assert/strict';
import vercelHandler from '../api/handler.js';

async function call(req) {
  const response = {};
  await vercelHandler({ headers: {}, ...req }, {
    writeHead(status, headers) { response.status = status; response.headers = headers; },
    end(body) { response.body = body; }
  });
  return response;
}

test('Vercel forwards rewritten API requests and parsed JSON to the shared handler', async () => {
  const options = await call({ method: 'OPTIONS', url: '/api/handler?__route=auth%2Flogin', query: { __route: 'auth/login' } });
  assert.equal(options.status, 204);
  const invalid = await call({ method: 'POST', url: '/api/handler?__route=auth%2Flogin', query: { __route: 'auth/login' }, body: '{' });
  assert.equal(invalid.status, 400);
  assert.match(JSON.parse(invalid.body).message, /JSON/);
});
