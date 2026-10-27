// Explicit opt-in check using two temporary records, removed in finally.
import 'dotenv/config';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { MongoClient, ObjectId } from 'mongodb';
import { normalizeLesson } from '../lesson.js';

if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required.');
const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000 });
const marker = `__qa_${crypto.randomUUID()}`;
const lessonId = new ObjectId();
const progressId = new ObjectId();
let db;
try {
  await client.connect();
  db = client.db('nihongo_study');
  const lesson = normalizeLesson({ id: marker, title: 'Temporary verification', readings: [{ id: 'r1', japanese: '私[わたし]は学生[がくせい]です。', translation: 'Tôi là học sinh.' }] });
  await db.collection('lessons').insertOne({ ...lesson, _id: lessonId, createdBy: marker });
  assert.deepEqual((await db.collection('lessons').findOne({ _id: lessonId })).readings, lesson.readings);
  const progress = { _id: progressId, key: `${marker}:card`, username: marker, reviews: 1, status: 'known' };
  await db.collection('progress').insertOne(progress);
  assert.equal((await db.collection('progress').findOne({ _id: progressId })).reviews, 1);
  console.log('Live MongoDB lesson and progress write/read checks passed.');
} catch (error) {
  console.error('Live MongoDB check failed:', error.name);
  process.exitCode = 1;
} finally {
  try {
    if (db) {
      await db.collection('lessons').deleteOne({ _id: lessonId, createdBy: marker });
      await db.collection('progress').deleteOne({ _id: progressId, username: marker });
      console.log('Temporary verification records removed.');
    }
  } catch (error) { console.error('Cleanup failed for marker:', marker, error.name); process.exitCode = 1; }
  await client.close();
}
