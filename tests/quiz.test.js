import test from 'node:test';
import assert from 'node:assert/strict';
import { generateQuestionChoices, buildQuizSession, updateReviewStatus, normalizeAnswer } from '../quiz.js';

test('normalizeAnswer strips punctuation and furigana', () => {
  assert.equal(normalizeAnswer(' 私[わたし] '), '私');
  assert.equal(normalizeAnswer('Đi học... !'), 'đi học');
});

test('generateQuestionChoices creates 4 distinct choices from candidate pool', () => {
  const pool = [
    { id: 'v1', japanese: '私', meaning: 'Tôi' },
    { id: 'v2', japanese: 'あなた', meaning: 'Bạn' },
    { id: 'v3', japanese: '先生', meaning: 'Giáo viên' },
    { id: 'v4', japanese: '学生', meaning: 'Học sinh' },
    { id: 'v5', japanese: '本', meaning: 'Sách' }
  ];

  const res = generateQuestionChoices(pool[0], pool, item => item.japanese, item => item.meaning);
  assert.equal(res.success, true);
  assert.equal(res.correctAnswer, 'Tôi');
  assert.equal(res.choices.length, 4);
  assert.ok(res.choices.includes('Tôi'));
  // Ensure all 4 choices are unique
  assert.equal(new Set(res.choices).size, 4);
});

test('generateQuestionChoices returns error if fewer than 3 valid distractors exist', () => {
  const smallPool = [
    { id: 'v1', japanese: '私', meaning: 'Tôi' },
    { id: 'v2', japanese: 'あなた', meaning: 'Bạn' }
  ];

  const res = generateQuestionChoices(smallPool[0], smallPool, item => item.japanese, item => item.meaning);
  assert.equal(res.success, false);
  assert.equal(res.error, 'INSUFFICIENT_DISTRACTORS');
  assert.match(res.message, /Chưa đủ 3 lựa chọn nhiễu/);
});

test('buildQuizSession builds questions and shuffles properly', () => {
  const items = [
    { id: 'v1', japanese: '私', meaning: 'Tôi' },
    { id: 'v2', japanese: 'あなた', meaning: 'Bạn' },
    { id: 'v3', japanese: '先生', meaning: 'Giáo viên' },
    { id: 'v4', japanese: '学生', meaning: 'Học sinh' },
    { id: 'v5', japanese: '本', meaning: 'Sách' }
  ];

  const session = buildQuizSession(items, 'vocab_ja_vi', true);
  assert.equal(session.success, true);
  assert.equal(session.questions.length, items.length);
  for (const q of session.questions) {
    assert.equal(q.choices.length, 4);
    assert.ok(q.choices.includes(q.correctAnswer));
  }
});

test('updateReviewStatus follows state transition rule', () => {
  // Initial wrong answer -> needsReview: true
  const r1 = updateReviewStatus(null, false);
  assert.equal(r1.status, 'learning');
  assert.equal(r1.needsReview, true);
  assert.equal(r1.reviews, 1);

  // Correct answer when in review -> needsReview: false, history preserved
  const r2 = updateReviewStatus(r1, true);
  assert.equal(r2.status, 'known');
  assert.equal(r2.needsReview, false);
  assert.equal(r2.reviews, 2);

  // Wrong answer again -> returns to needsReview: true
  const r3 = updateReviewStatus(r2, false);
  assert.equal(r3.status, 'learning');
  assert.equal(r3.needsReview, true);
  assert.equal(r3.reviews, 3);
});
