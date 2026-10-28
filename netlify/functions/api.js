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
const escapeRegex = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sessionUser = user => ({ username: user.username, name: user.name || user.username, role: user.role, mustChangePassword: !!user.mustChangePassword });

async function resolveMongoSrvViaDoH(uri) {
  try {
    const match = uri.match(/^mongodb\+srv:\/\/([^:]+):([^@]+)@([^/?]+)(\/[^?]*)?(\?.*)?$/);
    if (!match) return uri;
    const [, user, pass, host, pathPart = '', queryPart = ''] = match;
    
    // Phân giải SRV qua Cloudflare DNS-over-HTTPS (DoH)
    const srvUrl = `https://cloudflare-dns.com/dns-query?name=_mongodb._tcp.${host}&type=SRV`;
    const srvRes = await fetch(srvUrl, { headers: { accept: 'application/dns-json' } });
    if (!srvRes.ok) return uri;
    const srvData = await srvRes.json();
    if (!srvData.Answer || !srvData.Answer.length) return uri;

    const hosts = srvData.Answer.map(ans => {
      const parts = String(ans.data).trim().split(/\s+/);
      const port = parts[2] || '27017';
      const target = (parts[3] || '').replace(/\.$/, '');
      return target ? `${target}:${port}` : null;
    }).filter(Boolean);

    if (!hosts.length) return uri;

    // Phân giải TXT để lấy replicaSet và authSource
    let txtParams = 'ssl=true';
    try {
      const txtUrl = `https://cloudflare-dns.com/dns-query?name=${host}&type=TXT`;
      const txtRes = await fetch(txtUrl, { headers: { accept: 'application/dns-json' } });
      if (txtRes.ok) {
        const txtData = await txtRes.json();
        if (txtData.Answer && txtData.Answer.length) {
          const txtRaw = txtData.Answer.map(a => String(a.data).replace(/^"|"$/g, '')).join('&');
          if (txtRaw) txtParams += `&${txtRaw}`;
        }
      }
    } catch {}

    const queryClean = queryPart.replace(/^\?/, '');
    const directUri = `mongodb://${encodeURIComponent(decodeURIComponent(user))}:${encodeURIComponent(decodeURIComponent(pass))}@${hosts.join(',')}${pathPart}?${txtParams}${queryClean ? '&' + queryClean : ''}`;
    console.log(`[DoH Resolver] Đã chuyển đổi mongodb+srv sang direct hosts: ${hosts.length} nút.`);
    return directUri;
  } catch (err) {
    console.warn('[DoH Resolver Error]:', err.message);
    return uri;
  }
}

async function connectToDatabase() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('Chưa cấu hình biến môi trường MONGODB_URI.');
  }

  if (cachedClient && cachedDb) {
    return { client: cachedClient, db: cachedDb };
  }

  if (connectionPromise) return connectionPromise;

  const maskedUri = uri.replace(/\/\/([^:]+):([^@]+)@/, '//$1:****@');
  console.log(`[DB Connect] Bắt đầu kết nối MongoDB...`);
  console.log(`[DB Connect] URI scheme: ${uri.startsWith('mongodb+srv://') ? 'SRV (mongodb+srv)' : 'Direct (mongodb)'}`);
  console.log(`[DB Connect] Masked URI: ${maskedUri}`);

  connectionPromise = (async () => {
    let client;
    try {
      client = new MongoClient(uri, {
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 10000,
        connectTimeoutMS: 10000,
        socketTimeoutMS: 15000
      });
      console.log(`[DB Connect] MongoClient đã tạo, đang gọi client.connect()...`);
      await client.connect();
      console.log(`[DB Connect] ✅ client.connect() thành công!`);
    } catch (connectError) {
      console.error(`[DB Connect] ❌ client.connect() THẤT BẠI!`);
      console.error(`[DB Connect]   Loại lỗi: ${connectError.name}`);
      console.error(`[DB Connect]   Message: ${connectError.message}`);
      if (connectError.cause) {
        console.error(`[DB Connect]   Cause name: ${connectError.cause.name}`);
        console.error(`[DB Connect]   Cause message: ${connectError.cause.message}`);
        if (connectError.cause.code) console.error(`[DB Connect]   Cause code: ${connectError.cause.code}`);
        if (connectError.cause.syscall) console.error(`[DB Connect]   Cause syscall: ${connectError.cause.syscall}`);
        if (connectError.cause.hostname) console.error(`[DB Connect]   Cause hostname: ${connectError.cause.hostname}`);
      }
      if (connectError.reason) {
        const reason = connectError.reason;
        console.error(`[DB Connect]   Topology type: ${reason.type}`);
        if (reason.servers) {
          for (const [addr, desc] of reason.servers) {
            console.error(`[DB Connect]   Server ${addr}: type=${desc.type}, error=${desc.error?.message || 'none'}`);
          }
        }
      }
      await client?.close().catch(() => {});
      throw connectError;
    }

    try {
      const db = client.db('nihongo_study');
      await db.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
      await db.collection('progress').createIndex({ username: 1, key: 1 });
      await db.collection('lessons').createIndex({ id: 1 }, { unique: true });
      await db.collection('users').createIndex({ username: 1 }, { unique: true });
      await seedDatabaseIfEmpty(db);
      cachedClient = client;
      cachedDb = db;
      console.log(`[DB Connect] ✅ Kết nối và tạo index hoàn tất.`);
      return { client, db };
    } catch (error) {
      console.error(`[DB Connect] ❌ Lỗi sau khi connect (index/seed): ${error.message}`);
      await client.close().catch(() => {});
      throw error;
    }
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
  const qIdx = reqPath.indexOf('?');
  if (qIdx !== -1) reqPath = reqPath.slice(0, qIdx);
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
      console.error('[Health Check Error]:', err);
      const uri = process.env.MONGODB_URI;
      const maskedUri = uri ? uri.replace(/\/\/([^:]+):([^@]+)@/, '//$1:****@') : null;
      const uriScheme = uri ? (uri.startsWith('mongodb+srv://') ? 'SRV' : 'Direct') : 'N/A';
      
      // Thu thập chi tiết lỗi từ cause chain
      const causeInfo = err.cause ? {
        name: err.cause.name,
        message: err.cause.message,
        code: err.cause.code,
        syscall: err.cause.syscall,
        hostname: err.cause.hostname
      } : null;

      // Thu thập thông tin topology servers nếu có
      let serverDetails = null;
      if (err.reason && err.reason.servers) {
        serverDetails = {};
        for (const [addr, desc] of err.reason.servers) {
          serverDetails[addr] = {
            type: desc.type,
            error: desc.error?.message || null
          };
        }
      }

      return res(200, {
        ok: false,
        database: 'error',
        message: err.message,
        name: err.name,
        hasMongoUri: !!uri,
        uriScheme,
        maskedUri,
        cause: causeInfo,
        servers: serverDetails,
        hint: !uri ? 'Biến MONGODB_URI chưa được truyền vào Runtime. Kiểm tra Settings > Variables and secrets trên Cloudflare.'
          : err.message.includes('timed out') ? 'Có thể do DNS SRV không phân giải được trên Edge runtime, hoặc IP chưa mở 0.0.0.0/0 trên MongoDB Atlas.'
          : err.message.includes('Authentication') ? 'Username hoặc mật khẩu trong MONGODB_URI không đúng.'
          : 'Xem chi tiết cause và servers để xác định nguyên nhân.'
      });
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
      return res(200, { ok: true, token, user: sessionUser(user), mustChangePassword: !!user.mustChangePassword });
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

    // Đổi mật khẩu cá nhân: /auth/password
    if (reqPath === '/auth/password' && method === 'PUT') {
      const newPassword = String(body.newPassword || '').trim();
      if (newPassword.length < 4) return res(400, { ok: false, message: 'Mật khẩu mới tối thiểu 4 ký tự.' });
      if (!caller.mustChangePassword) {
        const oldPassword = String(body.oldPassword || '');
        if (!verifyPassword(oldPassword, caller.passwordHash)) {
          return res(400, { ok: false, message: 'Mật khẩu cũ không chính xác.' });
        }
      }
      await db.collection('users').updateOne(
        { username: caller.username },
        { $set: { passwordHash: hashPassword(newPassword), mustChangePassword: false, updatedAt: new Date() } }
      );
      return res(200, { ok: true, message: 'Đổi mật khẩu thành công.' });
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

    // Đổi/đặt lại mật khẩu: /auth/users/:username/password
    const pwdMatch = reqPath.match(/^\/auth\/users\/([^/]+)\/password$/);
    if (pwdMatch && method === 'PUT') {
      const targetUser = decodeURIComponent(pwdMatch[1]).toLowerCase();
      let newPassword = String(body.password || '').trim();
      const isTemporary = body.temporary === true || !newPassword;
      if (isTemporary && !newPassword) {
        newPassword = 'Tmp-' + crypto.randomBytes(3).toString('hex') + '!';
      }
      if (newPassword.length < 4) return res(400, { ok: false, message: 'Mật khẩu mới tối thiểu 4 ký tự.' });

      const result = await db.collection('users').updateOne(
        { username: targetUser },
        { $set: { passwordHash: hashPassword(newPassword), mustChangePassword: isTemporary, updatedAt: new Date() } }
      );
      if (result.matchedCount === 0) return res(404, { ok: false, message: 'Không tìm thấy người dùng.' });
      await db.collection('sessions').deleteMany({ username: targetUser });
      return res(200, {
        ok: true,
        temporary: isTemporary,
        mustChangePassword: isTemporary,
        temporaryPassword: isTemporary ? newPassword : undefined,
        message: isTemporary ? `Đã tạo mật khẩu tạm thời cho @${targetUser}.` : `Đã đổi mật khẩu cho @${targetUser}.`
      });
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
    // Người dùng thường: chỉ bài của mình. Admin: xem tất cả bài.
    if (reqPath === '/lessons' && method === 'GET') {
      const query = caller.role === 'admin' ? {} : { createdBy: caller.username };
      const lessons = await db.collection('lessons').find(query).sort({ order: 1, createdAt: -1, title: 1 }).toArray();
      return res(200, { ok: true, lessons });
    }

    const getLessonMatch = reqPath.match(/^\/lessons\/([^/]+)$/);
    if (getLessonMatch && method === 'GET') {
      const lessonId = decodeURIComponent(getLessonMatch[1]);
      const lesson = await db.collection('lessons').findOne({ id: lessonId });
      if (!lesson) return res(404, { ok: false, message: 'Không tìm thấy bài học.' });
      if (caller.role !== 'admin' && lesson.createdBy !== caller.username) {
        return res(403, { ok: false, message: 'Bạn không có quyền truy cập bài học này.' });
      }
      return res(200, { ok: true, lesson });
    }

    // Tạo / import bài học:
    // Cả người dùng và admin chỉ được sửa bài do chính mình sở hữu.
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

      // Kiểm tra quyền sở hữu cho mọi bài học trước khi ghi
      for (const lesson of items) {
        const existing = await db.collection('lessons').findOne({ id: lesson.id });
        if (existing && existing.createdBy !== caller.username) {
          return res(403, { ok: false, message: `Bạn không có quyền sửa bài ${lesson.id}.` });
        }
      }
      let count = 0;
      for (const item of items) {
        const { _id, createdAt, updatedAt, createdBy, ...lesson } = item;
        await db.collection('lessons').updateOne(
          { id: lesson.id },
          { 
            $set: { 
              ...lesson,
              sourceId: lesson.sourceId || lesson.id,
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

    // Sửa trực tiếp bài học & từng mục: /lessons/:id
    const putLessonMatch = reqPath.match(/^\/lessons\/([^/]+)$/);
    if (putLessonMatch && method === 'PUT') {
      const lessonId = decodeURIComponent(putLessonMatch[1]);
      const existing = await db.collection('lessons').findOne({ id: lessonId });
      if (!existing) return res(404, { ok: false, message: 'Không tìm thấy bài học.' });
      if (existing.createdBy !== caller.username) {
        return res(403, { ok: false, message: 'Bạn chỉ có quyền sửa bài học do chính mình tạo.' });
      }
      let normalized;
      try {
        normalized = normalizeLesson({ ...body, id: lessonId });
      } catch (err) {
        return res(400, { ok: false, message: err.message });
      }
      const { _id, createdAt, createdBy, ...updateData } = normalized;
      await db.collection('lessons').updateOne(
        { id: lessonId },
        { 
          $set: { 
            ...updateData,
            sourceId: updateData.sourceId || existing.sourceId || lessonId,
            updatedAt: new Date() 
          } 
        }
      );
      return res(200, { ok: true, message: `Đã cập nhật bài học "${updateData.title}".` });
    }

    // Xóa bài học: /lessons/:id
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
      // Dọn dẹp tiến trình liên quan đến bài học này để tránh rác và gắn nhầm
      await db.collection('progress').deleteMany({
        $or: [
          { lessonId: lessonId },
          { cardKey: { $regex: `^${escapeRegex(lessonId)}:` } }
        ]
      });
      return res(200, { ok: true, message: `Đã xóa bài học ${lessonId}.` });
    }

    // 4. TIẾN ĐỘ HỌC TẬP (PROGRESS)
    if (reqPath === '/progress' && method === 'GET') {
      const username = caller.username;
      const progress = await db.collection('progress').find({ username }).toArray();
      return res(200, { ok: true, progress });
    }

    if (reqPath === '/progress' && method === 'POST') {
      const rec = body?.record || body;
      if (!rec || rec.username !== caller.username || typeof rec.key !== 'string' || typeof rec.cardKey !== 'string') {
        return res(400, { ok: false, message: 'Bản ghi tiến độ không hợp lệ.' });
      }

      // Xác thực quyền xem bài học trước khi ghi tiến trình
      let lessonId = rec.lessonId;
      if (!lessonId && typeof rec.cardKey === 'string') {
        const parts = rec.cardKey.split(':');
        if (parts.length >= 3) {
          lessonId = parts.slice(0, parts.length - 2).join(':') || parts[0];
        } else if (parts.length > 0) {
          lessonId = parts[0];
        }
      }
      if (lessonId) {
        const lesson = await db.collection('lessons').findOne({ id: lessonId });
        if (lesson && caller.role !== 'admin' && lesson.createdBy !== caller.username && lesson.createdBy !== 'admin') {
          return res(403, { ok: false, message: 'Bạn không có quyền lưu tiến độ cho bài học này.' });
        }
      }

      const activity = rec.activity || 'flashcard';
      const updateDoc = {
        key: rec.key,
        username: caller.username,
        cardKey: rec.cardKey,
        lessonId: lessonId || undefined,
        activity,
        status: ['known', 'learning'].includes(rec.status) ? rec.status : 'known',
        updatedAt: Date.now()
      };

      if (activity === 'flashcard') {
        if (!['known', 'learning'].includes(rec.status) || !Number.isFinite(rec.dueAt) || !Number.isFinite(rec.intervalDays) || !Number.isInteger(rec.reviews) || rec.reviews < 1) {
          return res(400, { ok: false, message: 'Bản ghi tiến độ flashcard không hợp lệ.' });
        }
        updateDoc.dueAt = rec.dueAt;
        updateDoc.intervalDays = rec.intervalDays;
        updateDoc.reviews = rec.reviews;
      } else if (activity === 'quiz') {
        updateDoc.needsReview = typeof rec.needsReview === 'boolean' ? rec.needsReview : rec.status === 'learning';
        updateDoc.reviews = Number.isInteger(rec.reviews) ? rec.reviews : 1;
        if (Number.isFinite(rec.score)) updateDoc.score = rec.score;
        if (Number.isFinite(rec.dueAt)) updateDoc.dueAt = rec.dueAt;
        if (Number.isFinite(rec.intervalDays)) updateDoc.intervalDays = rec.intervalDays;
      } else if (activity === 'kanji_write') {
        updateDoc.score = Number.isFinite(rec.score) ? rec.score : 0;
        updateDoc.mode = rec.mode || 'shape';
        updateDoc.passed = typeof rec.passed === 'boolean' ? rec.passed : rec.score >= 80;
        updateDoc.reviews = Number.isInteger(rec.reviews) ? rec.reviews : 1;
      }

      await db.collection('progress').updateOne(
        { key: rec.key, username: caller.username },
        { $set: updateDoc },
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
