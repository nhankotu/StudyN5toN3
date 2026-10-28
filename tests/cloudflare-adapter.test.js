import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from '../functions/api/[[path]].js';

test('Cloudflare Pages adapter handles OPTIONS preflight', async () => {
  const req = new Request('https://example.com/api/health', {
    method: 'OPTIONS',
    headers: {
      'Access-Control-Request-Method': 'GET'
    }
  });

  const res = await onRequest({
    request: req,
    env: {
      MONGODB_URI: 'mongodb://localhost:27017'
    }
  });

  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('Cloudflare Pages adapter passes env to process.env', async () => {
  const testUri = 'mongodb://fake-uri-test:27017/nihongo_study';
  const req = new Request('https://example.com/api/health', {
    method: 'GET'
  });

  await onRequest({
    request: req,
    env: {
      MONGODB_URI: testUri
    }
  });

  assert.equal(process.env.MONGODB_URI, testUri);
});
