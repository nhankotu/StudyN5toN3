/**
 * Quiz and Spaced Review Engine for Nihongo Study
 * Pure deterministic logic for 4-option questions and review state management.
 */

import { stripFurigana } from './lesson.js';

export const QUIZ_RULES_EXPLANATION = `Quy tắc ôn tập trắc nghiệm:
1. Khi trả lời sai một câu: Từ/mục đó sẽ được đưa vào danh sách "Cần ôn tập".
2. Khi ôn tập trong danh sách và trả lời đúng: Mục đó sẽ được hoàn thành và gỡ khỏi danh sách cần ôn (lịch sử vẫn được lưu).
3. Nếu trả lời sai lần nữa trong tương lai: Mục đó sẽ quay lại danh sách cần ôn.`;

export function normalizeAnswer(text) {
  if (!text) return '';
  return stripFurigana(String(text))
    .toLowerCase()
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Generates 4 distinct choices (1 correct + 3 distractors) for a given item.
 * Strictly uses only items from the accessible pool; never fabricates dummy answers.
 */
export function generateQuestionChoices(targetItem, candidatePool, getPrompt, getAnswer) {
  const correctAnswer = getAnswer(targetItem);
  const normalizedCorrect = normalizeAnswer(correctAnswer);

  if (!normalizedCorrect) {
    throw new Error('Mục câu hỏi không có đáp án hợp lệ.');
  }

  // Collect candidate distractors with distinct normalized answers
  const seenNormalized = new Set([normalizedCorrect]);
  const validDistractors = [];

  // Shuffle pool to ensure random distractors each time
  const shuffledCandidates = [...candidatePool].sort(() => Math.random() - 0.5);

  for (const item of shuffledCandidates) {
    if (item.id === targetItem.id && item.lessonId === targetItem.lessonId) continue;
    const ans = getAnswer(item);
    const norm = normalizeAnswer(ans);
    if (norm && !seenNormalized.has(norm)) {
      seenNormalized.add(norm);
      validDistractors.push(ans);
      if (validDistractors.length === 3) break;
    }
  }

  if (validDistractors.length < 3) {
    return {
      success: false,
      error: 'INSUFFICIENT_DISTRACTORS',
      message: `Chưa đủ 3 lựa chọn nhiễu phù hợp (chỉ tìm thấy ${validDistractors.length}/3). Vui lòng chọn thêm bài học hoặc nạp thêm nội dung để bắt đầu trắc nghiệm.`
    };
  }

  const choices = [correctAnswer, ...validDistractors];
  // Shuffle choices
  for (let i = choices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [choices[i], choices[j]] = [choices[j], choices[i]];
  }

  return {
    success: true,
    prompt: getPrompt(targetItem),
    correctAnswer,
    choices,
    targetItem
  };
}

/**
 * Builds a full quiz session from items.
 * @param {Array<object>} items Accessible study items
 * @param {'vocab_ja_vi'|'vocab_vi_ja'|'kanji_meaning'|'kanji_reading'|'grammar_meaning'} mode
 * @param {boolean} shuffleQuestions Whether to randomize question order
 * @param {Array<object>} distractorPool Optional broader pool of accessible items for distractors
 */
export function buildQuizSession(items, mode = 'vocab_ja_vi', shuffleQuestions = true, distractorPool = null) {
  if (!items || items.length === 0) {
    return { success: false, message: 'Danh sách mục học trống.', questions: [] };
  }

  const pool = distractorPool && distractorPool.length > 0 ? distractorPool : items;

  let getPrompt, getAnswer;
  if (mode === 'vocab_vi_ja') {
    getPrompt = item => item.meaning;
    getAnswer = item => item.ruby || item.japanese;
  } else if (mode === 'kanji_meaning') {
    getPrompt = item => item.character;
    getAnswer = item => item.meaning;
  } else if (mode === 'kanji_reading') {
    getPrompt = item => `${item.character} (${item.meaning})`;
    getAnswer = item => [item.onyomi, item.kunyomi].filter(x => x && x !== '—').join(' / ') || item.reading || item.meaning;
  } else if (mode === 'grammar_meaning') {
    getPrompt = item => item.pattern || item.title;
    getAnswer = item => item.meaning;
  } else {
    // Default: vocab_ja_vi
    getPrompt = item => item.ruby || item.japanese;
    getAnswer = item => item.meaning;
  }

  const questions = [];
  const questionItems = shuffleQuestions ? [...items].sort(() => Math.random() - 0.5) : [...items];

  for (const item of questionItems) {
    const q = generateQuestionChoices(item, pool, getPrompt, getAnswer);
    if (!q.success) {
      return {
        success: false,
        error: q.error,
        message: q.message,
        questions: []
      };
    }
    questions.push(q);
  }

  return {
    success: true,
    mode,
    questions,
    total: questions.length
  };
}

/**
 * Review state transition rule (Plan Section 7)
 * - Wrong answer -> added to needsReview list (status: 'learning', needsReview: true)
 * - Correct answer while in review -> removed from needsReview (status: 'known', needsReview: false, history preserved)
 * - Wrong answer again -> returned to needsReview
 */
export function updateReviewStatus(currentRecord, isCorrect) {
  const reviews = (currentRecord?.reviews || 0) + 1;
  const now = Date.now();

  if (!isCorrect) {
    return {
      status: 'learning',
      needsReview: true,
      reviews,
      lastAnsweredAt: now,
      updatedAt: now
    };
  }

  return {
    status: 'known',
    needsReview: false,
    reviews,
    lastAnsweredAt: now,
    updatedAt: now
  };
}
