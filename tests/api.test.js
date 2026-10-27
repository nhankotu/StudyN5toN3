import test from 'node:test';
import assert from 'node:assert/strict';

import { data } from './helpers/memory-db.js';
process.env.MONGODB_URI = 'mongodb://localhost:27017/test';
process.env.INITIAL_ADMIN_PASSWORD = 'test-password';
const { handler } = await import('../netlify/functions/api.js');
async function call(path, method = 'GET', body, token) {
  const result = await handler({ path: '/api' + path, httpMethod: method, headers: token ? { authorization: `Bearer ${token}` } : {}, body: body ? JSON.stringify(body) : null }, {});
  return { status: result.statusCode, ...JSON.parse(result.body) };
}

test('sessions, authorization, lessons and progress', async () => {
  assert.equal((await call('/lessons')).status, 401);
  const admin = await call('/auth/login', 'POST', { username: 'admin', password: 'test-password' });
  assert.equal(admin.status, 200);
  assert.equal((await call('/auth/users', 'POST', { username: 'student', password: 'pass1234' }, admin.token)).status, 201);
  const student = await call('/auth/login', 'POST', { username: 'student', password: 'pass1234' });
  assert.equal((await call('/auth/users', 'GET', null, student.token)).status, 403);
  const lesson = { id: 'lesson-1', title: 'Lesson', createdAt: null, vocabulary: [{ id: 'v1', japanese: '私', meaning: 'Tôi' }] };
  assert.equal((await call('/lessons', 'POST', { lessons: [lesson] }, admin.token)).status, 200);
  const reading = { id: 'reading-1', title: 'Bài đọc', readings: [{ id: 'r1', title: 'Bài đọc', japanese: '私[わたし]です。', translation: 'Là tôi.' }] };
  assert.equal((await call('/lessons', 'POST', { lessons: [reading] }, admin.token)).status, 200);
  assert.deepEqual((await call('/lessons', 'GET', null, admin.token)).lessons.find(item => item.id === reading.id).readings, reading.readings);
  assert.equal((await call('/lessons', 'POST', { lessons: [lesson] }, student.token)).status, 403);
  assert.equal((await call('/lessons', 'POST', { lessons: [{ id: 'new', title: 'Invalid' }] }, admin.token)).status, 400);
  assert.equal((await call('/lessons', 'POST', { lessons: [reading, reading] }, admin.token)).status, 400);
  const unauthorizedBatch = await call('/lessons', 'POST', { lessons: [{ ...reading, id: 'should-not-exist' }, lesson] }, student.token);
  assert.equal(unauthorizedBatch.status, 403);
  assert.equal(data.lessons.some(item => item.id === 'should-not-exist'), false);
  assert.equal((await call('/auth/users', 'GET', null, admin.token)).users.some(item => 'passwordHash' in item), false);
  const record = { key: 'student:lesson-1:vocabulary:v1', username: 'student', cardKey: 'lesson-1:vocabulary:v1', status: 'known', dueAt: 123, intervalDays: 1, reviews: 1 };
  assert.equal((await call('/progress', 'POST', record, student.token)).status, 200);
  assert.equal((await call('/progress', 'GET', null, student.token)).progress.length, 1);
  assert.equal((await call('/progress', 'GET', null, admin.token)).progress.length, 0);
  assert.equal((await call('/progress', 'POST', record, admin.token)).status, 400);
  assert.equal((await call('/lessons/lesson-1', 'DELETE', null, student.token)).status, 403);
  assert.equal((await call('/auth/users/student/password', 'PUT', { password: 'changed-pass' }, admin.token)).status, 200);
  assert.equal((await call('/progress', 'GET', null, student.token)).status, 401);
  const updatedStudent = await call('/auth/login', 'POST', { username: 'student', password: 'changed-pass' });
  assert.equal(updatedStudent.status, 200);
  await call('/auth/logout', 'POST', null, updatedStudent.token);
  assert.equal((await call('/progress', 'GET', null, updatedStudent.token)).status, 401);
});
