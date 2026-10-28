import fs from 'node:fs';
import path from 'node:path';

const target = path.resolve('public');
fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
for (const item of ['index.html', 'styles.css', 'app.js', 'db.js', 'lesson.js', 'kanji-evaluator.js', 'kanji-strokes.js', 'quiz.js', 'sw.js', 'manifest.webmanifest', 'mau-bai-hoc-chuan.json', 'mau-bai-hoc.json', 'assets', 'data']) {
  if (fs.existsSync(item)) fs.cpSync(item, path.join(target, item), { recursive: true });
}
