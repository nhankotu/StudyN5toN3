import { normalizeLesson, stripFurigana } from './lesson.js';
export { normalizeLesson, stripFurigana };
import {
  checkCloudHealth, isCloudActive, restoreCloudSession, logoutCloud,
  cloudLogin, cloudGetUsers, cloudCreateUser, cloudResetPassword, cloudDeleteUser,
  cloudGetLessons, cloudGetLesson, cloudSaveLessons, cloudUpdateLesson, cloudDeleteLesson,
  cloudGetProgress, cloudSaveProgress, cloudChangePassword,
  initLocalAuth, getImportedLessons, getProgress
} from './db.js';
import { evaluateKanjiDrawing, KANJIVG_LICENSE } from './kanji-evaluator.js';
import { getKanjiStrokes, KANJIVG_ATTRIBUTION } from './kanji-strokes.js';
import { buildQuizSession, updateReviewStatus, QUIZ_RULES_EXPLANATION } from './quiz.js';

const PAGE = {
  vocabulary: ['Từ vựng', 'VOCABULARY COLLECTION', 'Kho từ vựng', 'Khám phá các từ tiếng Nhật theo từng bài học.'],
  practice: ['Luyện tập', 'FLASHCARD PRACTICE', 'Luyện tập flashcards', 'Lật thẻ, tự kiểm tra và ghi nhớ từ theo nhịp độ của bạn.'],
  grammar: ['Mẫu câu', 'GRAMMAR & PATTERNS', 'Ngữ pháp và mẫu câu', 'Công thức, giải thích và ví dụ đơn giản, dễ nhớ.'],
  quiz: ['Trắc nghiệm', 'QUIZ & REVIEW', 'Trắc nghiệm & Ôn tập phản xạ', 'Luyện phản xạ với câu hỏi 4 lựa chọn không dựng đáp án giả và quy tắc ôn tập từ sai rõ ràng.'],
  kanji: ['Chữ Hán', 'KANJI COLLECTION', 'Học & Luyện viết chữ Hán', 'Học ý nghĩa, âm đọc và luyện viết chữ Hán với Canvas 4 ô kẻ & chấm điểm nét KanjiVG (CC BY-SA 3.0).'],
  reading: ['Bài đọc', 'READING PRACTICE', 'Bài đọc tiếng Nhật', 'Đọc, xem bản dịch và nghe phát âm tiếng Nhật.'],
  imports: ['Kho bài học', 'LESSON LIBRARY & IMPORT', 'Kho bài học & Thêm bài mới', 'Tìm kiếm bài cũ để học lại hoặc nạp bài mới từ file JSON / AI.'],
  users: ['Quản lý tài khoản', 'INTERNAL USERS', 'Quản lý người dùng nội bộ', 'Chỉ Quản trị viên mới có quyền tạo thêm và quản lý người dùng.']
};

const state = {
  tab: 'vocabulary', lessonId: 'all', query: '',
  staticLessons: [], imported: [], lessons: [], progress: new Map(),
  lessonSearch: '',
  lessonFilter: 'all', // 'all' (Tất cả) | 'my' (Của tôi) | 'others' (Của người khác)
  lessonOwnerFilter: 'all',
  flash: {
    type: 'vocabulary',
    mode: 'all',
    direction: 'forward',
    index: 0,
    flipped: false,
    shuffledKeys: null
  },
  kanjiWrite: {
    subTab: 'library', // 'library' | 'write'
    mode: 'shape', // 'shape' | 'strict'
    currentIndex: 0,
    strokes: [],
    currentStroke: [],
    isDrawing: false,
    showHint: false,
    lastResult: null,
    overrideResult: null,
    loadingStrokes: false,
    loadedSvg: null
  },
  quiz: {
    session: null,
    currentIndex: 0,
    selectedOption: null,
    answered: false,
    history: [],
    contentType: 'all',
    mode: 'all_mix',
    scope: 'current',
    onlyReview: false,
    limit: 10
  },
  editor: {
    lesson: null,
    activeTab: 'vocab',
    duplicateError: null
  },
  deleteModal: {
    lessonId: null,
    lessonTitle: null,
    isOtherUser: false,
    confirmInput: ''
  },
  storageAvailable: true,
  currentUser: null,
  userList: []
};

const $ = id => document.getElementById(id);
const h = x => String(x ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
const str = (v, fallback='') => typeof v === 'string' || typeof v === 'number' ? String(v).trim() : fallback;
const list = v => Array.isArray(v) ? v : [];
let toastTimer;
let touchX = null, touchY = null, ignoreClickUntil = 0;
let savingProgress = false;

function notify(message) {
  const toast = $('toast'); toast.textContent = message; toast.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 4300);
}

export function renderFurigana(text) {
  if (!text) return '';
  const escaped = h(text);
  return escaped
    .replace(/\[([^\]]+)\](?:\[|\{)([^\]\}]+)(?:\]|\})/g, '<ruby>$1<rt>$2</rt></ruby>')
    .replace(/([\u4e00-\u9faf\u3400-\u4dbf々ヶA-Za-z0-9]+)\[([^\]]+)\]/g, '<ruby>$1<rt>$2</rt></ruby>');
}

function parseLessons(payload) {
  const items = Array.isArray(payload) ? payload : Array.isArray(payload?.lessons) ? payload.lessons : [payload];
  if (!items.length) throw new Error('File chưa có bài học.');
  return items.map(item => normalizeLesson(item));
}

function mergeLessons() {
  const merged = new Map(state.staticLessons.map(x => [x.id, x]));
  state.imported.forEach(x => merged.set(x.id, x));
  state.lessons = [...merged.values()].sort((a,b) => a.order - b.order || a.title.localeCompare(b.title, 'vi'));
  if (state.lessonId !== 'all' && !merged.has(state.lessonId)) state.lessonId = 'all';
}

function counts() {
  return state.lessons.reduce((tot, l) => {
    tot.vocabulary += (l.vocabulary || []).length;
    tot.grammar += (l.grammar || []).length;
    tot.kanji += (l.kanji || []).length;
    return tot;
  }, { vocabulary: 0, grammar: 0, kanji: 0 });
}

function allCards(type, lessonFiltered = true) {
  const keyType = type === 'grammar' ? 'grammar' : type === 'kanji' ? 'kanji' : 'vocabulary';
  const source = lessonFiltered ? visibleLessons() : state.lessons;
  return source.flatMap(lesson => (lesson[keyType] || []).map(item => ({
    ...item, lessonTitle: lesson.title, lessonId: lesson.id, key: `${lesson.id}:${keyType}:${item.id}`
  })));
}

function visibleLessons() { return state.lessonId === 'all' ? state.lessons : state.lessons.filter(l => l.id === state.lessonId); }
function isKnown(key) { return state.progress.get(key)?.status === 'known'; }
function isDue(key) { return !state.progress.has(key) || (state.progress.get(key).dueAt || 0) <= Date.now(); }

function renderMetrics() {
  const c = counts();
  const known = allCards('vocabulary', false).filter(card => isKnown(card.key)).length;
  const metrics = [['▤', state.lessons.length, 'Bài học'], ['あ', c.vocabulary, 'Từ vựng'], ['文', c.grammar, 'Mẫu câu'], ['漢', c.kanji, 'Chữ Hán']];
  $('metrics').innerHTML = metrics.map(([ico, num, label]) => `<article class="metric"><span class="metric-icon">${ico}</span><span class="metric-body"><strong>${num}</strong><small>${label}</small></span></article>`).join('');
}

function renderLessonOptions() {
  const sel = $('lessonSelect');
  const currentU = state.currentUser?.username;
  sel.innerHTML = `<option value="all">Tất cả bài học (${state.lessons.length})</option>` +
    state.lessons.map(l => {
      const isMine = currentU && l.createdBy === currentU;
      const tag = isMine ? ' [Của bạn]' : '';
      return `<option value="${h(l.id)}">${h(l.title)}${tag}</option>`;
    }).join('');
  sel.value = state.lessonId;
}

function switchTab(tab) {
  if (!PAGE[tab]) return;
  if (tab === 'users' && state.currentUser?.role !== 'admin') {
    notify('Chỉ Quản trị viên mới có quyền vào mục Quản lý tài khoản.');
    return;
  }
  if (state.tab !== tab && 'speechSynthesis' in window) speechSynthesis.cancel();
  state.tab = tab;
  history.replaceState(null, '', `#${tab}`);
  $('lessonSelect').value = state.lessonId;
  state.query = '';
  $('searchInput').value = '';
  document.querySelectorAll('[data-tab]').forEach(el => {
    const active = el.dataset.tab === tab;
    el.classList.toggle('active', active);
    if (active) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
  });
  $('breadcrumbCurrent').textContent = PAGE[tab][0];
  $('sectionEyebrow').textContent = PAGE[tab][1];
  $('sectionTitle').textContent = PAGE[tab][2];
  $('sectionDescription').textContent = PAGE[tab][3];
  $('searchWrap').style.display = ['practice', 'quiz', 'imports', 'users'].includes(tab) || (tab === 'kanji' && state.kanjiWrite.subTab === 'write') ? 'none' : 'flex';
  $('toolbar').classList.toggle('hidden', ['imports', 'users'].includes(tab));
  document.title = `${PAGE[tab][0]} — Nihongo Study`;
  renderView();
}

function render() {
  mergeLessons();
  renderMetrics();
  renderLessonOptions();
  switchTab(state.tab);
}

function matchesQuery(...texts) {
  const q = state.query.trim().toLocaleLowerCase();
  return !q || texts.some(x => str(x).toLocaleLowerCase().includes(q));
}

function itemTitle(card) { return card.lessonTitle ? `<span class="lesson-tag">✦ ${h(card.lessonTitle)}</span>` : ''; }

function empty(title, message, action=true) {
  return `<div class="empty-panel"><div class="empty-symbol">あ</div><h3>${h(title)}</h3><p>${h(message)}</p>${action ? `<button class="button-primary" data-tab="imports">＋ Nhập bài học JSON</button>` : ''}</div>`;
}

function renderVocabulary() {
  const items = allCards('vocabulary').filter(v => matchesQuery(v.japanese, v.ruby, v.reading, v.meaning, v.example, v.exampleMeaning));
  $('sectionCount').textContent = `${items.length} từ`;
  if (!items.length) return empty('Chưa có từ vựng phù hợp', 'Hãy chọn bài khác, thử từ khóa khác hoặc nhập thêm bài học.', state.lessons.length === 0);
  return `<div class="word-list">${items.map(v => `<article class="word-card"><div class="word-top"><div><div class="jp-main" lang="ja">${renderFurigana(v.ruby || v.japanese)}</div>${v.reading ? `<div class="jp-read" lang="ja">${h(v.reading)}</div>` : ''}</div><button class="audio-btn" data-action="speak" data-text="${h(stripFurigana(v.japanese))}" aria-label="Phát âm ${h(stripFurigana(v.japanese))}" title="Nghe phát âm">♫</button></div><div class="word-meaning">${h(v.meaning)}</div>${v.example ? `<div class="word-example"><span class="ja" lang="ja">${renderFurigana(v.example)}</span>${h(v.exampleMeaning)}</div>` : '<div></div>'}<div>${itemTitle(v)}</div></article>`).join('')}</div>`;
}

function renderGrammar() {
  const items = allCards('grammar').filter(v => matchesQuery(v.title, v.pattern, v.meaning, v.explanation, ...(v.examples || []).flatMap(e => [e.japanese, e.meaning])));
  $('sectionCount').textContent = `${items.length} mẫu câu`;
  if (!items.length) return empty('Không thấy mẫu câu', 'Hãy đổi bộ lọc hoặc thêm bài học có mục grammar.', state.lessons.length === 0);
  return `<div class="grammar-list">${items.map(v => `<article class="grammar-card"><div class="grammar-head"><div><h3 class="grammar-title">${h(v.title || v.pattern)}</h3><span class="lesson-tag">✦ ${h(v.lessonTitle)}</span></div>${v.pattern ? `<button class="audio-btn" data-action="speak" data-text="${h(stripFurigana(v.examples?.[0]?.japanese || v.pattern))}" title="Nghe mẫu câu">♫</button>` : ''}</div>${v.pattern ? `<div class="grammar-pattern" lang="ja">${renderFurigana(v.pattern)}</div>` : ''}${v.meaning ? `<p class="word-meaning">${h(v.meaning)}</p>` : ''}<div class="grammar-explanation">${h(v.explanation)}</div>${(v.examples || []).map(e => `<div class="grammar-example"><strong lang="ja">${renderFurigana(e.japanese)}</strong>${h(e.meaning)}</div>`).join('')}</article>`).join('')}</div>`;
}

function getKanjiStudyList() {
  const items = allCards('kanji');
  return items;
}

function renderKanji() {
  const isWritingSubTab = state.kanjiWrite.subTab === 'write';
  const allKanjis = getKanjiStudyList();

  const tabSwitcher = `
    <div class="kanji-subnav">
      <button class="kanji-subtab-btn ${!isWritingSubTab ? 'active' : ''}" data-action="switch-kanji-subtab" data-subtab="library">
        📚 Thư viện chữ Hán (${allKanjis.length})
      </button>
      <button class="kanji-subtab-btn ${isWritingSubTab ? 'active' : ''}" data-action="switch-kanji-subtab" data-subtab="write">
        ✍ Luyện viết nét Kanji
      </button>
    </div>
  `;

  if (!isWritingSubTab) {
    const items = allKanjis.filter(v => matchesQuery(v.character, v.meaning, v.onyomi, v.kunyomi, ...(v.examples || []).flatMap(e => [e.word, e.reading, e.meaning])));
    $('sectionCount').textContent = `${items.length} chữ`;
    if (!items.length) return tabSwitcher + empty('Chưa có chữ Hán', 'Hãy đổi bộ lọc hoặc thêm bài học có danh sách kanji.', state.lessons.length === 0);
    return tabSwitcher + `<div class="kanji-grid">${items.map((v, idx) => `
      <article class="kanji-card">
        <span class="kanji-character" lang="ja">${h(v.character)}</span>
        <div class="kanji-meaning">${h(v.meaning)}</div>
        <div class="kanji-readings">On: ${h(v.onyomi || '—')}<br>Kun: ${h(v.kunyomi || '—')}</div>
        <div class="kanji-card-actions">
          <button class="audio-btn" data-action="speak" data-text="${h(stripFurigana(v.examples?.[0]?.word || v.character))}" title="Phát âm" aria-label="Phát âm chữ Hán">♫</button>
          <button class="button-primary btn-sm" data-action="start-kanji-write" data-char="${h(v.character)}" title="Luyện viết chữ này">✍ Luyện viết</button>
        </div>
        ${(v.examples || []).length ? `<div class="kanji-words">${v.examples.map(e => `<div><strong lang="ja">${renderFurigana(e.word)}</strong> (${h(e.reading)}) — ${h(e.meaning)}</div>`).join('')}</div>` : ''}
        <div>${itemTitle(v)}</div>
      </article>
    `).join('')}</div>`;
  }

  // Chế độ Luyện viết
  if (!allKanjis.length) {
    return tabSwitcher + empty('Chưa có chữ Hán để luyện viết', 'Hãy chọn bài học khác hoặc nhập bài học có mục Kanji.', state.lessons.length === 0);
  }

  const idx = Math.min(state.kanjiWrite.currentIndex, allKanjis.length - 1);
  state.kanjiWrite.currentIndex = idx;
  const currentKanji = allKanjis[idx];
  const char = currentKanji.character;
  const isStrict = state.kanjiWrite.mode === 'strict';
  const lastRes = state.kanjiWrite.lastResult;
  const manualRes = state.kanjiWrite.overrideResult;

  $('sectionCount').textContent = `Chữ ${idx + 1} / ${allKanjis.length}`;

  return tabSwitcher + `
    <div class="kanji-practice-layout">
      <!-- CỘT CANVAS VẼ -->
      <div class="kanji-canvas-panel">
        <div class="kanji-write-header">
          <div class="kanji-info-badge">
            <span class="badge-char">${h(char)}</span>
            <div>
              <strong>${h(currentKanji.meaning)}</strong>
              <small>On: ${h(currentKanji.onyomi || '—')} · Kun: ${h(currentKanji.kunyomi || '—')}</small>
            </div>
          </div>
          <div class="kanji-mode-toggle">
            <button class="btn-mode ${!isStrict ? 'active' : ''}" data-action="set-kanji-mode" data-mode="shape" title="Chấm điểm dựa trên hình dạng tổng thể và độ khép nét">Dễ (Hình dạng)</button>
            <button class="btn-mode ${isStrict ? 'active' : ''}" data-action="set-kanji-mode" data-mode="strict" title="Chấm điểm nghiêm ngặt thứ tự nét và hướng đưa bút">Nghiêm ngặt (Thứ tự nét)</button>
          </div>
        </div>

        <div class="canvas-wrapper">
          <div class="canvas-crosshair"></div>
          <canvas id="kanjiCanvas" width="300" height="300" aria-label="Bảng viết chữ Hán"></canvas>
          ${state.kanjiWrite.showHint && state.kanjiWrite.loadedSvg ? `
            <div class="kanji-hint-overlay">${state.kanjiWrite.loadedSvg}</div>
          ` : ''}
        </div>

        <div class="kanji-canvas-toolbar">
          <button class="button-primary" data-action="submit-kanji-draw">✓ Xong &amp; Chấm điểm</button>
          <button class="button-secondary" data-action="clear-kanji-draw">↺ Viết lại</button>
          <button class="button-subtle" data-action="toggle-kanji-hint">${state.kanjiWrite.showHint ? 'Ẩn nét mờ' : '👁 Gợi ý nét mờ'}</button>
          <button class="button-subtle audio-btn" data-action="speak" data-text="${h(stripFurigana(currentKanji.examples?.[0]?.word || char))}" title="Phát âm">♫</button>
        </div>

        <div class="kanji-nav-bar">
          <button class="button-subtle btn-sm" data-action="prev-kanji" ${idx <= 0 ? 'disabled' : ''}>‹ Chữ trước</button>
          <span class="kanji-nav-status">${idx + 1} / ${allKanjis.length} (${h(currentKanji.lessonTitle)})</span>
          <button class="button-subtle btn-sm" data-action="next-kanji" ${idx >= allKanjis.length - 1 ? 'disabled' : ''}>Chữ tiếp ›</button>
        </div>
      </div>

      <!-- CỘT KẾT QUẢ & CHỮ MẪU KANJIVG -->
      <div class="kanji-feedback-panel">
        ${lastRes ? `
          <div class="grade-card ${(manualRes ?? lastRes.passed) ? 'grade-pass' : 'grade-fail'}">
            <div class="grade-header">
              <span class="grade-score">${lastRes.score}<small>/100</small></span>
              <span class="grade-badge">${(manualRes ?? lastRes.passed) ? 'ĐẠT (≥80)' : 'CHƯA ĐẠT (&lt;80)'}</span>
            </div>
            <p class="grade-feedback">${h(lastRes.feedback)}</p>
            ${lastRes.strokeCountMatch === false ? `<p class="stroke-warning">⚠ Số nét đã vẽ: ${lastRes.userStrokeCount} nét (Chữ mẫu chuẩn: ${lastRes.expectedStrokeCount} nét).</p>` : ''}

            <!-- Nút điều chỉnh đánh giá thủ công của người dùng -->
            <div class="override-box">
              <small>Thuật toán chấm chưa chính xác theo cảm nhận?</small>
              <div class="override-btns">
                <button class="btn-override pass ${manualRes === true ? 'active' : ''}" data-action="override-grade" data-status="pass">Đánh dấu Đạt</button>
                <button class="btn-override fail ${manualRes === false ? 'active' : ''}" data-action="override-grade" data-status="fail">Đánh dấu Cần luyện lại</button>
              </div>
            </div>
          </div>
        ` : `
          <div class="grade-placeholder">
            <span class="empty-symbol" style="width:48px;height:48px;font-size:24px">✍</span>
            <strong>Hãy dùng chuột, ngón tay hoặc bút viết chữ vào ô bên trái</strong>
            <p>Nhấn "Xong &amp; Chấm điểm" để thuật toán kiểm tra từng nét theo chuẩn KanjiVG. Chữ mẫu sẽ hiện ra sau khi bạn hoàn thành!</p>
          </div>
        `}

        <!-- HIỂN THỊ CHỮ MẪU VÀ BẢN QUYỀN KANJIVG -->
        <div class="kanjivg-reference-card">
          <div class="ref-header">
            <strong>Chữ mẫu &amp; Thứ tự nét (KanjiVG)</strong>
            <span class="ref-badge">${state.kanjiWrite.loadedSvg ? 'Chuẩn KanjiVG' : 'Tự đối chiếu'}</span>
          </div>
          <div class="kanjivg-preview-container" id="kanjivgPreviewBox">
            ${state.kanjiWrite.loadedSvg ? state.kanjiWrite.loadedSvg : `<div class="sample-char-text">${h(char)}</div>`}
          </div>
          <p class="license-attribution">${KANJIVG_ATTRIBUTION}. Giấy phép CC BY-SA 3.0.</p>
        </div>
      </div>
    </div>
  `;
}

function renderReadings() {
  const items = visibleLessons().flatMap(lesson => (lesson.readings || []).map(reading => ({ ...reading, lessonId: lesson.id, lessonTitle: lesson.title })))
    .filter(item => matchesQuery(item.title, item.japanese, item.translation, item.lessonTitle));
  $('sectionCount').textContent = `${items.length} bài đọc`;
  if (!items.length) return empty('Chưa có bài đọc phù hợp', 'Hãy chọn bài khác hoặc nhập JSON có mục readings.', true);
  return `<div class="reading-list">${items.map(item => `<article class="reading-card">
    <div class="reading-header"><div><span class="lesson-tag">✦ ${h(item.lessonTitle)}</span><h3 lang="ja">${renderFurigana(item.title)}</h3></div></div>
    <div class="reading-text" lang="ja">${renderFurigana(item.japanese)}</div>
    ${item.translation ? `<details class="reading-translation"><summary>Xem bản dịch tiếng Việt</summary><p>${h(item.translation)}</p></details>` : ''}
    <div class="reading-actions"><label>Tốc độ <select class="reading-rate" aria-label="Tốc độ đọc"><option value="0.7">Chậm</option><option value="0.85" selected>Vừa</option><option value="1">Bình thường</option></select></label>
      <button class="button-primary" data-action="read-passage" data-lesson-id="${h(item.lessonId)}" data-reading-id="${h(item.id)}">▶ Nghe bài đọc</button>
      <button class="button-secondary" data-action="stop-reading">■ Dừng đọc</button></div>
    <p class="reading-note">Giọng đọc phụ thuộc vào trình duyệt và giọng tiếng Nhật trên thiết bị.</p>
  </article>`).join('')}</div>`;
}

function studyCards() {
  let cards = allCards(state.flash.type);
  if (state.flash.mode === 'unknown') cards = cards.filter(c => !isKnown(c.key));
  if (state.flash.mode === 'due') cards = cards.filter(c => isDue(c.key));
  if (state.flash.shuffledKeys && state.flash.shuffledKeys.length) {
    const keyMap = new Map(cards.map(c => [c.key, c]));
    const ordered = [];
    for (const k of state.flash.shuffledKeys) {
      if (keyMap.has(k)) ordered.push(keyMap.get(k));
    }
    for (const c of cards) {
      if (!state.flash.shuffledKeys.includes(c.key)) ordered.push(c);
    }
    return ordered;
  }
  return cards;
}

function promptOf(c) {
  if (state.flash.type === 'grammar') return c.pattern || c.title;
  if (state.flash.type === 'kanji') return c.character;
  return c.ruby || c.japanese;
}

function answerOf(c) {
  return state.flash.type === 'grammar' ? (c.meaning || c.explanation) : c.meaning;
}

function flashExtra(c) {
  if (state.flash.type === 'grammar') return c.examples?.[0]?.japanese || c.explanation;
  if (state.flash.type === 'kanji') return `On: ${c.onyomi || '—'} · Kun: ${c.kunyomi || '—'}`;
  return c.example;
}

function shuffleCards() {
  const cards = studyCards();
  if (!cards.length) { notify('Không có thẻ nào để trộn.'); return; }
  const keys = cards.map(c => c.key);
  for (let i = keys.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [keys[i], keys[j]] = [keys[j], keys[i]];
  }
  state.flash.shuffledKeys = keys;
  state.flash.index = 0;
  state.flash.flipped = false;
  renderView();
  notify('🎲 Đã xáo trộn ngẫu nhiên danh sách thẻ ôn tập.');
}

function toggleReverse() {
  state.flash.direction = state.flash.direction === 'forward' ? 'reverse' : 'forward';
  state.flash.flipped = false;
  renderView();
  notify(state.flash.direction === 'reverse' ? '⇄ Đã đổi sang: Mặt trước nghĩa Tiếng Việt' : '⇄ Đã đổi sang: Mặt trước Tiếng Nhật');
}


function renderQuiz() {
  const accessibleLessons = state.lessons;
  const currentLessonId = state.lessonId;
  const session = state.quiz.session;

  if (!session) {
    const currentContentType = state.quiz.contentType || 'all';
    const username = state.currentUser?.username || 'default';

    // Calculate how many items need review in the current scope
    const targetLessons = state.quiz.scope === 'current' && state.lessonId !== 'all'
      ? state.lessons.filter(l => l.id === state.lessonId)
      : state.lessons;

    let reviewCount = 0;
    for (const l of targetLessons) {
      const checkKeys = [];
      if (currentContentType === 'all' || currentContentType === 'vocabulary') {
        (l.vocabulary || []).forEach(v => checkKeys.push(`${l.id}:vocabulary:${v.id}`));
      }
      if (currentContentType === 'all' || currentContentType === 'grammar') {
        (l.grammar || []).forEach(g => checkKeys.push(`${l.id}:grammar:${g.id}`));
      }
      if (currentContentType === 'all' || currentContentType === 'kanji') {
        (l.kanji || []).forEach(k => checkKeys.push(`${l.id}:kanji:${k.id}`));
      }

      for (const cardKey of checkKeys) {
        const progressKey = `${username}:quiz:${cardKey}`;
        const rec = state.progress.get(progressKey) || state.progress.get(cardKey);
        if (rec?.needsReview) reviewCount++;
      }
    }

    let modeOptionsHtml = '';
    if (currentContentType === 'all') {
      modeOptionsHtml = `
        <option value="all_mix" ${state.quiz.mode === 'all_mix' ? 'selected' : ''}>🎲 Trộn tổng hợp toàn bộ (Từ vựng 2 chiều + Mẫu câu + Chữ Hán)</option>
        <option value="vocab_ja_vi" ${state.quiz.mode === 'vocab_ja_vi' ? 'selected' : ''}>🇯🇵 Chỉ câu Từ vựng: Nhật ➔ Việt</option>
        <option value="vocab_vi_ja" ${state.quiz.mode === 'vocab_vi_ja' ? 'selected' : ''}>🇻🇳 Chỉ câu Từ vựng: Việt ➔ Nhật</option>
        <option value="grammar_meaning" ${state.quiz.mode === 'grammar_meaning' ? 'selected' : ''}>文 Chỉ câu Mẫu câu: Ngữ pháp ➔ Ý nghĩa</option>
        <option value="kanji_reading" ${state.quiz.mode === 'kanji_reading' ? 'selected' : ''}>読 Chỉ câu Chữ Hán: Xem chữ ➔ Chọn âm đọc On/Kun</option>
        <option value="kanji_meaning" ${state.quiz.mode === 'kanji_meaning' ? 'selected' : ''}>漢 Chỉ câu Chữ Hán: Xem chữ ➔ Chọn nghĩa Hán Việt</option>
      `;
    } else if (currentContentType === 'vocabulary') {
      modeOptionsHtml = `
        <option value="vocab_mix" ${state.quiz.mode === 'vocab_mix' ? 'selected' : ''}>🎲 Trộn cả 2 chiều: Nhật ➔ Việt & Việt ➔ Nhật</option>
        <option value="vocab_ja_vi" ${state.quiz.mode === 'vocab_ja_vi' ? 'selected' : ''}>🇯🇵 Tiếng Nhật ➔ Chọn nghĩa Tiếng Việt</option>
        <option value="vocab_vi_ja" ${state.quiz.mode === 'vocab_vi_ja' ? 'selected' : ''}>🇻🇳 Nghĩa Tiếng Việt ➔ Chọn chữ Nhật</option>
      `;
    } else if (currentContentType === 'grammar') {
      modeOptionsHtml = `
        <option value="grammar_mix" ${state.quiz.mode === 'grammar_mix' ? 'selected' : ''}>🎲 Trộn cả 2 chiều (Mẫu câu ➔ Nghĩa & Nghĩa ➔ Mẫu câu)</option>
        <option value="grammar_meaning" ${state.quiz.mode === 'grammar_meaning' ? 'selected' : ''}>文 Xem mẫu câu ➔ Chọn ý nghĩa Tiếng Việt</option>
        <option value="grammar_vi_ja" ${state.quiz.mode === 'grammar_vi_ja' ? 'selected' : ''}>🇻🇳 Xem ý nghĩa ➔ Chọn mẫu câu tương ứng</option>
      `;
    } else if (currentContentType === 'kanji') {
      modeOptionsHtml = `
        <option value="kanji_mix" ${state.quiz.mode === 'kanji_mix' ? 'selected' : ''}>🎲 Trộn cả 2 dạng: Nghĩa Hán Việt & Âm đọc On/Kun</option>
        <option value="kanji_reading" ${state.quiz.mode === 'kanji_reading' ? 'selected' : ''}>読 Xem chữ Hán ➔ Chọn âm đọc On/Kun</option>
        <option value="kanji_meaning" ${state.quiz.mode === 'kanji_meaning' ? 'selected' : ''}>漢 Xem chữ Hán ➔ Chọn ý nghĩa Hán Việt</option>
      `;
    }

    // Giao diện cấu hình và bắt đầu Quiz
    return `
      <div class="quiz-setup-card">
        <div class="quiz-setup-header">
          <div class="quiz-badge">❓ BỘ LUYỆN PHẢN XẠ TRẮC NGHIỆM</div>
          <h3>Luyện tập trắc nghiệm 4 lựa chọn</h3>
          <p>Tự động tạo câu hỏi 4 lựa chọn phân biệt từ các bài học bạn có quyền xem, hoàn toàn không dựng đáp án giả. Hệ thống tự động ghi nhận câu sai vào danh sách "Cần ôn tập" để bạn rèn luyện lại.</p>
        </div>

        <div class="quiz-setup-grid">
          <div class="quiz-config-field">
            <label for="quizContentTypeSelect">Nội dung học trắc nghiệm</label>
            <select id="quizContentTypeSelect">
              <option value="all" ${currentContentType === 'all' ? 'selected' : ''}>📚 Cả bài (Trộn Từ vựng, Mẫu câu & Chữ Hán)</option>
              <option value="vocabulary" ${currentContentType === 'vocabulary' ? 'selected' : ''}>あ Chỉ Từ vựng</option>
              <option value="grammar" ${currentContentType === 'grammar' ? 'selected' : ''}>文 Chỉ Mẫu câu (Ngữ pháp)</option>
              <option value="kanji" ${currentContentType === 'kanji' ? 'selected' : ''}>漢 Chỉ Chữ Hán</option>
            </select>
          </div>

          <div class="quiz-config-field">
            <label for="quizModeSelect">Dạng câu hỏi / Hướng trắc nghiệm</label>
            <select id="quizModeSelect">
              ${modeOptionsHtml}
            </select>
          </div>

          <div class="quiz-config-field">
            <label for="quizScopeSelect">Phạm vi bài học</label>
            <select id="quizScopeSelect">
              <option value="current" ${state.quiz.scope === 'current' ? 'selected' : ''}>Chỉ trong bài học đang chọn (${state.lessonId === 'all' ? 'Tất cả bài học' : (state.lessons.find(l=>l.id===state.lessonId)?.title || state.lessonId)})</option>
              <option value="all" ${state.quiz.scope === 'all' ? 'selected' : ''}>Toàn bộ các bài học bạn có quyền xem (${state.lessons.length} bài)</option>
            </select>
          </div>

          <div class="quiz-config-field">
            <label for="quizLimitSelect">Số lượng câu hỏi</label>
            <select id="quizLimitSelect">
              <option value="10" ${state.quiz.limit === 10 ? 'selected' : ''}>10 câu</option>
              <option value="20" ${state.quiz.limit === 20 ? 'selected' : ''}>20 câu</option>
              <option value="30" ${state.quiz.limit === 30 ? 'selected' : ''}>30 câu</option>
              <option value="all" ${state.quiz.limit === 'all' ? 'selected' : ''}>Tất cả các câu trong phạm vi</option>
            </select>
          </div>

          <div class="quiz-config-field">
            <label class="checkbox-label" style="${reviewCount === 0 ? 'opacity:0.65;cursor:not-allowed' : ''}">
              <input type="checkbox" id="quizReviewOnlyCheckbox" ${state.quiz.onlyReview && reviewCount > 0 ? 'checked' : ''} ${reviewCount === 0 ? 'disabled' : ''} />
              <span>Chỉ làm lại các câu trong danh sách <strong>Cần ôn tập</strong> (từng trả lời sai)</span>
            </label>
            <div style="font-size:11px;margin-top:4px;padding-left:28px;color:${reviewCount > 0 ? '#6e58e4' : '#8c93a8'}">
              ${reviewCount > 0
                ? `🔥 Bạn đang có <strong>${reviewCount}</strong> câu đã từng làm sai cần ôn lại.`
                : `✦ Bạn chưa có câu nào làm sai (Danh sách cần ôn tập đang trống). Bạn hãy bấm <strong>"▶ Bắt đầu làm trắc nghiệm"</strong> bên dưới để làm bài ngay!`}
            </div>
          </div>
        </div>

        <div class="quiz-rules-box">
          <strong>✦ Quy tắc ôn tập trắc nghiệm:</strong>
          <p>${QUIZ_RULES_EXPLANATION}</p>
        </div>

        <button class="button-primary btn-large" data-action="start-quiz-session" style="width:100%;margin-top:20px">
          ▶ Bắt đầu làm trắc nghiệm
        </button>
      </div>
    `;
  }

  // Đang trong phiên Quiz
  const qIndex = state.quiz.currentIndex;
  const questions = session.questions;

  if (qIndex >= questions.length) {
    // Đã hoàn thành phiên Quiz
    const history = state.quiz.history;
    const correctCount = history.filter(h => h.isCorrect).length;
    const total = history.length;
    const percent = total > 0 ? Math.round((correctCount / total) * 100) : 0;

    return `
      <div class="quiz-summary-card">
        <div class="quiz-summary-icon">${percent >= 80 ? '🎉' : '💪'}</div>
        <h2>Hoàn thành bài trắc nghiệm!</h2>
        <div class="quiz-score-big">${correctCount} / ${total} <small>(${percent}%)</small></div>
        <p>${percent >= 80 ? 'Rất tuyệt vời! Bạn đã ghi nhớ rất tốt các mục trong bài học.' : 'Hãy tiếp tục kiên trì! Các câu trả lời chưa đúng đã được lưu vào danh sách Cần ôn tập để bạn luyện lại.'}</p>
        
        <div class="quiz-summary-actions">
          <button class="button-primary" data-action="restart-quiz">↺ Làm lại bài khác</button>
          <button class="button-secondary" data-action="end-quiz">✕ Thoát ra danh mục</button>
        </div>
      </div>
    `;
  }

  const q = questions[qIndex];
  const answered = state.quiz.answered;
  const selected = state.quiz.selectedOption;
  $('sectionCount').textContent = `Câu ${qIndex + 1} / ${questions.length}`;

  const speakText = q.speakText || (['vocab_vi_ja', 'grammar_vi_ja'].includes(q.mode) ? q.correctAnswer : q.prompt);

  return `
    <div class="quiz-active-layout">
      <div class="quiz-progress-top">
        <span>CÂU ${qIndex + 1} / ${questions.length}</span>
        <button class="button-subtle btn-sm" data-action="end-quiz">✕ Dừng trắc nghiệm</button>
      </div>
      <div class="study-progress-bar">
        <div class="study-progress-fill" style="width:${(qIndex / questions.length) * 100}%"></div>
      </div>

      <div class="quiz-question-box">
        <span class="quiz-question-type">${h((q.modeLabel || q.mode).toUpperCase().replace(/_/g, ' '))} · ${h(q.lessonTitle)}</span>
        <div class="quiz-prompt-text" lang="ja">${renderFurigana(q.prompt)}</div>
        ${q.promptReading ? `<div class="quiz-prompt-reading" lang="ja">${h(q.promptReading)}</div>` : ''}
        <button class="audio-btn" data-action="speak" data-text="${h(stripFurigana(speakText))}" title="Nghe phát âm">♫</button>
      </div>

      <div class="quiz-options-grid">
        ${(q.options || []).map((opt, i) => {
          let btnClass = 'quiz-option-btn';
          if (answered) {
            if (opt.isCorrect) btnClass += ' option-correct';
            else if (selected === opt.text) btnClass += ' option-incorrect';
          }
          return `
            <button class="${btnClass}" data-action="select-quiz-option" data-option="${h(opt.text)}" ${answered ? 'disabled' : ''}>
              <span class="opt-index">${['A', 'B', 'C', 'D'][i]}</span>
              <span class="opt-text" lang="ja">${renderFurigana(opt.text)}</span>
            </button>
          `;
        }).join('')}
      </div>

      ${answered ? `
        <div class="quiz-feedback-bar ${selected === q.correctAnswer ? 'feedback-correct' : 'feedback-incorrect'}">
          <div class="feedback-text">
            <strong>${selected === q.correctAnswer ? '✓ Chính xác!' : '✗ Chưa đúng!'}</strong>
            <span>Đáp án chuẩn: <strong>${h(q.correctAnswer)}</strong></span>
          </div>
          <button class="button-primary" data-action="next-quiz-question">
            ${qIndex + 1 >= questions.length ? 'Xem kết quả tổng kết ›' : 'Câu tiếp theo ›'}
          </button>
        </div>
      ` : ''}
    </div>
  `;
}

function renderPractice() {
  const cards = studyCards();
  const length = cards.length;
  if (state.flash.index >= length) state.flash.index = 0;
  const item = cards[state.flash.index];
  const known = allCards(state.flash.type).filter(v => isKnown(v.key)).length;
  const total = allCards(state.flash.type).length;
  $('sectionCount').textContent = `${total} thẻ`;

  const isReverse = state.flash.direction === 'reverse';
  const isShuffled = !!state.flash.shuffledKeys;

  const filters = `<div class="study-controls">
    <label>Loại thẻ
      <select id="cardType">
        <option value="vocabulary" ${state.flash.type==='vocabulary'?'selected':''}>Từ vựng</option>
        <option value="grammar" ${state.flash.type==='grammar'?'selected':''}>Mẫu câu</option>
        <option value="kanji" ${state.flash.type==='kanji'?'selected':''}>Chữ Hán</option>
      </select>
    </label>
    <label>Chế độ ôn
      <select id="cardMode">
        <option value="all" ${state.flash.mode==='all'?'selected':''}>Tất cả thẻ</option>
        <option value="unknown" ${state.flash.mode==='unknown'?'selected':''}>Chưa thuộc</option>
        <option value="due" ${state.flash.mode==='due'?'selected':''}>Cần ôn hôm nay</option>
      </select>
    </label>
    <label>Hướng ôn
      <select id="cardDirection">
        <option value="forward" ${!isReverse?'selected':''}>🇯🇵 Nhật ➔ 🇻🇳 Việt</option>
        <option value="reverse" ${isReverse?'selected':''}>🇻🇳 Việt ➔ 🇯🇵 Nhật</option>
      </select>
    </label>
    <div class="study-quick-btns">
      <button class="btn-study-tool ${isReverse?'active':''}" data-action="toggle-reverse" title="Đảo chiều câu hỏi / câu trả lời">⇄ Đảo mặt thẻ</button>
      <button class="btn-study-tool ${isShuffled?'active':''}" data-action="shuffle" title="Trộn ngẫu nhiên thẻ">🎲 ${isShuffled?'Trộn lại':'Trộn thẻ'}</button>
    </div>
  </div>`;

  let cardFace = '';
  if (item) {
    if (!isReverse) {
      cardFace = state.flash.flipped
        ? `<span class="flash-label">MẶT SAU · NGHĨA TIẾNG VIỆT</span>
           <span class="flash-meaning">${h(answerOf(item))}</span>
           ${item.reading ? `<span class="flash-reading" lang="ja">${h(item.reading)}</span>` : ''}
           <span class="flash-extra" lang="ja">${renderFurigana(flashExtra(item))}</span>
           <span class="flash-hint">↻ Chạm để xem lại mặt trước</span>`
        : `<span class="flash-label">MẶT TRƯỚC · TIẾNG NHẬT</span>
           <span class="flash-jp" lang="ja">${renderFurigana(promptOf(item))}</span>
           <span class="flash-hint">↻ Chạm để xem đáp án tiếng Việt</span>`;
    } else {
      cardFace = state.flash.flipped
        ? `<span class="flash-label">MẶT SAU · TIẾNG NHẬT</span>
           <span class="flash-jp" lang="ja">${renderFurigana(promptOf(item))}</span>
           ${item.reading ? `<span class="flash-reading" lang="ja">${h(item.reading)}</span>` : ''}
           <span class="flash-extra" lang="ja">${renderFurigana(flashExtra(item))}</span>
           <span class="flash-hint">↻ Chạm để xem lại nghĩa tiếng Việt</span>`
        : `<span class="flash-label">MẶT TRƯỚC · NGHĨA TIẾNG VIỆT</span>
           <span class="flash-meaning">${h(answerOf(item))}</span>
           <span class="flash-hint">↻ Chạm để xem chữ Nhật &amp; phát âm</span>`;
    }
  }

  const cardMarkup = item ? `
    <div class="study-progress-head"><span>THẺ ${state.flash.index+1} / ${length}</span><span>${known}/${total} đã thuộc</span></div>
    <div class="study-progress-bar"><div class="study-progress-fill" style="width:${total ? known/total*100 : 0}%"></div></div>
    <button class="flashcard" data-action="flip" aria-label="Lật flashcard" aria-pressed="${state.flash.flipped}">
      ${cardFace}
    </button>
    <div class="flash-actions">
      <button class="button-danger" data-action="mark" data-rating="again">↻ Chưa nhớ</button>
      <button class="button-secondary" data-action="mark" data-rating="good">✓ Đã nhớ</button>
      <button class="button-primary" data-action="mark" data-rating="easy">★ Rất dễ</button>
    </div>
    <div class="flash-nav">
      <button data-action="prev">‹ Trước</button>
      <span>${h(item.lessonTitle)}</span>
      <div>
        <button data-action="speak" data-text="${h(stripFurigana(promptOf(item)))}" aria-label="Nghe phát âm">♫</button>
        <button data-action="next">Tiếp ›</button>
      </div>
    </div>`
    : empty('Không có thẻ để ôn', state.flash.mode==='all' ? 'Hãy tải bài học JSON có nội dung để tạo flashcards.' : 'Bạn đã học xong nhóm thẻ này. Đổi sang chế độ “Tất cả thẻ” để xem lại.', state.lessons.length===0);

  return `<div class="study-layout">
    <div class="study-panel">${filters}${cardMarkup}</div>
    <div class="study-side">
      <div class="study-aside-box">
        <h3>✦ Tiến độ ghi nhớ</h3>
        <div class="big-number">${known}<span style="font-size:15px;color:#aaa1d2"> / ${total}</span></div>
        <p>Tài khoản: <strong>${h(state.currentUser?.name || state.currentUser?.username || 'Khách')}</strong>.<br/>${isCloudActive ? 'Tiến độ học tập được lưu trên đám mây.' : 'Tiến độ chỉ được lưu trên thiết bị này.'}</p>
      </div>
      <div class="study-aside-box study-tip">
        <h3>☀ Mẹo ghi nhớ &amp; Chế độ ôn</h3>
        <p>Bật <strong>Đảo mặt</strong> để luyện phản xạ từ nghĩa tiếng Việt sang chữ Nhật. Dùng <strong>Trộn thẻ</strong> để kiểm tra ngẫu nhiên tránh học vẹt theo thứ tự.</p>
      </div>
    </div>
  </div>`;
}

const AI_PROMPT_TEMPLATE = `Bạn là một chuyên gia tiếng Nhật. Hãy chuyển đổi toàn bộ nội dung/hình ảnh/giáo trình tiếng Nhật được cung cấp dưới đây thành file JSON chuẩn để nạp vào website học tiếng Nhật Nihongo Study.

QUY TẮC BẮT BUỘC ĐỂ ỨNG DỤNG HIỂN THỊ CHUẨN FURIGANA:
1. Furigana: Trong tất cả các từ và câu có chữ Hán, BẮT BUỘC viết cách đọc Hiragana trong ngoặc vuông ngay sau chữ Hán tương ứng theo cú pháp: Kanji[Hiragana].
   Ví dụ:
   - "私[わたし]" (Tôi)
   - "行[い]きます" (Đi)
   - "飛行機[ひこうき]" (Máy bay)
   - "先生[せんせい]" (Thầy/Cô giáo)
   - "明日[あした]、京都[きょうと]へ 行[い]きます。"

2. CẤU TRÚC JSON PHẢI LÀ 1 OBJECT HOẶC MẢNG OBJECT VỚI CÁC TRƯỜNG:
{
  "id": "bai-01",
  "title": "Bài 1 – Giới thiệu bản thân & Chào hỏi",
  "level": "N5",
  "book": "Minna no Nihongo I",
  "order": 1,
  "readings": [{ "id": "r01", "title": "自己紹介", "japanese": "私[わたし]は学生[がくせい]です。", "translation": "Tôi là học sinh." }],
  "vocabulary": [
    {
      "id": "v01",
      "japanese": "私[わたし]",
      "reading": "わたし",
      "meaning": "Tôi (ngôi thứ nhất)",
      "example": "私[わたし]はベトナム人[じん]です。",
      "exampleMeaning": "Tôi là người Việt Nam."
    },
    {
      "id": "v02",
      "japanese": "先生[せんせい]",
      "reading": "せんせい",
      "meaning": "Thầy, cô giáo",
      "example": "田中[たなか]さんは先生[せんせい]です。",
      "exampleMeaning": "Anh Tanaka là giáo viên."
    }
  ],
  "grammar": [
    {
      "id": "g01",
      "title": "N1 は N2 です",
      "pattern": "N1 は N2 です。",
      "meaning": "N1 là N2.",
      "explanation": "Trợ từ は (đọc là wa) đánh dấu chủ đề câu. です kết thúc câu khẳng định lịch sự.",
      "examples": [
        {
          "japanese": "私[わたし]は学生[がくせい]です。",
          "meaning": "Tôi là sinh viên."
        }
      ]
    }
  ],
  "kanji": [
    {
      "id": "k01",
      "character": "人",
      "meaning": "Nhân (người)",
      "onyomi": "ジン、ニン",
      "kunyomi": "ひと",
      "examples": [
        {
          "word": "日本人[にほんじん]",
          "reading": "にほんじん",
          "meaning": "Người Nhật"
        }
      ]
    }
  ]
}

LƯU Ý QUAN TRỌNG:
- Chỉ trả về duy nhất một khối mã JSON hợp lệ (không kèm lời chào hay giải thích mở đầu/kết thúc).
- "id" bài học phải là duy nhất (ví dụ: bai-01, bai-02, n4-bai-05...).

Dưới đây là nội dung/hình ảnh bài học cần chuyển đổi:
[DÁN NỘI DUNG HOẶC TẢI ẢNH GIÁO TRÌNH VÀO ĐÂY]`;

const STANDARD_LESSON_TEMPLATE = {
  "_huong_dan_cho_nguoi_dung_va_ai": {
    "muc_dich": "Mẫu bài học chuẩn cho ứng dụng Nihongo Study. Dùng để nạp bài học hoặc gửi cho AI (ChatGPT/Claude/Gemini) làm mẫu cấu trúc.",
    "quy_tac_furigana": "Viết [cách đọc Hiragana] ngay sau chữ Hán: Kanji[Hiragana], ví dụ: 私[わたし], 行[い]きます, 日本語[にほんご]."
  },
  "id": "bai-01",
  "title": "Bài 1 – Giới thiệu bản thân & Chào hỏi",
  "level": "N5",
  "book": "Minna no Nihongo I",
  "order": 1,
  "readings": [{ "id": "r01", "title": "自己紹介", "japanese": "私[わたし]は学生[がくせい]です。", "translation": "Tôi là học sinh." }],
  "vocabulary": [
    {
      "id": "v01",
      "japanese": "私[わたし]",
      "reading": "わたし",
      "meaning": "Tôi (ngôi thứ nhất)",
      "example": "私[わたし]はベトナム人[じん]です。",
      "exampleMeaning": "Tôi là người Việt Nam."
    },
    {
      "id": "v02",
      "japanese": "あなた",
      "reading": "あなた",
      "meaning": "Bạn, anh, chị (ngôi thứ hai)",
      "example": "あなたはお名前[なまえ]は何[なん]ですか。",
      "exampleMeaning": "Bạn tên là gì vậy?"
    },
    {
      "id": "v03",
      "japanese": "先生[せんせい]",
      "reading": "せんせい",
      "meaning": "Thầy, cô giáo",
      "example": "田中[たなか]さんは先生[せんせい]です。",
      "exampleMeaning": "Thầy Tanaka là giáo viên."
    },
    {
      "id": "v04",
      "japanese": "学生[がくせい]",
      "reading": "がくせい",
      "meaning": "Học sinh, sinh viên",
      "example": "マイクさんは学生[がくせい]ではありません。",
      "exampleMeaning": "Mike không phải là sinh viên."
    },
    {
      "id": "v05",
      "japanese": "会社員[かいしゃいん]",
      "reading": "かいしゃいん",
      "meaning": "Nhân viên công ty",
      "example": "サントスさんは会社員[かいしゃいん]です。",
      "exampleMeaning": "Anh Santos là nhân viên công ty."
    }
  ],
  "grammar": [
    {
      "id": "g01",
      "title": "N1 は N2 です",
      "pattern": "N1 は N2 です。",
      "meaning": "N1 là N2.",
      "explanation": "Trợ từ は (đọc là wa) đánh dấu chủ đề câu. です dùng để kết thúc câu khẳng định lịch sự.",
      "examples": [
        {
          "japanese": "私[わたし]は学生[がくせい]です。",
          "meaning": "Tôi là sinh viên."
        }
      ]
    },
    {
      "id": "g02",
      "title": "N1 は N2 ではありません (Phủ định)",
      "pattern": "N1 は N2 ではありません / じゃありません。",
      "meaning": "N1 không phải là N2.",
      "explanation": "Dùng để phủ định danh từ N2 một cách lịch sự.",
      "examples": [
        {
          "japanese": "サントスさんは先生[せんせい]ではありません。",
          "meaning": "Anh Santos không phải là giáo viên."
        }
      ]
    }
  ],
  "kanji": [
    {
      "id": "k01",
      "character": "人",
      "meaning": "Nhân (người)",
      "onyomi": "ジン、ニン",
      "kunyomi": "ひと",
      "examples": [
        {
          "word": "日本人[にほんじん]",
          "reading": "にほんじん",
          "meaning": "Người Nhật"
        },
        {
          "word": "三人[さんにん]",
          "reading": "さんにん",
          "meaning": "3 người"
        }
      ]
    },
    {
      "id": "k02",
      "character": "日",
      "meaning": "Nhật (mặt trời, ngày)",
      "onyomi": "ニチ、ジツ",
      "kunyomi": "ひ、か",
      "examples": [
        {
          "word": "日曜日[にちようび]",
          "reading": "にちようび",
          "meaning": "Chủ nhật"
        },
        {
          "word": "日本[にほん]",
          "reading": "にほん",
          "meaning": "Nhật Bản"
        }
      ]
    }
  ]
};

function cleanJsonInput(raw) {
  let text = String(raw || '').trim();
  // Tự động loại bỏ khối markdown ```json ... ``` nếu người dùng copy từ AI
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  }
  return text.trim();
}

function renderImports() {
  const currentUsername = state.currentUser?.username || 'admin';
  const isAdmin = state.currentUser?.role === 'admin';
  const myLessons = state.lessons.filter(l => l.createdBy === currentUsername);
  const otherLessons = state.lessons.filter(l => l.createdBy !== currentUsername);

  // Lọc theo tab sở hữu
  let scopedLessons = state.lessons;
  if (state.lessonFilter === 'my') {
    scopedLessons = myLessons;
  } else if (state.lessonFilter === 'others' && isAdmin) {
    scopedLessons = otherLessons;
  }

  // Lọc thêm theo dropdown người tải lên nếu Admin chọn tab others
  if (state.lessonFilter === 'others' && isAdmin && state.lessonOwnerFilter !== 'all') {
    scopedLessons = scopedLessons.filter(l => l.createdBy === state.lessonOwnerFilter);
  }

  // Lọc theo từ khóa tìm kiếm
  let displayedLessons = scopedLessons;
  if (state.lessonSearch.trim()) {
    const q = state.lessonSearch.trim().toLowerCase();
    displayedLessons = displayedLessons.filter(l => 
      (l.title && l.title.toLowerCase().includes(q)) ||
      (l.id && l.id.toLowerCase().includes(q)) ||
      (l.level && l.level.toLowerCase().includes(q)) ||
      (l.book && l.book.toLowerCase().includes(q)) ||
      (l.createdBy && l.createdBy.toLowerCase().includes(q))
    );
  }

  $('sectionCount').textContent = `${state.lessons.length} bài học`;
  const storageText = isCloudActive 
    ? 'cơ sở dữ liệu đám mây <strong>MongoDB Atlas</strong> (Đồng bộ vĩnh viễn trên mọi máy tính và điện thoại)' 
    : '<strong>trình duyệt thiết bị này</strong> (Offline)';

  // Danh sách các creators duy nhất để Admin lọc
  const otherCreators = [...new Set(otherLessons.map(l => l.createdBy || 'unknown'))];

  return `
    <div class="notice">
      ⓘ Dữ liệu bài học được lưu vào ${storageText}. Mỗi khi bạn tải bài học lên, hệ thống sẽ lưu lại ứng với tài khoản của bạn để lần sau vào học lại ngay mà không cần tải lại.
    </div>

    <!-- HƯỚNG DẪN TẠO BÀI HỌC BẰNG AI -->
    <div class="ai-guide-box">
      <div class="ai-guide-header">
        <div class="ai-guide-title">
          <span>🤖</span>
          <strong>Tạo bài học tự động bằng AI (ChatGPT / Claude / Gemini)</strong>
        </div>
        <div class="ai-guide-actions" style="margin-top:0">
          <button class="button-primary" data-action="copy-ai-prompt" title="Sao chép Prompt mẫu gửi cho AI">📋 Sao chép Prompt cho AI</button>
          <button class="button-secondary" data-action="template" title="Tải file mẫu JSON chuẩn">↓ Tải file mẫu JSON</button>
        </div>
      </div>
      <p>
        Chỉ cần sao chép <b>Prompt mẫu</b> dưới đây, gửi cho AI (ChatGPT, Claude hoặc Gemini) kèm ảnh chụp sách hoặc nội dung bài học. AI sẽ xuất ra đúng chuẩn JSON để nạp vào website!
      </p>
      <div class="prompt-preview-box">${h(AI_PROMPT_TEMPLATE)}</div>
      <div style="margin-top:12px">
        <span class="schema-pill">id: Mã duy nhất (ví dụ: bai-01)</span>
        <span class="schema-pill">title: Tên bài</span>
        <span class="schema-pill">level: N5~N1</span>
        <span class="schema-pill">vocabulary: Từ vựng kèm Furigana 私[わたし]</span>
        <span class="schema-pill">grammar: Mẫu câu</span>
        <span class="schema-pill">kanji: Chữ Hán</span>
        <span class="schema-pill">readings: Bài đọc và bản dịch</span>
      </div>
    </div>

    <div class="import-layout">
      <!-- CỘT 1: NẠP BÀI HỌC MỚI -->
      <section class="import-panel">
        <h3>＋ Nạp bài học mới</h3>
        <p>Chọn cùng lúc nhiều file <b>.json</b> hoặc kéo thả vào ô bên dưới. Tự động lưu vào tài khoản <strong>@${h(currentUsername)}</strong>.</p>
        
        <div class="upload-zone" id="uploadZone">
          <span class="upload-icon">📁</span>
          <strong>Nhấn để chọn hoặc kéo thả file .JSON vào đây</strong>
          <small>Hỗ trợ chọn nhiều file JSON cùng lúc</small>
          <div class="upload-zone-button">
            <button type="button" class="button-primary btn-sm" data-action="trigger-file-input">Chọn file từ máy</button>
          </div>
          <input id="fileInput" type="file" accept=".json,application/json" multiple style="display:none" />
        </div>

        <label class="textarea-label" for="jsonPaste">HOẶC DÁN NỘI DUNG JSON (HỖ TRỢ COPY TỪ AI)</label>
        <textarea id="jsonPaste" spellcheck="false" placeholder="Dán mã JSON bài học vào đây (tự động loại bỏ markdown từ ChatGPT)..."></textarea>
        
        <div class="button-row">
          <button class="button-primary" data-action="paste">Nhập JSON đã dán</button>
          <button class="button-secondary" data-action="template">↓ Tải mẫu JSON chuẩn</button>
        </div>

        <div class="import-guide">
          <strong>✓ Định dạng Furigana chuẩn</strong>
          <p>Viết <code>漢字[かんじ]</code> (ví dụ: <code>私[わたし]</code> hoặc <code>今[いま]、何時[なんじ]ですか。</code>) ngay trong từ vựng, câu ví dụ để chữ nhỏ tự động hiển thị trên đầu chữ Hán.</p>
        </div>
      </section>

      <!-- CỘT 2: KHO BÀI HỌC & TÌM KIẾM BÀI ĐỂ HỌC LẠI -->
      <section class="import-panel">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:8px">
          <h3 style="margin:0">📚 Kho bài học (${state.lessons.length})</h3>
          <button class="button-subtle btn-sm" data-action="export">↓ Sao lưu</button>
        </div>
        <p>Tìm kiếm bài học cũ để vào học lại hoặc quản lý bài học của bạn.</p>

        <!-- THANH TÌM KIẾM BÀI HỌC -->
        <div class="lesson-search-bar">
          <span class="search-icon">⌕</span>
          <input type="text" inputmode="search" id="lessonSearchInput" placeholder="Tìm tên bài, mã bài, cấp độ N5/N4..." value="${h(state.lessonSearch)}" autocomplete="off" />
          ${state.lessonSearch ? `<button class="btn-clear-search" data-action="clear-lesson-search" title="Xóa tìm kiếm">✕</button>` : ''}
        </div>

        <!-- BỘ LỌC BÀI HỌC (TÁCH BIỆT BÀI CỦA TÔI VÀ BÀI NGƯỜI KHÁC VỚI ADMIN) -->
        <div class="lesson-filter-tabs">
          <button class="lesson-filter-btn ${state.lessonFilter==='all'?'active':''}" data-action="filter-lessons" data-filter="all">Tất cả bài học (${state.lessons.length})</button>
          <button class="lesson-filter-btn ${state.lessonFilter==='my'?'active':''}" data-action="filter-lessons" data-filter="my">Bài học của tôi (${myLessons.length})</button>
          ${isAdmin ? `
            <button class="lesson-filter-btn ${state.lessonFilter==='others'?'active':''}" data-action="filter-lessons" data-filter="others">Bài của người khác (${otherLessons.length})</button>
          ` : ''}
        </div>

        ${isAdmin && state.lessonFilter === 'others' && otherCreators.length ? `
          <div class="lesson-subfilter" style="margin-bottom:12px;display:flex;align-items:center;gap:8px;font-size:12px">
            <span>Lọc theo người tải:</span>
            <select id="lessonOwnerFilterSelect" style="padding:4px 8px;border-radius:6px;border:1px solid var(--border)">
              <option value="all">Tất cả người dùng (${otherCreators.length})</option>
              ${otherCreators.map(u => `<option value="${h(u)}" ${state.lessonOwnerFilter === u ? 'selected' : ''}>@${h(u)}</option>`).join('')}
            </select>
          </div>
        ` : ''}

        <!-- DANH SÁCH BÀI HỌC -->
        ${displayedLessons.length ? `
          <div class="lesson-card-list">
            ${displayedLessons.map(l => {
              const isMine = l.createdBy === currentUsername;
              const canEdit = isMine; // Nghiêm ngặt: Admin không được sửa bài người khác!
              const canDelete = isMine || isAdmin;
              const vocabCount = (l.vocabulary || []).length;
              const grammarCount = (l.grammar || []).length;
              const kanjiCount = (l.kanji || []).length;
              const readingCount = (l.readings || []).length;

              return `
                <div class="lesson-card-item">
                  <div class="lesson-card-header">
                    <div class="lesson-card-title-group">
                      <span class="lesson-badge-level">${h(l.level || 'N5')}</span>
                      <strong>${h(l.title)}</strong>
                      ${isMine ? `<span class="lesson-badge-mine">Của bạn</span>` : `<span class="lesson-badge-other">@${h(l.createdBy || 'system')}</span>`}
                    </div>
                    <div class="lesson-card-meta">
                      <span>単 ${vocabCount} từ</span>
                      <span>文 ${grammarCount} mẫu</span>
                      <span>漢 ${kanjiCount} Kanji</span>
                      <span>読 ${readingCount} bài đọc</span>
                      <span>👤 @${h(l.createdBy || 'system')}</span>
                    </div>
                  </div>
                  <div class="lesson-card-actions">
                    <button class="button-primary btn-sm" data-action="learn-lesson" data-id="${h(l.id)}" title="Học từ vựng bài này ngay">▶ Học từ vựng</button>
                    <button class="button-secondary btn-sm" data-action="practice-lesson" data-id="${h(l.id)}" title="Luyện flashcard bài này">▣ Flashcard</button>
                    <button class="button-subtle btn-sm" data-action="grammar-lesson" data-id="${h(l.id)}" title="Xem mẫu câu bài này">文 Mẫu câu</button>
                    ${canEdit ? `<button class="button-secondary btn-sm" data-action="edit-lesson" data-id="${h(l.id)}" title="Chỉnh sửa bài học &amp; từng mục">✏ Sửa bài</button>` : ''}
                    ${readingCount ? `<button class="button-subtle btn-sm" data-action="reading-lesson" data-id="${h(l.id)}">読 Bài đọc</button>` : ''}
                    <button class="button-subtle btn-sm" data-action="download-lesson" data-id="${h(l.id)}" title="Tải file JSON bài học này">↓ Tải JSON</button>
                    ${canDelete ? `<button class="button-danger btn-sm" data-action="open-delete-confirm" data-id="${h(l.id)}" title="Xóa bài học khỏi cơ sở dữ liệu">Xóa</button>` : ''}
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        ` : `
          <div class="empty-panel" style="box-shadow:none;margin-top:14px;padding:28px 14px">
            <div class="empty-symbol" style="width:48px;height:48px;font-size:24px">🔍</div>
            <h3 style="font-size:14px">Không tìm thấy bài học phù hợp</h3>
            <p>${state.lessonSearch ? `Không có bài học nào khớp với từ khóa "<b>${h(state.lessonSearch)}</b>".` : 'Chưa có bài học nào trong danh mục này. Hãy tải file JSON lên để bắt đầu!'}</p>
            ${state.lessonSearch ? `<button class="button-secondary btn-sm" data-action="clear-lesson-search">Xóa bộ lọc tìm kiếm</button>` : ''}
          </div>
        `}
      </section>
    </div>
  `;
}

// ==================== LESSON EDITOR FUNCTIONS ====================
function openLessonEditor(lessonId) {
  const lesson = state.lessons.find(l => l.id === lessonId);
  if (!lesson) return;
  // Deep clone to prevent mutating active state until saved
  state.editor.lesson = JSON.parse(JSON.stringify(lesson));
  state.editor.activeTab = 'vocab';
  state.editor.duplicateError = null;
  renderLessonEditorModal();
  $('lessonEditorOverlay').style.display = 'flex';
}

function renderLessonEditorModal() {
  const l = state.editor.lesson;
  if (!l) return;
  const tab = state.editor.activeTab;
  $('editorModalTitle').textContent = `✏ Chỉnh sửa bài học: ${l.title}`;

  const bodyEl = $('editorModalBody');
  bodyEl.innerHTML = `
    <div class="editor-header-fields">
      <div class="field-row">
        <label>
          <span>TÊN BÀI HỌC</span>
          <input type="text" id="editLessonTitle" value="${h(l.title)}" />
        </label>
        <label style="max-width:120px">
          <span>CẤP ĐỘ</span>
          <input type="text" id="editLessonLevel" value="${h(l.level || 'N5')}" />
        </label>
        <label>
          <span>GIÁO TRÌNH</span>
          <input type="text" id="editLessonBook" value="${h(l.book || '')}" />
        </label>
        <label style="max-width:100px">
          <span>THỨ TỰ</span>
          <input type="number" id="editLessonOrder" value="${l.order || 1}" />
        </label>
      </div>
    </div>

    ${state.editor.duplicateError ? `<div class="login-error" style="margin-bottom:12px">${h(state.editor.duplicateError)}</div>` : ''}

    <div class="editor-tabs">
      <button class="editor-tab-btn ${tab === 'vocab' ? 'active' : ''}" data-action="switch-editor-tab" data-tab="vocab">Từ vựng (${(l.vocabulary || []).length})</button>
      <button class="editor-tab-btn ${tab === 'grammar' ? 'active' : ''}" data-action="switch-editor-tab" data-tab="grammar">Mẫu câu (${(l.grammar || []).length})</button>
      <button class="editor-tab-btn ${tab === 'kanji' ? 'active' : ''}" data-action="switch-editor-tab" data-tab="kanji">Chữ Hán (${(l.kanji || []).length})</button>
      <button class="editor-tab-btn ${tab === 'reading' ? 'active' : ''}" data-action="switch-editor-tab" data-tab="reading">Bài đọc (${(l.readings || []).length})</button>
    </div>

    <div class="editor-items-container">
      ${tab === 'vocab' ? renderVocabEditor(l.vocabulary || []) : ''}
      ${tab === 'grammar' ? renderGrammarEditor(l.grammar || []) : ''}
      ${tab === 'kanji' ? renderKanjiEditor(l.kanji || []) : ''}
      ${tab === 'reading' ? renderReadingEditor(l.readings || []) : ''}
    </div>

    <div class="editor-footer-actions">
      <button class="button-primary" data-action="save-lesson-editor">💾 Lưu thay đổi vào MongoDB</button>
      <button class="button-secondary" data-action="close-modals">Hủy bỏ</button>
    </div>
  `;
}

function renderVocabEditor(vocabList) {
  return `
    <div class="items-list-editor">
      <div class="items-list-head">
        <strong>Danh sách từ vựng</strong>
        <button class="button-primary btn-sm" data-action="add-editor-item" data-type="vocab">＋ Thêm từ mới</button>
      </div>
      ${vocabList.map((item, idx) => `
        <div class="editor-item-row" data-index="${idx}">
          <div class="item-fields-grid">
            <input type="text" placeholder="Mã ID (v01, v02...)" value="${h(item.id)}" data-prop="id" class="item-input-id" />
            <input type="text" placeholder="Tiếng Nhật (私[わたし])" value="${h(item.japanese)}" data-prop="japanese" />
            <input type="text" placeholder="Phiên âm (わたし)" value="${h(item.reading || '')}" data-prop="reading" />
            <input type="text" placeholder="Nghĩa tiếng Việt" value="${h(item.meaning || '')}" data-prop="meaning" />
            <input type="text" placeholder="Câu ví dụ" value="${h(item.example || '')}" data-prop="example" />
            <input type="text" placeholder="Nghĩa câu ví dụ" value="${h(item.exampleMeaning || '')}" data-prop="exampleMeaning" />
          </div>
          <button class="btn-delete-item" data-action="remove-editor-item" data-index="${idx}" title="Xóa từ này">✕</button>
        </div>
      `).join('')}
    </div>
  `;
}

function renderGrammarEditor(grammarList) {
  return `
    <div class="items-list-editor">
      <div class="items-list-head">
        <strong>Danh sách mẫu câu</strong>
        <button class="button-primary btn-sm" data-action="add-editor-item" data-type="grammar">＋ Thêm mẫu câu</button>
      </div>
      ${grammarList.map((item, idx) => `
        <div class="editor-item-row" data-index="${idx}">
          <div class="item-fields-grid">
            <input type="text" placeholder="Mã ID (g01)" value="${h(item.id)}" data-prop="id" class="item-input-id" />
            <input type="text" placeholder="Tiêu đề mẫu" value="${h(item.title || '')}" data-prop="title" />
            <input type="text" placeholder="Cấu trúc (N1 は N2 です)" value="${h(item.pattern || '')}" data-prop="pattern" />
            <input type="text" placeholder="Ý nghĩa tiếng Việt" value="${h(item.meaning || '')}" data-prop="meaning" />
            <textarea placeholder="Giải thích ngữ pháp..." data-prop="explanation" style="grid-column:span 2;height:60px">${h(item.explanation || '')}</textarea>
          </div>
          <button class="btn-delete-item" data-action="remove-editor-item" data-index="${idx}" title="Xóa mẫu câu">✕</button>
        </div>
      `).join('')}
    </div>
  `;
}

function renderKanjiEditor(kanjiList) {
  return `
    <div class="items-list-editor">
      <div class="items-list-head">
        <strong>Danh sách chữ Hán</strong>
        <button class="button-primary btn-sm" data-action="add-editor-item" data-type="kanji">＋ Thêm chữ Hán</button>
      </div>
      ${kanjiList.map((item, idx) => `
        <div class="editor-item-row" data-index="${idx}">
          <div class="item-fields-grid">
            <input type="text" placeholder="Mã ID (k01)" value="${h(item.id)}" data-prop="id" class="item-input-id" />
            <input type="text" placeholder="Chữ Hán (人, 日...)" value="${h(item.character)}" data-prop="character" style="font-size:18px;font-weight:bold" />
            <input type="text" placeholder="Ý nghĩa (Nhân - người)" value="${h(item.meaning || '')}" data-prop="meaning" />
            <input type="text" placeholder="Âm Onyomi (ジン)" value="${h(item.onyomi || '')}" data-prop="onyomi" />
            <input type="text" placeholder="Âm Kunyomi (ひと)" value="${h(item.kunyomi || '')}" data-prop="kunyomi" />
          </div>
          <button class="btn-delete-item" data-action="remove-editor-item" data-index="${idx}" title="Xóa chữ Hán">✕</button>
        </div>
      `).join('')}
    </div>
  `;
}

function renderReadingEditor(readingList) {
  return `
    <div class="items-list-editor">
      <div class="items-list-head">
        <strong>Danh sách bài đọc</strong>
        <button class="button-primary btn-sm" data-action="add-editor-item" data-type="reading">＋ Thêm bài đọc</button>
      </div>
      ${readingList.map((item, idx) => `
        <div class="editor-item-row" data-index="${idx}">
          <div class="item-fields-grid" style="grid-template-columns:1fr">
            <div style="display:flex;gap:8px">
              <input type="text" placeholder="Mã ID (r01)" value="${h(item.id)}" data-prop="id" class="item-input-id" style="width:100px" />
              <input type="text" placeholder="Tiêu đề bài đọc" value="${h(item.title || '')}" data-prop="title" style="flex:1" />
            </div>
            <textarea placeholder="Nội dung tiếng Nhật..." data-prop="japanese" style="height:80px">${h(item.japanese || '')}</textarea>
            <textarea placeholder="Bản dịch tiếng Việt..." data-prop="translation" style="height:60px">${h(item.translation || '')}</textarea>
          </div>
          <button class="btn-delete-item" data-action="remove-editor-item" data-index="${idx}" title="Xóa bài đọc">✕</button>
        </div>
      `).join('')}
    </div>
  `;
}

// Xử lý xác nhận xóa bài học (Đặc biệt với Admin xóa bài người khác)
function openDeleteConfirmModal(lessonId) {
  const lesson = state.lessons.find(l => l.id === lessonId);
  if (!lesson) return;
  const currentUsername = state.currentUser?.username || '';
  const isOtherUser = lesson.createdBy !== currentUsername;

  state.deleteModal = {
    lessonId: lesson.id,
    lessonTitle: lesson.title,
    isOtherUser,
    confirmInput: ''
  };

  const bodyEl = $('deleteConfirmBody');
  bodyEl.innerHTML = `
    <div class="delete-warning-box">
      <p>Bạn đang chuẩn bị xóa bài học: <strong>${h(lesson.title)}</strong> (Mã: <code>${h(lesson.id)}</code>).</p>
      <p style="color:#d04c6b">⚠ Thao tác này sẽ xóa vĩnh viễn bài học và toàn bộ các bản ghi tiến độ học tập liên quan khỏi cơ sở dữ liệu MongoDB.</p>
      ${isOtherUser ? `
        <div class="admin-delete-notice">
          <strong>LƯU Ý DÀNH CHO QUẢN TRỊ VIÊN:</strong>
          <p>Bài học này thuộc về người dùng <strong>@${h(lesson.createdBy)}</strong>. Để đảm bảo an toàn tuyệt đối, vui lòng gõ chính xác mã bài <code>${h(lesson.id)}</code> hoặc tên bài vào ô bên dưới để xác nhận:</p>
          <input type="text" id="deleteConfirmInput" placeholder="Nhập '${h(lesson.id)}' để xác nhận" style="width:100%;height:40px;margin-top:8px" autocomplete="off" />
        </div>
      ` : ''}
      <div class="button-row" style="margin-top:20px;justify-content:flex-end">
        <button class="button-secondary" data-action="close-modals">Hủy bỏ</button>
        <button class="button-danger" data-action="confirm-delete-lesson" ${isOtherUser ? 'disabled' : ''} id="btnFinalDelete">
          Xác nhận xóa vĩnh viễn
        </button>
      </div>
    </div>
  `;

  $('deleteConfirmOverlay').style.display = 'flex';
}


// ==================== KANJI CANVAS INTERACTION ====================
function initKanjiCanvas() {
  const canvas = $('kanjiCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.strokeStyle = '#2d3748';
  ctx.lineWidth = 9;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  function redrawCanvas() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Draw all completed strokes
    for (const stroke of state.kanjiWrite.strokes) {
      if (!stroke.length) continue;
      ctx.beginPath();
      ctx.moveTo(stroke[0].x, stroke[0].y);
      for (let i = 1; i < stroke.length; i++) {
        ctx.lineTo(stroke[i].x, stroke[i].y);
      }
      ctx.stroke();
    }
    // Draw stroke currently being drawn
    if (state.kanjiWrite.currentStroke.length > 0) {
      const s = state.kanjiWrite.currentStroke;
      ctx.beginPath();
      ctx.moveTo(s[0].x, s[0].y);
      for (let i = 1; i < s.length; i++) {
        ctx.lineTo(s[i].x, s[i].y);
      }
      ctx.stroke();
    }
  }

  function getCoords(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY
    };
  }

  canvas.onpointerdown = (e) => {
    canvas.setPointerCapture(e.pointerId);
    state.kanjiWrite.isDrawing = true;
    const pt = getCoords(e);
    state.kanjiWrite.currentStroke = [pt];
    redrawCanvas();
  };

  canvas.onpointermove = (e) => {
    if (!state.kanjiWrite.isDrawing) return;
    const pt = getCoords(e);
    state.kanjiWrite.currentStroke.push(pt);
    redrawCanvas();
  };

  canvas.onpointerup = (e) => {
    if (!state.kanjiWrite.isDrawing) return;
    state.kanjiWrite.isDrawing = false;
    if (state.kanjiWrite.currentStroke.length > 0) {
      state.kanjiWrite.strokes.push([...state.kanjiWrite.currentStroke]);
      state.kanjiWrite.currentStroke = [];
    }
    redrawCanvas();
  };

  canvas.onpointercancel = () => {
    state.kanjiWrite.isDrawing = false;
    state.kanjiWrite.currentStroke = [];
    redrawCanvas();
  };

  redrawCanvas();
}

async function loadCurrentKanjiStrokes() {
  const allKanjis = getKanjiStudyList();
  if (!allKanjis.length) return;
  const idx = Math.min(state.kanjiWrite.currentIndex, allKanjis.length - 1);
  const currentKanji = allKanjis[idx];
  const char = currentKanji?.character;
  if (!char) return;

  state.kanjiWrite.loadingStrokes = true;
  try {
    const strokeData = await getKanjiStrokes(char);
    state.kanjiWrite.loadedSvg = strokeData.svgContent || null;
  } catch (err) {
    console.error('Không tải được mẫu nét:', err);
    state.kanjiWrite.loadedSvg = null;
  } finally {
    state.kanjiWrite.loadingStrokes = false;
    renderView();
    initKanjiCanvas();
  }
}

function renderUsers() {
  if (state.currentUser?.role !== 'admin') {
    return `<div class="empty-panel"><div class="empty-symbol">🔒</div><h3>Quyền truy cập bị giới hạn</h3><p>Chỉ tài khoản Quản trị viên (admin) mới có quyền truy cập trang quản lý người dùng.</p><button class="button-primary" data-tab="vocabulary">Quay lại Từ vựng</button></div>`;
  }

  $('sectionCount').textContent = `${state.userList.length} tài khoản`;

  return `
    <div class="notice">
      ⓘ <strong>Khu vực Quản trị nội bộ:</strong> Bạn đang đăng nhập với tư cách Quản trị viên (admin). Tạo tài khoản cho nhân viên/học viên nội bộ để họ đăng nhập trên bất kỳ điện thoại hay máy tính nào.
    </div>
    <div class="users-layout">
      <section class="import-panel">
        <h3>＋ Tạo tài khoản mới</h3>
        <p>Tạo tài khoản thành viên nội bộ (khoảng 10 người dùng).</p>
        <form id="createUserForm" class="user-form">
          <label class="user-field">
            <span>TÊN ĐĂNG NHẬP (DUY NHẤT)</span>
            <input type="text" id="newUsername" placeholder="Ví dụ: van_a, hoang_nam..." required autocomplete="off" />
          </label>
          <label class="user-field">
            <span>TÊN HIỂN THỊ</span>
            <input type="text" id="newName" placeholder="Ví dụ: Nguyễn Văn A" required autocomplete="off" />
          </label>
          <label class="user-field">
            <span>MẬT KHẨU KHỞI TẠO</span>
            <input type="password" id="newPassword" placeholder="Tối thiểu 4 ký tự" required autocomplete="new-password" />
          </label>
          <label class="user-field">
            <span>VAI TRÒ TÀI KHOẢN</span>
            <select id="newRole">
              <option value="user">Học viên / Thành viên nội bộ</option>
              <option value="admin">Quản trị viên (Toàn quyền)</option>
            </select>
          </label>
          <button type="submit" class="button-primary" style="margin-top:8px">＋ Tạo tài khoản</button>
        </form>
      </section>

      <section class="import-panel">
        <h3>Danh sách người dùng nội bộ (${state.userList.length})</h3>
        <p>${isCloudActive ? 'Đang lưu trữ trên MongoDB Atlas.' : 'Đang lưu tạm trên thiết bị (Offline).'}</p>
        <div class="user-list">
          ${state.userList.map(u => {
            const isAdmin = u.role === 'admin';
            const isSelf = u.username === state.currentUser?.username;
            const isMainAdmin = u.username === 'admin';
            return `
              <div class="user-card-item">
                <div class="user-card-main">
                  <div class="user-avatar-circle ${isAdmin ? 'role-admin' : 'role-user'}">${h((u.name || u.username)[0].toUpperCase())}</div>
                  <div class="user-card-details">
                    <strong>${h(u.name || u.username)} ${isSelf ? '<small style="color:#705be4;display:inline">(Bạn)</small>' : ''}</strong>
                    <small>@${h(u.username)} • <span class="user-badge-role ${isAdmin ? 'role-admin' : 'role-user'}">${isAdmin ? 'Quản trị' : 'Học viên'}</span></small>
                  </div>
                </div>
                <div class="user-card-actions">
                  <button class="button-subtle" style="padding:6px 10px;font-size:11px" data-action="reset-user-pwd" data-username="${h(u.username)}">Đổi pass</button>
                  ${(!isSelf && !isMainAdmin) ? `<button class="button-danger" style="padding:6px 10px;font-size:11px" data-action="delete-user" data-username="${h(u.username)}">Xóa</button>` : ''}
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </section>
    </div>
  `;
}

function renderView() {
  const pasteDraft = $('jsonPaste')?.value;
  let result = '';
  switch (state.tab) {
    case 'vocabulary': result = renderVocabulary(); break;
    case 'practice': result = renderPractice(); break;
    case 'quiz': result = renderQuiz(); break;
    case 'grammar': result = renderGrammar(); break;
    case 'kanji':
      result = renderKanji();
      setTimeout(() => { if (state.kanjiWrite.subTab === 'write') initKanjiCanvas(); }, 10);
      break;
    case 'reading': result = renderReadings(); break;
    case 'imports': result = renderImports(); break;
    case 'users': result = renderUsers(); break;
    default: result = renderVocabulary();
  }
  $('view').innerHTML = result;
  if (pasteDraft !== undefined && $('jsonPaste')) $('jsonPaste').value = pasteDraft;
  if (state.tab === 'practice') {
    if ($('cardType')) $('cardType').value = state.flash.type;
    if ($('cardMode')) $('cardMode').value = state.flash.mode;
    if ($('cardDirection')) $('cardDirection').value = state.flash.direction;
  }
}

function nextCard(delta) {
  const count = studyCards().length;
  if (!count) return;
  state.flash.index = (state.flash.index + delta + count) % count;
  state.flash.flipped = false;
  renderView();
}

async function markCard(rating) {
  if (savingProgress) return;
  const cards = studyCards();
  const card = cards[state.flash.index];
  if (!card) return;
  const username = state.currentUser?.username || 'default';
  const progressKey = `${username}:${card.key}`;
  const old = state.progress.get(progressKey) || state.progress.get(card.key);
  const prevInterval = old?.intervalDays || 0;
  const intervalDays = rating === 'again' ? 0 : rating === 'good' ? Math.max(1, Math.round(prevInterval * 1.8)) : Math.max(3, Math.round(prevInterval * 2.5));
  const record = {
    key: progressKey,
    cardKey: card.key,
    username,
    status: rating === 'again' ? 'learning' : 'known',
    intervalDays,
    dueAt: rating === 'again' ? Date.now() : Date.now() + intervalDays * 86400000,
    reviews: (old?.reviews || 0) + 1,
    updatedAt: Date.now()
  };
  try {
    savingProgress = true;
    await cloudSaveProgress(record);
  } catch (error) {
    console.error('Lỗi lưu tiến độ:', error);
    notify('Không lưu được kết quả học: ' + error.message);
    return;
  } finally {
    savingProgress = false;
  }
  if (state.currentUser?.username !== username) return;
  state.progress.set(progressKey, record);
  state.progress.set(card.key, record);

  const nextLength = studyCards().length;
  state.flash.index = nextLength ? (nextLength === cards.length ? (state.flash.index + 1) % nextLength : Math.min(state.flash.index, nextLength - 1)) : 0;
  state.flash.flipped = false;
  renderMetrics();
  renderView();
}

function speak(text) {
  if (!('speechSynthesis' in window)) { notify('Trình duyệt này chưa hỗ trợ đọc văn bản.'); return; }
  try {
    speechSynthesis.cancel();
    const clean = stripFurigana(text);
    const msg = new SpeechSynthesisUtterance(clean);
    msg.lang = 'ja-JP';
    msg.rate = 0.84;
    const voices = speechSynthesis.getVoices();
    msg.voice = voices.find(v => v.lang.toLowerCase() === 'ja-jp') || voices.find(v => v.lang.startsWith('ja')) || null;
    speechSynthesis.speak(msg);
  } catch (error) {
    notify('Không thể phát âm: ' + error.message);
  }
}

export function splitReadingText(text, maxLength = 150) {
  const chars = Array.from(stripFurigana(text));
  const chunks = [];
  let part = '';
  for (const char of chars) {
    part += char;
    if (part.length >= maxLength || (part.length >= 40 && /[。！？!?\n]/.test(char))) {
      if (part.trim()) chunks.push(part.trim());
      part = '';
    }
  }
  if (part.trim()) chunks.push(part.trim());
  return chunks;
}

function speakPassage(text, rate) {
  if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') { notify('Trình duyệt này chưa hỗ trợ đọc văn bản.'); return; }
  try {
    speechSynthesis.cancel();
    const voices = speechSynthesis.getVoices();
    const voice = voices.find(v => v.lang.toLowerCase() === 'ja-jp') || voices.find(v => v.lang.toLowerCase().startsWith('ja'));
    for (const chunk of splitReadingText(text)) {
      const msg = new SpeechSynthesisUtterance(chunk);
      msg.lang = 'ja-JP';
      msg.rate = Number.isFinite(rate) ? rate : 0.85;
      if (voice) msg.voice = voice;
      msg.onerror = event => { if (!['canceled', 'interrupted'].includes(event.error)) notify('Không thể đọc bài. Hãy kiểm tra giọng tiếng Nhật trên thiết bị.'); };
      speechSynthesis.speak(msg);
    }
  } catch (error) { notify('Không thể đọc bài: ' + error.message); }
}

function download(name, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = name; document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function importPayload(payload, sourceName='JSON') {
  const incoming = parseLessons(payload);
  const currentUsername = state.currentUser?.username || 'admin';
  for (const l of incoming) {
    if (!l.createdBy) l.createdBy = currentUsername;
    l.sourceId = l.sourceId || l.id;
    if (!l.id.startsWith(`${currentUsername}:`)) {
      l.id = `${currentUsername}:${l.id}`;
    }
  }
  await cloudSaveLessons(incoming, currentUsername);
  await reloadLessons();
  if ($('jsonPaste')) $('jsonPaste').value = '';
  render();
  notify(`Đã lưu ${incoming.length} bài học từ "${sourceName}" vào tài khoản @${currentUsername}.`);
  return incoming.length;
}

async function importFiles(fileList) {
  const files = Array.from(fileList).filter(f => f.name.toLowerCase().endsWith('.json') || f.type === 'application/json');
  if (!files.length) { notify('Vui lòng chọn file JSON.'); return; }
  let success = 0; const errors = [];
  for (const file of files) {
    try {
      const payload = JSON.parse(await file.text());
      await importPayload(payload, file.name);
      success++;
    } catch (error) {
      errors.push(`${file.name}: ${error.message}`);
    }
  }
  if (errors.length) {
    notify(`Nhập thành công ${success}/${files.length} file. Lỗi: ${errors.slice(0, 2).join(' | ')}${errors.length > 2 ? ' …' : ''}`);
  } else {
    notify(`Đã nạp thành công ${success} file JSON vào hệ thống.`);
  }
}

function fallbackCopyPrompt() {
  const ta = document.createElement('textarea');
  ta.value = AI_PROMPT_TEMPLATE;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    notify('📋 Đã sao chép Prompt cho AI vào bộ nhớ tạm!');
  } catch (e) {
    notify('Không thể tự sao chép. Bạn hãy chọn và sao chép thủ công từ khung bên dưới.');
  }
  ta.remove();
}

async function handleAction(button) {
  if (button.dataset.tab) { switchTab(button.dataset.tab); return; }
  const action = button.dataset.action;

  // --- KANJI ACTIONS ---
  if (action === 'switch-kanji-subtab') {
    state.kanjiWrite.subTab = button.dataset.subtab || 'library';
    if (state.kanjiWrite.subTab === 'write') {
      loadCurrentKanjiStrokes();
    } else {
      renderView();
    }
    return;
  }
  if (action === 'start-kanji-write') {
    const char = button.dataset.char;
    const allKanjis = getKanjiStudyList();
    const idx = allKanjis.findIndex(k => k.character === char);
    if (idx !== -1) state.kanjiWrite.currentIndex = idx;
    state.kanjiWrite.subTab = 'write';
    state.kanjiWrite.strokes = [];
    state.kanjiWrite.lastResult = null;
    state.kanjiWrite.overrideResult = null;
    loadCurrentKanjiStrokes();
    return;
  }
  if (action === 'set-kanji-mode') {
    state.kanjiWrite.mode = button.dataset.mode;
    renderView();
    initKanjiCanvas();
    return;
  }
  if (action === 'clear-kanji-draw') {
    state.kanjiWrite.strokes = [];
    state.kanjiWrite.currentStroke = [];
    state.kanjiWrite.lastResult = null;
    state.kanjiWrite.overrideResult = null;
    initKanjiCanvas();
    renderView();
    initKanjiCanvas();
    return;
  }
  if (action === 'toggle-kanji-hint') {
    state.kanjiWrite.showHint = !state.kanjiWrite.showHint;
    renderView();
    initKanjiCanvas();
    return;
  }
  if (action === 'prev-kanji') {
    if (state.kanjiWrite.currentIndex > 0) {
      state.kanjiWrite.currentIndex--;
      state.kanjiWrite.strokes = [];
      state.kanjiWrite.lastResult = null;
      state.kanjiWrite.overrideResult = null;
      loadCurrentKanjiStrokes();
    }
    return;
  }
  if (action === 'next-kanji') {
    const allKanjis = getKanjiStudyList();
    if (state.kanjiWrite.currentIndex < allKanjis.length - 1) {
      state.kanjiWrite.currentIndex++;
      state.kanjiWrite.strokes = [];
      state.kanjiWrite.lastResult = null;
      state.kanjiWrite.overrideResult = null;
      loadCurrentKanjiStrokes();
    }
    return;
  }
  if (action === 'submit-kanji-draw') {
    const allKanjis = getKanjiStudyList();
    const currentKanji = allKanjis[state.kanjiWrite.currentIndex];
    if (!currentKanji) return;
    const char = currentKanji.character;
    
    try {
      const strokeData = await getKanjiStrokes(char);
      const evalResult = evaluateKanjiDrawing(state.kanjiWrite.strokes, strokeData.strokes, {
        mode: state.kanjiWrite.mode,
        threshold: 80
      });
      state.kanjiWrite.lastResult = evalResult;
      state.kanjiWrite.overrideResult = null;

      // Lưu tiến độ vào MongoDB
      const username = state.currentUser?.username || 'default';
      const record = {
        key: `${username}:kanji_write:${currentKanji.lessonId || state.lessonId}:${currentKanji.id}`,
        cardKey: `${currentKanji.lessonId || state.lessonId}:kanji:${currentKanji.id}`,
        username,
        activity: 'kanji_write',
        score: evalResult.score,
        passed: evalResult.passed,
        mode: state.kanjiWrite.mode,
        reviews: 1,
        updatedAt: Date.now()
      };
      await cloudSaveProgress(record);
      notify(evalResult.passed ? `Đạt ${evalResult.score}/100 điểm!` : `Chưa đạt (${evalResult.score}/100 điểm). Hãy thử viết lại!`);
    } catch (err) {
      console.error('Lỗi chấm nét chữ Hán:', err);
      notify('Lỗi chấm điểm: ' + err.message);
    }
    renderView();
    initKanjiCanvas();
    return;
  }
  if (action === 'override-grade') {
    const status = button.dataset.status === 'pass';
    state.kanjiWrite.overrideResult = status;
    const allKanjis = getKanjiStudyList();
    const currentKanji = allKanjis[state.kanjiWrite.currentIndex];
    if (currentKanji) {
      const username = state.currentUser?.username || 'default';
      const record = {
        key: `${username}:kanji_write:${currentKanji.lessonId || state.lessonId}:${currentKanji.id}`,
        cardKey: `${currentKanji.lessonId || state.lessonId}:kanji:${currentKanji.id}`,
        username,
        activity: 'kanji_write',
        score: status ? 85 : 50,
        passed: status,
        mode: state.kanjiWrite.mode,
        manualOverride: true,
        updatedAt: Date.now()
      };
      await cloudSaveProgress(record);
      notify(status ? 'Đã đánh dấu Đạt cho chữ này.' : 'Đã đánh dấu Cần luyện lại cho chữ này.');
    }
    renderView();
    initKanjiCanvas();
    return;
  }

  // --- QUIZ ACTIONS ---
  if (action === 'start-quiz-session') {
    const contentType = $('quizContentTypeSelect')?.value || state.quiz.contentType || 'all';
    const mode = $('quizModeSelect')?.value || state.quiz.mode || 'all_mix';
    const scope = $('quizScopeSelect')?.value || state.quiz.scope || 'current';
    const limit = $('quizLimitSelect')?.value || state.quiz.limit || 10;
    const reviewCheckbox = $('quizReviewOnlyCheckbox');
    const onlyReview = reviewCheckbox && !reviewCheckbox.disabled ? Boolean(reviewCheckbox.checked) : false;

    state.quiz.contentType = contentType;
    state.quiz.mode = mode;
    state.quiz.scope = scope;
    state.quiz.limit = limit === 'all' ? 'all' : Number(limit);
    state.quiz.onlyReview = onlyReview;

    try {
      const session = buildQuizSession(state.lessons, {
        lessonId: scope === 'current' ? state.lessonId : 'all',
        contentType,
        mode,
        limit: state.quiz.limit,
        onlyReview,
        progressMap: state.progress,
        currentUser: state.currentUser
      });

      if (!session.success) {
        notify(session.message);
        return;
      }

      state.quiz.session = session;
      state.quiz.currentIndex = 0;
      state.quiz.selectedOption = null;
      state.quiz.answered = false;
      state.quiz.history = [];
      renderView();
    } catch (err) {
      notify(err.message);
    }
    return;
  }
  if (action === 'select-quiz-option') {
    if (state.quiz.answered) return;
    const optionText = button.dataset.option;
    const qIndex = state.quiz.currentIndex;
    const q = state.quiz.session.questions[qIndex];
    state.quiz.selectedOption = optionText;
    state.quiz.answered = true;

    const isCorrect = optionText === q.correctAnswer;
    state.quiz.history.push({
      questionIndex: qIndex,
      selected: optionText,
      correct: q.correctAnswer,
      isCorrect
    });

    // Cập nhật trạng thái ôn tập theo máy trạng thái quy tắc (updateReviewStatus)
    const username = state.currentUser?.username || 'default';
    const cardKey = `${q.lessonId}:${q.itemType}:${q.itemId}`;
    const progressKey = `${username}:quiz:${cardKey}`;
    const oldRecord = state.progress.get(progressKey) || state.progress.get(cardKey);

    const updated = updateReviewStatus(oldRecord, isCorrect);
    const fullRecord = {
      ...updated,
      key: progressKey,
      cardKey,
      username,
      lessonId: q.lessonId,
      itemId: q.itemId,
      itemType: q.itemType,
      activity: 'quiz'
    };

    cloudSaveProgress(fullRecord).catch(err => console.error('Lỗi lưu tiến độ trắc nghiệm:', err));
    state.progress.set(progressKey, fullRecord);
    state.progress.set(cardKey, fullRecord);

    renderView();
    return;
  }
  if (action === 'next-quiz-question') {
    state.quiz.currentIndex++;
    state.quiz.selectedOption = null;
    state.quiz.answered = false;
    renderView();
    return;
  }
  if (action === 'restart-quiz') {
    state.quiz.session = null;
    state.quiz.currentIndex = 0;
    state.quiz.selectedOption = null;
    state.quiz.answered = false;
    state.quiz.history = [];
    renderView();
    return;
  }
  if (action === 'end-quiz') {
    state.quiz.session = null;
    renderView();
    return;
  }

  // --- MODAL & EDITOR ACTIONS ---
  if (action === 'close-modals') {
    document.querySelectorAll('.modal-overlay').forEach(el => {
      // Do not close force change password modal if user must change password!
      if (el.id === 'forceChangePwdOverlay' && state.currentUser?.mustChangePassword) return;
      el.style.display = 'none';
    });
    return;
  }
  if (action === 'open-change-pwd') {
    $('currentPassword').value = '';
    $('changeNewPassword').value = '';
    $('changePwdError').style.display = 'none';
    $('changePwdOverlay').style.display = 'flex';
    return;
  }
  if (action === 'copy-temp-pwd') {
    const code = $('tempPwdDisplay').textContent;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(code).then(() => notify('📋 Đã sao chép mật khẩu tạm!'));
    } else {
      notify('Mật khẩu tạm: ' + code);
    }
    return;
  }
  if (action === 'edit-lesson') {
    openLessonEditor(button.dataset.id);
    return;
  }
  if (action === 'switch-editor-tab') {
    state.editor.activeTab = button.dataset.tab;
    renderLessonEditorModal();
    return;
  }
  if (action === 'add-editor-item') {
    const type = button.dataset.type;
    const l = state.editor.lesson;
    if (!l) return;
    if (type === 'vocab') {
      l.vocabulary = l.vocabulary || [];
      const id = 'v' + String(l.vocabulary.length + 1).padStart(2, '0');
      l.vocabulary.push({ id, japanese: '', reading: '', meaning: '', example: '', exampleMeaning: '' });
    } else if (type === 'grammar') {
      l.grammar = l.grammar || [];
      const id = 'g' + String(l.grammar.length + 1).padStart(2, '0');
      l.grammar.push({ id, title: '', pattern: '', meaning: '', explanation: '', examples: [] });
    } else if (type === 'kanji') {
      l.kanji = l.kanji || [];
      const id = 'k' + String(l.kanji.length + 1).padStart(2, '0');
      l.kanji.push({ id, character: '', meaning: '', onyomi: '', kunyomi: '', examples: [] });
    } else if (type === 'reading') {
      l.readings = l.readings || [];
      const id = 'r' + String(l.readings.length + 1).padStart(2, '0');
      l.readings.push({ id, title: '', japanese: '', translation: '' });
    }
    renderLessonEditorModal();
    return;
  }
  if (action === 'remove-editor-item') {
    const idx = Number(button.dataset.index);
    const l = state.editor.lesson;
    const tab = state.editor.activeTab;
    if (tab === 'vocab') l.vocabulary.splice(idx, 1);
    else if (tab === 'grammar') l.grammar.splice(idx, 1);
    else if (tab === 'kanji') l.kanji.splice(idx, 1);
    else if (tab === 'reading') l.readings.splice(idx, 1);
    renderLessonEditorModal();
    return;
  }
  if (action === 'save-lesson-editor') {
    const l = state.editor.lesson;
    if (!l) return;
    l.title = $('editLessonTitle').value.trim();
    l.level = $('editLessonLevel').value.trim();
    l.book = $('editLessonBook').value.trim();
    l.order = Number($('editLessonOrder').value) || 1;

    // Validate duplicate item IDs
    const checkDupes = (arr, name) => {
      const ids = new Set();
      for (const item of (arr || [])) {
        if (!item.id || !item.id.trim()) throw new Error(`Mục trong ${name} chưa có mã ID.`);
        if (ids.has(item.id.trim())) throw new Error(`Mã ID "${item.id}" bị trùng lặp trong ${name}.`);
        ids.add(item.id.trim());
      }
    };

    try {
      checkDupes(l.vocabulary, 'Từ vựng');
      checkDupes(l.grammar, 'Mẫu câu');
      checkDupes(l.kanji, 'Chữ Hán');
      checkDupes(l.readings, 'Bài đọc');
    } catch (err) {
      state.editor.duplicateError = err.message;
      renderLessonEditorModal();
      return;
    }

    try {
      await cloudUpdateLesson(l.id, l, state.currentUser?.username || '');
      await reloadLessons();
      render();
      $('lessonEditorOverlay').style.display = 'none';
      notify('Đã cập nhật bài học thành công!');
    } catch (err) {
      state.editor.duplicateError = err.message;
      renderLessonEditorModal();
    }
    return;
  }
  if (action === 'open-delete-confirm') {
    openDeleteConfirmModal(button.dataset.id);
    return;
  }
  if (action === 'confirm-delete-lesson') {
    const lessonId = state.deleteModal.lessonId;
    if (!lessonId) return;
    try {
      await cloudDeleteLesson(lessonId, state.currentUser?.username || '');
      await reloadLessons();
      render();
      $('deleteConfirmOverlay').style.display = 'none';
      notify('Đã xóa vĩnh viễn bài học và toàn bộ tiến độ liên quan.');
    } catch (err) {
      notify('Không xóa được: ' + err.message);
    }
    return;
  }

  if (action === 'speak') { speak(button.dataset.text); return; }
  if (action === 'read-passage') {
    const passage = state.lessons.find(lesson => lesson.id === button.dataset.lessonId)?.readings?.find(item => item.id === button.dataset.readingId);
    if (passage) speakPassage(passage.japanese, Number(button.closest('.reading-card').querySelector('.reading-rate').value));
    return;
  }
  if (action === 'stop-reading') { if ('speechSynthesis' in window) speechSynthesis.cancel(); return; }
  if (action === 'flip') { if (Date.now() < ignoreClickUntil) return; state.flash.flipped = !state.flash.flipped; renderView(); return; }
  if (action === 'next') { nextCard(1); return; }
  if (action === 'prev') { nextCard(-1); return; }
  if (action === 'mark') { await markCard(button.dataset.rating); return; }
  if (action === 'shuffle') { shuffleCards(); return; }
  if (action === 'toggle-reverse') { toggleReverse(); return; }
  if (action === 'logout') { await handleLogout(); return; }
  if (action === 'trigger-file-input') {
    const fi = $('fileInput');
    if (fi) fi.click();
    return;
  }
  if (action === 'filter-lessons') {
    state.lessonFilter = button.dataset.filter || 'all';
    renderView();
    return;
  }
  if (action === 'clear-lesson-search') {
    state.lessonSearch = '';
    renderView();
    return;
  }
  if (action === 'learn-lesson') {
    const lesson = state.lessons.find(l => l.id === button.dataset.id);
    if (lesson) {
      state.lessonId = lesson.id;
      switchTab('vocabulary');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      notify(`Đang học bài: "${lesson.title}"`);
    }
    return;
  }
  if (action === 'practice-lesson') {
    const lesson = state.lessons.find(l => l.id === button.dataset.id);
    if (lesson) {
      state.lessonId = lesson.id;
      state.flash.index = 0;
      state.flash.flipped = false;
      state.flash.shuffledKeys = null;
      switchTab('practice');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      notify(`Bắt đầu luyện Flashcard bài: "${lesson.title}"`);
    }
    return;
  }
  if (action === 'grammar-lesson') {
    const lesson = state.lessons.find(l => l.id === button.dataset.id);
    if (lesson) {
      state.lessonId = lesson.id;
      switchTab('grammar');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      notify(`Xem mẫu câu bài: "${lesson.title}"`);
    }
    return;
  }
  if (action === 'reading-lesson') {
    state.lessonId = button.dataset.id;
    switchTab('reading');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  if (action === 'download-lesson') {
    const lesson = state.lessons.find(l => l.id === button.dataset.id);
    if (lesson) {
      download(`${lesson.id}.json`, lesson);
      notify(`Đang tải file bài học: "${lesson.title}"`);
    }
    return;
  }
  if (action === 'copy-ai-prompt') {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(AI_PROMPT_TEMPLATE).then(() => {
        notify('📋 Đã sao chép Prompt cho AI! Bạn hãy dán vào ChatGPT hoặc Claude.');
      }).catch(() => fallbackCopyPrompt());
    } else {
      fallbackCopyPrompt();
    }
    return;
  }
  if (action === 'template') { download('mau-bai-hoc-chuan.json', STANDARD_LESSON_TEMPLATE); return; }
  if (action === 'paste') {
    const raw = $('jsonPaste').value;
    const content = cleanJsonInput(raw);
    if (!content) { notify('Hãy dán nội dung JSON trước.'); return; }
    try {
      await importPayload(JSON.parse(content), 'vùng dán');
    } catch (error) {
      notify('JSON không hợp lệ: ' + error.message);
    }
    return;
  }
  if (action === 'export') {
    if (!state.lessons.length && !state.progress.size) { notify('Chưa có dữ liệu để xuất.'); return; }
    download('nihongo-sao-luu.json', {
      format: 'nihongo-backup-v1',
      exportedAt: new Date().toISOString(),
      user: state.currentUser?.username || 'admin',
      lessons: state.lessons,
      progress: [...new Map([...state.progress.values()].map(item => [item.key, item])).values()]
    });
    return;
  }
  if (action === 'remove') {
    const lesson = state.lessons.find(l => l.id === button.dataset.id);
    if (!lesson) return;
    if (!confirm(`Xóa bài "${lesson.title}" khỏi cơ sở dữ liệu?`)) return;
    try {
      await cloudDeleteLesson(lesson.id, state.currentUser?.username || '');
      await reloadLessons();
      render();
      notify('Đã xóa bài học.');
    } catch (error) {
      notify('Không xóa được: ' + error.message);
    }
    return;
  }
  if (action === 'delete-user') {
    const targetUsername = button.dataset.username;
    if (targetUsername === 'admin' || targetUsername === state.currentUser?.username) {
      notify('Không thể xóa tài khoản này.');
      return;
    }
    if (!confirm(`Bạn có chắc muốn xóa tài khoản @${targetUsername} không?`)) return;
    try {
      await cloudDeleteUser(targetUsername);
      await loadUsersList();
      renderView();
      notify(`Đã xóa tài khoản @${targetUsername}.`);
    } catch (err) {
      notify('Lỗi xóa tài khoản: ' + err.message);
    }
    return;
  }
  if (action === 'reset-user-pwd') {
    const targetUsername = button.dataset.username;
    const useTemp = confirm(`Tạo MẬT KHẨU TẠM THỜI cho @${targetUsername}?\n\nNhấn [OK] để hệ thống tự sinh mật khẩu tạm ngẫu nhiên, thu hồi toàn bộ phiên đăng nhập cũ và bắt buộc người dùng đổi mật khẩu khi đăng nhập.\n\nNhấn [Cancel] nếu muốn tự gõ mật khẩu cố định.`);
    
    if (useTemp) {
      try {
        const res = await cloudResetPassword(targetUsername, '', true);
        $('tempPwdDisplay').textContent = res.temporaryPassword;
        $('tempPwdAlertOverlay').style.display = 'flex';
        notify(`Đã tạo mật khẩu tạm cho @${targetUsername}.`);
      } catch (err) {
        notify('Lỗi tạo mật khẩu tạm: ' + err.message);
      }
      return;
    }

    const newPwd = prompt(`Nhập mật khẩu mới cho tài khoản @${targetUsername}:`);
    if (!newPwd || newPwd.trim().length < 4) {
      if (newPwd !== null) notify('Mật khẩu cần có ít nhất 4 ký tự.');
      return;
    }
    try {
      await cloudResetPassword(targetUsername, newPwd.trim(), false);
      notify(`Đã cập nhật mật khẩu cho @${targetUsername} thành công.`);
    } catch (err) {
      notify('Lỗi đổi mật khẩu: ' + err.message);
    }
    return;
  }
}

async function loadUsersList() {
  try {
    state.userList = await cloudGetUsers();
  } catch (e) {
    state.userList = [];
  }
}

async function reloadUserProgress() {
  const username = state.currentUser?.username || 'default';
  try {
    const rawProgress = await cloudGetProgress(username);
    state.progress = new Map();
    for (const p of rawProgress) {
      const cardKey = p.cardKey || (p.key?.includes(':') && p.key.split(':').length > 3 ? p.key.substring(p.key.indexOf(':') + 1) : p.key);
      state.progress.set(p.key, p);
      if (cardKey) state.progress.set(cardKey, p);
    }
  } catch (err) {
    console.error('Không nạp được tiến độ:', err);
    state.progress = new Map();
    notify('Không tải được tiến độ học: ' + err.message);
  }
}

async function reloadLessons() {
  try {
    if (isCloudActive) {
      const cloudLessons = await cloudGetLessons();
      state.lessons = cloudLessons.map(l => normalizeLesson(l));
      state.imported = state.lessons;
      state.staticLessons = [];
    } else {
      const local = await getImportedLessons();
      state.imported = local.map(l => normalizeLesson(l));
      mergeLessons();
    }
  } catch (e) {
    console.error('Lỗi tải bài học:', e);
    notify('Không tải được bài học: ' + e.message);
    throw e;
  }
}

function updateUserUI() {
  const overlay = $('loginOverlay');
  const userPill = $('userPill');
  const adminNav = $('adminNavGroup');
  const mobileAdmin = $('mobileAdmin');
  if (state.currentUser) {
    overlay.style.display = 'none';
    userPill.style.display = 'flex';
    $('userName').textContent = state.currentUser.name || state.currentUser.username;
    $('userBadgeRole').textContent = state.currentUser.role === 'admin' ? 'Quản trị' : 'Học viên';
    $('userBadgeRole').className = `user-badge-role ${state.currentUser.role === 'admin' ? 'role-admin' : 'role-user'}`;
    if (adminNav) adminNav.style.display = state.currentUser.role === 'admin' ? 'block' : 'none';
    if (mobileAdmin) mobileAdmin.style.display = state.currentUser.role === 'admin' ? '' : 'none';
  } else {
    overlay.style.display = 'flex';
    userPill.style.display = 'none';
    if (adminNav) adminNav.style.display = 'none';
    if (mobileAdmin) mobileAdmin.style.display = 'none';
  }
}

async function handleLogin(e) {
  e.preventDefault();
  const username = $('loginUsername').value.trim().toLowerCase();
  const password = $('loginPassword').value;
  const errEl = $('loginError');
  errEl.style.display = 'none';
  const submit = e.currentTarget.querySelector('[type="submit"]');
  if (submit.disabled) return;
  submit.disabled = true;

  try {
    const user = await cloudLogin(username, password);

    state.currentUser = user;
    localStorage.setItem('nihongo_session', JSON.stringify({
      username: user.username,
      name: user.name,
      role: user.role,
      mustChangePassword: user.mustChangePassword
    }));

    if (user.mustChangePassword) {
      $('forcePwdError').style.display = 'none';
      $('forceNewPassword').value = '';
      $('forceConfirmPassword').value = '';
      $('forceChangePwdOverlay').style.display = 'flex';
    }

    $('loginPassword').value = '';
    updateUserUI();
    await reloadLessons();
    await reloadUserProgress();
    if (user.role === 'admin') await loadUsersList();
    render();
    notify(`Xin chào, ${user.name || user.username}!`);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
    updateUserUI();
    notify(err.message);
  } finally {
    submit.disabled = false;
  }
}

function clearSessionUI() {
  localStorage.removeItem('nihongo_session');
  state.currentUser = null;
  state.progress = new Map();
  state.userList = [];
  state.staticLessons = [];
  state.imported = [];
  state.lessons = [];
  state.lessonId = 'all';
  state.tab = 'vocabulary';
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  render();
  updateUserUI();
}

async function handleLogout() {
  if (!confirm('Bạn có muốn đăng xuất khỏi ứng dụng không?')) return;
  try { await logoutCloud(); } catch (error) { console.error('Không thu hồi được phiên:', error); }
  clearSessionUI();
  $('loginUsername').value = '';
  $('loginPassword').value = '';
  $('loginError').style.display = 'none';
  notify('Đã đăng xuất.');
}

async function handleCreateUser(e) {
  e.preventDefault();
  if (state.currentUser?.role !== 'admin') {
    notify('Chỉ Quản trị viên mới có quyền tạo tài khoản.');
    return;
  }
  const username = $('newUsername').value.trim().toLowerCase();
  const name = $('newName').value.trim();
  const password = $('newPassword').value;
  const role = $('newRole').value;

  if (username.length < 3) { notify('Tên đăng nhập tối thiểu 3 ký tự.'); return; }
  if (password.length < 4) { notify('Mật khẩu tối thiểu 4 ký tự.'); return; }

  try {
    await cloudCreateUser({
      username,
      name: name || username,
      role: role === 'admin' ? 'admin' : 'user',
      password
    });
    await loadUsersList();
    renderView();
    notify(`Đã tạo thành công tài khoản @${username}!`);
    $('newUsername').value = '';
    $('newName').value = '';
    $('newPassword').value = '';
  } catch (err) {
    notify('Lỗi tạo tài khoản: ' + err.message);
  }
}

function setupListeners() {
  window.addEventListener('nihongo-session-expired', () => {
    clearSessionUI();
    notify('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
  });
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-tab],[data-action]');
    if (button) {
      event.preventDefault();
      handleAction(button).catch(e => notify(e.message));
    }
  });

  $('lessonSelect').addEventListener('change', event => {
    state.lessonId = event.target.value;
    state.flash.index = 0;
    state.flash.flipped = false;
    state.flash.shuffledKeys = null;
    renderView();
  });

  $('searchInput').addEventListener('input', event => {
    state.query = event.target.value;
    renderView();
  });

  $('view').addEventListener('input', event => {
    if (event.target.id === 'lessonSearchInput') {
      state.lessonSearch = event.target.value;
      const selectionStart = event.target.selectionStart;
      const selectionEnd = event.target.selectionEnd;
      renderView();
      const input = $('lessonSearchInput');
      if (input) {
        input.focus();
        input.setSelectionRange(selectionStart, selectionEnd);
      }
    }
  });

  $('view').addEventListener('click', event => {
    const zone = event.target.closest('#uploadZone');
    if (zone && event.target.tagName !== 'BUTTON' && event.target.id !== 'fileInput') {
      const fi = $('fileInput');
      if (fi) fi.click();
    }
  });

  $('view').addEventListener('change', event => {
    if (event.target.id === 'cardType') {
      state.flash.type = event.target.value;
      state.flash.index = 0;
      state.flash.flipped = false;
      state.flash.shuffledKeys = null;
      renderView();
    }
    if (event.target.id === 'cardMode') {
      state.flash.mode = event.target.value;
      state.flash.index = 0;
      state.flash.flipped = false;
      renderView();
    }
    if (event.target.id === 'cardDirection') {
      state.flash.direction = event.target.value;
      state.flash.flipped = false;
      renderView();
    }
    if (event.target.id === 'quizContentTypeSelect') {
      state.quiz.contentType = event.target.value;
      if (state.quiz.contentType === 'all') state.quiz.mode = 'all_mix';
      else if (state.quiz.contentType === 'vocabulary') state.quiz.mode = 'vocab_mix';
      else if (state.quiz.contentType === 'grammar') state.quiz.mode = 'grammar_mix';
      else if (state.quiz.contentType === 'kanji') state.quiz.mode = 'kanji_mix';
      renderView();
    }
    if (event.target.id === 'quizModeSelect') {
      state.quiz.mode = event.target.value;
    }
    if (event.target.id === 'quizScopeSelect') {
      state.quiz.scope = event.target.value;
      renderView();
    }
    if (event.target.id === 'quizLimitSelect') {
      state.quiz.limit = event.target.value === 'all' ? 'all' : Number(event.target.value);
    }
    if (event.target.id === 'quizReviewOnlyCheckbox') {
      state.quiz.onlyReview = event.target.checked;
    }
    if (event.target.id === 'fileInput') {
      if (event.target.files && event.target.files.length) {
        importFiles(event.target.files).catch(e => notify(e.message));
      }
      event.target.value = '';
    }
  });

  $('view').addEventListener('submit', event => {
    if (event.target.id === 'createUserForm') {
      handleCreateUser(event);
    }
  });

  $('loginForm').addEventListener('submit', handleLogin);

  // Form bắt buộc đổi mật khẩu khi có flag mustChangePassword
  $('forceChangePwdForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const p1 = $('forceNewPassword').value;
    const p2 = $('forceConfirmPassword').value;
    const errEl = $('forcePwdError');
    if (p1.length < 4) { errEl.textContent = 'Mật khẩu tối thiểu 4 ký tự.'; errEl.style.display = 'block'; return; }
    if (p1 !== p2) { errEl.textContent = 'Mật khẩu xác nhận không khớp.'; errEl.style.display = 'block'; return; }
    
    try {
      await cloudChangePassword(p1);
      if (state.currentUser) state.currentUser.mustChangePassword = false;
      const s = JSON.parse(localStorage.getItem('nihongo_session') || '{}');
      s.mustChangePassword = false;
      localStorage.setItem('nihongo_session', JSON.stringify(s));
      $('forceChangePwdOverlay').style.display = 'none';
      notify('Đã cập nhật mật khẩu mới thành công! Bạn có thể bắt đầu học.');
    } catch (err) {
      errEl.textContent = err.message;
      errEl.style.display = 'block';
    }
  });

  // Form đổi mật khẩu tự nguyện của người dùng
  $('changePwdForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const current = $('currentPassword').value;
    const p1 = $('changeNewPassword').value;
    const errEl = $('changePwdError');
    if (p1.length < 4) { errEl.textContent = 'Mật khẩu mới tối thiểu 4 ký tự.'; errEl.style.display = 'block'; return; }

    try {
      await cloudChangePassword(p1, current);
      $('changePwdOverlay').style.display = 'none';
      notify('Đã đổi mật khẩu cá nhân thành công!');
    } catch (err) {
      errEl.textContent = err.message;
      errEl.style.display = 'block';
    }
  });

  // Listener input cho Modal xác nhận xóa của Admin
  $('deleteConfirmOverlay').addEventListener('input', (e) => {
    if (e.target.id === 'deleteConfirmInput') {
      const val = e.target.value.trim();
      const targetId = state.deleteModal.lessonId;
      const targetTitle = state.deleteModal.lessonTitle;
      const btn = $('btnFinalDelete');
      if (btn) {
        btn.disabled = !(val === targetId || val === targetTitle);
      }
    }
  });

  // Listener cập nhật trường dữ liệu trong Modal chỉnh sửa bài học
  $('editorModalBody').addEventListener('input', (e) => {
    const row = e.target.closest('.editor-item-row');
    if (!row) return;
    const idx = Number(row.dataset.index);
    const prop = e.target.dataset.prop;
    const tab = state.editor.activeTab;
    const l = state.editor.lesson;
    if (!l || !prop) return;
    if (tab === 'vocab' && l.vocabulary?.[idx]) l.vocabulary[idx][prop] = e.target.value;
    else if (tab === 'grammar' && l.grammar?.[idx]) l.grammar[idx][prop] = e.target.value;
    else if (tab === 'kanji' && l.kanji?.[idx]) l.kanji[idx][prop] = e.target.value;
    else if (tab === 'reading' && l.readings?.[idx]) l.readings[idx][prop] = e.target.value;
  });

  // Dropdown lọc bài học theo người tải
  $('view').addEventListener('change', (e) => {
    if (e.target.id === 'lessonOwnerFilterSelect') {
      state.lessonOwnerFilter = e.target.value;
      renderView();
    }
  });


  $('view').addEventListener('dragover', event => {
    const zone = event.target.closest('#uploadZone');
    if (!zone) return;
    event.preventDefault();
    zone.classList.add('dragging');
  });

  $('view').addEventListener('dragleave', event => {
    const zone = event.target.closest('#uploadZone');
    if (zone) zone.classList.remove('dragging');
  });

  $('view').addEventListener('drop', event => {
    const zone = event.target.closest('#uploadZone');
    if (!zone) return;
    event.preventDefault();
    zone.classList.remove('dragging');
    importFiles(event.dataTransfer.files).catch(e => notify(e.message));
  });

  $('view').addEventListener('touchstart', event => {
    if (!event.target.closest('.flashcard')) return;
    touchX = event.changedTouches[0].clientX;
    touchY = event.changedTouches[0].clientY;
  }, { passive: true });

  $('view').addEventListener('touchend', event => {
    if (touchX === null || !event.target.closest('.flashcard')) return;
    const dx = event.changedTouches[0].clientX - touchX;
    const dy = event.changedTouches[0].clientY - touchY;
    touchX = null; touchY = null;
    if (Math.abs(dx) > 65 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      ignoreClickUntil = Date.now() + 400;
      nextCard(dx < 0 ? 1 : -1);
    }
  }, { passive: true });

  document.addEventListener('keydown', event => {
    if (!state.currentUser) return;
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
    if (event.key === '/' && !typing && !['imports', 'users'].includes(state.tab)) {
      event.preventDefault();
      $('searchInput').focus();
    }
    if (state.tab === 'practice' && !typing) {
      if (event.key === 'ArrowRight') { event.preventDefault(); nextCard(1); }
      if (event.key === 'ArrowLeft') { event.preventDefault(); nextCard(-1); }
      if (event.code === 'Space' && !['BUTTON', 'A'].includes(document.activeElement?.tagName)) {
        event.preventDefault();
        state.flash.flipped = !state.flash.flipped;
        renderView();
      }
    }
  });

  if ('speechSynthesis' in window) {
    speechSynthesis.onvoiceschanged = () => {
      speechSynthesis.getVoices();
    };
  }
}

async function loadStaticLessonsFallback() {
  try {
    const response = await fetch('./data/manifest.json', { cache: 'no-store' });
    if (!response.ok) return [];
    const manifest = await response.json();
    const files = Array.isArray(manifest) ? manifest : manifest.files;
    if (!Array.isArray(files)) return [];

    const lessons = [];
    for (const path of files) {
      try {
        const r = await fetch(path, { cache: 'no-store' });
        if (r.ok) {
          const parsed = parseLessons(await r.json());
          lessons.push(...parsed);
        }
      } catch (e) {}
    }
    return lessons;
  } catch (e) {
    return [];
  }
}

async function start() {
  setupListeners();
  $('view').innerHTML = '<div class="loading">Đang kết nối hệ thống...</div>';

  // 1. Kiểm tra kết nối MongoDB qua API
  const health = await checkCloudHealth();
  const statusPill = $('storageStatus');
  if (isCloudActive) {
    statusPill.innerHTML = '<span class="online-dot" style="background:#10b981"></span> MongoDB Cloud';
    statusPill.title = 'Đang kết nối trực tiếp với MongoDB Atlas (Dữ liệu dùng chung 10 máy)';
  } else {
    statusPill.innerHTML = '<span class="online-dot" style="background:#f59e0b"></span> Không kết nối DB';
    statusPill.title = 'Không kết nối được cơ sở dữ liệu';
  }

  // 2. Nạp dữ liệu bài học
  if (!isCloudActive) $('loginError').textContent = 'Không kết nối được cơ sở dữ liệu. Vui lòng liên hệ quản trị viên.';
  if (!isCloudActive) $('loginError').style.display = 'block';

  // 3. Khôi phục phiên đăng nhập nếu có
  const savedSession = localStorage.getItem('nihongo_session');
  if (savedSession) {
    try {
      const parsed = isCloudActive ? await restoreCloudSession() : null;
      if (!parsed) throw new Error('Phiên đã hết hạn');
      state.currentUser = parsed;
      if (parsed.mustChangePassword) {
        $('forcePwdError').style.display = 'none';
        $('forceNewPassword').value = '';
        $('forceConfirmPassword').value = '';
        $('forceChangePwdOverlay').style.display = 'flex';
      }
      if (isCloudActive) await reloadLessons();
      await reloadUserProgress();
      if (parsed.role === 'admin') await loadUsersList();
    } catch (e) {
      localStorage.removeItem('nihongo_session');
    }
  }

  updateUserUI();

  const hash = window.location.hash.substring(1);
  if (PAGE[hash] && (hash !== 'users' || state.currentUser?.role === 'admin')) {
    state.tab = hash;
  }
  render();

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

if (typeof document !== 'undefined') start();
