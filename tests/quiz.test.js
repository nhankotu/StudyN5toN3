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

test('buildQuizSession supports lessons with contentType all, vocabulary only, and grammar only', () => {
  const sampleLessons = [
    {
      id: 'l1',
      title: 'Bài 1',
      vocabulary: [
        { id: 'v1', japanese: '私', meaning: 'Tôi' },
        { id: 'v2', japanese: 'あなた', meaning: 'Bạn' },
        { id: 'v3', japanese: '先生', meaning: 'Giáo viên' },
        { id: 'v4', japanese: '学生', meaning: 'Học sinh' }
      ],
      grammar: [
        { id: 'g1', title: 'N1 は N2 です', pattern: 'N1 は N2 です', meaning: 'N1 là N2' },
        { id: 'g2', title: 'か', pattern: 'ですか', meaning: 'phải không' },
        { id: 'g3', title: 'も', pattern: 'N cũng', meaning: 'cũng là' },
        { id: 'g4', title: 'じゃありません', pattern: 'phủ định', meaning: 'không phải là' }
      ],
      kanji: [
        { id: 'k1', character: '人', meaning: 'Người', onyomi: 'ジン', kunyomi: 'ひと' },
        { id: 'k2', character: '日', meaning: 'Ngày', onyomi: 'ニチ', kunyomi: 'ひ' },
        { id: 'k3', character: '学', meaning: 'Học', onyomi: 'ガク', kunyomi: 'まなぶ' },
        { id: 'k4', character: '生', meaning: 'Sinh', onyomi: 'セイ', kunyomi: 'いきる' }
      ]
    }
  ];

  // 1. Cả bài (Trộn toàn bộ: vocab + grammar + kanji)
  const fullSession = buildQuizSession(sampleLessons, {
    contentType: 'all',
    mode: 'all_mix'
  });
  assert.equal(fullSession.success, true);
  assert.equal(fullSession.questions.length, 12); // 4 vocab + 4 grammar + 4 kanji
  const types = new Set(fullSession.questions.map(q => q.itemType));
  assert.ok(types.has('vocabulary'));
  assert.ok(types.has('grammar'));
  assert.ok(types.has('kanji'));

  // 2. Chỉ từ vựng (Trộn cả 2 chiều Nhật->Việt & Việt->Nhật)
  const vocabSession = buildQuizSession(sampleLessons, {
    contentType: 'vocabulary',
    mode: 'vocab_mix'
  });
  assert.equal(vocabSession.success, true);
  assert.equal(vocabSession.questions.length, 4);
  assert.ok(vocabSession.questions.every(q => q.itemType === 'vocabulary'));

  // 3. Chỉ mẫu câu
  const grammarSession = buildQuizSession(sampleLessons, {
    contentType: 'grammar',
    mode: 'grammar_meaning'
  });
  assert.equal(grammarSession.success, true);
  assert.equal(grammarSession.questions.length, 4);
  assert.ok(grammarSession.questions.every(q => q.itemType === 'grammar'));

  // 4. Chỉ ôn tập các câu Cần ôn tập (needsReview)
  const progressMap = new Map();
  progressMap.set('l1:vocabulary:v1', { needsReview: true, status: 'learning' });
  progressMap.set('l1:grammar:g2', { needsReview: true, status: 'learning' });

  const reviewSession = buildQuizSession(sampleLessons, {
    contentType: 'all',
    onlyReview: true,
    progressMap
  });
  assert.equal(reviewSession.success, true);
  assert.equal(reviewSession.questions.length, 2);

  // 5. Khi không có câu nào cần ôn tập -> trả về thông báo lỗi thân thiện
  const emptyReviewSession = buildQuizSession(sampleLessons, {
    contentType: 'all',
    onlyReview: true,
    progressMap: new Map()
  });
  assert.equal(emptyReviewSession.success, false);
  assert.equal(emptyReviewSession.error, 'NO_REVIEW_ITEMS');
});
