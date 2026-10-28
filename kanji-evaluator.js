/**
 * Kanji Stroke Order and Evaluation Engine
 * Uses KanjiVG stroke specifications (CC BY-SA 3.0 Ulrich Apel).
 * Non-AI deterministic geometric stroke scoring algorithm.
 */

// Attribution & License notice
export const KANJIVG_LICENSE = {
  name: 'KanjiVG',
  author: 'Ulrich Apel',
  url: 'https://kanjivg.tagaini.net/',
  license: 'Creative Commons Attribution-Share Alike 3.0 (CC BY-SA 3.0)',
  licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0/'
};

/**
 * Resamples a sequence of 2D points to N equidistant points.
 */
export function resampleStroke(points, targetCount = 20) {
  if (!points || points.length === 0) return [];
  if (points.length === 1) return Array(targetCount).fill({ x: points[0].x, y: points[0].y });

  // Calculate total path length
  let totalLength = 0;
  const dists = [0];
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    totalLength += Math.hypot(dx, dy);
    dists.push(totalLength);
  }

  if (totalLength === 0) return Array(targetCount).fill({ x: points[0].x, y: points[0].y });

  const resampled = [{ x: points[0].x, y: points[0].y }];
  const step = totalLength / (targetCount - 1);

  let currentDist = step;
  let segIndex = 0;

  for (let i = 1; i < targetCount - 1; i++) {
    while (segIndex < dists.length - 1 && dists[segIndex + 1] < currentDist) {
      segIndex++;
    }
    const p1 = points[segIndex];
    const p2 = points[segIndex + 1] || p1;
    const segLen = dists[segIndex + 1] - dists[segIndex];
    const t = segLen === 0 ? 0 : (currentDist - dists[segIndex]) / segLen;
    resampled.push({
      x: p1.x + t * (p2.x - p1.x),
      y: p1.y + t * (p2.y - p1.y)
    });
    currentDist += step;
  }
  resampled.push({ x: points[points.length - 1].x, y: points[points.length - 1].y });
  return resampled;
}

/**
 * Calculates directional angle of a stroke in degrees [0, 360).
 */
export function strokeAngle(p1, p2) {
  const rad = Math.atan2(p2.y - p1.y, p2.x - p1.x);
  const deg = (rad * 180) / Math.PI;
  return (deg + 360) % 360;
}

/**
 * Angular difference between two angles in degrees [0, 180].
 */
export function angleDiff(a1, a2) {
  const diff = Math.abs(a1 - a2) % 360;
  return diff > 180 ? 360 - diff : diff;
}

/**
 * Mean Euclidean distance between two resampled stroke point arrays.
 */
export function strokeDistance(s1, s2) {
  if (s1.length !== s2.length) throw new Error('Strokes must have same resampled point count');
  let sum = 0;
  for (let i = 0; i < s1.length; i++) {
    sum += Math.hypot(s1[i].x - s2[i].x, s1[i].y - s2[i].y);
  }
  return sum / s1.length;
}

/**
 * Evaluates user drawn strokes against reference strokes.
 * @param {Array<Array<{x:number, y:number}>>} userStrokes Drawn strokes on canvas
 * @param {Array<Array<{x:number, y:number}>>} refStrokes Reference strokes (scaled to 100x100)
 * @param {number} canvasSize Size of the square canvas (e.g. 300)
 * @param {'shape'|'strict'} mode Evaluation mode
 * @returns {{ score: number, passed: boolean, strokeCountMatch: boolean, details: object }}
 */
export function evaluateKanjiDrawing(userStrokes, refStrokes, canvasSize = 300, mode = 'shape') {
  if (!userStrokes || userStrokes.length === 0) {
    return {
      score: 0,
      passed: false,
      strokeCountMatch: false,
      message: 'Chưa có nét vẽ nào trên khung.',
      details: { strokeCount: 0, refCount: refStrokes?.length || 0 }
    };
  }

  if (!refStrokes || refStrokes.length === 0) {
    // Không có mẫu tham khảo -> không tự chấm
    return {
      score: null,
      passed: null,
      strokeCountMatch: null,
      message: 'Chưa có dữ liệu nét chuẩn KanjiVG cho chữ này. Vui lòng tự đối chiếu.',
      details: {}
    };
  }

  // 1. Normalize user strokes to 100x100 coordinate space
  const scale = 100 / (canvasSize || 300);
  const normalizedUser = userStrokes
    .filter(s => s && s.length >= 2)
    .map(stroke => stroke.map(p => ({ x: p.x * scale, y: p.y * scale })))
    .map(stroke => resampleStroke(stroke, 20));

  const normalizedRef = refStrokes.map(stroke => resampleStroke(stroke, 20));

  const userCount = normalizedUser.length;
  const refCount = normalizedRef.length;
  const countDiff = Math.abs(userCount - refCount);

  // Stroke count penalty: -15 pts per missing/extra stroke
  const countPenalty = countDiff * 15;

  let strokeScores = [];

  if (mode === 'strict') {
    // Chế độ nghiêm ngặt: Kiểm tra đúng thứ tự và hướng nét vẽ
    const compareCount = Math.min(userCount, refCount);
    for (let i = 0; i < compareCount; i++) {
      const u = normalizedUser[i];
      const r = normalizedRef[i];

      const uDir = strokeAngle(u[0], u[u.length - 1]);
      const rDir = strokeAngle(r[0], r[r.length - 1]);
      const aDiff = angleDiff(uDir, rDir);

      // Distance between normalized points (range ~0 to 141)
      const dist = strokeDistance(u, r);
      let matchScore = Math.max(0, 100 - dist * 1.8);

      // Direction penalty if stroke drawn backwards (>70 deg difference)
      if (aDiff > 70) {
        matchScore = Math.max(0, matchScore - (aDiff / 180) * 45);
      }
      strokeScores.push(matchScore);
    }
  } else {
    // Chế độ hình dạng (dễ hơn): Tìm nét mẫu tương ứng tốt nhất
    const usedRefIndices = new Set();
    for (const u of normalizedUser) {
      let bestScore = 0;
      let bestRefIdx = -1;

      for (let j = 0; j < normalizedRef.length; j++) {
        if (usedRefIndices.has(j)) continue;
        const r = normalizedRef[j];
        const dist = strokeDistance(u, r);
        let sScore = Math.max(0, 100 - dist * 1.8);
        if (sScore > bestScore) {
          bestScore = sScore;
          bestRefIdx = j;
        }
      }
      if (bestRefIdx >= 0) usedRefIndices.add(bestRefIdx);
      strokeScores.push(bestScore);
    }
  }

  // Average stroke similarity
  const avgStrokeScore = strokeScores.length > 0
    ? strokeScores.reduce((a, b) => a + b, 0) / Math.max(refCount, userCount)
    : 0;

  // Final score deduction for stroke count mismatch
  let finalScore = Math.round(Math.max(0, Math.min(100, avgStrokeScore - countPenalty * 0.4)));

  return {
    score: finalScore,
    passed: finalScore >= 80,
    strokeCountMatch: userCount === refCount,
    userStrokeCount: userCount,
    refStrokeCount: refCount,
    mode,
    threshold: 80,
    details: {
      avgStrokeScore: Math.round(avgStrokeScore),
      countPenalty,
      strokeScores: strokeScores.map(s => Math.round(s))
    }
  };
}
