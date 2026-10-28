import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';

dotenv.config();

const uri = process.env.MONGODB_URI;

export async function runMigration(options = {}) {
  const isDryRun = options.dryRun ?? process.argv.includes('--dry-run');
  const doRollback = options.rollbackFile || process.argv.find(a => a.startsWith('--rollback='))?.split('=')[1];
  const customClient = options.client;

  if (!uri && !customClient) {
    throw new Error('Chưa cấu hình MONGODB_URI.');
  }

  const client = customClient || new MongoClient(uri);
  if (!customClient) await client.connect();
  const db = client.db('nihongo_study');

  try {
    // 1. ROLLBACK MODE
    if (doRollback) {
      const backupPath = path.resolve(doRollback);
      if (!fs.existsSync(backupPath)) throw new Error(`Không tìm thấy file sao lưu: ${backupPath}`);
      const data = JSON.parse(fs.readFileSync(backupPath, 'utf-8'));
      console.log(`[ROLLBACK] Khôi phục dữ liệu từ ${backupPath}...`);
      for (const colName of ['users', 'lessons', 'progress']) {
        if (Array.isArray(data[colName])) {
          await db.collection(colName).deleteMany({});
          if (data[colName].length) {
            await db.collection(colName).insertMany(data[colName]);
          }
          console.log(`[ROLLBACK] Đã khôi phục ${data[colName].length} bản ghi vào collection ${colName}.`);
        }
      }
      return { success: true, rollback: true };
    }

    // 2. BACKUP
    const backupDir = path.resolve('data', 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = path.join(backupDir, `backup-${timestamp}.json`);

    const users = await db.collection('users').find({}).toArray();
    const lessons = await db.collection('lessons').find({}).toArray();
    const progress = await db.collection('progress').find({}).toArray();

    const snapshot = {
      timestamp: new Date().toISOString(),
      counts: { users: users.length, lessons: lessons.length, progress: progress.length },
      users,
      lessons,
      progress
    };

    if (!isDryRun) {
      fs.writeFileSync(backupFile, JSON.stringify(snapshot, null, 2), 'utf-8');
      console.log(`[BACKUP] Đã sao lưu dữ liệu vào ${backupFile}`);
    } else {
      console.log(`[DRY-RUN] Dự kiến sao lưu: ${users.length} users, ${lessons.length} lessons, ${progress.length} progress.`);
    }

    // 3. THỐNG KÊ VÀ KIỂM TRA BÀI HỌC VÔ CHỦ & XUNG ĐỘT
    const unownedLessons = lessons.filter(l => !l.createdBy);
    const lessonIdCounts = new Map();
    for (const l of lessons) {
      lessonIdCounts.set(l.id, (lessonIdCounts.get(l.id) || 0) + 1);
    }
    const duplicateIds = [...lessonIdCounts.entries()].filter(([, c]) => c > 1).map(([id]) => id);

    console.log(`[AUDIT] Tổng bài học: ${lessons.length}`);
    console.log(`[AUDIT] Bài học chưa có chủ sở hữu (createdBy rỗng): ${unownedLessons.length}`);
    if (duplicateIds.length) {
      console.warn(`[AUDIT CẢNH BÁO] Phát hiện ${duplicateIds.length} mã bài học bị trùng lặp:`, duplicateIds);
    }

    // 4. CHUẨN HÓA BÀI HỌC
    let lessonsUpdated = 0;
    for (const l of lessons) {
      const updates = {};
      if (!l.sourceId) updates.sourceId = l.id;
      if (!l.createdBy) updates.createdBy = 'admin'; // Gán mặc định admin nếu vô chủ
      if (!l.createdAt) updates.createdAt = new Date();
      if (Object.keys(updates).length > 0) {
        lessonsUpdated++;
        if (!isDryRun) {
          await db.collection('lessons').updateOne({ _id: l._id }, { $set: updates });
        }
      }
    }

    // 5. CHUẨN HÓA TIẾN ĐỘ
    let progressUpdated = 0;
    let orphanedProgress = 0;
    const existingLessonIds = new Set(lessons.map(l => l.id));

    for (const p of progress) {
      const updates = {};
      if (!p.activity) updates.activity = 'flashcard';
      let lId = p.lessonId;
      if (!lId && typeof p.cardKey === 'string') {
        const parts = p.cardKey.split(':');
        if (parts.length >= 3) {
          lId = parts.slice(0, parts.length - 2).join(':') || parts[0];
        } else if (parts.length > 0) {
          lId = parts[0];
        }
        if (lId) updates.lessonId = lId;
      }
      if (lId && !existingLessonIds.has(lId)) {
        orphanedProgress++;
      }
      if (Object.keys(updates).length > 0) {
        progressUpdated++;
        if (!isDryRun) {
          await db.collection('progress').updateOne({ _id: p._id }, { $set: updates });
        }
      }
    }
    console.log(`[AUDIT] Tiến độ không còn bài học tương ứng (orphaned): ${orphanedProgress}`);
    console.log(`[MIGRATION] Bài học cần cập nhật: ${lessonsUpdated}, Tiến độ cần cập nhật: ${progressUpdated}`);

    // 6. TẠO CHỈ MỤC DUY NHẤT (UNIQUE INDEXES)
    if (!isDryRun) {
      await db.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
      await db.collection('users').createIndex({ username: 1 }, { unique: true });
      await db.collection('lessons').createIndex({ id: 1 }, { unique: true });
      await db.collection('progress').createIndex({ username: 1, key: 1 }, { unique: true });
      console.log(`[INDEXES] Đã đảm bảo tất cả chỉ mục duy nhất.`);
    }

    return {
      success: true,
      isDryRun,
      backupFile: isDryRun ? null : backupFile,
      stats: {
        totalLessons: lessons.length,
        unownedLessons: unownedLessons.length,
        duplicateLessonIds: duplicateIds.length,
        lessonsUpdated,
        totalProgress: progress.length,
        orphanedProgress,
        progressUpdated
      }
    };
  } finally {
    if (!customClient) await client.close();
  }
}

if (process.argv[1] && process.argv[1].endsWith('migrate.js')) {
  runMigration().then(res => {
    console.log('\n✓ Hoàn tất xử lý migration:', res);
    process.exit(0);
  }).catch(err => {
    console.error('\n✕ Lỗi migration:', err.message);
    process.exit(1);
  });
}
