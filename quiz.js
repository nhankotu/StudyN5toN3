/**
 * Quiz and Spaced Review Engine for Nihongo Study
 * Pure deterministic logic for 4-option questions and review state management.
 */

import { stripFurigana } from './lesson.js';

export const QUIZ_RULES_EXPLANATION = `Quy tắc ôn tập trắc nghiệm:
1. Khi trả lời sai một câu: Mục đó sẽ tự động được đưa vào danh sách "Cần ôn tập".
2. Khi ôn tập trong danh sách và trả lời đúng: Mục đó sẽ được đánh dấu hoàn thành và gỡ khỏi danh sách cần ôn (lịch sử ôn tập vẫn được bảo lưu).
3. Nếu trả lời sai lần nữa trong tương lai: Mục đó sẽ tự động quay lại danh sách cần ôn.`;

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

  const options = choices.map(text => ({
    text,
    isCorrect: text === correctAnswer
  }));

  return {
    success: true,
    prompt: getPrompt(targetItem),
    correctAnswer,
    choices,
    options,
    targetItem
  };
}

/**
 * Configuration helper for specific question modes
 */
function getModeHandlers(mode, vocabPool, grammarPool, kanjiPool) {
  switch (mode) {
    case 'vocab_vi_ja':
      return {
        modeLabel: 'Từ vựng: Việt ➔ Nhật',
        pool: vocabPool,
        getPrompt: item => item.meaning,
        getAnswer: item => item.ruby || item.japanese,
        getReading: () => '',
        speakTarget: 'correctAnswer'
      };
    case 'grammar_meaning':
      return {
        modeLabel: 'Mẫu câu: Ý nghĩa',
        pool: grammarPool,
        getPrompt: item => item.pattern || item.title,
        getAnswer: item => item.meaning,
        getReading: () => '',
        speakTarget: 'prompt'
      };
    case 'grammar_vi_ja':
      return {
        modeLabel: 'Mẫu câu: Nghĩa ➔ Mẫu câu',
        pool: grammarPool,
        getPrompt: item => item.meaning,
        getAnswer: item => item.pattern || item.title,
        getReading: () => '',
        speakTarget: 'correctAnswer'
      };
    case 'kanji_meaning':
      return {
        modeLabel: 'Chữ Hán: Nghĩa Hán Việt',
        pool: kanjiPool,
        getPrompt: item => item.character,
        getAnswer: item => item.meaning,
        getReading: () => '',
        speakTarget: 'prompt'
      };
    case 'kanji_reading':
      return {
        modeLabel: 'Chữ Hán: Âm đọc On/Kun',
        pool: kanjiPool,
        getPrompt: item => `${item.character} (${item.meaning})`,
        getAnswer: item => [item.onyomi, item.kunyomi].filter(x => x && x !== '—').join(' / ') || item.reading || item.meaning,
        getReading: () => '',
        speakTarget: 'prompt'
      };
    case 'vocab_ja_vi':
    default:
      return {
        modeLabel: 'Từ vựng: Nhật ➔ Việt',
        pool: vocabPool,
        getPrompt: item => item.ruby || item.japanese,
        getAnswer: item => item.meaning,
        getReading: item => item.reading && item.reading !== item.japanese ? item.reading : '',
        speakTarget: 'prompt'
      };
  }
}

/**
 * Builds a full quiz session from items or lessons.
 * Supports:
 * - Signature 1: buildQuizSession(items, mode, shuffleQuestions, distractorPool)
 * - Signature 2: buildQuizSession(lessons, options)
 */
export function buildQuizSession(itemsOrLessons, optionsOrMode = 'vocab_ja_vi', shuffleQuestions = true, distractorPool = null) {
  if (!itemsOrLessons || itemsOrLessons.length === 0) {
    return { success: false, message: 'Danh sách bài học hoặc mục học trống.', questions: [] };
  }

  // Detect Signature 2: Array of lessons + options object
  const isLessonArray = typeof optionsOrMode === 'object' || (itemsOrLessons[0] && (itemsOrLessons[0].vocabulary || itemsOrLessons[0].grammar || itemsOrLessons[0].kanji));

  if (isLessonArray && typeof optionsOrMode === 'object') {
    const options = optionsOrMode;
    const lessons = itemsOrLessons;
    const lessonId = options.lessonId || 'all';
    const contentType = options.contentType || 'all'; // 'all' | 'vocabulary' | 'grammar' | 'kanji'
    const mode = options.mode || 'all_mix';
    const onlyReview = Boolean(options.onlyReview);
    const progressMap = options.progressMap;
    const username = options.currentUser?.username || 'default';
    const limit = options.limit && options.limit !== 'all' ? Number(options.limit) : null;
    const shuffle = options.shuffleQuestions ?? true;

    // Build pools of accessible distractors across all accessible lessons
    const allVocab = [];
    const allGrammar = [];
    const allKanji = [];

    for (const l of lessons) {
      (l.vocabulary || []).forEach(v => allVocab.push({ ...v, itemType: 'vocabulary', lessonId: l.id, lessonTitle: l.title }));
      (l.grammar || []).forEach(g => allGrammar.push({ ...g, itemType: 'grammar', lessonId: l.id, lessonTitle: l.title }));
      (l.kanji || []).forEach(k => allKanji.push({ ...k, itemType: 'kanji', lessonId: l.id, lessonTitle: l.title }));
    }

    // Determine target lessons
    const targetLessons = lessonId === 'all' ? lessons : lessons.filter(l => l.id === lessonId);

    // Extract target question items based on contentType
    let targetItems = [];
    for (const l of targetLessons) {
      if (contentType === 'all' || contentType === 'vocabulary') {
        (l.vocabulary || []).forEach(v => targetItems.push({ ...v, itemType: 'vocabulary', lessonId: l.id, lessonTitle: l.title, cardKey: `${l.id}:vocabulary:${v.id}` }));
      }
      if (contentType === 'all' || contentType === 'grammar') {
        (l.grammar || []).forEach(g => targetItems.push({ ...g, itemType: 'grammar', lessonId: l.id, lessonTitle: l.title, cardKey: `${l.id}:grammar:${g.id}` }));
      }
      if (contentType === 'all' || contentType === 'kanji') {
        (l.kanji || []).forEach(k => targetItems.push({ ...k, itemType: 'kanji', lessonId: l.id, lessonTitle: l.title, cardKey: `${l.id}:kanji:${k.id}` }));
      }
    }

    if (targetItems.length === 0) {
      return { success: false, message: 'Không tìm thấy mục học nào phù hợp với bộ lọc.', questions: [] };
    }

    // Filter by needsReview if onlyReview is requested
    if (onlyReview) {
      targetItems = targetItems.filter(item => {
        const progressKey = `${username}:quiz:${item.cardKey}`;
        const rec = progressMap?.get(progressKey) || progressMap?.get(item.cardKey);
        return Boolean(rec?.needsReview);
      });

      if (targetItems.length === 0) {
        return {
          success: false,
          error: 'NO_REVIEW_ITEMS',
          message: 'Bạn chưa có mục nào trong danh sách "Cần ôn tập" trong phạm vi đã chọn (chưa có câu nào làm sai). Bạn hãy bỏ chọn ô "Chỉ làm lại các câu từng trả lời sai" để làm trắc nghiệm bình thường nhé!'
        };
      }
    }

    // Shuffle target items
    if (shuffle) {
      targetItems.sort(() => Math.random() - 0.5);
    }

    // Apply limit if specified
    if (limit && limit > 0 && targetItems.length > limit) {
      targetItems = targetItems.slice(0, limit);
    }

    const questions = [];

    for (const item of targetItems) {
      // Determine question mode for this specific item
      let itemMode;
      if (mode === 'all_mix') {
        if (item.itemType === 'vocabulary') {
          itemMode = Math.random() < 0.5 ? 'vocab_ja_vi' : 'vocab_vi_ja';
        } else if (item.itemType === 'grammar') {
          itemMode = Math.random() < 0.5 ? 'grammar_meaning' : 'grammar_vi_ja';
        } else {
          itemMode = Math.random() < 0.5 ? 'kanji_meaning' : 'kanji_reading';
        }
      } else if (mode === 'vocab_mix') {
        itemMode = Math.random() < 0.5 ? 'vocab_ja_vi' : 'vocab_vi_ja';
      } else if (mode === 'grammar_mix') {
        itemMode = Math.random() < 0.5 ? 'grammar_meaning' : 'grammar_vi_ja';
      } else if (mode === 'kanji_mix') {
        itemMode = Math.random() < 0.5 ? 'kanji_meaning' : 'kanji_reading';
      } else {
        itemMode = mode;
      }

      const handler = getModeHandlers(itemMode, allVocab, allGrammar, allKanji);
      const q = generateQuestionChoices(item, handler.pool, handler.getPrompt, handler.getAnswer);

      if (!q.success) {
        return {
          success: false,
          error: q.error,
          message: q.message,
          questions: []
        };
      }

      questions.push({
        ...q,
        mode: itemMode,
        modeLabel: handler.modeLabel,
        promptReading: handler.getReading(item),
        speakText: handler.speakTarget === 'correctAnswer' ? q.correctAnswer : q.prompt,
        lessonId: item.lessonId,
        lessonTitle: item.lessonTitle,
        itemId: item.id,
        itemType: item.itemType
      });
    }

    return {
      success: true,
      mode,
      questions,
      total: questions.length
    };
  }

  // --- Signature 1: Raw items array (original pure logic & backwards compatibility) ---
  const items = itemsOrLessons;
  const mode = typeof optionsOrMode === 'string' ? optionsOrMode : 'vocab_ja_vi';
  const pool = distractorPool && distractorPool.length > 0 ? distractorPool : items;

  const handler = getModeHandlers(mode, pool, pool, pool);

  const questions = [];
  const questionItems = shuffleQuestions ? [...items].sort(() => Math.random() - 0.5) : [...items];

  for (const item of questionItems) {
    const q = generateQuestionChoices(item, handler.pool, handler.getPrompt, handler.getAnswer);
    if (!q.success) {
      return {
        success: false,
        error: q.error,
        message: q.message,
        questions: []
      };
    }
    questions.push({
      ...q,
      mode,
      modeLabel: handler.modeLabel,
      promptReading: handler.getReading(item),
      speakText: handler.speakTarget === 'correctAnswer' ? q.correctAnswer : q.prompt,
      lessonId: item.lessonId || '',
      lessonTitle: item.lessonTitle || '',
      itemId: item.id || '',
      itemType: item.itemType || 'vocabulary'
    });
  }

  return {
    success: true,
    mode,
    questions,
    total: questions.length
  };
}

/**
 * Chu kỳ giãn cách khoa học Ebbinghaus & Leitner (ngày):
 * - Giai đoạn 1: Sau 1 ngày (24h) - Ngăn chặn 70% lượng kiến thức bị quên sau ngày đầu.
 * - Giai đoạn 2: Sau 3 ngày - Khơi dậy nơ-ron khi trí nhớ bắt đầu phai nhạt (Desirable Difficulty).
 * - Giai đoạn 3: Sau 7 ngày (1 tuần) - Củng cố liên kết trí nhớ trung hạn.
 * - Giai đoạn 4: Sau 14 ngày (2 tuần) - Rèn luyện phản xạ ngữ nghĩa tự nhiên.
 * - Giai đoạn 5: Sau 30 ngày (1 tháng) - Khắc sâu vào trí nhớ dài hạn.
 * - Giai đoạn 6: Sau 60 ngày (2 tháng) - Ghi nhớ vĩnh viễn (Mastered).
 */
export const SCIENTIFIC_SPACED_INTERVALS = [1, 3, 7, 14, 30, 60];

export function calculateNextInterval(currentInterval = 0, isCorrect = true, rating = 'good') {
  if (!isCorrect || rating === 'again') {
    return 0; // Cần ôn lại ngay hôm nay
  }
  if (rating === 'easy') {
    if (currentInterval < 1) return 3;
    if (currentInterval < 3) return 7;
    if (currentInterval < 7) return 14;
    if (currentInterval < 14) return 30;
    return Math.max(60, Math.round(currentInterval * 2.5));
  }
  // Đánh giá 'good' / đúng
  if (currentInterval < 1) return 1;
  if (currentInterval < 3) return 3;
  if (currentInterval < 7) return 7;
  if (currentInterval < 14) return 14;
  if (currentInterval < 30) return 30;
  return 60;
}

/**
 * Review state transition rule (Plan Section 7) + Spaced Repetition Schedule
 * - Wrong answer -> added to needsReview list (status: 'learning', needsReview: true, intervalDays: 0, dueAt: now)
 * - Correct answer -> removed from needsReview (status: 'known', needsReview: false, intervalDays tăng theo chu kỳ Ebbinghaus)
 * - Wrong answer again -> returned to needsReview, intervalDays reset về 0
 */
export function updateReviewStatus(currentRecord, isCorrect) {
  const reviews = (currentRecord?.reviews || 0) + 1;
  const now = Date.now();
  const currentInterval = currentRecord?.intervalDays || 0;
  const intervalDays = calculateNextInterval(currentInterval, isCorrect, 'good');
  const dueAt = intervalDays === 0 ? now : now + intervalDays * 86400000;

  if (!isCorrect) {
    return {
      status: 'learning',
      needsReview: true,
      reviews,
      intervalDays: 0,
      dueAt: now,
      lastAnsweredAt: now,
      updatedAt: now
    };
  }

  return {
    status: 'known',
    needsReview: false,
    reviews,
    intervalDays,
    dueAt,
    lastAnsweredAt: now,
    updatedAt: now
  };
}
