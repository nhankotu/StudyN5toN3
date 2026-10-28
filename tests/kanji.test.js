import test from 'node:test';
import assert from 'node:assert/strict';
import { resampleStroke, strokeAngle, angleDiff, evaluateKanjiDrawing, KANJIVG_LICENSE } from '../kanji-evaluator.js';
import { getKanjiStrokes, PREPACKAGED_KANJI, kanjiToHex } from '../kanji-strokes.js';

test('KanjiVG attribution and license info is present', () => {
  assert.equal(KANJIVG_LICENSE.name, 'KanjiVG');
  assert.equal(KANJIVG_LICENSE.author, 'Ulrich Apel');
  assert.match(KANJIVG_LICENSE.license, /CC BY-SA 3.0/);
});

test('kanjiToHex converts characters correctly', () => {
  assert.equal(kanjiToHex('人'), '04eba');
  assert.equal(kanjiToHex('日'), '065e5');
  assert.equal(kanjiToHex('一'), '04e00');
});

test('resampleStroke creates uniform point arrays', () => {
  const points = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  const resampled = resampleStroke(points, 5);
  assert.equal(resampled.length, 5);
  assert.equal(resampled[0].x, 0);
  assert.equal(resampled[4].x, 100);
  assert.equal(resampled[2].x, 50);
});

test('stroke angles and difference calculations', () => {
  assert.equal(strokeAngle({ x: 0, y: 0 }, { x: 10, y: 0 }), 0); // East
  assert.equal(strokeAngle({ x: 0, y: 0 }, { x: 0, y: 10 }), 90); // South
  assert.equal(angleDiff(10, 350), 20);
  assert.equal(angleDiff(0, 180), 180);
});

test('Prepackaged kanji strokes are available offline', async () => {
  const jin = await getKanjiStrokes('人');
  assert.ok(jin);
  assert.equal(jin.length, 2);

  const nichi = await getKanjiStrokes('日');
  assert.ok(nichi);
  assert.equal(nichi.length, 4);

  const san = await getKanjiStrokes('三');
  assert.ok(san);
  assert.equal(san.length, 3);
});

test('evaluateKanjiDrawing with matching strokes', async () => {
  const jinStrokes = await getKanjiStrokes('人');
  // Scale reference to 300x300 canvas size to simulate user drawing accurately
  const canvasSize = 300;
  const scale = canvasSize / 100;
  const userStrokes = jinStrokes.map(stroke =>
    stroke.map(p => ({ x: p.x * scale, y: p.y * scale }))
  );

  const resultShape = evaluateKanjiDrawing(userStrokes, jinStrokes, canvasSize, 'shape');
  assert.ok(resultShape.score >= 80, `Expected score >= 80, got ${resultShape.score}`);
  assert.equal(resultShape.passed, true);
  assert.equal(resultShape.strokeCountMatch, true);

  const resultStrict = evaluateKanjiDrawing(userStrokes, jinStrokes, canvasSize, 'strict');
  assert.ok(resultStrict.score >= 80, `Expected score >= 80, got ${resultStrict.score}`);
  assert.equal(resultStrict.passed, true);
});

test('evaluateKanjiDrawing penalizes wrong stroke count or backward stroke in strict mode', async () => {
  const jinStrokes = await getKanjiStrokes('人');
  const canvasSize = 300;
  const scale = canvasSize / 100;

  // Only 1 stroke instead of 2
  const oneStroke = [jinStrokes[0].map(p => ({ x: p.x * scale, y: p.y * scale }))];
  const countPenaltyResult = evaluateKanjiDrawing(oneStroke, jinStrokes, canvasSize, 'strict');
  assert.equal(countPenaltyResult.passed, false);
  assert.equal(countPenaltyResult.strokeCountMatch, false);

  // Backward stroke: reverse points of stroke 1
  const backwardStrokes = [
    [...jinStrokes[0]].reverse().map(p => ({ x: p.x * scale, y: p.y * scale })),
    jinStrokes[1].map(p => ({ x: p.x * scale, y: p.y * scale }))
  ];
  const strictResult = evaluateKanjiDrawing(backwardStrokes, jinStrokes, canvasSize, 'strict');
  assert.ok(strictResult.score < 80);
});

test('evaluateKanjiDrawing handles empty canvas and missing reference gracefully', () => {
  const emptyRes = evaluateKanjiDrawing([], [{ x: 0, y: 0 }], 300);
  assert.equal(emptyRes.score, 0);
  assert.equal(emptyRes.passed, false);

  const noRefRes = evaluateKanjiDrawing([[{ x: 0, y: 0 }, { x: 10, y: 10 }]], null, 300);
  assert.equal(noRefRes.score, null);
  assert.equal(noRefRes.passed, null);
});
