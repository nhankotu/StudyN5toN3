import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCloudHealth, cloudGetProgress, cloudSaveProgress } from '../db.js';

test('client reports failed saves and expired sessions instead of success', async () => {
  const storage = new Map([['nihongo_token', 'temporary-token']]);
  globalThis.localStorage = { getItem: key => storage.get(key), removeItem: key => storage.delete(key) };
  globalThis.window = new EventTarget();
  let expired = false;
  window.addEventListener('nihongo-session-expired', () => { expired = true; });
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, database: 'connected' }) });
  await checkCloudHealth();
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ ok: false, message: 'Save failed' }) });
  await assert.rejects(cloudSaveProgress({}), /Save failed/);
  await assert.rejects(cloudGetProgress('student'), /Save failed/);
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({ ok: false, message: 'Expired' }) });
  await assert.rejects(cloudGetProgress('student'), /Expired/);
  assert.equal(expired, true);
  assert.equal(storage.has('nihongo_token'), false);
});
