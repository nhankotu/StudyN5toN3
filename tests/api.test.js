import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';

const data = { users: [], lessons: [], sessions: [], progress: [] };
function matches(doc, query) {
  return Object.entries(query).every(([key, value]) => value && typeof value === 'object' && '$gt' in value ? doc[key] > value.$gt : doc[key] === value);
}
const db = { collection(name) {
  const rows = data[name];
  return {
    countDocuments: async () => rows.length,
    findOne: async query => rows.find(row => matches(row, query)) || null,
    find: query => ({ sort() { return this; }, toArray: async () => rows.filter(row => matches(row, query)) }),
    insertOne: async doc => { rows.push({ ...doc }); },
    updateOne: async (query, update, options = {}) => {
      let row = rows.find(item => matches(item, query));
      const existed = !!row;
      if (!row && options.upsert) { row = { ...query, ...update.$setOnInsert }; rows.push(row); }
      if (row) Object.assign(row, update.$set);
      return { matchedCount: existed ? 1 : 0 };
    },
    deleteOne: async query => { const index = rows.findIndex(row => matches(row, query)); if (index >= 0) rows.splice(index, 1); },
    deleteMany: async query => { for (let i = rows.length - 1; i >= 0; i--) if (matches(rows[i], query)) rows.splice(i, 1); }
  };
} };
MongoClient.prototype.connect = async function () { return this; };
MongoClient.prototype.db = () => db;
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
  const lesson = { id: 'lesson-1', title: 'Lesson', createdAt: null, vocabulary: [] };
  assert.equal((await call('/lessons', 'POST', { lessons: [lesson] }, admin.token)).status, 200);
  assert.equal((await call('/lessons', 'POST', { lessons: [lesson] }, student.token)).status, 403);
  const record = { key: 'student:lesson-1:vocabulary:v1', username: 'student', cardKey: 'lesson-1:vocabulary:v1', status: 'known', dueAt: 123, intervalDays: 1, reviews: 1 };
  assert.equal((await call('/progress', 'POST', record, student.token)).status, 200);
  assert.equal((await call('/progress', 'GET', null, student.token)).progress.length, 1);
  assert.equal((await call('/progress', 'GET', null, admin.token)).progress.length, 0);
  assert.equal((await call('/progress', 'POST', record, admin.token)).status, 400);
  await call('/auth/logout', 'POST', null, student.token);
  assert.equal((await call('/progress', 'GET', null, student.token)).status, 401);
});
