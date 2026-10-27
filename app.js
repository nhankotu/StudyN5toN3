import {
  checkCloudHealth, isCloudActive, restoreCloudSession, logoutCloud,
  cloudLogin, cloudGetUsers, cloudCreateUser, cloudResetPassword, cloudDeleteUser,
  cloudGetLessons, cloudSaveLessons, cloudDeleteLesson,
  cloudGetProgress, cloudSaveProgress,
  initLocalAuth, getImportedLessons, getProgress
} from './db.js';

const PAGE = {
  vocabulary: ['Từ vựng', 'VOCABULARY COLLECTION', 'Kho từ vựng', 'Khám phá các từ tiếng Nhật theo từng bài học.'],
  practice: ['Luyện tập', 'FLASHCARD PRACTICE', 'Luyện tập flashcards', 'Lật thẻ, tự kiểm tra và ghi nhớ từ theo nhịp độ của bạn.'],
  grammar: ['Mẫu câu', 'GRAMMAR & PATTERNS', 'Ngữ pháp và mẫu câu', 'Công thức, giải thích và ví dụ đơn giản, dễ nhớ.'],
  kanji: ['Chữ Hán', 'KANJI COLLECTION', 'Thư viện chữ Hán', 'Học ý nghĩa, âm đọc và các từ ghép Kanji.'],
  imports: ['Kho bài học', 'LESSON LIBRARY & IMPORT', 'Kho bài học & Thêm bài mới', 'Tìm kiếm bài cũ để học lại hoặc nạp bài mới từ file JSON / AI.'],
  users: ['Quản lý tài khoản', 'INTERNAL USERS', 'Quản lý người dùng nội bộ', 'Chỉ Quản trị viên mới có quyền tạo thêm và quản lý người dùng.']
};

const state = {
  tab: 'vocabulary', lessonId: 'all', query: '',
  staticLessons: [], imported: [], lessons: [], progress: new Map(),
  lessonSearch: '',
  lessonFilter: 'all', // 'all' (Tất cả bài học) | 'my' (Bài học của tôi)
  flash: {
    type: 'vocabulary',
    mode: 'all',
    direction: 'forward', // 'forward' (Nhật -> Việt) | 'reverse' (Việt -> Nhật)
    index: 0,
    flipped: false,
    shuffledKeys: null
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

export function stripFurigana(text) {
  if (!text) return '';
  return String(text)
    .replace(/\[([^\]]+)\](?:\[|\{)[^\]\}]+(?:\]|\})/g, '$1')
    .replace(/([\u4e00-\u9faf\u3400-\u4dbf々ヶA-Za-z0-9]+)\[[^\]]+\]/g, '$1')
    .replace(/\[([^\]]+)\]/g, '$1');
}

export function renderFurigana(text) {
  if (!text) return '';
  const escaped = h(text);
  return escaped
    .replace(/\[([^\]]+)\](?:\[|\{)([^\]\}]+)(?:\]|\})/g, '<ruby>$1<rt>$2</rt></ruby>')
    .replace(/([\u4e00-\u9faf\u3400-\u4dbf々ヶA-Za-z0-9]+)\[([^\]]+)\]/g, '<ruby>$1<rt>$2</rt></ruby>');
}

function normalizeLesson(raw, fallbackId='') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Mỗi bài học phải là một object JSON.');
  const id = str(raw.id || fallbackId);
  const title = str(raw.title);
  if (!id || !title) throw new Error('Bài học cần có "id" và "title".');
  if (id.length > 160) throw new Error('ID bài học quá dài.');

  const vocabulary = list(raw.vocabulary).map((v, i) => {
    const rawJp = str(v?.japanese || v?.ruby);
    const ruby = str(v?.ruby || (rawJp.includes('[') ? rawJp : ''));
    const japanese = str(v?.japanese, stripFurigana(ruby));
    return {
      id: str(v?.id, `v${i+1}`),
      japanese,
      ruby,
      reading: str(v?.reading),
      meaning: str(v?.meaning),
      example: str(v?.example),
      exampleMeaning: str(v?.exampleMeaning)
    };
  }).filter(v => (v.japanese || v.ruby) && v.meaning);

  const grammar = list(raw.grammar).map((v, i) => ({
    id: str(v?.id, `g${i+1}`), title: str(v?.title), pattern: str(v?.pattern), meaning: str(v?.meaning),
    explanation: str(v?.explanation), examples: list(v?.examples).map(e => ({ japanese: str(e?.japanese), meaning: str(e?.meaning) })).filter(e => e.japanese)
  })).filter(v => v.title || v.pattern);

  const kanji = list(raw.kanji).map((v, i) => ({
    id: str(v?.id, `k${i+1}`), character: str(v?.character), meaning: str(v?.meaning),
    onyomi: str(v?.onyomi), kunyomi: str(v?.kunyomi),
    examples: list(v?.examples).map(e => ({ word: str(e?.word), reading: str(e?.reading), meaning: str(e?.meaning) })).filter(e => e.word)
  })).filter(v => v.character && v.meaning);

  if (!vocabulary.length && !grammar.length && !kanji.length) throw new Error(`Bài "${title}" không có mục từ vựng, mẫu câu hoặc Kanji hợp lệ.`);
  const order = Number(raw.order);
  return { 
    id, 
    title, 
    level: str(raw.level, 'N5'), 
    book: str(raw.book), 
    order: Number.isFinite(order) ? order : 9999,
    createdBy: raw.createdBy || null,
    createdAt: raw.createdAt || null,
    updatedAt: raw.updatedAt || null,
    vocabulary, 
    grammar, 
    kanji 
  };
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
  state.tab = tab;
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
  $('searchWrap').style.display = ['practice', 'imports', 'users'].includes(tab) ? 'none' : 'flex';
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

function renderKanji() {
  const items = allCards('kanji').filter(v => matchesQuery(v.character, v.meaning, v.onyomi, v.kunyomi, ...(v.examples || []).flatMap(e => [e.word, e.reading, e.meaning])));
  $('sectionCount').textContent = `${items.length} chữ`;
  if (!items.length) return empty('Chưa có chữ Hán', 'Hãy đổi bộ lọc hoặc thêm bài học có danh sách kanji.', state.lessons.length === 0);
  return `<div class="kanji-grid">${items.map(v => `<article class="kanji-card"><span class="kanji-character" lang="ja">${h(v.character)}</span><div class="kanji-meaning">${h(v.meaning)}</div><div class="kanji-readings">On: ${h(v.onyomi || '—')}<br>Kun: ${h(v.kunyomi || '—')}</div><button style="margin-top:9px" class="audio-btn" data-action="speak" data-text="${h(stripFurigana(v.examples?.[0]?.word || v.character))}" title="Phát âm" aria-label="Phát âm chữ Hán">♫</button>${(v.examples || []).length ? `<div class="kanji-words">${v.examples.map(e => `<div><strong lang="ja">${renderFurigana(e.word)}</strong> (${h(e.reading)}) — ${h(e.meaning)}</div>`).join('')}</div>` : ''}<div>${itemTitle(v)}</div></article>`).join('')}</div>`;
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
  
  let displayedLessons = state.lessonFilter === 'my' ? myLessons : state.lessons;
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

        <!-- BỘ LỌC BÀI HỌC -->
        <div class="lesson-filter-tabs">
          <button class="lesson-filter-btn ${state.lessonFilter==='all'?'active':''}" data-action="filter-lessons" data-filter="all">Tất cả bài học (${state.lessons.length})</button>
          <button class="lesson-filter-btn ${state.lessonFilter==='my'?'active':''}" data-action="filter-lessons" data-filter="my">Bài học của tôi (${myLessons.length})</button>
        </div>

        <!-- DANH SÁCH BÀI HỌC -->
        ${displayedLessons.length ? `
          <div class="lesson-card-list">
            ${displayedLessons.map(l => {
              const isMine = l.createdBy === currentUsername;
              const canDelete = isMine || isAdmin;
              const vocabCount = (l.vocabulary || []).length;
              const grammarCount = (l.grammar || []).length;
              const kanjiCount = (l.kanji || []).length;

              return `
                <div class="lesson-card-item">
                  <div class="lesson-card-header">
                    <div class="lesson-card-title-group">
                      <span class="lesson-badge-level">${h(l.level || 'N5')}</span>
                      <strong>${h(l.title)}</strong>
                      ${isMine ? `<span class="lesson-badge-mine">Của bạn</span>` : ''}
                    </div>
                    <div class="lesson-card-meta">
                      <span>単 ${vocabCount} từ</span>
                      <span>文 ${grammarCount} mẫu</span>
                      <span>漢 ${kanjiCount} Kanji</span>
                      <span>👤 @${h(l.createdBy || 'system')}</span>
                    </div>
                  </div>
                  <div class="lesson-card-actions">
                    <button class="button-primary btn-sm" data-action="learn-lesson" data-id="${h(l.id)}" title="Học từ vựng bài này ngay">▶ Học từ vựng</button>
                    <button class="button-secondary btn-sm" data-action="practice-lesson" data-id="${h(l.id)}" title="Luyện flashcard bài này">▣ Flashcard</button>
                    <button class="button-subtle btn-sm" data-action="grammar-lesson" data-id="${h(l.id)}" title="Xem mẫu câu bài này">文 Mẫu câu</button>
                    <button class="button-subtle btn-sm" data-action="download-lesson" data-id="${h(l.id)}" title="Tải file JSON bài học này">↓ Tải JSON</button>
                    ${canDelete ? `<button class="button-danger btn-sm" data-action="remove" data-id="${h(l.id)}" title="Xóa bài học khỏi cơ sở dữ liệu">Xóa</button>` : ''}
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
  let result = '';
  switch (state.tab) {
    case 'vocabulary': result = renderVocabulary(); break;
    case 'practice': result = renderPractice(); break;
    case 'grammar': result = renderGrammar(); break;
    case 'kanji': result = renderKanji(); break;
    case 'imports': result = renderImports(); break;
    case 'users': result = renderUsers(); break;
    default: result = renderVocabulary();
  }
  $('view').innerHTML = result;
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
  }
  await cloudSaveLessons(incoming, currentUsername);
  await reloadLessons();
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
  if (action === 'speak') { speak(button.dataset.text); return; }
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
      progress: [...state.progress.values()]
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
    const newPwd = prompt(`Nhập mật khẩu mới cho tài khoản @${targetUsername}:`);
    if (!newPwd || newPwd.trim().length < 4) {
      if (newPwd !== null) notify('Mật khẩu cần có ít nhất 4 ký tự.');
      return;
    }
    try {
      await cloudResetPassword(targetUsername, newPwd.trim());
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

  try {
    const user = await cloudLogin(username, password);

    state.currentUser = user;
    localStorage.setItem('nihongo_session', JSON.stringify({
      username: user.username,
      name: user.name,
      role: user.role
    }));

    $('loginPassword').value = '';
    updateUserUI();
    await reloadLessons();
    await reloadUserProgress();
    await loadUsersList();
    render();
    notify(`Xin chào, ${user.name || user.username}!`);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  }
}

async function handleLogout() {
  if (!confirm('Bạn có muốn đăng xuất khỏi ứng dụng không?')) return;
  try { await logoutCloud(); } catch (error) { console.error('Không thu hồi được phiên:', error); }
  localStorage.removeItem('nihongo_session');
  state.currentUser = null;
  state.tab = 'vocabulary';
  updateUserUI();
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

start();
