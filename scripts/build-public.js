import fs from 'node:fs';
import path from 'node:path';

const target = path.resolve('public');
fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
for (const item of ['index.html', 'styles.css', 'app.js', 'db.js', 'sw.js', 'manifest.webmanifest', 'assets', 'data']) {
  fs.cpSync(item, path.join(target, item), { recursive: true });
}
