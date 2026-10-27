import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLesson, renderFurigana, splitReadingText } from '../app.js';

test('reading-only lessons preserve text and translation', () => {
  const lesson = normalizeLesson({ id: 'read-1', title: 'Bài đọc', readings: [{ japanese: '私[わたし]です。\n学校[がっこう]へ行[い]きます。', translation: 'Là tôi.\nĐi học.' }] });
  assert.equal(lesson.readings[0].id, 'r1');
  assert.match(lesson.readings[0].translation, /Đi học/);
  assert.match(renderFurigana(lesson.readings[0].japanese), /<ruby>私<rt>わたし<\/rt><\/ruby>/);
  assert.deepEqual(splitReadingText(lesson.readings[0].japanese), ['私です。\n学校へ行きます。']);
  assert.throws(() => normalizeLesson({ id: 'x', title: 'Rỗng', readings: [{ japanese: '' }] }), /không có nội dung/);
  assert.throws(() => normalizeLesson({ id: 'x', title: 'Trùng', readings: [{ id: 'r', japanese: 'あ' }, { id: 'r', japanese: 'い' }] }), /bị trùng/);
  assert.equal(renderFurigana('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
});

test('long passages are split without losing characters', () => {
  const text = 'あ'.repeat(320);
  const chunks = splitReadingText(text);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(''), text);
});
