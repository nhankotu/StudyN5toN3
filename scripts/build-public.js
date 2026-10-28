import fs from 'node:fs';
import path from 'node:path';

const target = path.resolve('public');
fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
for (const item of ['index.html', 'styles.css', 'app.js', 'db.js', 'lesson.js', 'kanji-evaluator.js', 'kanji-strokes.js', 'quiz.js', 'sw.js', 'manifest.webmanifest', 'mau-bai-hoc-chuan.json', 'mau-bai-hoc.json', 'assets', 'data']) {
  if (fs.existsSync(item)) fs.cpSync(item, path.join(target, item), { recursive: true });
}

// ==================== KIỂM TRA & DEBUG KẾT NỐI MONGODB TRONG BƯỚC BUILD ====================
console.log('\n======================================================');
console.log('🔍 [BUILD DEBUG] Kiểm tra cấu hình và kết nối MongoDB Atlas...');
const uri = process.env.MONGODB_URI;

if (!uri) {
  console.log('ℹ️ [BUILD DEBUG] Biến môi trường MONGODB_URI KHÔNG CÓ trong bước Build.');
  console.log('   👉 Lưu ý Cloudflare: Nếu bạn vừa thêm biến ở Settings > Variables and secrets,');
  console.log('      Cloudflare Pages mặc định có thể chỉ gán cho "Runtime".');
  console.log('      Để biến xuất hiện ở đây, hãy chọn phạm vi là "Build and runtime".');
} else {
  const maskedUri = uri.replace(/\/\/([^:]+):([^@]+)@/, '//$1:****@');
  console.log(`📡 [BUILD DEBUG] Đã nhận diện MONGODB_URI: ${maskedUri}`);
  
  try {
    const { MongoClient } = await import('mongodb');
    console.log('⏳ [BUILD DEBUG] Đang thử kết nối trực tiếp tới MongoDB Atlas (timeout 8s)...');
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000 });
    await client.connect();
    console.log('✅ [BUILD DEBUG] KẾT NỐI MONGODB ATLAS THÀNH CÔNG RỰC RỠ TRONG BUILD!');
    const db = client.db('nihongo_study');
    const [userCount, lessonCount] = await Promise.all([
      db.collection('users').countDocuments().catch(() => 0),
      db.collection('lessons').countDocuments().catch(() => 0)
    ]);
    console.log(`📊 [BUILD DEBUG] Dữ liệu hiện có: ${userCount} người dùng, ${lessonCount} bài học.`);
    await client.close();
  } catch (err) {
    console.error('❌ [BUILD DEBUG] LỖI KẾT NỐI MONGODB KHI BUILD:');
    console.error(`   - Loại lỗi (name): ${err.name}`);
    console.error(`   - Chi tiết (message): ${err.message}`);
    if (err.cause) console.error(`   - Nguyên nhân gốc (cause):`, err.cause);
    console.log('\n👉 Gợi ý chẩn đoán lỗi:');
    console.log('   • Nếu lỗi "Server selection timed out": Chưa mở IP 0.0.0.0/0 trên MongoDB Atlas > Network Access.');
    console.log('   • Nếu lỗi "Authentication failed": Sai username hoặc mật khẩu trong chuỗi MONGODB_URI.');
    console.log('   • Nếu lỗi "querySrv ENOTFOUND": Cụm cluster trong URI không tồn tại hoặc lỗi DNS.');
  }
}
console.log('======================================================\n');

