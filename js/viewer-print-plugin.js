

/**
 * Perpetual Web Diary — Integrated Day View & Fixed Print Studio (js/viewer-print-plugin.js)
 *
 *   Fixes over previous version:
 *   - Eliminates entry overwriting: strict DOM-confirmed date matching (never assigns hash date
 *     to stale DOM), non-destructive fingerprint-based entry store, and print-safe CSS (removed
 *     break-inside: avoid-page on multi-paragraph entries & flex print headers that caused overlaps)
 *   - Detects all available entries: deep recursive localStorage/sessionStorage + read-only
 *     IndexedDB scanner + live Reader & Archive DOM harvester + 1-click "Collect from Archive"
 *     + optional window.__PD_BRIDGE__ hook
 *   - Keeps native Integrated Main-Page Day View (zero separate reader modal, zero missing entries)
 *
 * Self-contained ES module. Requires zero edits to app.js, github.js, features.js, or bipolar-index-plugin.js.
 */

const VP_BOOKMARKS_KEY = 'pd_simple_index_bookmarks_v1';
const VP_HIGHLIGHTS_KEY = 'pd_simple_index_highlights_v1';
const VP_ENTRY_META_KEY = 'pd_simple_index_entry_meta_v1';
const VP_PREFS_KEY = 'pd_viewer_print_prefs_v2';
const VP_SKIP_KEYS = new Set([
  'pd_bipolar_tracker_v1',
  VP_BOOKMARKS_KEY,
  VP_HIGHLIGHTS_KEY,
  VP_ENTRY_META_KEY,
  VP_PREFS_KEY,
]);

// Non-destructive store: isoDate -> Map(fingerprint -> entry)
const vpEntryStore = new Map();
let vpIdbEntriesCache = [];
let vpIdbScanned = false;
let vpScanCancelled = false;
let vpSyncingLayout = false;

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(VP_PREFS_KEY) || '{}');
    return p && typeof p === 'object' ? p : {};
  } catch {
    return {};
  }
}

function savePrefs(partial) {
  try {
    localStorage.setItem(VP_PREFS_KEY, JSON.stringify(Object.assign(loadPrefs(), partial)));
  } catch {
    // ignore storage quota errors
  }
}

const savedPrefs = loadPrefs();

const vpState = {
  // Integrated Main-Page Day View
  dayMode: Boolean(savedPrefs.dayMode),
  selectedYear: savedPrefs.selectedYear || String(new Date().getFullYear()),
  dayFont: savedPrefs.dayFont || 'serif', // 'serif' | 'sans' | 'mono'
  daySize: savedPrefs.daySize || 'md', // 'sm' | 'md' | 'lg'
  dayTheme: savedPrefs.dayTheme || 'auto', // 'auto' | 'sepia' | 'paper'
  cleanRead: Boolean(savedPrefs.cleanRead),
  aaOpen: false,
  pinOpen: false,

  // Print Studio
  printTab: 'range', // 'range' | 'indices'
  rangeDocTitle: '',
  rangeStart: shiftISO(todayISO(), -29),
  rangeEnd: todayISO(),
  rangeFilter: '',
  rangeFont: savedPrefs.rangeFont || 'serif',
  rangeOptTitles: true,
  rangeOptHighlights: true,
  rangeOptMeta: true,
  rangeOptPageBreak: false,
  rangeOptToc: true,
  rangeExcludedDates: new Set(),
  rangeScanning: false,
  rangeScanProgress: '',

  // Indices Print State
  idxDocTitle: 'Perpetual Diary — Master Index',
  idxLayout: 'section', // 'section' | 'year' | 'timeline'
  idxIncludePinned: true,
  idxIncludeHighlights: true,
  idxIncludeEntries: true,
  idxIncludeTags: true,
  idxIncludeExcerpts: true,
  idxStart: '',
  idxEnd: '',
  idxYear: 'all',
  idxQuery: '',
  idxSort: 'oldest', // 'oldest' | 'newest' | 'title'
  idxFont: savedPrefs.idxFont || 'serif',
};

/* ==========================================================================
   1. UTILITIES, FULL-CONTENT FINGERPRINTING & SAFE HTML
   ========================================================================== */

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function shiftISO(isoDate, deltaDays) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate || '')) isoDate = todayISO();
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(y, m - 1, d + deltaDays);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function formatLongDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return iso || '';
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function formatShortDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return iso || '';
  const [y, m, d] = iso.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[m - 1]} ${d}, ${y}`;
}

function countWords(text) {
  const clean = String(text || '').trim();
  return clean ? clean.split(/\s+/).length : 0;
}

// Full-content dual FNV-1a fingerprint so distinct entries with similar openings NEVER overwrite each other
function contentFingerprint(text) {
  const norm = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
  if (!norm) return '';
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < norm.length; i++) {
    const ch = norm.charCodeAt(i);
    h1 ^= ch;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= ch + (i & 255);
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  return `${norm.length}:${(h1 >>> 0).toString(36)}:${(h2 >>> 0).toString(36)}`;
}

function extractTags(text, existingTags = []) {
  const set = new Set();
  (Array.isArray(existingTags) ? existingTags : []).forEach((t) => {
    const clean = String(t || '').trim().replace(/^#/, '').toLowerCase();
    if (clean && !/^\d+$/.test(clean)) set.add(clean);
  });
  const matches = String(text || '').match(/(^|[\s(])#([a-zA-Z0-9:_-]{2,40})/g) || [];
  matches.forEach((m) => {
    const tag = m.replace(/^[\s(]*#/, '').toLowerCase();
    if (tag && !/^\d+$/.test(tag)) set.add(tag);
  });
  return Array.from(set);
}

function makeExcerpt(text, maxLen = 175) {
  const clean = String(text || '').replace(/[#*_>`~[\]()]/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.length <= maxLen ? clean : `${clean.slice(0, maxLen).trim()}…`;
}

function enumerateDatesBetween(startIso, endIso, maxDays = 370) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startIso) || !/^\d{4}-\d{2}-\d{2}$/.test(endIso)) return [];
  if (startIso > endIso) return [];
  const out = [];
  let cur = startIso;
  while (cur <= endIso && out.length < maxDays) {
    out.push(cur);
    cur = shiftISO(cur, 1);
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function showToast(msg) {
  let el = document.getElementById('plug-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'plug-toast';
    Object.assign(el.style, {
      position: 'fixed',
      left: '50%',
      bottom: '24px',
      transform: 'translateX(-50%)',
      zIndex: '10050',
      padding: '9px 16px',
      borderRadius: '999px',
      background: '#1e2433',
      color: '#eef2f7',
      border: '1px solid rgba(229,184,105,0.45)',
      fontSize: '0.84rem',
      fontWeight: '600',
      boxShadow: '0 10px 28px rgba(0,0,0,0.45)',
      transition: 'opacity 0.2s ease',
      pointerEvents: 'none',
    });
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(el._timer);
  el._timer = setTimeout(() => {
    el.style.opacity = '0';
  }, 2800);
}

/* ==========================================================================
   2. SHARED INDEX STORAGE (Synced with Entry & Highlight Index)
   ========================================================================== */

function loadPinnedDates() {
  try {
    const arr = JSON.parse(localStorage.getItem(VP_BOOKMARKS_KEY) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function savePinnedDates(list) {
  localStorage.setItem(VP_BOOKMARKS_KEY, JSON.stringify(list));
}

function loadHighlights() {
  try {
    const arr = JSON.parse(localStorage.getItem(VP_HIGHLIGHTS_KEY) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function loadEntryMetaMap() {
  try {
    const obj = JSON.parse(localStorage.getItem(VP_ENTRY_META_KEY) || '{}');
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

/* ==========================================================================
   3. NON-DESTRUCTIVE ENTRY STORE & MULTI-SOURCE HARVESTER
   ========================================================================== */

function upsertEntryIntoStore(entry) {
  if (!entry || !/^\d{4}-\d{2}-\d{2}$/.test(entry.isoDate || '')) return;
  const text = String(entry.text || '').trim();
  const title = String(entry.title || '').trim();
  if (!text && !title) return;

  const fp = contentFingerprint(text || title);
  if (!fp) return;

  if (!vpEntryStore.has(entry.isoDate)) {
    vpEntryStore.set(entry.isoDate, new Map());
  }
  const dayMap = vpEntryStore.get(entry.isoDate);

  // If a longer/full version already exists for this day whose prefix matches an excerpt, keep the full version
  if (entry.isExcerptOnly) {
    const needle = text.replace(/…$/, '').toLowerCase().replace(/\s+/g, ' ').trim();
    for (const existing of dayMap.values()) {
      if (
        !existing.isExcerptOnly &&
        needle.length >= 20 &&
        existing.text.toLowerCase().replace(/\s+/g, ' ').includes(needle.slice(0, 60))
      ) {
        return;
      }
    }
  } else {
    // Full text arrived: remove any shorter excerpt-only stub that matches its start
    const fullNorm = text.toLowerCase().replace(/\s+/g, ' ');
    for (const [k, existing] of dayMap.entries()) {
      if (existing.isExcerptOnly) {
        const stub = existing.text.replace(/…$/, '').toLowerCase().replace(/\s+/g, ' ').trim();
        if (stub.length >= 16 && fullNorm.includes(stub.slice(0, 60))) {
          dayMap.delete(k);
        }
      }
    }
  }

  const prev = dayMap.get(fp);
  if (prev && !prev.isExcerptOnly && entry.isExcerptOnly) return;

  dayMap.set(fp, {
    isoDate: entry.isoDate,
    year: entry.isoDate.slice(0, 4),
    mmdd: entry.isoDate.slice(5),
    orderHint: typeof entry.orderHint === 'number' ? entry.orderHint : prev?.orderHint ?? dayMap.size,
    title: title || prev?.title || '',
    text: text.length >= (prev?.text?.length || 0) ? text : prev.text,
    words: countWords(text.length >= (prev?.text?.length || 0) ? text : prev.text),
    tags: Array.from(new Set([...(prev?.tags || []), ...(entry.tags || [])])),
    pills: Array.from(new Set([...(prev?.pills || []), ...(entry.pills || [])])),
    timeStamp: entry.timeStamp || prev?.timeStamp || '',
    source: entry.source || prev?.source || 'dom',
    isExcerptOnly: Boolean(entry.isExcerptOnly),
  });
}

function findAllMainColumns() {
  let cols = Array.from(document.querySelectorAll('.year-col')).filter(
    (el) => !el.closest('.plug-backdrop') && !el.closest('#vp-inline-day-bar')
  );
  if (!cols.length) {
    cols = Array.from(document.querySelectorAll('[data-year]')).filter(
      (el) =>
        !el.closest('.plug-backdrop') &&
        !el.closest('#vp-inline-day-bar') &&
        !el.parentElement?.closest('[data-year]')
    );
  }
  return cols;
}

function getColumnYear(col) {
  if (!col) return null;
  const attr = col.getAttribute('data-year');
  if (attr && /^\d{4}$/.test(attr)) return attr;
  const header = col.querySelector('.year-header, .year-title, .year-col-header, h2, h3');
  const m = (header?.textContent || '').match(/\b(19|20)\d{2}\b/);
  return m ? m[0] : null;
}

function extractExplicitIsoFromNode(node) {
  if (!node) return null;
  for (const attr of ['data-date', 'data-iso', 'data-entry-date', 'data-archive-date']) {
    const val = node.getAttribute?.(attr) || '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(val)) return val;
  }
  const dateEl = node.querySelector?.(
    '.entry-date, .stacked-entry-date, .year-col-date, .entry-subheader, .archive-date, time'
  );
  if (dateEl) {
    const dtAttr = dateEl.getAttribute?.('datetime') || '';
    const mAttr = dtAttr.match(/((?:19|20)\d{2}-\d{2}-\d{2})/);
    if (mAttr) return mAttr[1];
    const mTxt = (dateEl.textContent || '').match(/\b((?:19|20)\d{2}-\d{2}-\d{2})\b/);
    if (mTxt) return mTxt[1];
  }
  // Check only the leading header/meta text (never deep inside prose where user might mention another date)
  const clone = node.cloneNode(true);
  clone
    .querySelectorAll('.entry-body, .entry-body-content, .year-entry-body, .entry-text, .prose, .markdown-body')
    .forEach((el) => el.remove());
  const headText = (clone.textContent || '').slice(0, 180);
  const mIso = headText.match(/\b((?:19|20)\d{2}-\d{2}-\d{2})\b/);
  if (mIso) return mIso[1];

  // Also parse "Nov 20, 2026" or "November 20, 2026" in headers
  const mWord = headText.match(
    /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s+((?:19|20)\d{2})\b/i
  );
  if (mWord) {
    const mNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const mIdx = mNames.indexOf(mWord[1].slice(0, 3).toLowerCase());
    if (mIdx !== -1) {
      return `${mWord[3]}-${String(mIdx + 1).padStart(2, '0')}-${String(Number(mWord[2])).padStart(2, '0')}`;
    }
  }
  return null;
}

// Strict UI-only MM-DD detector (NEVER reads location.hash so failed navigation can never overwrite dates)
function detectDisplayedUIMMDD() {
  // 1) Explicit YYYY-MM-DD inside any currently rendered column
  for (const col of findAllMainColumns()) {
    const iso = extractExplicitIsoFromNode(col);
    if (iso) return iso.slice(5);
  }
  // 2) Main page date input
  const dateInput = document.querySelector('#date-picker, #current-date-input, input[type="date"]');
  if (dateInput && !dateInput.closest('.plug-backdrop') && /^\d{4}-\d{2}-\d{2}$/.test(dateInput.value)) {
    return dateInput.value.slice(5);
  }
  // 3) Month / Day dropdowns
  const monthSel = document.querySelector('#month-select, [data-role="month-select"]');
  const daySel = document.querySelector('#day-select, [data-role="day-select"]');
  if (monthSel && daySel && monthSel.value && daySel.value) {
    return `${String(Number(monthSel.value)).padStart(2, '0')}-${String(Number(daySel.value)).padStart(2, '0')}`;
  }
  // 4) Visible date heading ("November 28" / "Nov 28")
  const headerNodes = document.querySelectorAll(
    '#current-date-title, #date-heading, .date-display, .current-date, .reader-date, header h1, header h2, main h1, main h2'
  );
  const mNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  for (const node of headerNodes) {
    if (node.closest('.plug-backdrop, #vp-inline-day-bar')) continue;
    const hit = (node.textContent || '').match(
      /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})\b/i
    );
    if (hit) {
      const mIdx = mNames.indexOf(hit[1].slice(0, 3).toLowerCase());
      const dNum = Number(hit[2]);
      if (mIdx !== -1 && dNum >= 1 && dNum <= 31) {
        return `${String(mIdx + 1).padStart(2, '0')}-${String(dNum).padStart(2, '0')}`;
      }
    }
  }
  return null;
}

function detectCurrentDiaryMMDD() {
  return detectDisplayedUIMMDD() || (location.hash.match(/(\d{2}-\d{2})/) || [])[1] || todayISO().slice(5);
}

function extractCleanCardData(card) {
  const badgeTags = [];
  const metaPills = [];
  card
    .querySelectorAll('.tag, .tag-chip, .entry-tag, .pill, .badge, .meta-pill, .chip, [data-tag]')
    .forEach((el) => {
      const txt = (el.textContent || '').trim();
      if (!txt) return;
      if (txt.startsWith('#')) badgeTags.push(txt);
      else if (txt.length <= 44 && !/^(share|quote|edit|delete|history|pin)$/i.test(txt)) {
        metaPills.push(txt);
      }
    });

  const explicitIso = extractExplicitIsoFromNode(card);
  const bodyNode = card.querySelector(
    '.entry-body-content, .entry-body, .entry-content, .stacked-entry-body, .year-entry-body, .year-entry-content, .entry-text, .entry-prose, .prose, .markdown-body, .archive-excerpt, .archive-body, .card-body'
  );
  const clone = (bodyNode || card).cloneNode(true);
  clone
    .querySelectorAll(
      'button, nav, input, textarea, select, script, style, .entry-actions, .entry-toolbar, .entry-meta, .entry-header, .entry-subheader, .entry-date, .stacked-entry-date, .archive-date, .entry-pills, .entry-badges, .meta-pills, .pills, .badges, .tags-row, .tag-list, .entry-tags, .pill, .badge, .chip, .year-header, .year-col-header, .year-col-actions, .year-col-add-entry-bar, .stacked-entry-header, .stacked-entry-index, .margin-notes, .comments-section'
    )
    .forEach((el) => el.remove());

  clone.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
  clone.querySelectorAll('p, div, li, blockquote, h1, h2, h3, h4').forEach((blk) => {
    blk.append('\n');
  });

  let rawText = (clone.textContent || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!bodyNode) {
    rawText = rawText
      .replace(/^(?:19|20)\d{2}(?:-\d{2}-\d{2})?\s*\n+/g, '')
      .replace(/^(?:History|Pin|Share|Quote|Edit|Delete)(\s+(?:History|Pin|Share|Quote|Edit|Delete))*\s*\n+/gi, '')
      .trim();
  }

  if (/^(no entry|nothing written|write an entry|add entry|click to write|no entries)/i.test(rawText) && rawText.length < 75) {
    rawText = '';
  }

  const title = (card.querySelector('.entry-title, .stacked-entry-title, .archive-title, h4')?.textContent || '').trim();
  const timeStamp = (card.querySelector('.entry-time, .stacked-entry-time')?.textContent || '').trim();

  return {
    explicitIso,
    title,
    body: rawText,
    tags: extractTags(rawText, badgeTags),
    pills: Array.from(new Set(metaPills)),
    timeStamp,
  };
}

function extractEntriesFromColumn(col, fallbackMmdd) {
  const yr = getColumnYear(col);
  if (!yr) return [];
  const colIso = extractExplicitIsoFromNode(col);

  // Detect stacked multi-entries first, then single-entry containers, then direct prose fallback
  let cards = Array.from(
    col.querySelectorAll('.stacked-entry-item, .stacked-entry, .entry-card, .entry-item, .year-entry, .diary-entry')
  ).filter((c) => !c.parentElement?.closest('.stacked-entry-item, .stacked-entry, .entry-card, .entry-item, .year-entry, .diary-entry'));

  if (!cards.length) {
    const bodies = Array.from(
      col.querySelectorAll(
        '.entry-body-content, .entry-body, .entry-content, .year-entry-body, .entry-text, .prose, .markdown-body'
      )
    ).filter((b) => !b.parentElement?.closest('.entry-body, .entry-content, .year-entry-body, .prose'));
    if (bodies.length) cards = bodies;
  }

  if (!cards.length) {
    // Generic fallback for custom card markup inside .year-col
    cards = [col];
  }

  const out = [];
  const seenFp = new Set();
  cards.forEach((card, idx) => {
    const parsed = extractCleanCardData(card);
    const fp = contentFingerprint(parsed.body);
    if (!parsed.body || !fp || seenFp.has(fp)) return;
    seenFp.add(fp);

    const isoDate = parsed.explicitIso || colIso || (fallbackMmdd ? `${yr}-${fallbackMmdd}` : null);
    if (!isoDate) return;

    out.push({
      isoDate,
      year: isoDate.slice(0, 4),
      mmdd: isoDate.slice(5),
      orderHint: idx,
      title: parsed.title,
      text: parsed.body,
      words: countWords(parsed.body),
      tags: parsed.tags,
      pills: parsed.pills,
      timeStamp: parsed.timeStamp,
      source: 'reader-dom',
      isExcerptOnly: false,
    });
  });

  return out.map((item, idx) => ({
    ...item,
    entryIndex: idx + 1,
    totalInYear: out.length,
  }));
}

function columnHasRealEntry(col) {
  const mmdd = detectDisplayedUIMMDD();
  return extractEntriesFromColumn(col, mmdd).length > 0;
}

// Harvest any visible Archive / Timeline / Search rows (captures ALL unlocked entries at once when Archive is open)
function captureVisibleArchiveDOM() {
  const archiveSelectors = [
    '.archive-entry',
    '.archive-item',
    '.archive-card',
    '.archive-row',
    '.timeline-item',
    '.timeline-entry',
    '.search-result',
    '[data-archive-date]',
    '[data-entry-date]',
  ].join(', ');

  const candidates = Array.from(document.querySelectorAll(archiveSelectors)).filter(
    (el) => !el.closest('.plug-backdrop, #vp-inline-day-bar, .year-col')
  );

  // Also check cards inside #archive-view / .archive-list if custom class names are used
  const archiveHost = document.querySelector(
    '#archive-view, #view-archive, .archive-view, .archive-list, [data-view-panel="archive"]'
  );
  if (archiveHost && archiveHost.offsetParent !== null) {
    archiveHost.querySelectorAll('article, .card, .item, li').forEach((node) => {
      if (!candidates.includes(node)) candidates.push(node);
    });
  }

  let harvested = 0;
  candidates.forEach((node, idx) => {
    const iso = extractExplicitIsoFromNode(node);
    if (!iso) return;
    const parsed = extractCleanCardData(node);
    if (!parsed.body || parsed.body.length < 3) return;
    const looksTruncated = parsed.body.endsWith('…') || parsed.body.endsWith('...');
    upsertEntryIntoStore({
      isoDate: iso,
      orderHint: idx,
      title: parsed.title,
      text: parsed.body,
      tags: parsed.tags,
      pills: parsed.pills,
      timeStamp: parsed.timeStamp,
      source: 'archive-dom',
      isExcerptOnly: looksTruncated,
    });
    harvested++;
  });
  return harvested;
}

function captureVisibleDOM(strictExpectedMmdd = null) {
  const displayedMmdd = detectDisplayedUIMMDD();

  // If scanning a specific date, NEVER capture unless the UI actually moved to that MM-DD
  if (strictExpectedMmdd && displayedMmdd !== strictExpectedMmdd) {
    return 0;
  }

  let captured = 0;
  const seenYears = new Set();
  findAllMainColumns().forEach((col) => {
    const yr = getColumnYear(col);
    if (!yr || seenYears.has(yr)) return;
    seenYears.add(yr);

    const items = extractEntriesFromColumn(col, displayedMmdd);
    items.forEach((item) => {
      // Double-check strictExpectedMmdd so pinned or stale columns can NEVER pollute another date
      if (strictExpectedMmdd && item.mmdd !== strictExpectedMmdd) return;
      upsertEntryIntoStore(item);
      captured++;
    });
  });

  captured += captureVisibleArchiveDOM();
  return captured;
}

/* --- DEEP RECURSIVE STORAGE & INDEXEDDB SCANNER (FINDS ALL UNENCRYPTED CACHED ENTRIES) --- */

function isEncryptedEnvelope(obj) {
  if (!obj || typeof obj !== 'object') return false;
  return Boolean(
    obj.encrypted === true ||
      (typeof obj.ct === 'string' && typeof obj.iv === 'string') ||
      (typeof obj.ciphertext === 'string' && typeof obj.iv === 'string') ||
      (typeof obj.cipher === 'string' && typeof obj.salt === 'string')
  );
}

function extractEntriesFromArbitraryObject(root, sink, depth = 0, ctxMmdd = '', ctxYear = '') {
  if (!root || typeof root !== 'object' || depth > 6 || isEncryptedEnvelope(root)) return;

  if (Array.isArray(root)) {
    root.forEach((item, idx) => {
      if (typeof item === 'string' && ctxYear && ctxMmdd) {
        sink({ isoDate: `${ctxYear}-${ctxMmdd}`, text: item, orderHint: idx, source: 'storage' });
      } else if (item && typeof item === 'object' && !isEncryptedEnvelope(item)) {
        const text = item.body ?? item.text ?? item.content ?? item.markdown ?? '';
        const explicitDate =
          (typeof item.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.date) && item.date) ||
          (typeof item.isoDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.isoDate) && item.isoDate) ||
          (ctxYear && ctxMmdd ? `${ctxYear}-${ctxMmdd}` : '');
        if (typeof text === 'string' && text.trim() && explicitDate) {
          sink({
            isoDate: explicitDate,
            orderHint: idx,
            title: String(item.title || '').trim(),
            text: text.trim(),
            tags: extractTags(text, item.tags || []),
            timeStamp: item.createdAt || item.updatedAt || item.timestamp || '',
            source: 'storage',
          });
        } else {
          extractEntriesFromArbitraryObject(item, sink, depth + 1, ctxMmdd, ctxYear);
        }
      }
    });
    return;
  }

  // Check if this object itself is a single diary entry
  const directText = root.body ?? root.text ?? root.content ?? root.markdown;
  const directDate =
    (typeof root.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(root.date) && root.date) ||
    (typeof root.isoDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(root.isoDate) && root.isoDate) ||
    (ctxYear && ctxMmdd ? `${ctxYear}-${ctxMmdd}` : '');

  if (typeof directText === 'string' && directText.trim() && directDate) {
    sink({
      isoDate: directDate,
      orderHint: 0,
      title: String(root.title || '').trim(),
      text: directText.trim(),
      tags: extractTags(directText, root.tags || []),
      timeStamp: root.createdAt || root.updatedAt || root.timestamp || '',
      source: 'storage',
    });
  }

  // Walk child keys for MM-DD, YYYY-MM-DD, YYYY, days, years, entries
  Object.keys(root).forEach((k) => {
    const val = root[k];
    if (!val || typeof val !== 'object') {
      if (typeof val === 'string' && /^\d{4}$/.test(k) && ctxMmdd) {
        sink({ isoDate: `${k}-${ctxMmdd}`, text: val, orderHint: 0, source: 'storage' });
      }
      return;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(k)) {
      extractEntriesFromArbitraryObject(val, sink, depth + 1, k.slice(5), k.slice(0, 4));
    } else if (/^\d{2}-\d{2}$/.test(k)) {
      extractEntriesFromArbitraryObject(val, sink, depth + 1, k, ctxYear);
    } else if (/^\d{4}$/.test(k)) {
      extractEntriesFromArbitraryObject(val, sink, depth + 1, ctxMmdd, k);
    } else if (k === 'days' || k === 'years' || k === 'entries' || k === 'items' || k === 'data' || k === 'cache') {
      extractEntriesFromArbitraryObject(val, sink, depth + 1, ctxMmdd, ctxYear);
    }
  });
}

function scanWebStorage(storageObj) {
  if (!storageObj) return;
  for (let i = 0; i < storageObj.length; i++) {
    const k = storageObj.key(i);
    if (!k || VP_SKIP_KEYS.has(k)) continue;
    const rawStr = storageObj.getItem(k);
    if (!rawStr || (rawStr[0] !== '{' && rawStr[0] !== '[')) continue;
    try {
      const parsed = JSON.parse(rawStr);
      const initMmdd = /^\d{2}-\d{2}$/.test(k) ? k : /^\d{4}-\d{2}-\d{2}$/.test(k) ? k.slice(5) : '';
      const initYear = /^\d{4}-\d{2}-\d{2}$/.test(k) ? k.slice(0, 4) : '';
      extractEntriesFromArbitraryObject(parsed, upsertEntryIntoStore, 0, initMmdd, initYear);
    } catch {
      // ignore non-JSON
    }
  }
}

async function scanIndexedDBReadOnly() {
  if (vpIdbScanned || typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') return;
  vpIdbScanned = true;
  const collected = [];
  try {
    const dbs = await indexedDB.databases();
    for (const info of dbs || []) {
      if (!info?.name) continue;
      await new Promise((resolve) => {
        let req;
        try {
          req = indexedDB.open(info.name);
        } catch {
          return resolve();
        }
        req.onerror = () => resolve();
        req.onsuccess = () => {
          const db = req.result;
          const stores = Array.from(db.objectStoreNames || []);
          if (!stores.length) {
            db.close();
            return resolve();
          }
          let pending = stores.length;
          const done = () => {
            pending--;
            if (pending <= 0) {
              try { db.close(); } catch { /* noop */ }
              resolve();
            }
          };
          stores.forEach((storeName) => {
            try {
              const tx = db.transaction(storeName, 'readonly');
              const st = tx.objectStore(storeName);
              const allReq = st.getAll();
              allReq.onerror = done;
              allReq.onsuccess = () => {
                (allReq.result || []).forEach((rec) => {
                  extractEntriesFromArbitraryObject(rec, (e) => collected.push(e), 0, '', '');
                });
                done();
              };
            } catch {
              done();
            }
          });
        };
      });
    }
  } catch {
    // ignore IndexedDB permission errors
  }
  vpIdbEntriesCache = collected;
  vpIdbEntriesCache.forEach(upsertEntryIntoStore);
}

function ingestOptionalAppBridge() {
  try {
    const candidates = [
      typeof window.__PD_BRIDGE__?.getAllEntries === 'function' ? window.__PD_BRIDGE__.getAllEntries() : null,
      typeof window.__PD_BRIDGE__?.getPlainEntries === 'function' ? window.__PD_BRIDGE__.getPlainEntries() : null,
      typeof window.__PD_PRINT_ENTRIES__ === 'function' ? window.__PD_PRINT_ENTRIES__() : window.__PD_PRINT_ENTRIES__,
    ];
    candidates.forEach((data) => {
      if (data) extractEntriesFromArbitraryObject(data, upsertEntryIntoStore, 0, '', '');
    });
  } catch {
    // ignore bridge errors
  }
}

function collectAllKnownEntries() {
  ingestOptionalAppBridge();
  captureVisibleDOM();
  scanWebStorage(localStorage);
  scanWebStorage(sessionStorage);
  vpIdbEntriesCache.forEach(upsertEntryIntoStore);

  const metaMap = loadEntryMetaMap();
  const out = [];

  Array.from(vpEntryStore.keys())
    .sort()
    .forEach((isoDate) => {
      const dayList = Array.from(vpEntryStore.get(isoDate).values()).sort(
        (a, b) => (a.orderHint ?? 0) - (b.orderHint ?? 0)
      );
      dayList.forEach((item, idx) => {
        const entryIndex = idx + 1;
        const customMeta = metaMap[`${isoDate}|${entryIndex}`] || {};
        const title = customMeta.title || item.title || '';
        const description = customMeta.description || '';
        out.push({
          ...item,
          entryIndex,
          totalInYear: dayList.length,
          title,
          description,
          excerpt: makeExcerpt(item.text || title, 180),
          tags: extractTags(`${title} ${description} ${item.text}`, item.tags || []),
        });
      });
    });

  return out;
}

/* ==========================================================================
   4. INTEGRATED MAIN-PAGE DAY VIEW (LIVE DOM FOCUS MODE)
   ========================================================================== */

function clearInlineDayViewStyles() {
  document.body.classList.remove('vp-day-mode', 'vp-clean-read');
  document.querySelectorAll('.vp-day-grid-host').forEach((el) => el.classList.remove('vp-day-grid-host'));
  document.querySelectorAll('.vp-focused-col, .vp-hidden-col').forEach((el) => {
    el.classList.remove(
      'vp-focused-col',
      'vp-hidden-col',
      'vp-font-serif',
      'vp-font-sans',
      'vp-font-mono',
      'vp-size-sm',
      'vp-size-md',
      'vp-size-lg',
      'vp-theme-auto',
      'vp-theme-sepia',
      'vp-theme-paper'
    );
  });
  const bar = document.getElementById('vp-inline-day-bar');
  if (bar) bar.remove();
}

function updateHeaderDayButtonState() {
  const btn = document.getElementById('vp-day-trigger');
  if (!btn) return;
  btn.classList.toggle('is-active', vpState.dayMode);
  btn.textContent = vpState.dayMode ? 'Side-by-Side' : 'Day View';
  btn.title = vpState.dayMode
    ? 'Switch back to Side-by-Side multi-year view (Alt+D)'
    : 'Focus a single day directly on the main page (Alt+D)';
}

function toggleIntegratedDayView(forceState = null, preferredYear = null) {
  vpState.dayMode = typeof forceState === 'boolean' ? forceState : !vpState.dayMode;
  if (preferredYear && /^\d{4}$/.test(String(preferredYear))) {
    vpState.selectedYear = String(preferredYear);
    savePrefs({ selectedYear: vpState.selectedYear });
  }
  vpState.aaOpen = false;
  vpState.pinOpen = false;
  savePrefs({ dayMode: vpState.dayMode });
  updateHeaderDayButtonState();

  if (!vpState.dayMode) {
    clearInlineDayViewStyles();
    return;
  }
  syncIntegratedDayView();
}

function findGridHostForColumns(cols) {
  if (!cols.length) return null;
  const parent = cols[0].parentElement;
  if (parent && parent !== document.body) return parent;
  return document.querySelector('#columns-container, #reader-grid, .columns-grid, .side-by-side, main') || parent;
}

function syncIntegratedDayView() {
  if (vpSyncingLayout) return;
  updateHeaderDayButtonState();

  if (!vpState.dayMode) {
    clearInlineDayViewStyles();
    return;
  }

  const allCols = findAllMainColumns();
  if (!allCols.length) {
    const strayBar = document.getElementById('vp-inline-day-bar');
    if (strayBar) strayBar.remove();
    return;
  }

  vpSyncingLayout = true;
  try {
    document.body.classList.add('vp-day-mode');
    document.body.classList.toggle('vp-clean-read', vpState.cleanRead);

    const uniqueEntries = [];
    const seenYears = new Set();
    allCols.forEach((col, idx) => {
      const yr = getColumnYear(col);
      if (!yr || seenYears.has(yr)) {
        col.classList.add('vp-hidden-col');
        col.classList.remove('vp-focused-col');
        return;
      }
      seenYears.add(yr);
      uniqueEntries.push({ yr, col, hasContent: columnHasRealEntry(col), idx });
    });

    if (!uniqueEntries.length) return;

    let chosen = uniqueEntries.find((u) => u.yr === vpState.selectedYear);
    if (!chosen || (!chosen.hasContent && uniqueEntries.some((u) => u.hasContent))) {
      chosen = uniqueEntries.find((u) => u.hasContent) || uniqueEntries[0];
    }
    vpState.selectedYear = chosen.yr;

    const host = findGridHostForColumns(allCols);
    if (host) host.classList.add('vp-day-grid-host');

    const focusClasses = [
      'vp-focused-col',
      `vp-font-${vpState.dayFont}`,
      `vp-size-${vpState.daySize}`,
      `vp-theme-${vpState.dayTheme}`,
    ];

    uniqueEntries.forEach((u) => {
      u.col.classList.remove(
        'vp-focused-col',
        'vp-hidden-col',
        'vp-font-serif',
        'vp-font-sans',
        'vp-font-mono',
        'vp-size-sm',
        'vp-size-md',
        'vp-size-lg',
        'vp-theme-auto',
        'vp-theme-sepia',
        'vp-theme-paper'
      );
      if (u.col === chosen.col) u.col.classList.add(...focusClasses);
      else u.col.classList.add('vp-hidden-col');
    });

    renderInlineDayToolbar(host, uniqueEntries, chosen);
  } finally {
    vpSyncingLayout = false;
  }
}

function renderInlineDayToolbar(gridHost, uniqueEntries, chosen) {
  if (!gridHost || !gridHost.parentNode) return;

  const mmdd = detectCurrentDiaryMMDD();
  const activeIso = extractExplicitIsoFromNode(chosen.col) || `${chosen.yr}-${mmdd}`;
  const liveItems = extractEntriesFromColumn(chosen.col, mmdd);
  const wordCount = liveItems.reduce((sum, e) => sum + e.words, 0);
  const dayPins = loadPinnedDates().filter((p) => p.isoDate === activeIso);

  let bar = document.getElementById('vp-inline-day-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'vp-inline-day-bar';
    bar.className = 'vp-inline-day-bar';
    gridHost.parentNode.insertBefore(bar, gridHost);
  } else if (bar.nextSibling !== gridHost) {
    gridHost.parentNode.insertBefore(bar, gridHost);
  }

  bar.innerHTML = `
    <div class="vp-bar-row">
      <div class="vp-bar-left">
        <span class="vp-bar-date">${esc(formatLongDate(activeIso))}</span>
        <span class="vp-bar-meta">${liveItems.length ? `${liveItems.length > 1 ? `${liveItems.length} entries · ` : ''}${wordCount.toLocaleString()} words` : 'Empty day'}</span>
      </div>

      <div class="vp-bar-years" role="tablist" aria-label="Switch Year">
        ${uniqueEntries
          .map(
            (u) => `
          <button type="button" class="vp-yr-pill ${u.yr === chosen.yr ? 'is-active' : ''} ${u.hasContent ? 'has-entry' : 'is-empty'}" data-vp-yr="${esc(u.yr)}">
            ${esc(u.yr)}${u.hasContent ? '<i class="vp-yr-dot"></i>' : ''}
          </button>`
          )
          .join('')}
      </div>

      <div class="vp-bar-right">
        <button type="button" class="plug-btn plug-btn-sm ${vpState.aaOpen ? 'plug-btn-primary' : ''}" id="vp-bar-aa">Aa</button>
        <button type="button" class="plug-btn plug-btn-sm ${vpState.pinOpen ? 'plug-btn-primary' : ''}" id="vp-bar-pin">${dayPins.length ? `Pinned (${dayPins.length})` : '+ Pin'}</button>
        <button type="button" class="plug-btn plug-btn-sm" id="vp-bar-print">Print Day</button>
        <button type="button" class="plug-btn plug-btn-sm" id="vp-bar-exit">Side-by-Side</button>
      </div>
    </div>

    ${
      vpState.aaOpen
        ? `<div class="vp-bar-drawer">
            <div class="vp-drawer-group">
              <span class="vp-drawer-lbl">Surface</span>
              <div class="vp-seg">
                <button type="button" class="${vpState.dayTheme === 'auto' ? 'is-on' : ''}" data-set-theme="auto">Dark</button>
                <button type="button" class="${vpState.dayTheme === 'sepia' ? 'is-on' : ''}" data-set-theme="sepia">Sepia</button>
                <button type="button" class="${vpState.dayTheme === 'paper' ? 'is-on' : ''}" data-set-theme="paper">Paper</button>
              </div>
            </div>
            <div class="vp-drawer-group">
              <span class="vp-drawer-lbl">Font</span>
              <div class="vp-seg">
                <button type="button" class="${vpState.dayFont === 'serif' ? 'is-on' : ''}" data-set-font="serif">Serif</button>
                <button type="button" class="${vpState.dayFont === 'sans' ? 'is-on' : ''}" data-set-font="sans">Sans</button>
                <button type="button" class="${vpState.dayFont === 'mono' ? 'is-on' : ''}" data-set-font="mono">Mono</button>
              </div>
            </div>
            <div class="vp-drawer-group">
              <span class="vp-drawer-lbl">Size</span>
              <div class="vp-seg">
                <button type="button" class="${vpState.daySize === 'sm' ? 'is-on' : ''}" data-set-size="sm">A-</button>
                <button type="button" class="${vpState.daySize === 'md' ? 'is-on' : ''}" data-set-size="md">A</button>
                <button type="button" class="${vpState.daySize === 'lg' ? 'is-on' : ''}" data-set-size="lg">A+</button>
              </div>
            </div>
            <label class="vp-check" style="margin-left:auto;">
              <input type="checkbox" id="vp-bar-clean" ${vpState.cleanRead ? 'checked' : ''} /> Hide mood/weather pills
            </label>
          </div>`
        : ''
    }

    ${
      vpState.pinOpen
        ? `<div class="vp-bar-drawer vp-bar-pin-form">
            <input type="text" id="vp-inline-pin-title" class="plug-input" style="flex:1 1 200px;" placeholder="Index Title for ${esc(activeIso)}..." />
            <input type="text" id="vp-inline-pin-desc" class="plug-input" style="flex:1 1 220px;" placeholder="Description or #tags (optional)..." />
            <button type="button" id="vp-inline-pin-save" class="plug-btn plug-btn-primary plug-btn-sm">Save Pin</button>
          </div>`
        : ''
    }
  `;

  bar.querySelectorAll('[data-vp-yr]').forEach((btn) => {
    btn.addEventListener('click', () => {
      vpState.selectedYear = btn.getAttribute('data-vp-yr');
      savePrefs({ selectedYear: vpState.selectedYear });
      syncIntegratedDayView();
    });
  });

  bar.querySelector('#vp-bar-aa').addEventListener('click', () => {
    vpState.aaOpen = !vpState.aaOpen;
    if (vpState.aaOpen) vpState.pinOpen = false;
    syncIntegratedDayView();
  });

  bar.querySelector('#vp-bar-pin').addEventListener('click', () => {
    vpState.pinOpen = !vpState.pinOpen;
    if (vpState.pinOpen) vpState.aaOpen = false;
    syncIntegratedDayView();
    if (vpState.pinOpen) document.getElementById('vp-inline-pin-title')?.focus();
  });

  bar.querySelector('#vp-bar-exit').addEventListener('click', () => toggleIntegratedDayView(false));

  bar.querySelector('#vp-bar-print').addEventListener('click', () => {
    const entries = extractEntriesFromColumn(chosen.col, mmdd);
    if (!entries.length) return showToast('Nothing written on this day to print.');
    const metaMap = loadEntryMetaMap();
    const enriched = entries.map((e) => {
      const m = metaMap[`${e.isoDate}|${e.entryIndex}`] || {};
      return { ...e, title: m.title || e.title, description: m.description || '' };
    });
    const html = buildRangePrintDocument([{ isoDate: activeIso, entries: enriched }], {
      docTitle: formatLongDate(activeIso),
      subtitle: `Single-Day Reading Sheet (${activeIso})`,
      font: vpState.dayFont,
      includeTitles: true,
      includeHighlights: true,
      includeMeta: true,
      pageBreakPerDay: false,
      includeToc: false,
    });
    sendHtmlToIframePrinter(html, `diary-${activeIso}.html`);
  });

  if (vpState.aaOpen) {
    bar.querySelectorAll('[data-set-theme]').forEach((b) =>
      b.addEventListener('click', () => {
        vpState.dayTheme = b.getAttribute('data-set-theme');
        savePrefs({ dayTheme: vpState.dayTheme });
        syncIntegratedDayView();
      })
    );
    bar.querySelectorAll('[data-set-font]').forEach((b) =>
      b.addEventListener('click', () => {
        vpState.dayFont = b.getAttribute('data-set-font');
        savePrefs({ dayFont: vpState.dayFont });
        syncIntegratedDayView();
      })
    );
    bar.querySelectorAll('[data-set-size]').forEach((b) =>
      b.addEventListener('click', () => {
        vpState.daySize = b.getAttribute('data-set-size');
        savePrefs({ daySize: vpState.daySize });
        syncIntegratedDayView();
      })
    );
    bar.querySelector('#vp-bar-clean').addEventListener('change', (e) => {
      vpState.cleanRead = e.target.checked;
      savePrefs({ cleanRead: vpState.cleanRead });
      syncIntegratedDayView();
    });
  }

  if (vpState.pinOpen) {
    const commitPin = () => {
      const title = bar.querySelector('#vp-inline-pin-title').value.trim();
      const description = bar.querySelector('#vp-inline-pin-desc').value.trim();
      if (!title) return showToast('Enter an Index Title first.');
      const list = loadPinnedDates();
      list.unshift({
        id: `pin_${Date.now()}`,
        isoDate: activeIso,
        year: activeIso.slice(0, 4),
        mmdd: activeIso.slice(5),
        title,
        description,
        tags: extractTags(`${title} ${description}`),
        createdAt: new Date().toISOString(),
      });
      savePinnedDates(list);
      vpState.pinOpen = false;
      showToast(`Pinned "${title}" (${activeIso})`);
      syncIntegratedDayView();
    };
    bar.querySelector('#vp-inline-pin-save').addEventListener('click', commitPin);
    bar.querySelector('#vp-inline-pin-title').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitPin();
      }
    });
  }
}

/* ==========================================================================
   5. PRINT-SAFE HIGHLIGHT RENDERER & OVERLAP-FREE IFRAME PRINT ENGINE
   ========================================================================== */

function formatEntryProseWithHighlights(rawText, dayHighlights = []) {
  const paragraphs = String(rawText || '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!paragraphs.length) return '';

  const colorStyles = {
    gold: 'background:rgba(245,196,81,0.34);border-bottom:2px solid #d99b1e;',
    blue: 'background:rgba(96,165,250,0.28);border-bottom:2px solid #3b82f6;',
    green: 'background:rgba(52,211,153,0.28);border-bottom:2px solid #10b981;',
    pink: 'background:rgba(244,114,182,0.28);border-bottom:2px solid #ec4899;',
  };

  return paragraphs
    .map((paraText) => {
      const lower = paraText.toLowerCase();
      const ranges = [];
      dayHighlights.forEach((h) => {
        const q = String(h.quote || '').trim();
        if (q.length < 2) return;
        let idx = lower.indexOf(q.toLowerCase());
        let len = q.length;
        if (idx === -1 && /\s/.test(q)) {
          const flex = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
          const m = new RegExp(flex, 'i').exec(paraText);
          if (m) {
            idx = m.index;
            len = m[0].length;
          }
        }
        if (idx !== -1) ranges.push({ start: idx, end: idx + len, hl: h });
      });

      if (!ranges.length) return `<p>${esc(paraText).replace(/\n/g, '<br/>')}</p>`;

      ranges.sort((a, b) => a.start - b.start || b.end - a.end);
      const clean = [];
      let cursor = 0;
      ranges.forEach((r) => {
        if (r.start >= cursor) {
          clean.push(r);
          cursor = r.end;
        }
      });

      let out = '';
      let pos = 0;
      clean.forEach((r) => {
        if (r.start > pos) out += esc(paraText.slice(pos, r.start)).replace(/\n/g, '<br/>');
        const st = colorStyles[r.hl.color || 'gold'] || colorStyles.gold;
        out += `<mark style="${st}padding:0 2px;border-radius:3px;">${esc(paraText.slice(r.start, r.end)).replace(/\n/g, '<br/>')}</mark>`;
        pos = r.end;
      });
      if (pos < paraText.length) out += esc(paraText.slice(pos)).replace(/\n/g, '<br/>');
      return `<p>${out}</p>`;
    })
    .join('');
}

function getFontStack(fontChoice) {
  if (fontChoice === 'mono') return '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace';
  if (fontChoice === 'sans') return '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  return 'Georgia, "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Palatino, serif';
}

function downloadPrintableHtml(html, filename) {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  showToast(`Downloaded ${filename}`);
}

function sendHtmlToIframePrinter(html, fallbackFilename) {
  try {
    document.querySelectorAll('iframe.vp-print-frame').forEach((f) => f.remove());
    const iframe = document.createElement('iframe');
    iframe.className = 'vp-print-frame';
    Object.assign(iframe.style, {
      position: 'fixed',
      left: '-9999px',
      top: '0',
      width: '1px',
      height: '1px',
      border: '0',
      opacity: '0',
      pointerEvents: 'none',
    });
    document.body.appendChild(iframe);
    const win = iframe.contentWindow;
    const doc = win.document;
    doc.open();
    doc.write(html);
    doc.close();

    let printed = false;
    const cleanup = () => {
      try { iframe.remove(); } catch { /* noop */ }
    };
    win.addEventListener('afterprint', () => setTimeout(cleanup, 400), { once: true });

    const runPrint = () => {
      if (printed) return;
      printed = true;
      try {
        win.focus();
        win.print();
        // Keep iframe alive long enough for slow print dialogs, then clean up
        setTimeout(cleanup, 60000);
      } catch {
        cleanup();
        downloadPrintableHtml(html, fallbackFilename);
      }
    };
    iframe.addEventListener('load', () => setTimeout(runPrint, 120), { once: true });
    setTimeout(runPrint, 420);
  } catch {
    downloadPrintableHtml(html, fallbackFilename);
  }
}

// Overlap-free, block/table print CSS (NO flex rows, NO break-inside: avoid on long entries)
function buildRangePrintDocument(daysGrouped, opts) {
  const fontCss = getFontStack(opts.font);
  const allHighlights = loadHighlights();
  const totalEntries = daysGrouped.reduce((acc, g) => acc + g.entries.length, 0);
  const totalWords = daysGrouped.reduce((acc, g) => acc + g.entries.reduce((s, e) => s + e.words, 0), 0);

  const tocHtml =
    opts.includeToc && daysGrouped.length > 1
      ? `<section class="toc">
          <h2>Table of Contents</h2>
          <table class="toc-table">
            <tbody>
              ${daysGrouped
                .map((g, i) => {
                  const firstTitle = g.entries.find((e) => e.title)?.title || '';
                  const words = g.entries.reduce((s, e) => s + e.words, 0);
                  return `<tr>
                    <td class="toc-num">${i + 1}.</td>
                    <td class="toc-date">${esc(g.isoDate)}</td>
                    <td class="toc-title">${esc(firstTitle || formatShortDate(g.isoDate))}</td>
                    <td class="toc-meta">${g.entries.length > 1 ? `${g.entries.length} entries · ` : ''}${words.toLocaleString()} words</td>
                  </tr>`;
                })
                .join('')}
            </tbody>
          </table>
        </section>`
      : '';

  const daysHtml = daysGrouped
    .map((g, dayIdx) => {
      const dayHl = opts.includeHighlights ? allHighlights.filter((h) => h.isoDate === g.isoDate) : [];
      const breakCls = opts.pageBreakPerDay && dayIdx > 0 ? ' day-break' : '';
      return `
        <section class="day-section${breakCls}">
          <table class="day-head-table">
            <tr>
              <td class="day-head-left"><h2>${esc(formatLongDate(g.isoDate))}</h2></td>
              <td class="day-head-right">${esc(g.isoDate)}</td>
            </tr>
          </table>
          ${g.entries
            .map(
              (e) => `
            <div class="entry-block">
              ${g.entries.length > 1 ? `<div class="entry-num">Entry #${e.entryIndex} of ${g.entries.length}${e.timeStamp ? ` · ${esc(e.timeStamp)}` : ''}</div>` : ''}
              ${opts.includeTitles && e.title ? `<h3 class="entry-title">${esc(e.title)}</h3>` : ''}
              ${opts.includeTitles && e.description ? `<p class="entry-desc">${esc(e.description)}</p>` : ''}
              <div class="entry-prose">${formatEntryProseWithHighlights(e.text, dayHl)}</div>
              ${
                opts.includeMeta
                  ? `<div class="entry-foot">${e.words.toLocaleString()} words${
                      e.tags.length ? ` · ${e.tags.map((t) => `#${esc(t)}`).join(' ')}` : ''
                    }</div>`
                  : ''
              }
            </div>`
            )
            .join('')}
        </section>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${esc(opts.docTitle)}</title>
<style>
  @page { margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body {
    font-family: ${fontCss};
    color: #16181d;
    background: #ffffff;
    margin: 0;
    padding: 8px 14px;
    line-height: 1.65;
    font-size: 11.2pt;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .doc-header { display: block; border-bottom: 2px solid #16181d; padding-bottom: 10px; margin-bottom: 20px; }
  .doc-header h1 { margin: 0 0 4px; font-size: 18pt; line-height: 1.2; }
  .doc-meta { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 9pt; color: #525866; }
  .toc { display: block; margin: 0 0 24px; padding: 12px 14px; border: 1px solid #d1d5db; page-break-after: always; break-after: page; }
  .toc h2 { margin: 0 0 10px; font-size: 13pt; }
  .toc-table { width: 100%; border-collapse: collapse; font-size: 9.8pt; }
  .toc-table td { padding: 4px 6px; border-bottom: 1px dotted #d1d5db; vertical-align: top; }
  .toc-num { width: 28px; color: #6b7280; font-family: sans-serif; }
  .toc-date { width: 92px; font-family: monospace; font-weight: 700; white-space: nowrap; }
  .toc-title { }
  .toc-meta { width: 140px; text-align: right; font-family: sans-serif; font-size: 8.5pt; color: #6b7280; white-space: nowrap; }
  .day-section { display: block; position: relative; clear: both; margin: 0 0 26px; }
  .day-break { page-break-before: always; break-before: page; }
  .day-head-table { width: 100%; border-collapse: collapse; border-bottom: 1px solid #9ca3af; margin-bottom: 12px; page-break-after: avoid; break-after: avoid; }
  .day-head-left { padding: 0 0 4px; vertical-align: baseline; }
  .day-head-left h2 { margin: 0; font-size: 13.5pt; line-height: 1.25; }
  .day-head-right { padding: 0 0 4px; text-align: right; font-family: monospace; font-size: 9.5pt; color: #4b5563; white-space: nowrap; vertical-align: baseline; }
  .entry-block { display: block; position: relative; clear: both; margin: 0 0 18px; padding: 0 0 12px; border-bottom: 1px dotted #e2e8f0; }
  .entry-block:last-child { border-bottom: none; padding-bottom: 0; }
  .entry-num { font-family: sans-serif; font-size: 8.5pt; font-weight: 700; color: #6b7280; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 4px; page-break-after: avoid; break-after: avoid; }
  .entry-title { margin: 0 0 4px; font-size: 12pt; page-break-after: avoid; break-after: avoid; }
  .entry-desc { margin: 0 0 8px; font-style: italic; color: #4b5563; font-size: 10pt; page-break-after: avoid; break-after: avoid; }
  .entry-prose { display: block; overflow-wrap: break-word; word-wrap: break-word; }
  .entry-prose p { margin: 0 0 10px; text-align: left; orphans: 3; widows: 3; }
  .entry-foot { font-family: sans-serif; font-size: 8.5pt; color: #6b7280; margin-top: 6px; }
</style>
</head>
<body>
  <header class="doc-header">
    <h1>${esc(opts.docTitle)}</h1>
    <div class="doc-meta">${esc(opts.subtitle)} · ${daysGrouped.length} ${daysGrouped.length === 1 ? 'day' : 'days'} · ${totalEntries} ${totalEntries === 1 ? 'entry' : 'entries'} · ${totalWords.toLocaleString()} words · Printed ${esc(todayISO())}</div>
  </header>
  ${tocHtml}
  ${daysHtml}
</body>
</html>`;
}

function buildIndicesPrintDocument(payload, opts) {
  const fontCss = getFontStack(opts.font);
  const colorMap = { gold: '#d99b1e', blue: '#3b82f6', green: '#10b981', pink: '#ec4899' };

  const renderUnifiedTable = (items) => `
    <table>
      <thead><tr><th style="width:96px;">Date</th><th style="width:84px;">Type</th><th>Title, Description &amp; Content</th></tr></thead>
      <tbody>
        ${items
          .map((item) => {
            const border = item.kind === 'Highlight' ? ` style="border-left:3px solid ${colorMap[item.color || 'gold'] || colorMap.gold};"` : '';
            return `<tr>
              <td class="mono">${esc(item.isoDate)}</td>
              <td class="muted">${esc(item.kind)}</td>
              <td${border}>
                ${item.title ? `<div><strong>${esc(item.title)}</strong></div>` : ''}
                ${item.description ? `<div class="muted" style="margin-bottom:3px;">${esc(item.description)}</div>` : ''}
                ${item.quote ? `<blockquote>“${esc(item.quote)}”</blockquote>` : ''}
                ${item.excerpt && opts.includeExcerpts ? `<div>${esc(item.excerpt)}</div>` : ''}
                ${item.tags?.length ? `<div class="tag-line">${item.tags.map((t) => `#${esc(t)}`).join(' ')}</div>` : ''}
              </td>
            </tr>`;
          })
          .join('')}
      </tbody>
    </table>`;

  let bodySections = '';

  if (opts.layout === 'timeline' || opts.layout === 'year') {
    const unified = [];
    if (opts.includePinned) payload.pinned.forEach((p) => unified.push({ ...p, kind: 'Pinned' }));
    if (opts.includeHighlights) payload.highlights.forEach((h) => unified.push({ ...h, kind: 'Highlight' }));
    if (opts.includeEntries) payload.entries.forEach((e) => unified.push({ ...e, kind: 'Entry' }));

    unified.sort((a, b) =>
      opts.sort === 'newest'
        ? b.isoDate.localeCompare(a.isoDate)
        : opts.sort === 'title'
        ? (a.title || a.isoDate).localeCompare(b.title || b.isoDate)
        : a.isoDate.localeCompare(b.isoDate)
    );

    if (opts.layout === 'year') {
      const byYear = new Map();
      unified.forEach((it) => {
        const y = it.year || it.isoDate.slice(0, 4);
        if (!byYear.has(y)) byYear.set(y, []);
        byYear.get(y).push(it);
      });
      const sortedYears = Array.from(byYear.keys()).sort((a, b) =>
        opts.sort === 'newest' ? b.localeCompare(a) : a.localeCompare(b)
      );
      bodySections = sortedYears
        .map((y) => `<section class="idx-sec"><h2>${esc(y)} (${byYear.get(y).length} items)</h2>${renderUnifiedTable(byYear.get(y))}</section>`)
        .join('');
    } else if (unified.length) {
      bodySections = `<section class="idx-sec"><h2>Unified Index Timeline (${unified.length} items)</h2>${renderUnifiedTable(unified)}</section>`;
    }
  } else {
    if (opts.includePinned && payload.pinned.length) {
      bodySections += `<section class="idx-sec">
        <h2>Pinned Dates Index (${payload.pinned.length})</h2>
        <table>
          <thead><tr><th style="width:92px;">Date</th><th style="width:28%;">Title</th><th>Description &amp; Tags</th></tr></thead>
          <tbody>
            ${payload.pinned
              .map(
                (p) => `<tr>
                  <td class="mono">${esc(p.isoDate)}</td>
                  <td><strong>${esc(p.title || 'Untitled')}</strong></td>
                  <td>${esc(p.description || '—')}${p.tags.length ? `<div class="tag-line">${p.tags.map((t) => `#${esc(t)}`).join(' ')}</div>` : ''}</td>
                </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </section>`;
    }
    if (opts.includeHighlights && payload.highlights.length) {
      bodySections += `<section class="idx-sec">
        <h2>Highlighted Passages (${payload.highlights.length})</h2>
        ${payload.highlights
          .map(
            (h) => `<div class="hl-card" style="border-left-color:${colorMap[h.color || 'gold'] || colorMap.gold};">
              <div class="hl-head"><span class="mono">${esc(h.isoDate)}</span>${h.title ? ` <strong>${esc(h.title)}</strong>` : ''}</div>
              ${h.description ? `<p class="hl-desc">${esc(h.description)}</p>` : ''}
              <blockquote>“${esc(h.quote)}”</blockquote>
              ${h.tags.length ? `<div class="tag-line">${h.tags.map((t) => `#${esc(t)}`).join(' ')}</div>` : ''}
            </div>`
          )
          .join('')}
      </section>`;
    }
    if (opts.includeEntries && payload.entries.length) {
      bodySections += `<section class="idx-sec">
        <h2>Diary Entries Directory (${payload.entries.length})</h2>
        <table>
          <thead><tr><th style="width:98px;">Date</th><th>Title, Description${opts.includeExcerpts ? ' &amp; Excerpt' : ''}</th><th style="width:68px;">Words</th></tr></thead>
          <tbody>
            ${payload.entries
              .map(
                (e) => `<tr>
                  <td class="mono">${esc(e.isoDate)}${e.totalInYear > 1 ? `<br/><span class="muted">#${e.entryIndex}/${e.totalInYear}</span>` : ''}</td>
                  <td>
                    ${e.title ? `<div><strong>${esc(e.title)}</strong></div>` : ''}
                    ${e.description ? `<div class="muted" style="margin-bottom:3px;">${esc(e.description)}</div>` : ''}
                    ${opts.includeExcerpts ? `<div>${esc(e.excerpt)}</div>` : ''}
                    ${e.tags.length ? `<div class="tag-line">${e.tags.map((t) => `#${esc(t)}`).join(' ')}</div>` : ''}
                  </td>
                  <td class="mono">${e.words.toLocaleString()}</td>
                </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </section>`;
    }
  }

  if (opts.includeTags && payload.tags.length) {
    bodySections += `<section class="idx-sec">
      <h2>#Tag Cross-Reference Index (${payload.tags.length})</h2>
      <table>
        <thead><tr><th style="width:28%;">Tag</th><th>Dates</th></tr></thead>
        <tbody>
          ${payload.tags
            .map(
              ([tag, dates]) => `<tr>
                <td><strong>#${esc(tag)}</strong> <span class="muted">(${dates.length})</span></td>
                <td class="mono">${dates.map((d) => esc(d)).join(' · ')}</td>
              </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </section>`;
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${esc(opts.docTitle)}</title>
<style>
  @page { margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  body { font-family: ${fontCss}; color: #16181d; background: #ffffff; margin: 0; padding: 8px 14px; font-size: 10.5pt; line-height: 1.5; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  header { border-bottom: 2px solid #16181d; padding-bottom: 8px; margin-bottom: 18px; }
  h1 { margin: 0 0 3px; font-size: 18pt; }
  h2 { font-size: 13pt; margin: 18px 0 8px; border-bottom: 1px solid #9ca3af; padding-bottom: 3px; page-break-after: avoid; break-after: avoid; }
  .meta { font-family: sans-serif; font-size: 9pt; color: #525866; }
  .mono { font-family: monospace; font-size: 9.2pt; }
  .muted { color: #525866; font-size: 9.2pt; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 14px; }
  th, td { border: 1px solid #d1d5db; padding: 6px 8px; text-align: left; vertical-align: top; overflow-wrap: break-word; }
  th { background: #f3f4f6; font-family: sans-serif; font-size: 9pt; font-weight: 700; }
  tr { break-inside: avoid; }
  .hl-card { display: block; border: 1px solid #e5e7eb; border-left: 4px solid #d99b1e; border-radius: 4px; padding: 8px 10px; margin-bottom: 8px; break-inside: avoid; }
  .hl-head { margin-bottom: 3px; }
  .hl-desc { margin: 0 0 4px; color: #4b5563; font-size: 9.5pt; }
  blockquote { margin: 2px 0 0; padding: 0; font-style: italic; }
  .tag-line { font-family: sans-serif; font-size: 8.5pt; color: #4b5563; margin-top: 3px; }
</style>
</head>
<body>
  <header>
    <h1>${esc(opts.docTitle)}</h1>
    <div class="meta">${esc(opts.filterSummary)} · Generated ${esc(todayISO())}</div>
  </header>
  ${bodySections}
</body>
</html>`;
}

/* ==========================================================================
   6. SAFE NAVIGATION & ARCHIVE / RANGE COLLECTORS (ZERO DATE OVERWRITING)
   ========================================================================== */

function setSelectOptionSmart(sel, numVal) {
  if (!sel) return false;
  const padded = String(numVal).padStart(2, '0');
  const plain = String(numVal);
  const match = Array.from(sel.options || []).find((o) => o.value === padded || o.value === plain);
  if (!match) return false;
  sel.value = match.value;
  sel.dispatchEvent(new Event('input', { bubbles: true }));
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

function findNavButtonByText(regex) {
  const btns = Array.from(document.querySelectorAll('header button, nav button, .tabs button, .nav-tabs button, [role="tab"]'));
  return btns.find((b) => !b.closest('.plug-backdrop, #plug-trigger-dock') && regex.test((b.textContent || '').trim())) || null;
}

// Returns true ONLY if an actual UI date control was found and triggered (never fakes via hash alone)
function navigateMainPageToMMDD(mmdd, fullIsoHint = '') {
  const [mNum, dNum] = mmdd.split('-').map(Number);

  const hmCell = document.querySelector(
    `[data-mmdd="${mmdd}"], [data-date="${mmdd}"], [data-day-key="${mmdd}"]`
  );
  if (hmCell) {
    hmCell.click();
    return true;
  }

  const monthSel = document.querySelector('#month-select, [data-role="month-select"], select[name="month"]');
  const daySel = document.querySelector('#day-select, [data-role="day-select"], select[name="day"]');
  if (monthSel && daySel) {
    const okM = setSelectOptionSmart(monthSel, mNum);
    const okD = setSelectOptionSmart(daySel, dNum);
    if (okM || okD) return true;
  }

  const dateInput = document.querySelector('#date-picker, #current-date-input, input[type="date"]');
  if (dateInput && !dateInput.closest('.plug-backdrop')) {
    dateInput.value = fullIsoHint || `${new Date().getFullYear()}-${mmdd}`;
    dateInput.dispatchEvent(new Event('input', { bubbles: true }));
    dateInput.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  return false;
}

function getVisibleDOMSignature() {
  const cols = findAllMainColumns();
  return `${detectDisplayedUIMMDD() || 'none'}|${cols
    .map((c) => `${getColumnYear(c) || ''}:${(c.textContent || '').slice(0, 90)}`)
    .join('||')}`;
}

async function waitForMainDateVerified(targetMmdd, prevSig, maxWaitMs = 1400) {
  const start = Date.now();
  let lastSig = prevSig;
  let changedAt = 0;

  while (Date.now() - start < maxWaitMs) {
    await sleep(90);
    const curSig = getVisibleDOMSignature();
    const curMmdd = detectDisplayedUIMMDD();

    if (curSig !== lastSig) {
      lastSig = curSig;
      changedAt = Date.now();
    }
    if (curMmdd === targetMmdd && changedAt > 0 && Date.now() - changedAt >= 160) {
      return true;
    }
    if (curMmdd === targetMmdd && Date.now() - start >= 500 && changedAt === 0) {
      return true;
    }
  }
  return detectDisplayedUIMMDD() === targetMmdd;
}

async function collectEntriesFromArchiveTab() {
  const archiveBtn =
    document.querySelector('[data-view="archive"], #tab-archive, #nav-archive, #btn-archive') ||
    findNavButtonByText(/^archive$/i);
  const readerBtn =
    document.querySelector('[data-view="reader"], [data-view="diary"], #tab-reader, #nav-reader, #btn-reader') ||
    findNavButtonByText(/^(diary|reader|entries|side[- ]by[- ]side)$/i);

  if (!archiveBtn) {
    const count = captureVisibleArchiveDOM();
    if (count > 0) {
      updateRangeResultsOnly();
      showToast(`Collected ${count} entries from Archive`);
    } else {
      showToast('Open your Archive tab once, then reopen Print Studio to load all entries.');
    }
    return;
  }

  const wasAlreadyInReader = findAllMainColumns().length > 0;
  vpState.rangeScanning = true;
  vpState.rangeScanProgress = 'Reading Archive tab…';
  updateRangeScanUI();

  archiveBtn.click();
  await sleep(550);
  const count = captureVisibleArchiveDOM();

  // Return to Reader cleanly if user started there
  if (wasAlreadyInReader && readerBtn) {
    readerBtn.click();
    await sleep(320);
    captureVisibleDOM();
  }

  vpState.rangeScanning = false;
  vpState.rangeScanProgress = '';
  updateRangeScanUI();
  updateRangeResultsOnly();
  if (vpState.dayMode) syncIntegratedDayView();
  showToast(
    count > 0
      ? `Collected ${count} entries from Archive`
      : 'Archive scanned — if entries use click-to-open, use Scan Date Range instead.'
  );
}

async function scanUnlockedVaultForRange() {
  const allDates = enumerateDatesBetween(vpState.rangeStart, vpState.rangeEnd, 370);
  if (!allDates.length) return showToast('Choose a valid Start and End date first.');

  const uniqueMmdds = Array.from(new Set(allDates.map((d) => d.slice(5))));
  if (uniqueMmdds.length > 45) {
    if (!confirm(`Scanning ${uniqueMmdds.length} calendar days will take ~${Math.round(uniqueMmdds.length * 0.55)}s. Continue?`)) {
      return;
    }
  }

  const originalMmdd = detectDisplayedUIMMDD();
  vpScanCancelled = false;
  vpState.rangeScanning = true;
  updateRangeScanUI();

  let verifiedDays = 0;
  let failedNavCount = 0;

  for (let i = 0; i < uniqueMmdds.length; i++) {
    if (vpScanCancelled) break;
    const mmdd = uniqueMmdds[i];
    vpState.rangeScanProgress = `Scanning ${i + 1} / ${uniqueMmdds.length} (${mmdd})…`;
    updateRangeScanUI();

    const prevSig = getVisibleDOMSignature();
    const triggered = navigateMainPageToMMDD(mmdd, `${vpState.rangeStart.slice(0, 4)}-${mmdd}`);
    if (!triggered) {
      failedNavCount++;
      if (failedNavCount >= 2) {
        showToast('Could not locate date controls on this view. Try "Collect from Archive" instead.');
        break;
      }
      continue;
    }

    const ok = await waitForMainDateVerified(mmdd, prevSig, 1300);
    if (ok) {
      // Strictly verify date matches mmdd before caching — eliminates overwriting!
      captureVisibleDOM(mmdd);
      verifiedDays++;
      updateRangeResultsOnly();
    }
  }

  if (originalMmdd) {
    const prevSig = getVisibleDOMSignature();
    if (navigateMainPageToMMDD(originalMmdd)) {
      await waitForMainDateVerified(originalMmdd, prevSig, 900);
      captureVisibleDOM(originalMmdd);
    }
  }

  vpState.rangeScanning = false;
  vpState.rangeScanProgress = '';
  updateRangeScanUI();
  updateRangeResultsOnly();
  if (vpState.dayMode) syncIntegratedDayView();
  showToast(
    vpScanCancelled
      ? 'Range scan stopped'
      : `Verified ${verifiedDays} day${verifiedDays === 1 ? '' : 's'} in range`
  );
}

/* ==========================================================================
   7. PRINT STUDIO MODAL (PRINT DATE RANGE + PRINT INDICES)
   ========================================================================== */

function ensureModal(id) {
  let backdrop = document.getElementById(id);
  if (!backdrop) {
    backdrop = document.createElement('div');
    backdrop.id = id;
    backdrop.className = 'plug-backdrop';
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closePrintModal();
    });
    document.body.appendChild(backdrop);
  }
  return backdrop;
}

function closePrintModal() {
  vpScanCancelled = true;
  const el = document.getElementById('vp-print-backdrop');
  if (el) el.classList.remove('is-open');
}

function openPrintHubModal(defaultTab = 'range', prefill = null) {
  document.querySelectorAll('.plug-backdrop.is-open').forEach((el) => el.classList.remove('is-open'));
  vpState.printTab = defaultTab;
  if (prefill && typeof prefill === 'object') {
    if (typeof prefill.idxQuery === 'string') vpState.idxQuery = prefill.idxQuery;
    if (typeof prefill.idxYear === 'string') vpState.idxYear = prefill.idxYear;
  }
  const backdrop = ensureModal('vp-print-backdrop');
  backdrop.classList.add('is-open');
  renderPrintHubShell();

  // Trigger read-only IndexedDB scan in background and refresh results if anything new is found
  scanIndexedDBReadOnly().then(() => {
    if (vpIdbEntriesCache.length && backdrop.classList.contains('is-open')) {
      if (vpState.printTab === 'range') updateRangeResultsOnly();
      else updateIndicesResultsOnly();
    }
  });
}

function getFilteredRangeGroups() {
  const start = vpState.rangeStart;
  const end = vpState.rangeEnd;
  const q = vpState.rangeFilter.trim().toLowerCase();
  const entries = collectAllKnownEntries().filter((e) => {
    if (start && e.isoDate < start) return false;
    if (end && e.isoDate > end) return false;
    if (q) {
      const hay = `${e.isoDate} ${e.title} ${e.description} ${e.text} ${e.tags.map((t) => '#' + t).join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const map = new Map();
  entries.forEach((e) => {
    if (!map.has(e.isoDate)) map.set(e.isoDate, []);
    map.get(e.isoDate).push(e);
  });

  return Array.from(map.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([isoDate, list]) => ({
      isoDate,
      entries: list.sort((a, b) => a.entryIndex - b.entryIndex),
    }));
}

function getFilteredIndexPayload() {
  const start = vpState.idxStart;
  const end = vpState.idxEnd;
  const yr = vpState.idxYear;
  const q = vpState.idxQuery.trim().toLowerCase();

  const matches = (item) => {
    if (start && item.isoDate < start) return false;
    if (end && item.isoDate > end) return false;
    if (yr !== 'all' && item.year !== yr) return false;
    if (q) {
      const hay = `${item.isoDate} ${item.title || ''} ${item.description || ''} ${item.quote || ''} ${item.text || ''} ${(item.tags || []).map((t) => '#' + t).join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  };

  const sortFn = (a, b) => {
    if (vpState.idxSort === 'newest') return b.isoDate.localeCompare(a.isoDate);
    if (vpState.idxSort === 'title') {
      return (a.title || a.isoDate).localeCompare(b.title || b.isoDate) || a.isoDate.localeCompare(b.isoDate);
    }
    return a.isoDate.localeCompare(b.isoDate);
  };

  const pinned = loadPinnedDates()
    .map((p) => ({
      isoDate: p.isoDate,
      year: p.year || p.isoDate.slice(0, 4),
      title: p.title || '',
      description: p.description || '',
      tags: extractTags(`${p.title || ''} ${p.description || ''}`, p.tags || []),
    }))
    .filter(matches)
    .sort(sortFn);

  const highlights = loadHighlights()
    .map((h) => ({
      isoDate: h.isoDate,
      year: h.year || h.isoDate.slice(0, 4),
      title: h.title || '',
      description: h.description ?? h.note ?? '',
      quote: h.quote || '',
      color: h.color || 'gold',
      tags: extractTags(`${h.title || ''} ${h.description || ''} ${h.quote || ''}`, h.tags || []),
    }))
    .filter(matches)
    .sort(sortFn);

  const entries = collectAllKnownEntries().filter(matches).sort(sortFn);

  const tagMap = new Map();
  [...pinned, ...highlights, ...entries].forEach((item) => {
    (item.tags || []).forEach((t) => {
      if (!tagMap.has(t)) tagMap.set(t, new Set());
      tagMap.get(t).add(item.isoDate);
    });
  });

  const tags = Array.from(tagMap.entries())
    .map(([t, set]) => [t, Array.from(set).sort()])
    .sort((a, b) => a[0].localeCompare(b[0]));

  return { pinned, highlights, entries, tags };
}

function renderPrintHubShell() {
  const backdrop = ensureModal('vp-print-backdrop');
  backdrop.innerHTML = `
    <div class="plug-modal" role="dialog" aria-modal="true" aria-label="Print Studio">
      <div class="plug-header">
        <div class="plug-title-wrap">
          <h2>Print Studio — Date Ranges &amp; Indices</h2>
          <p class="plug-subtitle">Overlap-free printing &amp; HTML export for specific date ranges and your Master Index</p>
        </div>
        <div class="plug-header-actions">
          <button type="button" class="plug-btn plug-btn-sm" id="vp-print-close">Close</button>
        </div>
      </div>

      <div class="plug-tabs">
        <button type="button" class="plug-tab" data-vp-tab="range">Print Date Range</button>
        <button type="button" class="plug-tab" data-vp-tab="indices">Print Indices</button>
      </div>

      <div class="plug-body" id="vp-print-body"></div>
    </div>
  `;

  backdrop.querySelector('#vp-print-close').addEventListener('click', closePrintModal);
  backdrop.querySelectorAll('[data-vp-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      vpState.printTab = btn.getAttribute('data-vp-tab');
      mountActivePrintTab();
    });
  });

  mountActivePrintTab();
}

function mountActivePrintTab() {
  const backdrop = document.getElementById('vp-print-backdrop');
  if (!backdrop) return;
  backdrop.querySelectorAll('[data-vp-tab]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.getAttribute('data-vp-tab') === vpState.printTab);
  });
  const body = backdrop.querySelector('#vp-print-body');
  if (vpState.printTab === 'range') mountPrintRangeShell(body);
  else mountPrintIndicesShell(body);
}

function mountPrintRangeShell(container) {
  container.innerHTML = `
    <div class="plug-card">
      <div class="plug-card-title">
        <span>1. Select Date Range</span>
        <div style="display:flex;gap:5px;flex-wrap:wrap;">
          <button type="button" class="plug-btn plug-btn-sm vp-preset" data-preset="7">Last 7d</button>
          <button type="button" class="plug-btn plug-btn-sm vp-preset" data-preset="30">Last 30d</button>
          <button type="button" class="plug-btn plug-btn-sm vp-preset" data-preset="month">This Month</button>
          <button type="button" class="plug-btn plug-btn-sm vp-preset" data-preset="year">This Year</button>
        </div>
      </div>

      <div class="plug-grid-3">
        <div><label class="bpt-field-label">Start Date</label><input type="date" id="vp-r-start" class="plug-input" value="${esc(vpState.rangeStart)}" /></div>
        <div><label class="bpt-field-label">End Date</label><input type="date" id="vp-r-end" class="plug-input" value="${esc(vpState.rangeEnd)}" /></div>
        <div><label class="bpt-field-label">Optional #Tag or Keyword</label><input type="search" id="vp-r-filter" class="plug-input" placeholder="Leave blank for all entries" value="${esc(vpState.rangeFilter)}" /></div>
      </div>

      <div style="margin-top:10px;">
        <label class="bpt-field-label">Custom Print Title (optional)</label>
        <input type="text" id="vp-r-title" class="plug-input" placeholder="Auto: Diary Entries (Start – End)" value="${esc(vpState.rangeDocTitle)}" />
      </div>

      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:12px;flex-wrap:wrap;">
        <span id="vp-r-scan-status" style="font-size:0.79rem;color:var(--plug-muted);"></span>
        <div id="vp-r-scan-actions" style="display:flex;gap:6px;flex-wrap:wrap;"></div>
      </div>
    </div>

    <div class="plug-card">
      <div class="plug-card-title"><span>2. Print Layout Options</span></div>
      <div class="vp-checks-grid">
        <label class="vp-check"><input type="checkbox" id="vp-opt-titles" ${vpState.rangeOptTitles ? 'checked' : ''} /> Include Index Titles &amp; Descriptions</label>
        <label class="vp-check"><input type="checkbox" id="vp-opt-hl" ${vpState.rangeOptHighlights ? 'checked' : ''} /> Show saved text highlights in color</label>
        <label class="vp-check"><input type="checkbox" id="vp-opt-meta" ${vpState.rangeOptMeta ? 'checked' : ''} /> Include word counts &amp; #tags</label>
        <label class="vp-check"><input type="checkbox" id="vp-opt-toc" ${vpState.rangeOptToc ? 'checked' : ''} /> Include Table of Contents page</label>
        <label class="vp-check"><input type="checkbox" id="vp-opt-break" ${vpState.rangeOptPageBreak ? 'checked' : ''} /> Start each day on a new page</label>
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-size:0.8rem;color:var(--plug-muted);">Font:</span>
          <select id="vp-opt-font" class="plug-select" style="width:auto;padding:4px 8px;font-size:0.8rem;">
            <option value="serif" ${vpState.rangeFont === 'serif' ? 'selected' : ''}>Book Serif (Georgia)</option>
            <option value="sans" ${vpState.rangeFont === 'sans' ? 'selected' : ''}>Clean Sans</option>
            <option value="mono" ${vpState.rangeFont === 'mono' ? 'selected' : ''}>Typewriter Mono</option>
          </select>
        </div>
      </div>
    </div>

    <div id="vp-r-results"></div>
  `;

  container.querySelector('#vp-r-start').addEventListener('change', (e) => { vpState.rangeStart = e.target.value; updateRangeResultsOnly(); });
  container.querySelector('#vp-r-end').addEventListener('change', (e) => { vpState.rangeEnd = e.target.value; updateRangeResultsOnly(); });
  container.querySelector('#vp-r-filter').addEventListener('input', (e) => { vpState.rangeFilter = e.target.value; updateRangeResultsOnly(); });
  container.querySelector('#vp-r-title').addEventListener('input', (e) => { vpState.rangeDocTitle = e.target.value; });

  container.querySelectorAll('.vp-preset').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = btn.getAttribute('data-preset');
      const now = todayISO();
      vpState.rangeEnd = now;
      if (p === '7') vpState.rangeStart = shiftISO(now, -6);
      else if (p === '30') vpState.rangeStart = shiftISO(now, -29);
      else if (p === 'month') vpState.rangeStart = `${now.slice(0, 7)}-01`;
      else if (p === 'year') vpState.rangeStart = `${now.slice(0, 4)}-01-01`;
      vpState.rangeExcludedDates.clear();
      container.querySelector('#vp-r-start').value = vpState.rangeStart;
      container.querySelector('#vp-r-end').value = vpState.rangeEnd;
      updateRangeResultsOnly();
    });
  });

  container.querySelector('#vp-opt-titles').addEventListener('change', (e) => { vpState.rangeOptTitles = e.target.checked; });
  container.querySelector('#vp-opt-hl').addEventListener('change', (e) => { vpState.rangeOptHighlights = e.target.checked; });
  container.querySelector('#vp-opt-meta').addEventListener('change', (e) => { vpState.rangeOptMeta = e.target.checked; });
  container.querySelector('#vp-opt-toc').addEventListener('change', (e) => { vpState.rangeOptToc = e.target.checked; });
  container.querySelector('#vp-opt-break').addEventListener('change', (e) => { vpState.rangeOptPageBreak = e.target.checked; });
  container.querySelector('#vp-opt-font').addEventListener('change', (e) => {
    vpState.rangeFont = e.target.value;
    savePrefs({ rangeFont: vpState.rangeFont });
  });

  updateRangeScanUI();
  updateRangeResultsOnly();
}

function updateRangeScanUI() {
  const statusEl = document.getElementById('vp-r-scan-status');
  const actEl = document.getElementById('vp-r-scan-actions');
  if (!statusEl || !actEl) return;

  if (vpState.rangeScanning) {
    statusEl.innerHTML = `<strong>${esc(vpState.rangeScanProgress || 'Scanning…')}</strong>`;
    actEl.innerHTML = `<button type="button" id="vp-r-stop" class="plug-btn plug-btn-danger plug-btn-sm">Stop Scan</button>`;
    actEl.querySelector('#vp-r-stop').addEventListener('click', () => { vpScanCancelled = true; });
  } else {
    statusEl.textContent = 'Missing encrypted entries? Collect from Archive (fast) or Scan Date Range:';
    actEl.innerHTML = `
      <button type="button" id="vp-r-archive" class="plug-btn plug-btn-sm">Collect from Archive</button>
      <button type="button" id="vp-r-scan" class="plug-btn plug-btn-sm">Scan Date Range</button>
    `;
    actEl.querySelector('#vp-r-archive').addEventListener('click', collectEntriesFromArchiveTab);
    actEl.querySelector('#vp-r-scan').addEventListener('click', scanUnlockedVaultForRange);
  }
}

function updateRangeResultsOnly() {
  const host = document.getElementById('vp-r-results');
  if (!host) return;

  const groups = getFilteredRangeGroups();
  const included = groups.filter((g) => !vpState.rangeExcludedDates.has(g.isoDate));
  const entriesCount = included.reduce((s, g) => s + g.entries.length, 0);
  const wordsCount = included.reduce((s, g) => s + g.entries.reduce((a, e) => a + e.words, 0), 0);

  host.innerHTML = `
    <div class="plug-stat-strip" style="justify-content:space-between;align-items:center;">
      <div><strong>${included.length}</strong> of ${groups.length} days · <strong>${entriesCount}</strong> entries · <strong>${wordsCount.toLocaleString()}</strong> words</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        ${
          groups.length
            ? `<button type="button" id="vp-r-sel-all" class="plug-btn plug-btn-sm">All</button>
               <button type="button" id="vp-r-sel-none" class="plug-btn plug-btn-sm">None</button>`
            : ''
        }
        <button type="button" id="vp-r-dl-btn" class="plug-btn plug-btn-sm">Download HTML</button>
        <button type="button" id="vp-r-print-btn" class="plug-btn plug-btn-primary plug-btn-sm">Print Range</button>
      </div>
    </div>

    <div class="pdx-list">
      ${
        groups.length
          ? groups
              .map((g) => {
                const checked = !vpState.rangeExcludedDates.has(g.isoDate);
                const firstTitle = g.entries.find((e) => e.title)?.title || '';
                const words = g.entries.reduce((s, e) => s + e.words, 0);
                return `
              <div class="pdx-row" style="padding:9px 12px;opacity:${checked ? '1' : '0.52'};">
                <div class="pdx-row-top">
                  <label class="vp-check" style="font-weight:700;color:var(--plug-accent);">
                    <input type="checkbox" class="vp-day-toggle" data-iso="${esc(g.isoDate)}" ${checked ? 'checked' : ''} />
                    <span>${esc(g.isoDate)}</span>
                    ${firstTitle ? `<span style="color:var(--plug-text);font-weight:600;">· ${esc(firstTitle)}</span>` : ''}
                  </label>
                  <div style="display:flex;gap:6px;align-items:center;">
                    <span class="pdx-entry-num">${g.entries.length} ${g.entries.length === 1 ? 'entry' : 'entries'} · ${words.toLocaleString()}w</span>
                    <button type="button" class="plug-btn plug-btn-sm vp-open-day-btn" data-iso="${esc(g.isoDate)}">Open Day</button>
                  </div>
                </div>
                <p class="pdx-excerpt" style="margin-left:22px;">${esc(g.entries[0].excerpt)}</p>
              </div>`;
              })
              .join('')
          : `<div class="pdx-empty">No loaded entries found between <strong>${esc(vpState.rangeStart)}</strong> and <strong>${esc(vpState.rangeEnd)}</strong>. Click <strong>Collect from Archive</strong> or <strong>Scan Date Range</strong> above.</div>`
      }
    </div>
  `;

  host.querySelector('#vp-r-sel-all')?.addEventListener('click', () => { vpState.rangeExcludedDates.clear(); updateRangeResultsOnly(); });
  host.querySelector('#vp-r-sel-none')?.addEventListener('click', () => { groups.forEach((g) => vpState.rangeExcludedDates.add(g.isoDate)); updateRangeResultsOnly(); });

  host.querySelectorAll('.vp-day-toggle').forEach((chk) => {
    chk.addEventListener('change', () => {
      const iso = chk.getAttribute('data-iso');
      if (chk.checked) vpState.rangeExcludedDates.delete(iso);
      else vpState.rangeExcludedDates.add(iso);
      updateRangeResultsOnly();
    });
  });

  host.querySelectorAll('.vp-open-day-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const iso = btn.getAttribute('data-iso');
      closePrintModal();
      navigateMainPageToMMDD(iso.slice(5), iso);
      toggleIntegratedDayView(true, iso.slice(0, 4));
      setTimeout(syncIntegratedDayView, 320);
    });
  });

  const buildDoc = () => {
    if (!included.length) { showToast('Select at least one day with entries first.'); return null; }
    const customTitle = vpState.rangeDocTitle.trim();
    return buildRangePrintDocument(included, {
      docTitle: customTitle || `Diary Entries: ${formatShortDate(vpState.rangeStart)} – ${formatShortDate(vpState.rangeEnd)}`,
      subtitle: vpState.rangeFilter ? `Filtered by "${vpState.rangeFilter}"` : `${vpState.rangeStart} to ${vpState.rangeEnd}`,
      font: vpState.rangeFont,
      includeTitles: vpState.rangeOptTitles,
      includeHighlights: vpState.rangeOptHighlights,
      includeMeta: vpState.rangeOptMeta,
      pageBreakPerDay: vpState.rangeOptPageBreak,
      includeToc: vpState.rangeOptToc,
    });
  };

  host.querySelector('#vp-r-print-btn').addEventListener('click', () => {
    const html = buildDoc();
    if (html) sendHtmlToIframePrinter(html, `diary-range-${vpState.rangeStart}-to-${vpState.rangeEnd}.html`);
  });
  host.querySelector('#vp-r-dl-btn').addEventListener('click', () => {
    const html = buildDoc();
    if (html) downloadPrintableHtml(html, `diary-range-${vpState.rangeStart}-to-${vpState.rangeEnd}.html`);
  });
}

function mountPrintIndicesShell(container) {
  const allKnownYears = Array.from(
    new Set([
      ...loadPinnedDates().map((p) => p.year || p.isoDate.slice(0, 4)),
      ...loadHighlights().map((h) => h.year || h.isoDate.slice(0, 4)),
      ...collectAllKnownEntries().map((e) => e.year),
    ])
  ).sort((a, b) => b.localeCompare(a));

  container.innerHTML = `
    <div class="plug-card">
      <div class="plug-card-title"><span>1. Index Sections &amp; Layout</span></div>
      <div class="vp-checks-grid">
        <label class="vp-check"><input type="checkbox" id="vp-idx-pin" ${vpState.idxIncludePinned ? 'checked' : ''} /> Pinned Dates Index</label>
        <label class="vp-check"><input type="checkbox" id="vp-idx-hl" ${vpState.idxIncludeHighlights ? 'checked' : ''} /> Highlighted Passages</label>
        <label class="vp-check"><input type="checkbox" id="vp-idx-ent" ${vpState.idxIncludeEntries ? 'checked' : ''} /> Diary Entries Directory</label>
        <label class="vp-check"><input type="checkbox" id="vp-idx-tag" ${vpState.idxIncludeTags ? 'checked' : ''} /> #Tag Cross-Reference</label>
        <label class="vp-check"><input type="checkbox" id="vp-idx-exc" ${vpState.idxIncludeExcerpts ? 'checked' : ''} /> Include text excerpts</label>
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-size:0.8rem;color:var(--plug-muted);">Layout:</span>
          <select id="vp-idx-layout" class="plug-select" style="width:auto;padding:4px 8px;font-size:0.8rem;">
            <option value="section" ${vpState.idxLayout === 'section' ? 'selected' : ''}>Grouped by Section</option>
            <option value="year" ${vpState.idxLayout === 'year' ? 'selected' : ''}>Grouped by Year</option>
            <option value="timeline" ${vpState.idxLayout === 'timeline' ? 'selected' : ''}>Unified Timeline</option>
          </select>
        </div>
      </div>

      <div class="plug-grid-2" style="margin-top:10px;">
        <div><label class="bpt-field-label">Document Title</label><input type="text" id="vp-idx-title" class="plug-input" value="${esc(vpState.idxDocTitle)}" /></div>
        <div><label class="bpt-field-label">Print Font</label>
          <select id="vp-idx-font" class="plug-select">
            <option value="serif" ${vpState.idxFont === 'serif' ? 'selected' : ''}>Book Serif (Georgia)</option>
            <option value="sans" ${vpState.idxFont === 'sans' ? 'selected' : ''}>Clean Sans</option>
            <option value="mono" ${vpState.idxFont === 'mono' ? 'selected' : ''}>Typewriter Mono</option>
          </select>
        </div>
      </div>
    </div>

    <div class="plug-card">
      <div class="plug-card-title"><span>2. Optional Filters &amp; Ordering</span></div>
      <div class="plug-grid-3">
        <div><label class="bpt-field-label">Start Date</label><input type="date" id="vp-idx-start" class="plug-input" value="${esc(vpState.idxStart)}" /></div>
        <div><label class="bpt-field-label">End Date</label><input type="date" id="vp-idx-end" class="plug-input" value="${esc(vpState.idxEnd)}" /></div>
        <div><label class="bpt-field-label">Year</label>
          <select id="vp-idx-year" class="plug-select">
            <option value="all" ${vpState.idxYear === 'all' ? 'selected' : ''}>All Years</option>
            ${allKnownYears.map((y) => `<option value="${esc(y)}" ${vpState.idxYear === y ? 'selected' : ''}>${esc(y)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="plug-grid-2" style="margin-top:10px;">
        <div><label class="bpt-field-label">Keyword or #Tag Filter</label><input type="search" id="vp-idx-q" class="plug-input" placeholder="Filter titles, descriptions, quotes, or #tags..." value="${esc(vpState.idxQuery)}" /></div>
        <div><label class="bpt-field-label">Sort Order</label>
          <select id="vp-idx-sort" class="plug-select">
            <option value="oldest" ${vpState.idxSort === 'oldest' ? 'selected' : ''}>Chronological (Oldest → Newest)</option>
            <option value="newest" ${vpState.idxSort === 'newest' ? 'selected' : ''}>Reverse Chronological (Newest → Oldest)</option>
            <option value="title" ${vpState.idxSort === 'title' ? 'selected' : ''}>Alphabetical by Title</option>
          </select>
        </div>
      </div>
    </div>

    <div id="vp-idx-results"></div>
  `;

  container.querySelector('#vp-idx-pin').addEventListener('change', (e) => { vpState.idxIncludePinned = e.target.checked; updateIndicesResultsOnly(); });
  container.querySelector('#vp-idx-hl').addEventListener('change', (e) => { vpState.idxIncludeHighlights = e.target.checked; updateIndicesResultsOnly(); });
  container.querySelector('#vp-idx-ent').addEventListener('change', (e) => { vpState.idxIncludeEntries = e.target.checked; updateIndicesResultsOnly(); });
  container.querySelector('#vp-idx-tag').addEventListener('change', (e) => { vpState.idxIncludeTags = e.target.checked; updateIndicesResultsOnly(); });
  container.querySelector('#vp-idx-exc').addEventListener('change', (e) => { vpState.idxIncludeExcerpts = e.target.checked; });
  container.querySelector('#vp-idx-layout').addEventListener('change', (e) => { vpState.idxLayout = e.target.value; updateIndicesResultsOnly(); });
  container.querySelector('#vp-idx-title').addEventListener('input', (e) => { vpState.idxDocTitle = e.target.value; });
  container.querySelector('#vp-idx-font').addEventListener('change', (e) => {
    vpState.idxFont = e.target.value;
    savePrefs({ idxFont: vpState.idxFont });
  });
  container.querySelector('#vp-idx-start').addEventListener('change', (e) => { vpState.idxStart = e.target.value; updateIndicesResultsOnly(); });
  container.querySelector('#vp-idx-end').addEventListener('change', (e) => { vpState.idxEnd = e.target.value; updateIndicesResultsOnly(); });
  container.querySelector('#vp-idx-year').addEventListener('change', (e) => { vpState.idxYear = e.target.value; updateIndicesResultsOnly(); });
  container.querySelector('#vp-idx-sort').addEventListener('change', (e) => { vpState.idxSort = e.target.value; updateIndicesResultsOnly(); });
  container.querySelector('#vp-idx-q').addEventListener('input', (e) => { vpState.idxQuery = e.target.value; updateIndicesResultsOnly(); });

  updateIndicesResultsOnly();
}

function updateIndicesResultsOnly() {
  const host = document.getElementById('vp-idx-results');
  if (!host) return;

  const payload = getFilteredIndexPayload();
  const totalSelected =
    (vpState.idxIncludePinned ? payload.pinned.length : 0) +
    (vpState.idxIncludeHighlights ? payload.highlights.length : 0) +
    (vpState.idxIncludeEntries ? payload.entries.length : 0) +
    (vpState.idxIncludeTags ? payload.tags.length : 0);

  host.innerHTML = `
    <div class="plug-stat-strip" style="justify-content:space-between;align-items:center;">
      <div>
        Ready: <strong>${payload.pinned.length}</strong> Pinned ·
        <strong>${payload.highlights.length}</strong> Highlights ·
        <strong>${payload.entries.length}</strong> Entries ·
        <strong>${payload.tags.length}</strong> #Tags
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        <button type="button" id="vp-idx-dl-btn" class="plug-btn plug-btn-sm">Download HTML</button>
        <button type="button" id="vp-idx-print-btn" class="plug-btn plug-btn-primary plug-btn-sm">Print Index</button>
      </div>
    </div>

    ${
      totalSelected === 0
        ? `<div class="pdx-empty">No index items match your current selection or filter.</div>`
        : `<div class="plug-card" style="padding:12px;">
            <div class="plug-card-title" style="margin-bottom:6px;"><span>Included Preview</span></div>
            <div class="pdx-list">
              ${[...payload.pinned.slice(0, 3), ...payload.highlights.slice(0, 3)]
                .map(
                  (it) => `<div class="pdx-row" style="padding:7px 10px;">
                    <div class="pdx-row-top">
                      <span class="pdx-date-badge">${esc(it.isoDate)}${it.title ? ` · <span style="color:var(--plug-text);">${esc(it.title)}</span>` : ''}</span>
                      <span class="pdx-entry-num">${it.quote ? 'Highlight' : 'Pinned'}</span>
                    </div>
                    ${it.description ? `<p class="pdx-item-desc">${esc(it.description)}</p>` : ''}
                    ${it.quote ? `<p class="pdx-excerpt" style="font-style:italic;">“${esc(makeExcerpt(it.quote, 120))}”</p>` : ''}
                  </div>`
                )
                .join('') || '<p class="plug-subtitle" style="margin:0;">Will print Diary Entries Directory and/or #Tag Cross-Reference.</p>'}
            </div>
          </div>`
    }
  `;

  const buildDoc = () => {
    if (totalSelected === 0) { showToast('Nothing selected to print.'); return null; }
    const parts = [];
    if (vpState.idxStart || vpState.idxEnd) parts.push(`Range: ${vpState.idxStart || 'Start'} to ${vpState.idxEnd || 'Present'}`);
    if (vpState.idxYear !== 'all') parts.push(`Year: ${vpState.idxYear}`);
    if (vpState.idxQuery.trim()) parts.push(`Filter: "${vpState.idxQuery.trim()}"`);
    return buildIndicesPrintDocument(payload, {
      docTitle: vpState.idxDocTitle.trim() || 'Perpetual Diary — Master Index',
      layout: vpState.idxLayout,
      sort: vpState.idxSort,
      includePinned: vpState.idxIncludePinned,
      includeHighlights: vpState.idxIncludeHighlights,
      includeEntries: vpState.idxIncludeEntries,
      includeTags: vpState.idxIncludeTags,
      includeExcerpts: vpState.idxIncludeExcerpts,
      font: vpState.idxFont,
      filterSummary: parts.length ? parts.join(' · ') : 'Complete Diary Index',
    });
  };

  host.querySelector('#vp-idx-print-btn').addEventListener('click', () => {
    const html = buildDoc();
    if (html) sendHtmlToIframePrinter(html, `diary-index-${todayISO()}.html`);
  });
  host.querySelector('#vp-idx-dl-btn').addEventListener('click', () => {
    const html = buildDoc();
    if (html) downloadPrintableHtml(html, `diary-index-${todayISO()}.html`);
  });
}

/* ==========================================================================
   8. HEADER TRIGGERS (SELF-HEALING), INDEX BRIDGE & BOOTSTRAP
   ========================================================================== */

function injectPrintButtonIntoIndexModal() {
  const indexModal = document.getElementById('pdx-modal-backdrop');
  if (!indexModal || !indexModal.classList.contains('is-open')) return;
  const actions = indexModal.querySelector('.plug-header-actions');
  if (!actions || actions.querySelector('#vp-inline-print-idx')) return;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'vp-inline-print-idx';
  btn.className = 'plug-btn plug-btn-primary plug-btn-sm';
  btn.textContent = 'Print Index';
  btn.addEventListener('click', () => {
    const activeSearch = document.getElementById('pdx-search-input')?.value || '';
    const activeYear = document.getElementById('pdx-year-select')?.value || 'all';
    openPrintHubModal('indices', { idxQuery: activeSearch, idxYear: activeYear });
  });
  actions.insertBefore(btn, actions.firstChild);
}

function injectPrintStudioIntoDayBar() {
  const barRight = document.querySelector('#vp-inline-day-bar .vp-bar-right');
  if (!barRight || barRight.querySelector('#vp-bar-print-studio')) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'vp-bar-print-studio';
  btn.className = 'plug-btn plug-btn-sm';
  btn.textContent = 'Print Range';
  btn.title = 'Open Print Studio (Range of Days & Indices)';
  btn.addEventListener('click', () => openPrintHubModal('range'));
  const printDayBtn = barRight.querySelector('#vp-bar-print');
  if (printDayBtn && printDayBtn.nextSibling) {
    barRight.insertBefore(btn, printDayBtn.nextSibling);
  } else {
    barRight.appendChild(btn);
  }
}

function mountTriggers() {
  let dock = document.getElementById('plug-trigger-dock');
  if (!dock || !document.body.contains(dock)) {
    dock = document.createElement('div');
    dock.id = 'plug-trigger-dock';
    const headerTarget =
      document.querySelector('.header-actions, .topbar-actions, .nav-actions, header .actions, header .right') ||
      document.querySelector('header');
    if (headerTarget && headerTarget.offsetParent !== null) {
      dock.className = 'plug-dock-inline';
      headerTarget.appendChild(dock);
    } else {
      dock.className = 'plug-dock-floating';
      document.body.appendChild(dock);
    }
  }

  if (!dock.querySelector('#vp-day-trigger')) {
    const existingDay = document.getElementById('vp-day-trigger');
    if (existingDay) existingDay.remove();
    const dayBtn = document.createElement('button');
    dayBtn.type = 'button';
    dayBtn.id = 'vp-day-trigger';
    dayBtn.className = 'plug-trigger-btn';
    dayBtn.addEventListener('click', () => toggleIntegratedDayView());
    dock.appendChild(dayBtn);
  }

  if (!dock.querySelector('#vp-print-trigger')) {
    const existingPrint = document.getElementById('vp-print-trigger');
    if (existingPrint) existingPrint.remove();
    const printBtn = document.createElement('button');
    printBtn.type = 'button';
    printBtn.id = 'vp-print-trigger';
    printBtn.className = 'plug-trigger-btn';
    printBtn.textContent = 'Print';
    printBtn.title = 'Print Specific Range of Days or Indices (Alt+P)';
    printBtn.addEventListener('click', () => openPrintHubModal('range'));
    dock.appendChild(printBtn);
  }

  updateHeaderDayButtonState();
}

function bootViewerPrintAddon() {
  window.__VP_OPEN_PRINT__ = (tab = 'range') => openPrintHubModal(tab);

  mountTriggers();
  captureVisibleDOM();
  scanIndexedDBReadOnly();

  if (vpState.dayMode) {
    syncIntegratedDayView();
    injectPrintStudioIntoDayBar();
  }

  setTimeout(() => {
    mountTriggers();
    captureVisibleDOM();
    if (vpState.dayMode) {
      syncIntegratedDayView();
      injectPrintStudioIntoDayBar();
    }
  }, 450);

  let timer = null;
  const obs = new MutationObserver((muts) => {
    if (vpSyncingLayout) return;
    if (!document.getElementById('vp-print-trigger') || !document.getElementById('vp-day-trigger')) {
      mountTriggers();
    }
    injectPrintButtonIntoIndexModal();
    injectPrintStudioIntoDayBar();

    const relevant = muts.some(
      (m) => !m.target?.closest?.('.plug-backdrop, #pdx-sel-bar, #vp-inline-day-bar, #plug-toast')
    );
    if (!relevant) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      captureVisibleDOM();
      if (vpState.dayMode) {
        syncIntegratedDayView();
        injectPrintStudioIntoDayBar();
      }
    }, 180);
  });
  obs.observe(document.body, { childList: true, subtree: true });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closePrintModal();
      return;
    }
    if (e.altKey && !e.target.closest('input, textarea, select')) {
      if (e.key === 'd' || e.key === 'D') {
        e.preventDefault();
        toggleIntegratedDayView();
      } else if (e.key === 'p' || e.key === 'P') {
        e.preventDefault();
        openPrintHubModal('range');
      }
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootViewerPrintAddon);
} else {
  bootViewerPrintAddon();
}
