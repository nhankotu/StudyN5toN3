const str = (v, fallback='') => typeof v === 'string' || typeof v === 'number' ? String(v).trim() : fallback;
const list = v => Array.isArray(v) ? v : [];

export function stripFurigana(text) {
  if (!text) return '';
  return String(text)
    .replace(/\[([^\]]+)\](?:\[|\{)[^\]\}]+(?:\]|\})/g, '$1')
    .replace(/([\u4e00-\u9faf\u3400-\u4dbf々ヶA-Za-z0-9]+)\[[^\]]+\]/g, '$1')
    .replace(/\[([^\]]+)\]/g, '$1');
}

export function normalizeLesson(raw, fallbackId='') {
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

  const readings = list(raw.readings).map((v, i) => ({
    id: str(v?.id, `r${i + 1}`), title: str(v?.title, title),
    japanese: str(v?.japanese), translation: str(v?.translation)
  })).filter(v => v.japanese);
  if (!vocabulary.length && !grammar.length && !kanji.length && !readings.length) throw new Error(`Bài "${title}" không có nội dung học hợp lệ.`);
  for (const group of [vocabulary, grammar, kanji, readings]) {
    if (new Set(group.map(item => item.id)).size !== group.length) throw new Error(`Bài "${title}" có mã nội dung bị trùng.`);
  }
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
    kanji,
    readings
  };
}

