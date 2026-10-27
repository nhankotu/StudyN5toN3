import { MongoClient } from 'mongodb';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { normalizeLesson } from '../../lesson.js';

let cachedClient = null;
let cachedDb = null;
let connectionPromise = null;

function hashPassword(plainText) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(String(plainText), salt, 64).toString('hex')}`;
}
function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  if (!stored.startsWith('scrypt$')) return crypto.createHash('sha256').update(String(password)).digest('hex') === stored;
  const [, salt, hash] = stored.split('$');
  if (!salt || !/^[a-f0-9]{128}$/.test(hash || '')) return false;
  return crypto.timingSafeEqual(crypto.scryptSync(String(password), salt, 64), Buffer.from(hash, 'hex'));
}
const tokenHash = token => crypto.createHash('sha256').update(token).digest('hex');
const sessionUser = user => ({ username: user.username, name: user.name || user.username, role: user.role });

async function connectToDatabase() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('Chưa cấu hình biến môi trường MONGODB_URI.');
  }

  if (cachedClient && cachedDb) {
    return { client: cachedClient, db: cachedDb };
  }

  if (connectionPromise) return connectionPromise;
  connectionPromise = (async () => {
  const client = new MongoClient(uri, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5000
  });

  try {
  await client.connect();
  const db = client.db('nihongo_study');
  await db.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection('progress').createIndex({ username: 1, key: 1 });
  // Tự động khởi tạo dữ liệu mẫu nếu DB trống
  await seedDatabaseIfEmpty(db);
  cachedClient = client;
  cachedDb = db;
  return { client, db };
  } catch (error) { await client.close().catch(() => {}); throw error; }
  })();
  try { return await connectionPromise; }
  finally { connectionPromise = null; }
}

async function seedDatabaseIfEmpty(db) {
  try {
    const userCount = await db.collection('users').countDocuments();
    if (userCount === 0 && process.env.INITIAL_ADMIN_PASSWORD?.length >= 8) {
      await db.collection('users').insertOne({
        username: 'admin',
        name: 'Quản trị viên',
        role: 'admin',
        passwordHash: hashPassword(process.env.INITIAL_ADMIN_PASSWORD),
        createdAt: new Date()
      });
      console.log('Đã khởi tạo tài khoản quản trị.');
    }

    const lessonCount = await db.collection('lessons').countDocuments();
    if (lessonCount === 0) {
      // Đọc các bài học tĩnh đi kèm để nạp sẵn vào MongoDB
      const defaultLessonsDir = path.resolve(process.cwd(), 'data', 'lessons');
      if (fs.existsSync(defaultLessonsDir)) {
        const files = fs.readdirSync(defaultLessonsDir).filter(f => f.endsWith('.json'));
        const seedLessons = [];
        for (const file of files) {
          try {
            const content = fs.readFileSync(path.join(defaultLessonsDir, file), 'utf-8');
            const parsed = JSON.parse(content);
            const items = Array.isArray(parsed) ? parsed : (parsed.lessons || [parsed]);
            seedLessons.push(...items);
          } catch (e) {
            console.error('Lỗi đọc file seed:', file, e.message);
          }
        }
        if (seedLessons.length) {
          for (const l of seedLessons) {
            await db.collection('lessons').updateOne({ id: l.id }, { $set: l }, { upsert: true });
          }
          console.log(`Đã nạp ${seedLessons.length} bài học khởi đầu vào MongoDB.`);
        }
      }
    }
  } catch (err) {
    console.error('Lỗi khi seed database:', err);
  }
}

const headers = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
};

function res(status, body) {
  return {
    statusCode: status,
    headers,
    body: JSON.stringify(body)
  };
}

export async function handler(event, context) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  // Chuẩn hóa đường dẫn API
  let reqPath = event.path || '';
  reqPath = reqPath.replace(/^\/\.netlify\/functions\/api/, '').replace(/^\/api/, '');
  if (!reqPath.startsWith('/')) reqPath = '/' + reqPath;

  const method = event.httpMethod;
  let body = {};
  if (event.body) {
    try {
      body = JSON.parse(event.body);
    } catch (e) {
      return res(400, { ok: false, message: 'Nội dung JSON không hợp lệ.' });
    }
  }
  if (!body || typeof body !== 'object') return res(400, { ok: false, message: 'Nội dung yêu cầu phải là JSON object hoặc mảng bài học.' });

  // Health check không cần DB kết nối trước để báo trạng thái cấu hình
  if (reqPath === '/health') {
    try {
      const { db } = await connectToDatabase();
      const [users, lessons] = await Promise.all([
        db.collection('users').countDocuments(),
        db.collection('lessons').countDocuments()
      ]);
      return res(200, { ok: true, database: 'connected', users, lessons });
    } catch (err) {
      return res(200, { ok: false, database: 'error', message: err.message });
    }
  }

  let db;
  try {
    const conn = await connectToDatabase();
    db = conn.db;
  } catch (err) {
    return res(503, {
      ok: false,
      code: 'DB_CONNECTION_ERROR',
      message: 'Chưa thể kết nối MongoDB: ' + err.message
    });
  }

  try {
    // 1. ĐĂNG NHẬP
    if (reqPath === '/auth/login' && method === 'POST') {
      const username = String(body.username || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!username || !password) return res(400, { ok: false, message: 'Vui lòng nhập tên đăng nhập và mật khẩu.' });

      const user = await db.collection('users').findOne({ username });
      if (!user) return res(401, { ok: false, message: 'Tài khoản không tồn tại.' });

      if (!verifyPassword(password, user.passwordHash)) {
        return res(401, { ok: false, message: 'Mật khẩu không chính xác.' });
      }

      if (!user.passwordHash.startsWith('scrypt$')) await db.collection('users').updateOne({ username, passwordHash: user.passwordHash }, { $set: { passwordHash: hashPassword(password) } });
      const token = crypto.randomBytes(32).toString('hex');
      await db.collection('sessions').insertOne({ tokenHash: tokenHash(token), username, expiresAt: new Date(Date.now() + 7 * 86400000) });
      return res(200, { ok: true, token, user: sessionUser(user) });
    }

    const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
    const match = /^Bearer ([a-f0-9]{64})$/.exec(authHeader);
    const session = match && await db.collection('sessions').findOne({ tokenHash: tokenHash(match[1]), expiresAt: { $gt: new Date() } });
    const caller = session && await db.collection('users').findOne({ username: session.username });
    if (!caller) return res(401, { ok: false, message: 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn.' });
    if (reqPath === '/auth/session' && method === 'GET') return res(200, { ok: true, user: sessionUser(caller) });
    if (reqPath === '/auth/logout' && method === 'POST') {
      await db.collection('sessions').deleteOne({ tokenHash: tokenHash(match[1]) });
      return res(200, { ok: true });
    }
    if (reqPath.startsWith('/auth/users') && caller.role !== 'admin') return res(403, { ok: false, message: 'Chỉ quản trị viên có quyền quản lý tài khoản.' });

    // 2. QUẢN LÝ TÀI KHOẢN (USER MANAGEMENT)
    if (reqPath === '/auth/users' && method === 'GET') {
      const users = await db.collection('users').find({}, { projection: { passwordHash: 0 } }).toArray();
      return res(200, { ok: true, users });
    }

    if (reqPath === '/auth/users' && method === 'POST') {
      const username = String(body.username || '').trim().toLowerCase();
      const name = String(body.name || '').trim();
      const password = String(body.password || '');
      const role = body.role === 'admin' ? 'admin' : 'user';

      if (!username || username.length < 3) return res(400, { ok: false, message: 'Tên đăng nhập tối thiểu 3 ký tự.' });
      if (!password || password.length < 4) return res(400, { ok: false, message: 'Mật khẩu tối thiểu 4 ký tự.' });

      const existing = await db.collection('users').findOne({ username });
      if (existing) return res(400, { ok: false, message: `Tài khoản @${username} đã tồn tại.` });

      const newUser = {
        username,
        name: name || username,
        role,
        passwordHash: hashPassword(password),
        createdAt: new Date()
      };
      await db.collection('users').insertOne(newUser);
      return res(201, { ok: true, message: `Tạo tài khoản @${username} thành công!` });
    }

    // Đổi mật khẩu: /auth/users/:username/password
    const pwdMatch = reqPath.match(/^\/auth\/users\/([^/]+)\/password$/);
    if (pwdMatch && method === 'PUT') {
      const targetUser = decodeURIComponent(pwdMatch[1]).toLowerCase();
      const newPassword = String(body.password || '');
      if (newPassword.length < 4) return res(400, { ok: false, message: 'Mật khẩu mới tối thiểu 4 ký tự.' });

      const result = await db.collection('users').updateOne(
        { username: targetUser },
        { $set: { passwordHash: hashPassword(newPassword), updatedAt: new Date() } }
      );
      if (result.matchedCount === 0) return res(404, { ok: false, message: 'Không tìm thấy người dùng.' });
      await db.collection('sessions').deleteMany({ username: targetUser });
      return res(200, { ok: true, message: `Đã đổi mật khẩu cho @${targetUser}.` });
    }

    // Xóa tài khoản: /auth/users/:username
    const delUserMatch = reqPath.match(/^\/auth\/users\/([^/]+)$/);
    if (delUserMatch && method === 'DELETE') {
      const targetUser = decodeURIComponent(delUserMatch[1]).toLowerCase();
      if (targetUser === 'admin') return res(400, { ok: false, message: 'Không được xóa tài khoản quản trị gốc.' });
      await db.collection('users').deleteOne({ username: targetUser });
      await db.collection('sessions').deleteMany({ username: targetUser });
      return res(200, { ok: true, message: `Đã xóa tài khoản @${targetUser}.` });
    }

    // 3. BÀI HỌC (LESSONS)
    if (reqPath === '/lessons' && method === 'GET') {
      const lessons = await db.collection('lessons').find({}).sort({ order: 1, createdAt: -1, title: 1 }).toArray();
      return res(200, { ok: true, lessons });
    }

    if (reqPath === '/lessons' && method === 'POST') {
      const payload = body;
      const creator = caller.username;
      let items;
      try {
        const rawItems = Array.isArray(payload) ? payload : (payload.lessons || [payload]);
        if (!Array.isArray(rawItems) || !rawItems.length) throw new Error('Danh sách bài học trống hoặc không hợp lệ.');
        items = rawItems.map(item => normalizeLesson(item));
        if (new Set(items.map(item => item.id)).size !== items.length) throw new Error('Trùng mã bài học trong cùng lần nhập.');
      } catch (error) { return res(400, { ok: false, message: error.message }); }
      // Check every lesson before writing any of the batch.
      for (const lesson of items) {
        const existing = await db.collection('lessons').findOne({ id: lesson.id });
        if (existing && caller.role !== 'admin' && existing.createdBy !== caller.username) return res(403, { ok: false, message: `Bạn không có quyền sửa bài ${lesson.id}.` });
      }
      let count = 0;
      for (const item of items) {
        const { _id, createdAt, updatedAt, createdBy, ...lesson } = item;
        await db.collection('lessons').updateOne(
          { id: lesson.id },
          { 
            $set: { 
              ...lesson,
              updatedAt: new Date() 
            },
            $setOnInsert: {
              createdAt: new Date(),
              createdBy: creator
            }
          },
          { upsert: true }
        );
        count++;
      }
      return res(200, { ok: true, count, message: `Đã lưu ${count} bài học vào MongoDB cho @${creator}.` });
    }

    const delLessonMatch = reqPath.match(/^\/lessons\/([^/]+)$/);
    if (delLessonMatch && method === 'DELETE') {
      const lessonId = decodeURIComponent(delLessonMatch[1]);
      
      const existingLesson = await db.collection('lessons').findOne({ id: lessonId });
      if (!existingLesson) {
        return res(404, { ok: false, message: 'Không tìm thấy bài học cần xóa.' });
      }

      if (caller.role !== 'admin' && existingLesson.createdBy !== caller.username) {
        return res(403, { ok: false, message: 'Bạn chỉ có quyền xóa bài học do chính mình tải lên.' });
      }

      await db.collection('lessons').deleteOne({ id: lessonId });
      return res(200, { ok: true, message: `Đã xóa bài học ${lessonId}.` });
    }

    // 4. TIẾN ĐỘ HỌC TẬP (PROGRESS)
    if (reqPath === '/progress' && method === 'GET') {
      const username = caller.username;

      const progress = await db.collection('progress').find({ username }).toArray();
      return res(200, { ok: true, progress });
    }

    if (reqPath === '/progress' && method === 'POST') {
      const rec = body;
      if (!rec || rec.username !== caller.username || typeof rec.key !== 'string' || typeof rec.cardKey !== 'string' || rec.key !== `${rec.username}:${rec.cardKey}` || !['known', 'learning'].includes(rec.status) || !Number.isFinite(rec.dueAt) || !Number.isFinite(rec.intervalDays) || !Number.isInteger(rec.reviews) || rec.reviews < 1) {
        return res(400, { ok: false, message: 'Bản ghi tiến độ không hợp lệ.' });
      }
      await db.collection('progress').updateOne(
        { key: rec.key, username: rec.username },
        { $set: { key: rec.key, username: rec.username, cardKey: rec.cardKey, status: rec.status, dueAt: rec.dueAt, intervalDays: rec.intervalDays, reviews: rec.reviews, updatedAt: Date.now() } },
        { upsert: true }
      );
      return res(200, { ok: true });
    }

    return res(404, { ok: false, message: `Endpoint không tồn tại: ${method} ${reqPath}` });
  } catch (err) {
    console.error('API Error:', err);
    return res(500, { ok: false, message: 'Lỗi máy chủ nội bộ: ' + err.message });
  }
}
