import test from 'node:test';
import assert from 'node:assert/strict';

import { data } from './helpers/memory-db.js';
process.env.MONGODB_URI = 'mongodb://localhost:27017/test';
process.env.INITIAL_ADMIN_PASSWORD = 'test-password';
const { handler } = await import('../netlify/functions/api.js');

async function call(path, method = 'GET', body, token) {
  const result = await handler({
    path: '/api' + path,
    httpMethod: method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: body ? JSON.stringify(body) : null
  }, {});
  return { status: result.statusCode, ...(result.body ? JSON.parse(result.body) : {}) };
}

test('Comprehensive Acceptance Criteria: Permissions, Isolation, Admin Delete, and Password Flow', async () => {
  // 1. Initial State: Login as admin
  const admin = await call('/auth/login', 'POST', { username: 'admin', password: 'test-password' });
  assert.equal(admin.status, 200);

  // Admin creates User A and User B
  const createA = await call('/auth/users', 'POST', { username: 'user_a', name: 'User A', role: 'user', password: 'password_a' }, admin.token);
  assert.equal(createA.status, 201);

  const createB = await call('/auth/users', 'POST', { username: 'user_b', name: 'User B', role: 'user', password: 'password_b' }, admin.token);
  assert.equal(createB.status, 201);

  // Login as User A
  const userA = await call('/auth/login', 'POST', { username: 'user_a', password: 'password_a' });
  assert.equal(userA.status, 200);

  // Login as User B
  const userB = await call('/auth/login', 'POST', { username: 'user_b', password: 'password_b' });
  assert.equal(userB.status, 200);

  // 2. Both User A and User B import a lesson with the SAME sourceId / code "bai-01"
  const lessonA = {
    id: 'user_a:bai-01',
    sourceId: 'bai-01',
    title: 'Bài 1 của A',
    level: 'N5',
    vocabulary: [{ id: 'v01', japanese: '私[わたし]', meaning: 'Tôi của A' }]
  };
  const saveA = await call('/lessons', 'POST', { lessons: [lessonA] }, userA.token);
  assert.equal(saveA.status, 200);

  const lessonB = {
    id: 'user_b:bai-01',
    sourceId: 'bai-01',
    title: 'Bài 1 của B',
    level: 'N5',
    vocabulary: [{ id: 'v01', japanese: '私[わたし]', meaning: 'Tôi của B' }]
  };
  const saveB = await call('/lessons', 'POST', { lessons: [lessonB] }, userB.token);
  assert.equal(saveB.status, 200);

  // Verify internal IDs: User A's lesson has id user_a:bai-01, User B's has user_b:bai-01
  const lessonsForA = (await call('/lessons', 'GET', null, userA.token)).lessons;
  assert.equal(lessonsForA.length, 1);
  assert.equal(lessonsForA[0].title, 'Bài 1 của A');
  assert.equal(lessonsForA[0].createdBy, 'user_a');
  assert.equal(lessonsForA[0].id, 'user_a:bai-01');

  const lessonsForB = (await call('/lessons', 'GET', null, userB.token)).lessons;
  assert.equal(lessonsForB.length, 1);
  assert.equal(lessonsForB[0].title, 'Bài 1 của B');
  assert.equal(lessonsForB[0].createdBy, 'user_b');
  assert.equal(lessonsForB[0].id, 'user_b:bai-01');

  // 3. User A CANNOT view or edit or delete User B's lesson
  const bInternalId = lessonsForB[0].id;
  const getBbyA = await call(`/lessons/${bInternalId}`, 'GET', null, userA.token);
  assert.equal(getBbyA.status, 403);

  const editBbyA = await call(`/lessons/${bInternalId}`, 'PUT', { lesson: { ...lessonsForB[0], title: 'A hack B' } }, userA.token);
  assert.equal(editBbyA.status, 403);

  const deleteBbyA = await call(`/lessons/${bInternalId}`, 'DELETE', null, userA.token);
  assert.equal(deleteBbyA.status, 403);

  // 4. Admin CAN view all lessons
  const lessonsForAdmin = (await call('/lessons', 'GET', null, admin.token)).lessons;
  // Should have at least user_a's and user_b's lesson
  assert.ok(lessonsForAdmin.some(l => l.id === 'user_a:bai-01'));
  assert.ok(lessonsForAdmin.some(l => l.id === 'user_b:bai-01'));

  // 5. Admin CANNOT edit User B's lesson (Strict rule: only owner can edit)
  const editBbyAdmin = await call(`/lessons/${bInternalId}`, 'PUT', { lesson: { ...lessonsForB[0], title: 'Admin hack B' } }, admin.token);
  assert.equal(editBbyAdmin.status, 403);

  // 6. User A CANNOT save progress on User B's lesson
  const progressAonB = await call('/progress', 'POST', {
    record: {
      key: `user_a:${bInternalId}:vocabulary:v01`,
      cardKey: `${bInternalId}:vocabulary:v01`,
      username: 'user_a',
      status: 'known'
    }
  }, userA.token);
  assert.equal(progressAonB.status, 403);

  // 7. User B saves progress on User B's lesson
  const progressBonB = await call('/progress', 'POST', {
    record: {
      key: `user_b:${bInternalId}:vocabulary:v01`,
      cardKey: `${bInternalId}:vocabulary:v01`,
      username: 'user_b',
      status: 'known',
      activity: 'quiz'
    }
  }, userB.token);
  assert.equal(progressBonB.status, 200);

  // 8. Admin studying User B's lesson creates progress ONLY for Admin
  const progressAdminOnB = await call('/progress', 'POST', {
    record: {
      key: `admin:${bInternalId}:vocabulary:v01`,
      cardKey: `${bInternalId}:vocabulary:v01`,
      username: 'admin',
      status: 'known',
      activity: 'quiz'
    }
  }, admin.token);
  assert.equal(progressAdminOnB.status, 200);

  // Verify User B's progress has not been altered or merged with Admin's
  const bProgress = (await call('/progress?username=user_b', 'GET', null, userB.token)).progress;
  assert.equal(bProgress.length, 1);
  assert.equal(bProgress[0].username, 'user_b');

  const adminProgress = (await call('/progress?username=admin', 'GET', null, admin.token)).progress;
  assert.ok(adminProgress.some(p => p.username === 'admin' && p.cardKey === `${bInternalId}:vocabulary:v01`));

  // 9. Admin CAN delete User B's lesson (which also cleans up associated progress records)
  const deleteBbyAdmin = await call(`/lessons/${bInternalId}`, 'DELETE', null, admin.token);
  assert.equal(deleteBbyAdmin.status, 200);

  // Verify progress associated with lesson B was cleaned up
  const bProgressAfter = (await call('/progress?username=user_b', 'GET', null, userB.token)).progress;
  assert.equal(bProgressAfter.filter(p => p.cardKey.startsWith(bInternalId)).length, 0);

  // 10. Temporary Password Flow & Session Revocation
  // Admin generates temporary password for User A
  const tempRes = await call('/auth/users/user_a/password', 'PUT', { temporary: true }, admin.token);
  assert.equal(tempRes.status, 200);
  assert.ok(tempRes.temporaryPassword);
  assert.equal(tempRes.mustChangePassword, true);

  // User A's old session token MUST BE REVOKED immediately
  const oldSessionReq = await call('/lessons', 'GET', null, userA.token);
  assert.equal(oldSessionReq.status, 401);

  // User A logs in with the temporary password
  const tempLogin = await call('/auth/login', 'POST', { username: 'user_a', password: tempRes.temporaryPassword });
  assert.equal(tempLogin.status, 200);
  assert.equal(tempLogin.mustChangePassword, true);
  const newSessionTokenA = tempLogin.token;

  // User A changes password via PUT /api/auth/password
  const changePwdRes = await call('/auth/password', 'PUT', { newPassword: 'new_super_secret_password' }, newSessionTokenA);
  assert.equal(changePwdRes.status, 200);

  // User A logs in with the newly set permanent password
  const finalLogin = await call('/auth/login', 'POST', { username: 'user_a', password: 'new_super_secret_password' });
  assert.equal(finalLogin.status, 200);
  assert.equal(finalLogin.mustChangePassword, false);
});
