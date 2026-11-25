/**
 * js/conflict.js — Line-Level Diff Renderer & 3-Way Merge Engine
 * Powers the Interactive 3-Way Conflict Resolver when two devices edit
 * the same calendar entry concurrently. Zero external dependencies.
 */

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function splitLines(text) {
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n');
  if (!normalized) return [];
  return normalized.split('\n');
}

/**
 * Computes a Longest Common Subsequence (LCS) line diff between `oldText` and `newText`.
 * Falls back to a fast prefix/suffix diff for very large texts (> 900 lines) to stay instant.
 * @param {string} oldText
 * @param {string} newText
 * @returns {Array<{ type: 'eq' | 'add' | 'del', text: string }>}
 */
export function computeLineDiff(oldText, newText) {
  const a = splitLines(oldText);
  const b = splitLines(newText);

  if (a.length === 0 && b.length === 0) return [];
  if (a.length === 0) return b.map((text) => ({ type: 'add', text }));
  if (b.length === 0) return a.map((text) => ({ type: 'del', text }));

  // Trim identical leading and trailing lines first for speed
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start += 1;
  }

  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA -= 1;
    endB -= 1;
  }

  const prefix = a.slice(0, start).map((text) => ({ type: 'eq', text }));
  const suffix = a.slice(endA + 1).map((text) => ({ type: 'eq', text }));

  const midA = a.slice(start, endA + 1);
  const midB = b.slice(start, endB + 1);

  if (midA.length === 0 && midB.length === 0) {
    return [...prefix, ...suffix];
  }

  // Guard against O(N*M) memory spikes on huge entries
  if (midA.length * midB.length > 250000) {
    return [
      ...prefix,
      ...midA.map((text) => ({ type: 'del', text })),
      ...midB.map((text) => ({ type: 'add', text })),
      ...suffix,
    ];
  }

  const m = midA.length;
  const n = midB.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));

  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      if (midA[i] === midB[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = dp[i + 1][j] >= dp[i][j + 1] ? dp[i + 1][j] : dp[i][j + 1];
      }
    }
  }

  const middle = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (midA[i] === midB[j]) {
      middle.push({ type: 'eq', text: midA[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      middle.push({ type: 'del', text: midA[i] });
      i += 1;
    } else {
      middle.push({ type: 'add', text: midB[j] });
      j += 1;
    }
  }

  while (i < m) {
    middle.push({ type: 'del', text: midA[i] });
    i += 1;
  }
  while (j < n) {
    middle.push({ type: 'add', text: midB[j] });
    j += 1;
  }

  return [...prefix, ...middle, ...suffix];
}

/**
 * Renders color-coded diff rows comparing `referenceText` -> `targetText`.
 * Matches `.diff-line`, `.diff-add`, `.diff-del`, `.diff-eq`, `.diff-sign` in css/styles.css.
 * @param {string} referenceText
 * @param {string} targetText
 * @returns {string}
 */
export function renderDiffHtml(referenceText, targetText) {
  const ops = computeLineDiff(referenceText, targetText);
  if (ops.length === 0) {
    return '<div class="diff-line diff-eq"><span class="diff-sign"> </span><span>(empty)</span></div>';
  }

  return ops
    .map((op) => {
      const cls = op.type === 'add' ? 'diff-add' : op.type === 'del' ? 'diff-del' : 'diff-eq';
      const sign = op.type === 'add' ? '+' : op.type === 'del' ? '−' : ' ';
      const safeLine = op.text === '' ? '&nbsp;' : escapeHtml(op.text);
      return `<div class="diff-line ${cls}"><span class="diff-sign">${sign}</span><span>${safeLine}</span></div>`;
    })
    .join('');
}

/**
 * Splits prose into paragraph blocks (preserving Markdown double-newline boundaries)
 * so 3-way merges align cleanly on human paragraphs rather than individual words.
 * @param {string} text
 * @returns {string[]}
 */
function splitParagraphs(text) {
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];
  return normalized.split(/\n{2,}/);
}

/**
 * Performs a clean paragraph-level 3-way merge across:
 *   - baseText   (the entry version when the composer opened)
 *   - localText  (your unsaved edit)
 *   - remoteText (the latest version committed on GitHub by another device)
 *
 * Non-overlapping edits merge automatically without markers.
 * Overlapping edits to the same paragraph emit standard git-style conflict blocks.
 * @param {string} baseText
 * @param {string} localText
 * @param {string} remoteText
 * @returns {{ mergedText: string, hasConflicts: boolean, conflictCount: number }}
 */
export function buildThreeWayMerge(baseText, localText, remoteText) {
  const baseStr = String(baseText ?? '').replace(/\r\n?/g, '\n').trim();
  const localStr = String(localText ?? '').replace(/\r\n?/g, '\n').trim();
  const remoteStr = String(remoteText ?? '').replace(/\r\n?/g, '\n').trim();

  if (localStr === remoteStr) {
    return { mergedText: localStr, hasConflicts: false, conflictCount: 0 };
  }
  if (localStr === baseStr) {
    return { mergedText: remoteStr, hasConflicts: false, conflictCount: 0 };
  }
  if (remoteStr === baseStr) {
    return { mergedText: localStr, hasConflicts: false, conflictCount: 0 };
  }

  // If no common base exists (e.g. concurrent new entry creation on two devices)
  if (!baseStr) {
    const mergedText = [
      '<<<<<<< YOUR UNSAVED EDIT',
      localStr,
      '=======',
      remoteStr,
      '>>>>>>> LATEST GITHUB VERSION',
    ].join('\n');
    return { mergedText, hasConflicts: true, conflictCount: 1 };
  }

  const baseParas = splitParagraphs(baseStr);
  const localParas = splitParagraphs(localStr);
  const remoteParas = splitParagraphs(remoteStr);
  const maxLen = Math.max(baseParas.length, localParas.length, remoteParas.length);

  const outParas = [];
  let conflictCount = 0;

  for (let i = 0; i < maxLen; i += 1) {
    const b = i < baseParas.length ? baseParas[i] : null;
    const l = i < localParas.length ? localParas[i] : null;
    const r = i < remoteParas.length ? remoteParas[i] : null;

    if (l === r) {
      if (l !== null) outParas.push(l);
      continue;
    }

    if (l === b) {
      // Only remote changed (or deleted) this paragraph
      if (r !== null) outParas.push(r);
      continue;
    }

    if (r === b) {
      // Only local changed (or deleted) this paragraph
      if (l !== null) outParas.push(l);
      continue;
    }

    // Both sides modified or appended differently at position i
    conflictCount += 1;
    outParas.push(
      [
        '<<<<<<< YOUR UNSAVED EDIT',
        l !== null ? l : '(removed locally)',
        '=======',
        r !== null ? r : '(removed remotely)',
        '>>>>>>> LATEST GITHUB VERSION',
      ].join('\n')
    );
  }

  return {
    mergedText: outParas.join('\n\n'),
    hasConflicts: conflictCount > 0,
    conflictCount,
  };
}

/**
 * Merges two tag arrays cleanly (case-insensitive deduplication, preserving order).
 * @param {string[]} localTags
 * @param {string[]} remoteTags
 * @returns {string[]}
 */
export function mergeTags(localTags = [], remoteTags = []) {
  const seen = new Set();
  const out = [];
  for (const list of [localTags, remoteTags]) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const cleaned = String(raw || '').trim();
      if (!cleaned) continue;
      const key = cleaned.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(cleaned);
      }
    }
  }
  return out;
}
