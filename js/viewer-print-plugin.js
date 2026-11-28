

/**
 * Perpetual Web Diary — Integrated Main-Page Day View & Print Studio (js/viewer-print-plugin.js)
 *
 *   1) Native Integrated Day View (Directly on the Main Page — Zero Separate Reader Modal)
 *      - Toggles the main page between Side-by-Side and focused single-column Day View
 *      - Uses the live decrypted DOM rendered by app.js, so entries NEVER go missing and
 *        Edit, Delete, Quote, Share, History, stacked entries & highlights all work natively
 *      - Inline toolbar right above the entry: Year switcher pills (auto-deduping pinned columns),
 *        Aa reading controls (Font, Size, Dark/Sepia/Paper surface, Clean/Full metadata pills),
 *        + Pin Day, Print Day, and Side-by-Side toggle
 *   2) Print Studio (Print Specific Range of Days + Print Indices)
 *      - Book-ready printing & direct .html download via iOS-safe hidden iframe
 *      - Printable Master Index (Pinned Dates, Highlights w/ Titles & Descriptions, Entries, #Tags)
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

const vpSessionCache = new Map();
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
    // ignore storage errors
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
  cleanRead: Boolean(savedPrefs.cleanRead), // optionally hides metadata pills for distraction-free reading
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
   1. UTILITIES & SAFE HTML
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

function normalizeForDedupe(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 90);
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
  }, 2600);
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
   3. LIVE MAIN-PAGE COLUMN DISCOVERY & CLEAN ENTRY EXTRACTION
   ========================================================================== */

function findAllMainColumns() {
  // Prefer direct .year-col cards; fallback to top-level [data-year] elements outside modals
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
  const header = col.querySelector('.year-header, .year-title, h2, h3');
  const m = (header?.textContent || '').match(/\b(19|20)\d{2}\b/);
  return m ? m[0] : null;
}

function extractExplicitIsoFromNode(node) {
  if (!node) return null;
  const attrDate = node.getAttribute?.('data-date') || node.getAttribute?.('data-iso') || '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(attrDate)) return attrDate;
  const dateEl = node.querySelector?.('.entry-date, .stacked-entry-date, .year-col-date, .entry-subheader, time');
  const txt = dateEl ? dateEl.textContent : (node.textContent || '').slice(0, 140);
  const m = (txt || '').match(/\b((?:19|20)\d{2}-\d{2}-\d{2})\b/);
  return m ? m[1] : null;
}

function detectCurrentDiaryMMDD() {
  // 1) Explicit YYYY-MM-DD inside any rendered column
  for (const col of findAllMainColumns()) {
    const iso = extractExplicitIsoFromNode(col);
    if (iso) return iso.slice(5);
  }
  // 2) Main page date input
  const dateInput = document.querySelector('#date-picker, #current-date-input, input[type="date"]');
  if (dateInput && !dateInput.closest('.plug-backdrop') && /^\d{4}-\d{2}-\d{2}$/.test(dateInput.value)) {
    return dateInput.value.slice(5);
  }
  // 3) Month / Day selects
  const monthSel = document.querySelector('#month-select, [data-role="month-select"]');
  const daySel = document.querySelector('#day-select, [data-role="day-select"]');
  if (monthSel && daySel && monthSel.value && daySel.value) {
    return `${String(Number(monthSel.value)).padStart(2, '0')}-${String(Number(daySel.value)).padStart(2, '0')}`;
  }
  // 4) Hash
  const hashMatch = (location.hash || '').match(/(\d{2}-\d{2})/);
  if (hashMatch) return hashMatch[1];
  // 5) Visible header text ("November 20")
  const headerText =
    document.querySelector('#current-date-title, #date-heading, .date-display, .current-date, h1, h2')
      ?.textContent || '';
  const months = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december',
  ];
  const hit = headerText.match(new RegExp(`\\b(${months.join('|')})\\s+(\\d{1,2})\\b`, 'i'));
  if (hit) {
    const mNum = months.indexOf(hit[1].toLowerCase()) + 1;
    const dNum = Number(hit[2]);
    if (mNum >= 1 && dNum >= 1 && dNum <= 31) {
      return `${String(mNum).padStart(2, '0')}-${String(dNum).padStart(2, '0')}`;
    }
  }
  return todayISO().slice(5);
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
    '.entry-body-content, .entry-body, .entry-content, .stacked-entry-body, .year-entry-body, .year-entry-content, .entry-text, .entry-prose, .prose, .markdown-body'
  );
  const clone = (bodyNode || card).cloneNode(true);
  clone
    .querySelectorAll(
      'button, nav, input, textarea, select, script, style, .entry-actions, .entry-toolbar, .entry-meta, .entry-header, .entry-subheader, .entry-date, .stacked-entry-date, .entry-pills, .entry-badges, .meta-pills, .pills, .badges, .tags-row, .tag-list, .entry-tags, .pill, .badge, .chip, .year-header, .year-col-header, .year-col-actions, .year-col-add-entry-bar, .stacked-entry-header, .stacked-entry-index, .margin-notes, .comments-section'
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
    rawText = rawText.replace(/^(?:19|20)\d{2}(?:-\d{2}-\d{2})?\s*\n+/g, '').trim();
  }

  // Ignore empty-state placeholder prompts inside empty year columns
  if (/^(no entry|nothing written|write an entry|add entry|click to write)/i.test(rawText) && rawText.length < 70) {
    rawText = '';
  }

  const title = (card.querySelector('.entry-title, .stacked-entry-title, h4')?.textContent || '').trim();
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

  let cards = Array.from(col.querySelectorAll('.stacked-entry-item'));
  if (!cards.length) cards = Array.from(col.querySelectorAll('.entry-card, .year-entry'));
  if (!cards.length) {
    const single = col.querySelector(
      '.entry-body-content, .entry-body, .entry-content, .year-entry-body, .entry-text, .prose'
    );
    if (single) cards = [single];
  }

  const out = [];
  const seen = new Set();
  cards.forEach((card) => {
    const parsed = extractCleanCardData(card);
    const norm = normalizeForDedupe(parsed.body);
    if (!parsed.body || !norm || seen.has(norm)) return;
    seen.add(norm);
    const isoDate = parsed.explicitIso || colIso || `${yr}-${fallbackMmdd}`;
    out.push({
      isoDate,
      year: isoDate.slice(0, 4),
      mmdd: isoDate.slice(5),
      title: parsed.title,
      text: parsed.body,
      words: countWords(parsed.body),
      tags: parsed.tags,
      pills: parsed.pills,
      timeStamp: parsed.timeStamp,
    });
  });

  return out.map((item, idx) => ({
    ...item,
    entryIndex: idx + 1,
    totalInYear: out.length,
  }));
}

function columnHasRealEntry(col) {
  const mmdd = detectCurrentDiaryMMDD();
  return extractEntriesFromColumn(col, mmdd).length > 0;
}

function captureVisibleDOM() {
  const fallbackMmdd = detectCurrentDiaryMMDD();
  if (!fallbackMmdd) return;

  const seenYears = new Set();
  findAllMainColumns().forEach((col) => {
    const yr = getColumnYear(col);
    if (!yr || seenYears.has(yr)) return;
    seenYears.add(yr);

    const items = extractEntriesFromColumn(col, fallbackMmdd);
    if (!items.length) return;

    const byIso = new Map();
    items.forEach((it) => {
      if (!byIso.has(it.isoDate)) byIso.set(it.isoDate, []);
      byIso.get(it.isoDate).push(it);
    });

    byIso.forEach((list, isoDate) => {
      Array.from(vpSessionCache.keys()).forEach((k) => {
        if (k.startsWith(`${isoDate}|`)) vpSessionCache.delete(k);
      });
      list.forEach((item, idx) => {
        vpSessionCache.set(`${isoDate}|${idx}`, {
          ...item,
          entryIndex: idx + 1,
          totalInYear: list.length,
        });
      });
    });
  });
}

function normalizeYearEntryList(yearVal) {
  if (!yearVal) return [];
  if (Array.isArray(yearVal)) return yearVal;
  if (Array.isArray(yearVal.entries)) return yearVal.entries;
  if (typeof yearVal === 'object' && (yearVal.body || yearVal.text || yearVal.content)) return [yearVal];
  if (typeof yearVal === 'string') return [{ body: yearVal }];
  return [];
}

function collectAllKnownEntries() {
  captureVisibleDOM();

  const metaMap = loadEntryMetaMap();
  const results = [];
  const seen = new Set();

  const pushEntry = (isoDate, year, mmdd, idx, totalInYear, raw) => {
    const text = String(raw.body || raw.text || raw.content || '').trim();
    const rawTitle = String(raw.title || '').trim();
    if (!text && !rawTitle) return;

    const norm = normalizeForDedupe(text || rawTitle);
    const dedupeKey = `${isoDate}|${norm}`;
    if (!norm || seen.has(dedupeKey)) return;
    seen.add(dedupeKey);

    const entryIndex = idx + 1;
    const metaKey = `${isoDate}|${entryIndex}`;
    const customMeta = metaMap[metaKey] || {};
    const title = customMeta.title || rawTitle;
    const description = customMeta.description || '';

    results.push({
      isoDate,
      year: String(year),
      mmdd,
      entryIndex,
      totalInYear,
      title,
      description,
      text: text || title,
      excerpt: makeExcerpt(text || title, 180),
      words: countWords(text),
      tags: extractTags(`${title} ${description} ${text}`, raw.tags || []),
      pills: Array.isArray(raw.pills) ? raw.pills : [],
      timeStamp: raw.timeStamp || raw.createdAt || '',
    });
  };

  vpSessionCache.forEach((item) => {
    pushEntry(item.isoDate, item.year, item.mmdd, item.entryIndex - 1, item.totalInYear, item);
  });

  const ingestDayObject = (mmdd, dayObj) => {
    if (!dayObj || typeof dayObj !== 'object' || dayObj.encrypted || dayObj.ct || !/^\d{2}-\d{2}$/.test(mmdd)) return;
    const yearsMap = dayObj.years && typeof dayObj.years === 'object' ? dayObj.years : dayObj;
    Object.keys(yearsMap).forEach((yr) => {
      if (!/^\d{4}$/.test(yr)) return;
      const list = normalizeYearEntryList(yearsMap[yr]);
      list.forEach((item, idx) => {
        if (item && !item.encrypted && !item.ct) {
          pushEntry(`${yr}-${mmdd}`, yr, mmdd, idx, list.length, item);
        }
      });
    });
  };

  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || VP_SKIP_KEYS.has(k)) continue;
    const rawStr = localStorage.getItem(k);
    if (!rawStr || rawStr[0] !== '{') continue;
    try {
      const parsed = JSON.parse(rawStr);
      if (!parsed || typeof parsed !== 'object' || parsed.encrypted || parsed.ct) continue;
      if (/^\d{2}-\d{2}$/.test(k)) {
        ingestDayObject(k, parsed);
      } else if (parsed.days && typeof parsed.days === 'object') {
        Object.keys(parsed.days).forEach((d) => ingestDayObject(d, parsed.days[d]));
      } else {
        Object.keys(parsed).forEach((subKey) => {
          if (/^\d{2}-\d{2}$/.test(subKey)) ingestDayObject(subKey, parsed[subKey]);
          if (/^\d{4}-\d{2}-\d{2}$/.test(subKey)) {
            const list = normalizeYearEntryList(parsed[subKey]);
            list.forEach((item, idx) => {
              if (item && !item.encrypted && !item.ct) {
                pushEntry(subKey, subKey.slice(0, 4), subKey.slice(5), idx, list.length, item);
              }
            });
          }
        });
      }
    } catch {
      // ignore non-JSON
    }
  }

  return results;
}

/* ==========================================================================
   4. INTEGRATED MAIN-PAGE DAY VIEW (LIVE DOM FOCUS MODE — ZERO MISSING ENTRIES)
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
  // Find common parent container holding the year columns
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
    // User may be on Archive, Heatmap, or Lock Screen — remove inline bar cleanly until reader is visible
    const strayBar = document.getElementById('vp-inline-day-bar');
    if (strayBar) strayBar.remove();
    return;
  }

  vpSyncingLayout = true;
  try {
    document.body.classList.add('vp-day-mode');
    document.body.classList.toggle('vp-clean-read', vpState.cleanRead);

    // Deduplicate columns by year (so pinned duplicate columns like two 2026 columns collapse to one)
    const uniqueEntries = [];
    const seenYears = new Set();
    allCols.forEach((col, idx) => {
      const yr = getColumnYear(col);
      if (!yr) {
        col.classList.add('vp-hidden-col');
        col.classList.remove('vp-focused-col');
        return;
      }
      const hasContent = columnHasRealEntry(col);
      if (seenYears.has(yr)) {
        // Hide duplicate pinned column of the same year
        col.classList.add('vp-hidden-col');
        col.classList.remove('vp-focused-col');
        return;
      }
      seenYears.add(yr);
      uniqueEntries.push({ yr, col, hasContent, idx });
    });

    if (!uniqueEntries.length) return;

    // Pick which year column to focus:
    // 1) User's selected year if present AND (has content OR no other year has content)
    // 2) Otherwise the first year that actually has an entry on this date
    // 3) Otherwise the first available year column
    let chosen = uniqueEntries.find((u) => u.yr === vpState.selectedYear);
    if (!chosen || (!chosen.hasContent && uniqueEntries.some((u) => u.hasContent))) {
      const firstPopulated = uniqueEntries.find((u) => u.hasContent);
      chosen = firstPopulated || uniqueEntries[0];
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
      if (u.col === chosen.col) {
        u.col.classList.add(...focusClasses);
      } else {
        u.col.classList.add('vp-hidden-col');
      }
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
        <span class="vp-bar-meta">${liveItems.length ? `${wordCount.toLocaleString()} words` : 'Empty day'}</span>
      </div>

      <div class="vp-bar-years" role="tablist" aria-label="Switch Year">
        ${uniqueEntries
          .map(
            (u) => `
          <button type="button" class="vp-yr-pill ${u.yr === chosen.yr ? 'is-active' : ''} ${u.hasContent ? 'has-entry' : 'is-empty'}" data-vp-yr="${esc(u.yr)}" title="${u.hasContent ? `${u.yr} has an entry` : `${u.yr} is empty`}">
            ${esc(u.yr)}${u.hasContent ? '<i class="vp-yr-dot"></i>' : ''}
          </button>`
          )
          .join('')}
      </div>

      <div class="vp-bar-right">
        <button type="button" class="plug-btn plug-btn-sm ${vpState.aaOpen ? 'plug-btn-primary' : ''}" id="vp-bar-aa" title="Reading appearance">Aa</button>
        <button type="button" class="plug-btn plug-btn-sm ${vpState.pinOpen ? 'plug-btn-primary' : ''}" id="vp-bar-pin" title="Pin this day to your Index">${dayPins.length ? `Pinned (${dayPins.length})` : '+ Pin'}</button>
        <button type="button" class="plug-btn plug-btn-sm" id="vp-bar-print" title="Print this day">Print Day</button>
        <button type="button" class="plug-btn plug-btn-sm" id="vp-bar-exit" title="Return to Side-by-Side view">Side-by-Side</button>
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
   5. RANGE-SAFE HIGHLIGHT RENDERER & iOS-SAFE PRINT ENGINE
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
    const iframe = document.createElement('iframe');
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
    const runPrint = () => {
      if (printed) return;
      printed = true;
      try {
        win.focus();
        win.print();
        setTimeout(() => iframe.remove(), 3500);
      } catch {
        iframe.remove();
        downloadPrintableHtml(html, fallbackFilename);
      }
    };
    iframe.addEventListener('load', () => setTimeout(runPrint, 120), { once: true });
    setTimeout(runPrint, 380);
  } catch {
    downloadPrintableHtml(html, fallbackFilename);
  }
}

function buildRangePrintDocument(daysGrouped, opts) {
  const fontCss = getFontStack(opts.font);
  const allHighlights = loadHighlights();
  const totalEntries = daysGrouped.reduce((acc, g) => acc + g.entries.length, 0);
  const totalWords = daysGrouped.reduce((acc, g) => acc + g.entries.reduce((s, e) => s + e.words, 0), 0);

  const tocHtml =
    opts.includeToc && daysGrouped.length > 1
      ? `<section class="toc">
          <h2>Table of Contents</h2>
          <ol>
            ${daysGrouped
              .map((g) => {
                const firstTitle = g.entries.find((e) => e.title)?.title || '';
                const words = g.entries.reduce((s, e) => s + e.words, 0);
                return `<li>
                  <span class="toc-date">${esc(g.isoDate)}</span>
                  <span class="toc-title">${esc(firstTitle || formatShortDate(g.isoDate))}</span>
                  <span class="toc-meta">${g.entries.length > 1 ? `${g.entries.length} entries · ` : ''}${words.toLocaleString()} words</span>
                </li>`;
              })
              .join('')}
          </ol>
        </section>`
      : '';

  const daysHtml = daysGrouped
    .map((g, dayIdx) => {
      const dayHl = opts.includeHighlights ? allHighlights.filter((h) => h.isoDate === g.isoDate) : [];
      const breakCls = opts.pageBreakPerDay && dayIdx > 0 ? ' day-break' : '';
      return `
        <article class="day-section${breakCls}">
          <header class="day-head">
            <h2>${esc(formatLongDate(g.isoDate))}</h2>
            <span class="day-iso">${esc(g.isoDate)}</span>
          </header>
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
        </article>`;
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
  body { font-family: ${fontCss}; color: #16181d; background: #ffffff; margin: 0; padding: 12px 18px; line-height: 1.65; font-size: 11.5pt; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .doc-header { border-bottom: 2px solid #16181d; padding-bottom: 10px; margin-bottom: 20px; }
  .doc-header h1 { margin: 0 0 4px; font-size: 19pt; letter-spacing: -0.01em; }
  .doc-meta { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 9pt; color: #525866; }
  .toc { margin: 0 0 24px; padding: 12px 16px; border: 1px solid #d1d5db; border-radius: 6px; page-break-after: always; }
  .toc h2 { margin: 0 0 10px; font-size: 13pt; }
  .toc ol { margin: 0; padding-left: 18px; }
  .toc li { display: flex; gap: 10px; align-items: baseline; padding: 3px 0; border-bottom: 1px dotted #e5e7eb; font-size: 10pt; }
  .toc-date { font-family: monospace; font-weight: 700; min-width: 84px; }
  .toc-title { flex: 1; }
  .toc-meta { font-family: sans-serif; font-size: 8.5pt; color: #6b7280; }
  .day-section { margin-bottom: 26px; }
  .day-break { page-break-before: always; }
  .day-head { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 1px solid #9ca3af; padding-bottom: 4px; margin-bottom: 12px; page-break-after: avoid; }
  .day-head h2 { margin: 0; font-size: 13.5pt; }
  .day-iso { font-family: monospace; font-size: 9.5pt; color: #4b5563; }
  .entry-block { margin-bottom: 16px; break-inside: avoid-page; }
  .entry-num { font-family: sans-serif; font-size: 8.5pt; font-weight: 700; color: #6b7280; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 4px; }
  .entry-title { margin: 0 0 4px; font-size: 12pt; }
  .entry-desc { margin: 0 0 8px; font-style: italic; color: #4b5563; font-size: 10pt; }
  .entry-prose p { margin: 0 0 10px; text-align: justify; }
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
              <div class="hl-head"><span class="mono">${esc(h.isoDate)}</span>${h.title ? `<strong>${esc(h.title)}</strong>` : ''}</div>
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
      <div class="tag-grid">
        ${payload.tags
          .map(
            ([tag, dates]) => `<div class="tag-card">
              <strong>#${esc(tag)}</strong> <span class="muted">(${dates.length})</span>
              <div class="tag-dates">${dates.map((d) => esc(d)).join(' · ')}</div>
            </div>`
          )
          .join('')}
      </div>
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
  body { font-family: ${fontCss}; color: #16181d; background: #ffffff; margin: 0; padding: 10px 16px; font-size: 10.5pt; line-height: 1.5; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  header { border-bottom: 2px solid #16181d; padding-bottom: 8px; margin-bottom: 18px; }
  h1 { margin: 0 0 3px; font-size: 18pt; }
  h2 { font-size: 13pt; margin: 18px 0 8px; border-bottom: 1px solid #9ca3af; padding-bottom: 3px; page-break-after: avoid; }
  .meta { font-family: sans-serif; font-size: 9pt; color: #525866; }
  .mono { font-family: monospace; font-size: 9.5pt; }
  .muted { color: #525866; font-size: 9.2pt; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 14px; }
  th, td { border: 1px solid #d1d5db; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { background: #f3f4f6; font-family: sans-serif; font-size: 9pt; font-weight: 700; }
  tr { break-inside: avoid; }
  .hl-card { border: 1px solid #e5e7eb; border-left: 4px solid #d99b1e; border-radius: 4px; padding: 8px 10px; margin-bottom: 8px; break-inside: avoid; }
  .hl-head { display: flex; gap: 10px; align-items: baseline; margin-bottom: 3px; }
  .hl-desc { margin: 0 0 4px; color: #4b5563; font-size: 9.5pt; }
  blockquote { margin: 2px 0 0; padding: 0; font-style: italic; }
  .tag-line { font-family: sans-serif; font-size: 8.5pt; color: #4b5563; margin-top: 3px; }
  .tag-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
  .tag-card { border: 1px solid #d1d5db; border-radius: 4px; padding: 7px 9px; break-inside: avoid; }
  .tag-dates { font-family: monospace; font-size: 8.5pt; color: #4b5563; margin-top: 3px; }
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
   6. NAVIGATION HELPERS FOR RANGE SCANNER & JUMP-TO-DAY
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

function navigateMainPageToMMDD(mmdd, fullIsoHint = '') {
  const [mNum, dNum] = mmdd.split('-').map(Number);

  const hmCell = document.querySelector(
    `[data-mmdd="${mmdd}"], [data-date="${mmdd}"], [data-day-key="${mmdd}"]`
  );
  if (hmCell) {
    hmCell.click();
    return true;
  }

  const monthSel = document.querySelector('#month-select, [data-role="month-select"]');
  const daySel = document.querySelector('#day-select, [data-role="day-select"]');
  if (monthSel && daySel) {
    if (setSelectOptionSmart(monthSel, mNum) || setSelectOptionSmart(daySel, dNum)) return true;
  }

  const dateInput = document.querySelector('#date-picker, #current-date-input, input[type="date"]');
  if (dateInput && !dateInput.closest('.plug-backdrop')) {
    dateInput.value = fullIsoHint || `${new Date().getFullYear()}-${mmdd}`;
    dateInput.dispatchEvent(new Event('input', { bubbles: true }));
    dateInput.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  location.hash = `#${mmdd}`;
  window.dispatchEvent(new HashChangeEvent('hashchange'));
  return true;
}

function getVisibleDOMSignature() {
  const cols = findAllMainColumns();
  return `${detectCurrentDiaryMMDD()}|${cols
    .map((c) => `${getColumnYear(c) || ''}:${(c.textContent || '').slice(0, 80)}`)
    .join('||')}`;
}

async function waitForMainRender(targetMmdd, prevSig, maxWaitMs = 1100) {
  const start = Date.now();
  let lastSig = prevSig;
  let changedAt = 0;

  while (Date.now() - start < maxWaitMs) {
    await sleep(90);
    const curSig = getVisibleDOMSignature();
    const curMmdd = detectCurrentDiaryMMDD();
    if (curSig !== lastSig) {
      lastSig = curSig;
      changedAt = Date.now();
    }
    if (curMmdd === targetMmdd && changedAt > 0 && Date.now() - changedAt >= 140) break;
    if (curMmdd === targetMmdd && Date.now() - start >= 420 && changedAt === 0) break;
  }
  captureVisibleDOM();
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

async function scanUnlockedVaultForRange() {
  const allDates = enumerateDatesBetween(vpState.rangeStart, vpState.rangeEnd, 370);
  if (!allDates.length) return showToast('Choose a valid Start and End date first.');

  const uniqueMmdds = Array.from(new Set(allDates.map((d) => d.slice(5))));
  if (uniqueMmdds.length > 45) {
    if (!confirm(`Scanning ${uniqueMmdds.length} calendar days will take ~${Math.round(uniqueMmdds.length * 0.45)}s. Continue?`)) {
      return;
    }
  }

  const originalMmdd = detectCurrentDiaryMMDD();
  vpScanCancelled = false;
  vpState.rangeScanning = true;
  updateRangeScanUI();

  for (let i = 0; i < uniqueMmdds.length; i++) {
    if (vpScanCancelled) break;
    const mmdd = uniqueMmdds[i];
    vpState.rangeScanProgress = `Scanning ${i + 1} / ${uniqueMmdds.length} (${mmdd})…`;
    updateRangeScanUI();
    const prevSig = getVisibleDOMSignature();
    navigateMainPageToMMDD(mmdd, `${vpState.rangeStart.slice(0, 4)}-${mmdd}`);
    await waitForMainRender(mmdd, prevSig, 1000);
    updateRangeResultsOnly();
  }

  if (originalMmdd) {
    const prevSig = getVisibleDOMSignature();
    navigateMainPageToMMDD(originalMmdd);
    await waitForMainRender(originalMmdd, prevSig, 900);
  }

  vpState.rangeScanning = false;
  vpState.rangeScanProgress = '';
  updateRangeScanUI();
  updateRangeResultsOnly();
  if (vpState.dayMode) syncIntegratedDayView();
  showToast(vpScanCancelled ? 'Range scan stopped' : 'Finished scanning date range');
}

function renderPrintHubShell() {
  const backdrop = ensureModal('vp-print-backdrop');
  backdrop.innerHTML = `
    <div class="plug-modal" role="dialog" aria-modal="true" aria-label="Print Studio">
      <div class="plug-header">
        <div class="plug-title-wrap">
          <h2>Print Studio — Date Ranges &amp; Indices</h2>
          <p class="plug-subtitle">Book-ready printing &amp; HTML export for specific date ranges and your Master Index</p>
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
        <div id="vp-r-scan-actions" style="display:flex;gap:6px;"></div>
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
    statusEl.textContent = 'Encrypted vault? Scan collects unvisited days in this range from your unlocked diary.';
    actEl.innerHTML = `<button type="button" id="vp-r-scan" class="plug-btn plug-btn-sm">Scan Unlocked Diary for Range</button>`;
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
                    <button type="button" class="plug-btn plug-btn-sm vp-open-day-btn" data-iso="${esc(g.isoDate)}">Open in Day View</button>
                  </div>
                </div>
                <p class="pdx-excerpt" style="margin-left:22px;">${esc(g.entries[0].excerpt)}</p>
              </div>`;
              })
              .join('')
          : `<div class="pdx-empty">No loaded entries found between <strong>${esc(vpState.rangeStart)}</strong> and <strong>${esc(vpState.rangeEnd)}</strong>. Browse those dates or click <strong>Scan Unlocked Diary for Range</strong> above.</div>`
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
   8. HEADER TRIGGERS, INDEX BRIDGE & LIVE OBSERVER BOOTSTRAP
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

function mountTriggers() {
  if (document.getElementById('vp-day-trigger')) return;

  let dock = document.getElementById('plug-trigger-dock');
  if (!dock) {
    dock = document.createElement('div');
    dock.id = 'plug-trigger-dock';
    const headerTarget =
      document.querySelector('.header-actions, .topbar-actions, .nav-actions, header .actions, header .right') ||
      document.querySelector('header');
    if (headerTarget) {
      dock.className = 'plug-dock-inline';
      headerTarget.appendChild(dock);
    } else {
      dock.className = 'plug-dock-floating';
      document.body.appendChild(dock);
    }
  }

  const dayBtn = document.createElement('button');
  dayBtn.type = 'button';
  dayBtn.id = 'vp-day-trigger';
  dayBtn.className = 'plug-trigger-btn';
  dayBtn.addEventListener('click', () => toggleIntegratedDayView());

  const printBtn = document.createElement('button');
  printBtn.type = 'button';
  printBtn.id = 'vp-print-trigger';
  printBtn.className = 'plug-trigger-btn';
  printBtn.textContent = 'Print';
  printBtn.title = 'Print Specific Range of Days or Indices';
  printBtn.addEventListener('click', () => openPrintHubModal('range'));

  dock.appendChild(dayBtn);
  dock.appendChild(printBtn);
  updateHeaderDayButtonState();
}

function bootViewerPrintAddon() {
  mountTriggers();
  captureVisibleDOM();
  if (vpState.dayMode) syncIntegratedDayView();
  setTimeout(() => {
    mountTriggers();
    if (vpState.dayMode) syncIntegratedDayView();
  }, 450);

  let timer = null;
  const obs = new MutationObserver((muts) => {
    if (vpSyncingLayout) return;
    injectPrintButtonIntoIndexModal();
    const relevant = muts.some(
      (m) => !m.target?.closest?.('.plug-backdrop, #pdx-sel-bar, #vp-inline-day-bar, #plug-toast')
    );
    if (!relevant) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      captureVisibleDOM();
      if (vpState.dayMode) syncIntegratedDayView();
    }, 180);
  });
  obs.observe(document.body, { childList: true, subtree: true });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closePrintModal();
      return;
    }
    if (e.altKey && (e.key === 'd' || e.key === 'D') && !e.target.closest('input, textarea, select')) {
      e.preventDefault();
      toggleIntegratedDayView();
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootViewerPrintAddon);
} else {
  bootViewerPrintAddon();
}

