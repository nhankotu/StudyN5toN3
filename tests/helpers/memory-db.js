import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';

// Isolated in-memory MongoDB adapter for tests; never used by production.
export const data = { users: [], lessons: [], sessions: [], progress: [] };
function matches(doc, query) {
  if (!query || Object.keys(query).length === 0) return true;
  if (query.$or && Array.isArray(query.$or)) {
    return query.$or.some(subQuery => matches(doc, subQuery));
  }
  return Object.entries(query).every(([key, value]) => {
    if (value && typeof value === 'object') {
      if ('$gt' in value) return doc[key] > value.$gt;
      if ('$regex' in value) return new RegExp(value.$regex).test(String(doc[key] ?? ''));
    }
    return doc[key] === value;
  });
}
export const db = { collection(name) {
  const rows = data[name];
  return {
    createIndex: async () => 'test-index',
    countDocuments: async () => rows.length,
    findOne: async query => rows.find(row => matches(row, query)) || null,
    find: (query, options = {}) => ({ sort() { return this; }, toArray: async () => rows.filter(row => matches(row, query)).map(row => {
      const copy = { ...row };
      for (const [key, value] of Object.entries(options.projection || {})) if (value === 0) delete copy[key];
      return copy;
    }) }),
    insertOne: async doc => { rows.push({ ...doc }); },
    updateOne: async (query, update, options = {}) => {
      for (const key of Object.keys(update.$set || {})) assert.ok(!(key in (update.$setOnInsert || {})), `MongoDB update conflict: ${key}`);
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
