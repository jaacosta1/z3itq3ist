


/**
 * Perpetual Web Diary — Perfected Drop-In Addon (js/viewer-print-plugin.js)
 *   1) One Day Viewer (.vp-day)
 *      - Focused single-day reading sheet (Serif / Sans / Mono, Compact / Normal / Large, Dark / Sepia / Paper themes)
 *      - Prev/Next calendar day + Prev/Next written day + Arrow keys + Mobile swipe + Same-day year switcher
 *      - Live text selection highlighting & quick day pinning right from the reader
 *      - Wait-for-render vault fetch so newly opened dates never show stale content
 *   2) Print Date Range (.vp-range)
 *      - Custom book title, date presets, keyword/#tag filter (zero focus loss on mobile/desktop)
 *      - Select All / None + per-day toggles + live word/entry totals
 *      - Safe unlocked-vault range scanner (waits for DOM settle, restores original date)
 *      - iOS-safe hidden iframe printing + direct Download .html button
 *   3) Print Indices (.vp-index)
 *      - Printable Master Index for Pinned Dates, Highlights (with Titles & Descriptions), Entries & #Tags
 *      - Layout modes: Grouped by Section, Grouped by Year, or Unified Chronological Timeline
 *      - Filter by date range, year, keyword/#tag, sort order, plus direct Print & Download .html
 *
 * Self-contained ES module. Requires zero edits to app.js, github.js, features.js, or bipolar-index-plugin.js.
 */

const VP_BOOKMARKS_KEY = 'pd_simple_index_bookmarks_v1';
const VP_HIGHLIGHTS_KEY = 'pd_simple_index_highlights_v1';
const VP_ENTRY_META_KEY = 'pd_simple_index_entry_meta_v1';
const VP_PREFS_KEY = 'pd_viewer_print_prefs_v1';
const VP_SKIP_KEYS = new Set([
  'pd_bipolar_tracker_v1',
  VP_BOOKMARKS_KEY,
  VP_HIGHLIGHTS_KEY,
  VP_ENTRY_META_KEY,
  VP_PREFS_KEY,
]);

const vpSessionCache = new Map(); // key: `${isoDate}|${idx}` -> entry
let vpScanCancelled = false;
let vpActiveDayRequestId = 0;

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
    const next = Object.assign(loadPrefs(), partial);
    localStorage.setItem(VP_PREFS_KEY, JSON.stringify(next));
  } catch {
    // ignore storage errors
  }
}

const savedPrefs = loadPrefs();

const vpState = {
  // One Day Viewer
  dayDate: todayISO(),
  dayFont: savedPrefs.dayFont || 'serif', // 'serif' | 'sans' | 'mono'
  daySize: savedPrefs.daySize || 'md', // 'sm' | 'md' | 'lg'
  dayTheme: savedPrefs.dayTheme || 'auto', // 'auto' | 'sepia' | 'paper'
  dayLoading: false,
  dayPinOpen: false,

  // Print Studio
  printTab: 'range', // 'range' | 'indices'

  // Range Print State
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
  }, 2800);
}

/* ==========================================================================
   2. SHARED STORAGE READERS & WRITERS (Synced with Entry & Highlight Index)
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

function saveHighlights(list) {
  localStorage.setItem(VP_HIGHLIGHTS_KEY, JSON.stringify(list));
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
   3. CLEAN DEDUPED DIARY SCANNER & RACE-FREE VAULT BRIDGE
   ========================================================================== */

function findPrimaryYearColumns() {
  let cols = Array.from(document.querySelectorAll('.year-col')).filter((el) => !el.closest('.plug-backdrop'));
  if (!cols.length) {
    cols = Array.from(document.querySelectorAll('[data-year]')).filter(
      (el) => !el.closest('.plug-backdrop') && !el.parentElement?.closest('[data-year]')
    );
  }
  return cols;
}

function getColumnYear(col) {
  const attr = col.getAttribute('data-year');
  if (attr && /^\d{4}$/.test(attr)) return attr;
  const header = col.querySelector('.year-header, .year-title, h2, h3');
  const m = (header?.textContent || '').match(/\b(19|20)\d{2}\b/);
  return m ? m[0] : null;
}

function detectCurrentDiaryMMDD() {
  const dateInput = document.querySelector('#date-picker, #current-date-input, input[type="date"]');
  if (dateInput && !dateInput.closest('.plug-backdrop') && /^\d{4}-\d{2}-\d{2}$/.test(dateInput.value)) {
    return dateInput.value.slice(5);
  }
  const monthSel = document.querySelector('#month-select, [data-role="month-select"]');
  const daySel = document.querySelector('#day-select, [data-role="day-select"]');
  if (monthSel && daySel && monthSel.value && daySel.value) {
    return `${String(Number(monthSel.value)).padStart(2, '0')}-${String(Number(daySel.value)).padStart(2, '0')}`;
  }
  for (const col of findPrimaryYearColumns()) {
    const m = (col.textContent || '').match(/\b(19|20)\d{2}-(\d{2}-\d{2})\b/);
    if (m) return m[2];
  }
  const hashMatch = (location.hash || '').match(/(\d{2}-\d{2})/);
  if (hashMatch) return hashMatch[1];

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

function extractExplicitIsoFromNode(node) {
  if (!node) return null;
  const attrDate = node.getAttribute?.('data-date') || node.getAttribute?.('data-iso') || '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(attrDate)) return attrDate;
  const dateEl = node.querySelector?.('.entry-date, .stacked-entry-date, .year-col-date, .entry-subheader, time');
  const txt = dateEl ? dateEl.textContent : (node.textContent || '').slice(0, 120);
  const m = (txt || '').match(/\b((?:19|20)\d{2}-\d{2}-\d{2})\b/);
  return m ? m[1] : null;
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

  // Guard against stray leading YYYY or YYYY-MM-DD line if fallback cloned a whole card
  if (!bodyNode) {
    rawText = rawText
      .replace(/^(?:19|20)\d{2}(?:-\d{2}-\d{2})?\s*\n+/g, '')
      .trim();
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

function getVisibleDOMSignature() {
  const cols = findPrimaryYearColumns();
  return `${detectCurrentDiaryMMDD()}|${cols
    .map((c) => `${getColumnYear(c) || ''}:${(c.textContent || '').slice(0, 80)}`)
    .join('||')}`;
}

function captureVisibleDOM() {
  const fallbackMmdd = detectCurrentDiaryMMDD();
  if (!fallbackMmdd) return;

  const seenYears = new Set();
  findPrimaryYearColumns().forEach((col) => {
    const yr = getColumnYear(col);
    if (!yr || seenYears.has(yr)) return; // prevents pinned duplicate year columns
    seenYears.add(yr);

    const colIso = extractExplicitIsoFromNode(col);
    let cards = Array.from(col.querySelectorAll('.stacked-entry-item'));
    if (!cards.length) cards = Array.from(col.querySelectorAll('.entry-card, .year-entry'));
    if (!cards.length) {
      const single = col.querySelector(
        '.entry-body-content, .entry-body, .entry-content, .year-entry-body, .entry-text, .prose'
      );
      if (single) cards = [single];
    }

    const groupedByIso = new Map();
    cards.forEach((card) => {
      const parsed = extractCleanCardData(card);
      const norm = normalizeForDedupe(parsed.body);
      if (!parsed.body || !norm) return;

      // Trust explicit YYYY-MM-DD inside the card/column over global date header to prevent cross-date contamination
      const isoDate = parsed.explicitIso || colIso || `${yr}-${fallbackMmdd}`;
      if (!groupedByIso.has(isoDate)) groupedByIso.set(isoDate, { norms: new Set(), items: [] });
      const bucket = groupedByIso.get(isoDate);
      if (bucket.norms.has(norm)) return;
      bucket.norms.add(norm);
      bucket.items.push(parsed);
    });

    groupedByIso.forEach((bucket, isoDate) => {
      if (!bucket.items.length) return;
      Array.from(vpSessionCache.keys()).forEach((k) => {
        if (k.startsWith(`${isoDate}|`)) vpSessionCache.delete(k);
      });
      bucket.items.forEach((item, idx) => {
        vpSessionCache.set(`${isoDate}|${idx}`, {
          isoDate,
          year: isoDate.slice(0, 4),
          mmdd: isoDate.slice(5),
          entryIndex: idx + 1,
          totalInYear: bucket.items.length,
          title: item.title,
          text: item.body,
          tags: item.tags,
          pills: item.pills,
          timeStamp: item.timeStamp,
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

  // 1) Session DOM cache (cleanest decrypted live entries)
  vpSessionCache.forEach((item) => {
    pushEntry(item.isoDate, item.year, item.mmdd, item.entryIndex - 1, item.totalInYear, item);
  });

  // 2) Plaintext / Sandbox localStorage records (skips encrypted envelopes)
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

function navigateUnderlyingDiaryToMMDD(mmdd, fullIsoHint = '') {
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

  location.hash = `#${mmdd}`;
  window.dispatchEvent(new HashChangeEvent('hashchange'));
  return true;
}

async function waitForDiaryDateRender(targetMmdd, prevSig, maxWaitMs = 1500) {
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

    // Settled once target date is active and DOM stopped mutating for >= 150ms
    if (curMmdd === targetMmdd && changedAt > 0 && Date.now() - changedAt >= 150) {
      break;
    }
    // If targetMmdd has no entries (DOM cleared or unchanged after 420ms), stop early
    if (curMmdd === targetMmdd && Date.now() - start >= 450 && changedAt === 0) {
      break;
    }
  }
  captureVisibleDOM();
}

async function fetchSingleDateIntoCache(isoDate) {
  const mmdd = isoDate.slice(5);
  const prevSig = getVisibleDOMSignature();
  if (detectCurrentDiaryMMDD() !== mmdd) {
    navigateUnderlyingDiaryToMMDD(mmdd, isoDate);
    await waitForDiaryDateRender(mmdd, prevSig, 1500);
  } else {
    captureVisibleDOM();
  }
}

/* ==========================================================================
   4. RANGE-SAFE HIGHLIGHT RENDERER (Zero HTML Corruption on Overlapping Quotes)
   ========================================================================== */

function formatEntryProseWithHighlights(rawText, dayHighlights = [], isPrint = false) {
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

  const renderParagraphSafe = (paraText) => {
    const lower = paraText.toLowerCase();
    const ranges = [];

    // Locate match spans on PLAIN text first so HTML attributes are never touched
    dayHighlights.forEach((h) => {
      const q = String(h.quote || '').trim();
      if (q.length < 2) return;
      let idx = lower.indexOf(q.toLowerCase());
      let len = q.length;

      // Also match quotes where line breaks were normalized to single spaces
      if (idx === -1 && /\s/.test(q)) {
        const flexPattern = q
          .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          .replace(/\s+/g, '\\s+');
        const m = new RegExp(flexPattern, 'i').exec(paraText);
        if (m) {
          idx = m.index;
          len = m[0].length;
        }
      }

      if (idx !== -1) {
        ranges.push({ start: idx, end: idx + len, hl: h });
      }
    });

    if (!ranges.length) {
      return `<p>${esc(paraText).replace(/\n/g, '<br/>')}</p>`;
    }

    // Sort by start offset and drop overlapping sub-ranges cleanly
    ranges.sort((a, b) => a.start - b.start || b.end - a.end);
    const nonOverlapping = [];
    let cursor = 0;
    ranges.forEach((r) => {
      if (r.start >= cursor) {
        nonOverlapping.push(r);
        cursor = r.end;
      }
    });

    let out = '';
    let pos = 0;
    nonOverlapping.forEach((r) => {
      if (r.start > pos) {
        out += esc(paraText.slice(pos, r.start)).replace(/\n/g, '<br/>');
      }
      const chunk = esc(paraText.slice(r.start, r.end)).replace(/\n/g, '<br/>');
      const color = r.hl.color || 'gold';
      if (isPrint) {
        const st = colorStyles[color] || colorStyles.gold;
        out += `<mark style="${st}padding:0 2px;border-radius:3px;">${chunk}</mark>`;
      } else {
        const tip = esc([r.hl.title, r.hl.description || r.hl.note].filter(Boolean).join(' — ') || 'Saved highlight');
        out += `<mark class="pdx-hl pdx-hl-${esc(color)}" title="${tip}">${chunk}</mark>`;
      }
      pos = r.end;
    });

    if (pos < paraText.length) {
      out += esc(paraText.slice(pos)).replace(/\n/g, '<br/>');
    }

    return `<p>${out}</p>`;
  };

  return paragraphs.map(renderParagraphSafe).join('');
}

/* ==========================================================================
   5. iOS-SAFE HIDDEN IFRAME PRINT ENGINE + DIRECT HTML DOWNLOAD
   ========================================================================== */

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
    // Off-screen 1x1 opacity:0 is more reliable on iOS Safari than 0x0 visibility:hidden
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
  const totalWords = daysGrouped.reduce(
    (acc, g) => acc + g.entries.reduce((s, e) => s + e.words, 0),
    0
  );

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
            .map((e) => {
              const prose = formatEntryProseWithHighlights(e.text, dayHl, true);
              return `
                <div class="entry-block">
                  ${g.entries.length > 1 ? `<div class="entry-num">Entry #${e.entryIndex} of ${g.entries.length}${e.timeStamp ? ` · ${esc(e.timeStamp)}` : ''}</div>` : ''}
                  ${opts.includeTitles && e.title ? `<h3 class="entry-title">${esc(e.title)}</h3>` : ''}
                  ${opts.includeTitles && e.description ? `<p class="entry-desc">${esc(e.description)}</p>` : ''}
                  <div class="entry-prose">${prose}</div>
                  ${
                    opts.includeMeta
                      ? `<div class="entry-foot">${e.words.toLocaleString()} words${
                          e.tags.length ? ` · ${e.tags.map((t) => `#${esc(t)}`).join(' ')}` : ''
                        }</div>`
                      : ''
                  }
                </div>`;
            })
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
  body {
    font-family: ${fontCss};
    color: #16181d;
    background: #ffffff;
    margin: 0;
    padding: 12px 18px;
    line-height: 1.65;
    font-size: 11.5pt;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
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
    <div class="doc-meta">
      ${esc(opts.subtitle)} · ${daysGrouped.length} ${daysGrouped.length === 1 ? 'day' : 'days'} · ${totalEntries} ${totalEntries === 1 ? 'entry' : 'entries'} · ${totalWords.toLocaleString()} words · Printed ${esc(todayISO())}
    </div>
  </header>
  ${tocHtml}
  ${daysHtml}
</body>
</html>`;
}

function buildIndicesPrintDocument(payload, opts) {
  const fontCss = getFontStack(opts.font);
  const colorMap = { gold: '#d99b1e', blue: '#3b82f6', green: '#10b981', pink: '#ec4899' };

  const renderUnifiedItems = (items) => `
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
    if (opts.includePinned) {
      payload.pinned.forEach((p) => unified.push({ ...p, kind: 'Pinned' }));
    }
    if (opts.includeHighlights) {
      payload.highlights.forEach((h) => unified.push({ ...h, kind: 'Highlight' }));
    }
    if (opts.includeEntries) {
      payload.entries.forEach((e) => unified.push({ ...e, kind: 'Entry' }));
    }

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
        .map((y) => `<section class="idx-sec"><h2>${esc(y)} (${byYear.get(y).length} items)</h2>${renderUnifiedItems(byYear.get(y))}</section>`)
        .join('');
    } else {
      bodySections = unified.length
        ? `<section class="idx-sec"><h2>Unified Index Timeline (${unified.length} items)</h2>${renderUnifiedItems(unified)}</section>`
        : '';
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
              <div class="hl-head">
                <span class="mono">${esc(h.isoDate)}</span>
                ${h.title ? `<strong>${esc(h.title)}</strong>` : ''}
              </div>
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
  body {
    font-family: ${fontCss};
    color: #16181d;
    background: #ffffff;
    margin: 0;
    padding: 10px 16px;
    font-size: 10.5pt;
    line-height: 1.5;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
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
   6. MODAL SHELL HELPERS
   ========================================================================== */

function ensureModal(id) {
  let backdrop = document.getElementById(id);
  if (!backdrop) {
    backdrop = document.createElement('div');
    backdrop.id = id;
    backdrop.className = 'plug-backdrop';
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeAllModals();
    });
    document.body.appendChild(backdrop);
  }
  return backdrop;
}

function closeAllModals() {
  vpScanCancelled = true;
  hideDaySelectionBar();
  document.querySelectorAll('.plug-backdrop.is-open').forEach((el) => el.classList.remove('is-open'));
}

/* ==========================================================================
   7. ONE DAY VIEWER MODAL (Selection Highlighting, Swipe, Written-Day Jumps)
   ========================================================================== */

let vpDaySelPending = null;

function hideDaySelectionBar() {
  const bar = document.getElementById('vp-day-sel-bar');
  if (bar) {
    bar.classList.remove('is-visible');
    bar.querySelector('#vp-sel-form')?.classList.remove('is-open');
  }
  vpDaySelPending = null;
}

function ensureDaySelectionBar() {
  let bar = document.getElementById('vp-day-sel-bar');
  if (bar) return bar;

  bar = document.createElement('div');
  bar.id = 'vp-day-sel-bar';
  bar.className = 'pdx-sel-bar vp-day-sel-bar';
  bar.style.zIndex = '10020';
  bar.innerHTML = `
    <div class="pdx-sel-bar-colors">
      <span style="font-weight:700;">Highlight:</span>
      <button type="button" class="pdx-color-dot" data-vp-color="gold" title="Gold" style="background:#f5c451;"></button>
      <button type="button" class="pdx-color-dot" data-vp-color="blue" title="Blue" style="background:#60a5fa;"></button>
      <button type="button" class="pdx-color-dot" data-vp-color="green" title="Green" style="background:#34d399;"></button>
      <button type="button" class="pdx-color-dot" data-vp-color="pink" title="Pink" style="background:#f472b6;"></button>
    </div>
    <div class="pdx-sel-bar-form" id="vp-sel-form">
      <input type="text" id="vp-sel-title" class="plug-input" style="padding:6px 8px;font-size:0.8rem;" placeholder="Highlight Title (optional)..." />
      <textarea id="vp-sel-desc" class="plug-textarea" style="min-height:46px;padding:6px 8px;font-size:0.8rem;" placeholder="Description or #tags (optional)..."></textarea>
      <div style="display:flex;justify-content:flex-end;gap:6px;">
        <button type="button" id="vp-sel-cancel" class="plug-btn plug-btn-sm">Cancel</button>
        <button type="button" id="vp-sel-save" class="plug-btn plug-btn-primary plug-btn-sm">Save Highlight</button>
      </div>
    </div>
  `;
  document.body.appendChild(bar);

  let chosenColor = 'gold';
  const form = bar.querySelector('#vp-sel-form');
  const titleEl = bar.querySelector('#vp-sel-title');
  const descEl = bar.querySelector('#vp-sel-desc');

  bar.querySelectorAll('[data-vp-color]').forEach((btn) => {
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      if (!vpDaySelPending) return;
      chosenColor = btn.getAttribute('data-vp-color') || 'gold';
      form.classList.add('is-open');
      titleEl.focus();
    });
  });

  bar.querySelector('#vp-sel-cancel').addEventListener('click', () => {
    window.getSelection()?.removeAllRanges();
    hideDaySelectionBar();
  });

  const saveHl = () => {
    if (!vpDaySelPending) return;
    const title = titleEl.value.trim();
    const description = descEl.value.trim();
    const list = loadHighlights();
    list.unshift({
      id: `hl_${Date.now()}`,
      isoDate: vpDaySelPending.isoDate,
      year: vpDaySelPending.isoDate.slice(0, 4),
      mmdd: vpDaySelPending.isoDate.slice(5),
      quote: vpDaySelPending.quote,
      color: chosenColor,
      title,
      description,
      tags: extractTags(`${title} ${description} ${vpDaySelPending.quote}`),
      createdAt: new Date().toISOString(),
    });
    saveHighlights(list);
    titleEl.value = '';
    descEl.value = '';
    window.getSelection()?.removeAllRanges();
    hideDaySelectionBar();
    renderOneDayViewer();
    showToast(title ? `Highlighted: ${title}` : 'Highlight saved to Index');
  };

  bar.querySelector('#vp-sel-save').addEventListener('click', saveHl);
  titleEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveHl();
    }
  });

  return bar;
}

function inspectOneDaySelection() {
  const dayBackdrop = document.getElementById('vp-day-backdrop');
  if (!dayBackdrop || !dayBackdrop.classList.contains('is-open')) return;
  const bar = ensureDaySelectionBar();
  if (bar.querySelector('#vp-sel-form')?.classList.contains('is-open')) return;

  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return hideDaySelectionBar();
  const quote = sel.toString().replace(/\s+/g, ' ').trim();
  if (quote.length < 3 || quote.length > 500) return hideDaySelectionBar();

  const anchorEl = sel.anchorNode?.nodeType === 1 ? sel.anchorNode : sel.anchorNode?.parentElement;
  if (!anchorEl || !anchorEl.closest('.vp-day-prose')) return hideDaySelectionBar();

  const rect = sel.getRangeAt(0).getBoundingClientRect();
  if (!rect.width && !rect.height) return hideDaySelectionBar();

  vpDaySelPending = { isoDate: vpState.dayDate, quote };
  const left = Math.max(12, Math.min(window.innerWidth - 332, rect.left + rect.width / 2 - 110));
  const top = Math.max(12, Math.min(window.innerHeight - 210, rect.top - 52));
  bar.style.left = `${left}px`;
  bar.style.top = `${top}px`;
  bar.classList.add('is-visible');
}

async function openOneDayViewer(initialIso = null) {
  closeAllModals();
  vpState.dayPinOpen = false;
  if (initialIso && /^\d{4}-\d{2}-\d{2}$/.test(initialIso)) {
    vpState.dayDate = initialIso;
  } else {
    const activeMmdd = detectCurrentDiaryMMDD();
    const cols = findPrimaryYearColumns();
    const firstYr = cols.length ? getColumnYear(cols[0]) : String(new Date().getFullYear());
    vpState.dayDate = `${firstYr || new Date().getFullYear()}-${activeMmdd}`;
  }

  const backdrop = ensureModal('vp-day-backdrop');
  backdrop.classList.add('is-open');
  renderOneDayViewer();

  const reqId = ++vpActiveDayRequestId;
  const existing = collectAllKnownEntries().filter((e) => e.isoDate === vpState.dayDate);
  if (!existing.length) {
    vpState.dayLoading = true;
    renderOneDayViewer();
    await fetchSingleDateIntoCache(vpState.dayDate);
    if (reqId !== vpActiveDayRequestId) return;
    vpState.dayLoading = false;
    renderOneDayViewer();
  }
}

async function switchOneDayViewerDate(newIso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(newIso)) return;
  hideDaySelectionBar();
  vpState.dayPinOpen = false;
  vpState.dayDate = newIso;
  const reqId = ++vpActiveDayRequestId;
  const known = collectAllKnownEntries().filter((e) => e.isoDate === newIso);
  if (!known.length) {
    vpState.dayLoading = true;
    renderOneDayViewer();
    await fetchSingleDateIntoCache(newIso);
    if (reqId !== vpActiveDayRequestId) return;
    vpState.dayLoading = false;
  }
  renderOneDayViewer();
}

function renderOneDayViewer() {
  const backdrop = ensureModal('vp-day-backdrop');
  const iso = vpState.dayDate;
  const allEntries = collectAllKnownEntries();
  const dayEntries = allEntries
    .filter((e) => e.isoDate === iso)
    .sort((a, b) => a.entryIndex - b.entryIndex);

  const dayHighlights = loadHighlights().filter((h) => h.isoDate === iso);
  const dayPins = loadPinnedDates().filter((p) => p.isoDate === iso);
  const totalWords = dayEntries.reduce((sum, e) => sum + e.words, 0);

  // Known written dates sorted chronologically for Prev/Next Written Day jumps
  const writtenDates = Array.from(new Set(allEntries.map((e) => e.isoDate))).sort();
  const prevWritten = [...writtenDates].reverse().find((d) => d < iso) || null;
  const nextWritten = writtenDates.find((d) => d > iso) || null;

  const sameMmddYears = Array.from(
    new Set(allEntries.filter((e) => e.mmdd === iso.slice(5)).map((e) => e.year))
  ).sort((a, b) => b.localeCompare(a));

  const sheetClass = `vp-day-sheet vp-font-${vpState.dayFont} vp-size-${vpState.daySize} vp-theme-${vpState.dayTheme}`;

  const pinQuickFormHtml = vpState.dayPinOpen
    ? `<div class="vp-quick-pin-box">
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px;">
          <input type="text" id="vp-qpin-title" class="plug-input" style="flex:1 1 180px;" placeholder="Index Title for ${esc(iso)}..." />
          <button type="button" id="vp-qpin-save" class="plug-btn plug-btn-primary plug-btn-sm">Save Pin</button>
          <button type="button" id="vp-qpin-cancel" class="plug-btn plug-btn-sm">Cancel</button>
        </div>
        <textarea id="vp-qpin-desc" class="plug-textarea" style="min-height:48px;" placeholder="Description or #tags (optional)..."></textarea>
      </div>`
    : '';

  const entriesBodyHtml = vpState.dayLoading
    ? `<div class="pdx-empty">Loading ${esc(formatShortDate(iso))} from unlocked diary…</div>`
    : dayEntries.length
    ? dayEntries
        .map(
          (e) => `
        <article class="vp-day-entry">
          <div class="vp-day-entry-meta">
            ${dayEntries.length > 1 ? `<span class="pdx-entry-num">Entry #${e.entryIndex} of ${dayEntries.length}</span>` : ''}
            ${e.timeStamp ? `<span>${esc(e.timeStamp)}</span>` : ''}
            <span>${e.words.toLocaleString()} words</span>
            ${e.pills.slice(0, 6).map((p) => `<span class="vp-pill">${esc(p)}</span>`).join('')}
          </div>
          ${e.title ? `<h3 class="vp-day-entry-title">${esc(e.title)}</h3>` : ''}
          ${e.description ? `<p class="vp-day-entry-desc">${esc(e.description)}</p>` : ''}
          <div class="vp-day-prose">
            ${formatEntryProseWithHighlights(e.text, dayHighlights, false)}
          </div>
          ${
            e.tags.length
              ? `<div class="vp-day-tags">${e.tags.map((t) => `<span class="pdx-tag-chip">#${esc(t)}</span>`).join('')}</div>`
              : ''
          }
        </article>`
        )
        .join('')
    : `<div class="pdx-empty">
        <p style="margin:0 0 10px;">No entry found for <strong>${esc(formatLongDate(iso))}</strong>.</p>
        <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;">
          <button type="button" class="plug-btn plug-btn-sm" id="vp-day-reload">Fetch ${esc(iso.slice(5))} from Live Diary</button>
          ${prevWritten ? `<button type="button" class="plug-btn plug-btn-sm vp-jump-written" data-iso="${esc(prevWritten)}">← ${esc(prevWritten)}</button>` : ''}
          ${nextWritten ? `<button type="button" class="plug-btn plug-btn-sm vp-jump-written" data-iso="${esc(nextWritten)}">${esc(nextWritten)} →</button>` : ''}
        </div>
      </div>`;

  const sideNotesHtml =
    dayPins.length || dayHighlights.length
      ? `<div class="vp-day-notes">
          ${
            dayPins.length
              ? `<div class="vp-note-group">
                  <h4>Pinned Index Notes (${dayPins.length})</h4>
                  ${dayPins
                    .map(
                      (p) => `<div class="vp-note-item">
                        <strong>${esc(p.title)}</strong>
                        ${p.description ? `<p>${esc(p.description)}</p>` : ''}
                      </div>`
                    )
                    .join('')}
                </div>`
              : ''
          }
          ${
            dayHighlights.length
              ? `<div class="vp-note-group">
                  <h4>Saved Highlights (${dayHighlights.length})</h4>
                  ${dayHighlights
                    .map((h) => {
                      const hex = { gold: '#f5c451', blue: '#60a5fa', green: '#34d399', pink: '#f472b6' }[h.color || 'gold'];
                      return `<div class="vp-note-item" style="border-left:3px solid ${hex};padding-left:10px;">
                        ${h.title ? `<strong>${esc(h.title)}</strong>` : ''}
                        ${h.description ? `<p style="margin:2px 0;">${esc(h.description)}</p>` : ''}
                        <div style="font-style:italic;opacity:0.92;">“${esc(h.quote)}”</div>
                      </div>`;
                    })
                    .join('')}
                </div>`
              : ''
          }
        </div>`
      : '';

  backdrop.innerHTML = `
    <div class="plug-modal vp-day-modal" role="dialog" aria-modal="true" aria-label="One Day Viewer">
      <div class="plug-header">
        <div class="plug-title-wrap">
          <h2>One Day Viewer</h2>
          <p class="plug-subtitle">${esc(formatLongDate(iso))} · ${dayEntries.length} ${dayEntries.length === 1 ? 'entry' : 'entries'} · ${totalWords.toLocaleString()} words</p>
        </div>
        <div class="plug-header-actions">
          <button type="button" class="plug-btn plug-btn-sm" id="vp-day-pin-toggle">${vpState.dayPinOpen ? 'Close Pin' : '+ Pin Day'}</button>
          <button type="button" class="plug-btn plug-btn-sm" id="vp-day-open-main" title="Open in Side-by-Side view">Side-by-Side</button>
          <button type="button" class="plug-btn plug-btn-primary plug-btn-sm" id="vp-day-print">Print Day</button>
          <button type="button" class="plug-btn plug-btn-sm" id="vp-day-close">Close</button>
        </div>
      </div>

      <div class="vp-day-controls">
        <div class="vp-day-nav">
          ${prevWritten ? `<button type="button" class="plug-btn plug-btn-sm vp-jump-written" data-iso="${esc(prevWritten)}" title="Previous written day (${esc(prevWritten)})">⟪</button>` : ''}
          <button type="button" class="plug-btn plug-btn-sm" id="vp-day-prev" title="Previous calendar day (←)">←</button>
          <input type="date" id="vp-day-picker" class="plug-input" style="width:auto;padding:5px 8px;" value="${esc(iso)}" />
          <button type="button" class="plug-btn plug-btn-sm" id="vp-day-next" title="Next calendar day (→)">→</button>
          ${nextWritten ? `<button type="button" class="plug-btn plug-btn-sm vp-jump-written" data-iso="${esc(nextWritten)}" title="Next written day (${esc(nextWritten)})">⟫</button>` : ''}
          <button type="button" class="plug-btn plug-btn-sm" id="vp-day-today">Today</button>
        </div>

        <div class="vp-day-typo">
          ${
            sameMmddYears.length > 1
              ? `<div class="vp-year-pills">
                  ${sameMmddYears
                    .map(
                      (y) =>
                        `<button type="button" class="plug-btn plug-btn-sm ${y === iso.slice(0, 4) ? 'plug-btn-primary' : ''} vp-day-yr-btn" data-yr="${esc(y)}">${esc(y)}</button>`
                    )
                    .join('')}
                </div>`
              : ''
          }
          <select id="vp-day-theme" class="plug-select" style="width:auto;padding:4px 8px;font-size:0.78rem;" title="Reading surface">
            <option value="auto" ${vpState.dayTheme === 'auto' ? 'selected' : ''}>Dark Theme</option>
            <option value="sepia" ${vpState.dayTheme === 'sepia' ? 'selected' : ''}>Warm Sepia</option>
            <option value="paper" ${vpState.dayTheme === 'paper' ? 'selected' : ''}>Crisp Paper</option>
          </select>
          <select id="vp-day-font" class="plug-select" style="width:auto;padding:4px 8px;font-size:0.78rem;">
            <option value="serif" ${vpState.dayFont === 'serif' ? 'selected' : ''}>Serif</option>
            <option value="sans" ${vpState.dayFont === 'sans' ? 'selected' : ''}>Sans</option>
            <option value="mono" ${vpState.dayFont === 'mono' ? 'selected' : ''}>Mono</option>
          </select>
          <select id="vp-day-size" class="plug-select" style="width:auto;padding:4px 8px;font-size:0.78rem;">
            <option value="sm" ${vpState.daySize === 'sm' ? 'selected' : ''}>Small</option>
            <option value="md" ${vpState.daySize === 'md' ? 'selected' : ''}>Normal</option>
            <option value="lg" ${vpState.daySize === 'lg' ? 'selected' : ''}>Large</option>
          </select>
        </div>
      </div>

      <div class="plug-body" id="vp-day-scroll-body">
        ${pinQuickFormHtml}
        <div class="${sheetClass}">
          <div class="vp-day-banner">
            <h1>${esc(formatLongDate(iso))}</h1>
            <span>${esc(iso)}</span>
          </div>
          ${entriesBodyHtml}
          ${sideNotesHtml}
          ${dayEntries.length ? `<div class="vp-day-hint">Tip: Select any passage above to highlight it directly into your Index.</div>` : ''}
        </div>
      </div>
    </div>
  `;

  backdrop.querySelector('#vp-day-close').addEventListener('click', closeAllModals);
  backdrop.querySelector('#vp-day-prev').addEventListener('click', () => switchOneDayViewerDate(shiftISO(iso, -1)));
  backdrop.querySelector('#vp-day-next').addEventListener('click', () => switchOneDayViewerDate(shiftISO(iso, 1)));
  backdrop.querySelector('#vp-day-today').addEventListener('click', () => switchOneDayViewerDate(todayISO()));
  backdrop.querySelector('#vp-day-picker').addEventListener('change', (e) => {
    if (e.target.value) switchOneDayViewerDate(e.target.value);
  });

  backdrop.querySelector('#vp-day-theme').addEventListener('change', (e) => {
    vpState.dayTheme = e.target.value;
    savePrefs({ dayTheme: vpState.dayTheme });
    renderOneDayViewer();
  });
  backdrop.querySelector('#vp-day-font').addEventListener('change', (e) => {
    vpState.dayFont = e.target.value;
    savePrefs({ dayFont: vpState.dayFont });
    renderOneDayViewer();
  });
  backdrop.querySelector('#vp-day-size').addEventListener('change', (e) => {
    vpState.daySize = e.target.value;
    savePrefs({ daySize: vpState.daySize });
    renderOneDayViewer();
  });

  backdrop.querySelector('#vp-day-pin-toggle').addEventListener('click', () => {
    vpState.dayPinOpen = !vpState.dayPinOpen;
    renderOneDayViewer();
    if (vpState.dayPinOpen) backdrop.querySelector('#vp-qpin-title')?.focus();
  });

  if (vpState.dayPinOpen) {
    backdrop.querySelector('#vp-qpin-cancel').addEventListener('click', () => {
      vpState.dayPinOpen = false;
      renderOneDayViewer();
    });
    const savePin = () => {
      const title = backdrop.querySelector('#vp-qpin-title').value.trim();
      const description = backdrop.querySelector('#vp-qpin-desc').value.trim();
      if (!title) return showToast('Enter a title for this pinned date.');
      const list = loadPinnedDates();
      list.unshift({
        id: `pin_${Date.now()}`,
        isoDate: iso,
        year: iso.slice(0, 4),
        mmdd: iso.slice(5),
        title,
        description,
        tags: extractTags(`${title} ${description}`),
        createdAt: new Date().toISOString(),
      });
      savePinnedDates(list);
      vpState.dayPinOpen = false;
      showToast(`Pinned "${title}" (${iso})`);
      renderOneDayViewer();
    };
    backdrop.querySelector('#vp-qpin-save').addEventListener('click', savePin);
    backdrop.querySelector('#vp-qpin-title').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        savePin();
      }
    });
  }

  backdrop.querySelectorAll('.vp-day-yr-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchOneDayViewerDate(`${btn.getAttribute('data-yr')}-${iso.slice(5)}`));
  });

  backdrop.querySelectorAll('.vp-jump-written').forEach((btn) => {
    btn.addEventListener('click', () => switchOneDayViewerDate(btn.getAttribute('data-iso')));
  });

  backdrop.querySelector('#vp-day-open-main').addEventListener('click', () => {
    navigateUnderlyingDiaryToMMDD(iso.slice(5), iso);
    closeAllModals();
    showToast(`Opened ${formatShortDate(iso)} in Side-by-Side view`);
  });

  backdrop.querySelector('#vp-day-print').addEventListener('click', () => {
    if (!dayEntries.length) return showToast('Nothing to print for this day yet.');
    const html = buildRangePrintDocument([{ isoDate: iso, entries: dayEntries }], {
      docTitle: formatLongDate(iso),
      subtitle: `Single-Day Reading Sheet (${iso})`,
      font: vpState.dayFont,
      includeTitles: true,
      includeHighlights: true,
      includeMeta: true,
      pageBreakPerDay: false,
      includeToc: false,
    });
    sendHtmlToIframePrinter(html, `diary-${iso}.html`);
  });

  const reloadBtn = backdrop.querySelector('#vp-day-reload');
  if (reloadBtn) {
    reloadBtn.addEventListener('click', async () => {
      const reqId = ++vpActiveDayRequestId;
      vpState.dayLoading = true;
      renderOneDayViewer();
      await fetchSingleDateIntoCache(iso);
      if (reqId !== vpActiveDayRequestId) return;
      vpState.dayLoading = false;
      renderOneDayViewer();
    });
  }

  // Mobile horizontal swipe left/right to flip days (ignored when text is selected)
  const scrollBody = backdrop.querySelector('#vp-day-scroll-body');
  let touchX = 0;
  let touchY = 0;
  scrollBody.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length !== 1) return;
      touchX = e.touches[0].clientX;
      touchY = e.touches[0].clientY;
    },
    { passive: true }
  );
  scrollBody.addEventListener(
    'touchend',
    (e) => {
      if (e.changedTouches.length !== 1) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      const dx = e.changedTouches[0].clientX - touchX;
      const dy = e.changedTouches[0].clientY - touchY;
      if (Math.abs(dx) > 78 && Math.abs(dy) < 42) {
        switchOneDayViewerDate(shiftISO(iso, dx < 0 ? 1 : -1));
      }
    },
    { passive: true }
  );
}

/* ==========================================================================
   8. PRINT STUDIO MODAL (ZERO INPUT FOCUS LOSS · RANGE + INDICES)
   ========================================================================== */

function openPrintHubModal(defaultTab = 'range', prefill = null) {
  closeAllModals();
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

  const matchesFilters = (item) => {
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
    .filter(matchesFilters)
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
    .filter(matchesFilters)
    .sort(sortFn);

  const entries = collectAllKnownEntries().filter(matchesFilters).sort(sortFn);

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
    if (
      !confirm(
        `Scanning ${uniqueMmdds.length} calendar days from your unlocked diary will take ~${Math.round(
          uniqueMmdds.length * 0.45
        )} seconds. Continue?`
      )
    ) {
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
    navigateUnderlyingDiaryToMMDD(mmdd, `${vpState.rangeStart.slice(0, 4)}-${mmdd}`);
    await waitForDiaryDateRender(mmdd, prevSig, 1000);
    updateRangeResultsOnly();
  }

  if (originalMmdd) {
    const prevSig = getVisibleDOMSignature();
    navigateUnderlyingDiaryToMMDD(originalMmdd);
    await waitForDiaryDateRender(originalMmdd, prevSig, 900);
  }

  vpState.rangeScanning = false;
  vpState.rangeScanProgress = '';
  updateRangeScanUI();
  updateRangeResultsOnly();
  showToast(vpScanCancelled ? 'Range scan stopped' : 'Finished scanning date range');
}

function renderPrintHubShell() {
  const backdrop = ensureModal('vp-print-backdrop');
  backdrop.innerHTML = `
    <div class="plug-modal" role="dialog" aria-modal="true" aria-label="Print Studio">
      <div class="plug-header">
        <div class="plug-title-wrap">
          <h2>Print Studio — Date Ranges &amp; Indices</h2>
          <p class="plug-subtitle">Book-ready printing and HTML export for specific date ranges and your Master Index</p>
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

  backdrop.querySelector('#vp-print-close').addEventListener('click', closeAllModals);
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
  if (vpState.printTab === 'range') {
    mountPrintRangeShell(body);
  } else {
    mountPrintIndicesShell(body);
  }
}

/* --- TAB A: PRINT DATE RANGE (Static controls + dynamic results) --- */

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
        <div>
          <label class="bpt-field-label">Start Date</label>
          <input type="date" id="vp-r-start" class="plug-input" value="${esc(vpState.rangeStart)}" />
        </div>
        <div>
          <label class="bpt-field-label">End Date</label>
          <input type="date" id="vp-r-end" class="plug-input" value="${esc(vpState.rangeEnd)}" />
        </div>
        <div>
          <label class="bpt-field-label">Optional #Tag or Keyword</label>
          <input type="search" id="vp-r-filter" class="plug-input" placeholder="Leave blank for all entries" value="${esc(vpState.rangeFilter)}" />
        </div>
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

  container.querySelector('#vp-r-start').addEventListener('change', (e) => {
    vpState.rangeStart = e.target.value;
    updateRangeResultsOnly();
  });
  container.querySelector('#vp-r-end').addEventListener('change', (e) => {
    vpState.rangeEnd = e.target.value;
    updateRangeResultsOnly();
  });
  container.querySelector('#vp-r-filter').addEventListener('input', (e) => {
    vpState.rangeFilter = e.target.value;
    updateRangeResultsOnly();
  });
  container.querySelector('#vp-r-title').addEventListener('input', (e) => {
    vpState.rangeDocTitle = e.target.value;
  });

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
    actEl.querySelector('#vp-r-stop').addEventListener('click', () => {
      vpScanCancelled = true;
    });
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
      <div>
        <strong>${included.length}</strong> of ${groups.length} days ·
        <strong>${entriesCount}</strong> entries ·
        <strong>${wordsCount.toLocaleString()}</strong> words
      </div>
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
                    <button type="button" class="plug-btn plug-btn-sm vp-preview-day-btn" data-iso="${esc(g.isoDate)}">View Day</button>
                  </div>
                </div>
                <p class="pdx-excerpt" style="margin-left:22px;">${esc(g.entries[0].excerpt)}</p>
              </div>`;
              })
              .join('')
          : `<div class="pdx-empty">No loaded entries found between <strong>${esc(vpState.rangeStart)}</strong> and <strong>${esc(vpState.rangeEnd)}</strong>. Click <strong>Scan Unlocked Diary for Range</strong> above to pull unvisited days from your vault.</div>`
      }
    </div>
  `;

  const selAll = host.querySelector('#vp-r-sel-all');
  if (selAll) {
    selAll.addEventListener('click', () => {
      vpState.rangeExcludedDates.clear();
      updateRangeResultsOnly();
    });
  }
  const selNone = host.querySelector('#vp-r-sel-none');
  if (selNone) {
    selNone.addEventListener('click', () => {
      groups.forEach((g) => vpState.rangeExcludedDates.add(g.isoDate));
      updateRangeResultsOnly();
    });
  }

  host.querySelectorAll('.vp-day-toggle').forEach((chk) => {
    chk.addEventListener('change', () => {
      const iso = chk.getAttribute('data-iso');
      if (chk.checked) vpState.rangeExcludedDates.delete(iso);
      else vpState.rangeExcludedDates.add(iso);
      updateRangeResultsOnly();
    });
  });

  host.querySelectorAll('.vp-preview-day-btn').forEach((btn) => {
    btn.addEventListener('click', () => openOneDayViewer(btn.getAttribute('data-iso')));
  });

  const buildDoc = () => {
    if (!included.length) {
      showToast('Select at least one day with entries first.');
      return null;
    }
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

/* --- TAB B: PRINT INDICES (Static controls + dynamic results) --- */

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
        <div>
          <label class="bpt-field-label">Document Title</label>
          <input type="text" id="vp-idx-title" class="plug-input" value="${esc(vpState.idxDocTitle)}" />
        </div>
        <div>
          <label class="bpt-field-label">Print Font</label>
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
        <div>
          <label class="bpt-field-label">Start Date</label>
          <input type="date" id="vp-idx-start" class="plug-input" value="${esc(vpState.idxStart)}" />
        </div>
        <div>
          <label class="bpt-field-label">End Date</label>
          <input type="date" id="vp-idx-end" class="plug-input" value="${esc(vpState.idxEnd)}" />
        </div>
        <div>
          <label class="bpt-field-label">Year</label>
          <select id="vp-idx-year" class="plug-select">
            <option value="all" ${vpState.idxYear === 'all' ? 'selected' : ''}>All Years</option>
            ${allKnownYears.map((y) => `<option value="${esc(y)}" ${vpState.idxYear === y ? 'selected' : ''}>${esc(y)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="plug-grid-2" style="margin-top:10px;">
        <div>
          <label class="bpt-field-label">Keyword or #Tag Filter</label>
          <input type="search" id="vp-idx-q" class="plug-input" placeholder="Filter titles, descriptions, quotes, or #tags..." value="${esc(vpState.idxQuery)}" />
        </div>
        <div>
          <label class="bpt-field-label">Sort Order</label>
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
  container.querySelector('#vp-idx-q').addEventListener('input', (e) => {
    vpState.idxQuery = e.target.value;
    updateIndicesResultsOnly();
  });

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
            <div class="plug-card-title" style="margin-bottom:6px;"><span>Included Highlights &amp; Pinned Preview</span></div>
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
    if (totalSelected === 0) {
      showToast('Nothing selected to print.');
      return null;
    }
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
   9. TRIGGER INJECTION, INDEX MODAL BRIDGE & BOOTSTRAP
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
    // Carry over active search & year filter from Entry Index into Print Indices
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
  dayBtn.textContent = 'Day View';
  dayBtn.title = 'Open Focused One-Day Reader';
  dayBtn.addEventListener('click', () => openOneDayViewer());

  const printBtn = document.createElement('button');
  printBtn.type = 'button';
  printBtn.id = 'vp-print-trigger';
  printBtn.className = 'plug-trigger-btn';
  printBtn.textContent = 'Print';
  printBtn.title = 'Print Specific Range of Days or Indices';
  printBtn.addEventListener('click', () => openPrintHubModal('range'));

  dock.appendChild(dayBtn);
  dock.appendChild(printBtn);
}

function bootViewerPrintAddon() {
  mountTriggers();
  captureVisibleDOM();
  setTimeout(mountTriggers, 500);

  document.addEventListener('mouseup', (e) => {
    if (e.target.closest('#vp-day-sel-bar')) return;
    setTimeout(inspectOneDaySelection, 20);
  });
  document.addEventListener('touchend', (e) => {
    if (e.target.closest('#vp-day-sel-bar')) return;
    setTimeout(inspectOneDaySelection, 120);
  });
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('#vp-day-sel-bar')) hideDaySelectionBar();
  });

  let timer = null;
  const obs = new MutationObserver((muts) => {
    injectPrintButtonIntoIndexModal();
    const relevant = muts.some((m) => !m.target?.closest?.('.plug-backdrop, #pdx-sel-bar, #vp-day-sel-bar, #plug-toast'));
    if (!relevant) return;
    clearTimeout(timer);
    timer = setTimeout(captureVisibleDOM, 350);
  });
  obs.observe(document.body, { childList: true, subtree: true });

  document.addEventListener('keydown', (e) => {
    const dayOpen = document.getElementById('vp-day-backdrop')?.classList.contains('is-open');
    if (e.key === 'Escape') {
      closeAllModals();
      return;
    }
    if (dayOpen && !e.target.closest('input, textarea, select')) {
      if (e.key === 'ArrowLeft') switchOneDayViewerDate(shiftISO(vpState.dayDate, -1));
      else if (e.key === 'ArrowRight') switchOneDayViewerDate(shiftISO(vpState.dayDate, 1));
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootViewerPrintAddon);
} else {
  bootViewerPrintAddon();
}

