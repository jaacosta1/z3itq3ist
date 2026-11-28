

/**
 * Perpetual Web Diary — Editorial Drop-In Addon (js/viewer-print-plugin.js)
 *   1) One Day Viewer — Distraction-free reading sheet with Aa popover, color-coded pills,
 *      locked-vault awareness, live selection highlighting, swipe & keyboard nav.
 *   2) Print Studio — Uncluttered 2-column Date Range & Master Index printer with
 *      unlocked-vault scanning, iOS-safe iframe printing, and direct HTML download.
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

const vpSessionCache = new Map(); // `${isoDate}|${idx}` -> decrypted clean entry
const vpLockedCache = new Map();  // `${isoDate}` -> { isoDate, pills, tags }
let vpScanCancelled = false;
let vpActiveDayReqId = 0;

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
    // ignore quota errors
  }
}

const initialPrefs = loadPrefs();

const vpState = {
  // One Day Viewer
  dayDate: todayISO(),
  dayFont: initialPrefs.dayFont || 'serif',   // 'serif' | 'sans' | 'mono'
  daySize: initialPrefs.daySize || 'md',      // 'sm' | 'md' | 'lg'
  dayTheme: initialPrefs.dayTheme || 'auto',  // 'auto' | 'sepia' | 'paper'
  dayLoading: false,
  dayPinOpen: false,
  dayPopOpen: false,

  // Print Studio
  printTab: 'range', // 'range' | 'indices'

  // Range Print
  rangeDocTitle: '',
  rangeStart: shiftISO(todayISO(), -29),
  rangeEnd: todayISO(),
  rangeFilter: '',
  rangeFont: initialPrefs.rangeFont || 'serif',
  rangeOptTitles: true,
  rangeOptHighlights: true,
  rangeOptMeta: true,
  rangeOptPageBreak: false,
  rangeOptToc: true,
  rangeExcludedDates: new Set(),
  rangeScanning: false,
  rangeScanProgress: '',

  // Indices Print
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
  idxFont: initialPrefs.idxFont || 'serif',
};

/* ==========================================================================
   1. UTILITIES
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
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
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

function makeExcerpt(text, maxLen = 155) {
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
      background: '#171e2d',
      color: '#eef2f7',
      border: '1px solid rgba(229,184,105,0.45)',
      fontSize: '0.82rem',
      fontWeight: '600',
      boxShadow: '0 10px 28px rgba(0,0,0,0.5)',
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
   2. SHARED STORAGE (Entry Index, Highlights & Pinned Dates)
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
   3. SEMANTIC DOM EXTRACTOR (ZERO SMASHED PILLS · LOCK-AWARE)
   ========================================================================== */

const LOCKED_TEXT_RE = /ENCRYPTED\s+ENTRY|AES-256-GCM|VAULT\s+LOCKED|UNLOCK\s+VAULT\s+TO\s+READ/i;
const ACTION_CHROME_RE = /^(↗\s*)?share$|^[“"']?\s*quote$|^edit$|^delete$|^history$|^pin$|^unpin$|^unlock(\s+vault)?$|^\+\s*add(\s+entry)?$|^add\s+entry$|^save$|^cancel$/i;

function classifyPillText(raw) {
  const txt = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!txt || txt.length > 64) return null;
  if (/^mood:\s*.+/i.test(txt)) return { kind: 'mood', text: txt };
  if (/^(energy|clarity|calm|sleep|focus|stress|anxiety|pain):\s*\d+\s*\/\s*\d+$/i.test(txt)) {
    return { kind: 'metric', text: txt };
  }
  if (/^[◎📍📌]\s*\S+/.test(txt)) return { kind: 'loc', text: txt };
  if (/^[☁☀🌤⛅🌦🌧⛈🌩❄🌫💨🌙🌡]/.test(txt) || /·\s*-?\d+\s*°\s*[CF]\b/i.test(txt)) {
    return { kind: 'loc', text: txt };
  }
  if (/^#[a-zA-Z0-9:_-]{2,42}$/.test(txt)) return { kind: 'arc', text: txt };
  return null;
}

function findPrimaryYearColumns() {
  let cols = Array.from(document.querySelectorAll('.year-col')).filter(
    (el) => !el.closest('.plug-backdrop, .vp-backdrop')
  );
  if (!cols.length) {
    cols = Array.from(document.querySelectorAll('[data-year]')).filter(
      (el) => !el.closest('.plug-backdrop, .vp-backdrop') && !el.parentElement?.closest('[data-year]')
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
  if (dateInput && !dateInput.closest('.plug-backdrop, .vp-backdrop') && /^\d{4}-\d{2}-\d{2}$/.test(dateInput.value)) {
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
  const txt = dateEl ? dateEl.textContent : (node.textContent || '').slice(0, 140);
  const m = (txt || '').match(/\b((?:19|20)\d{2}-\d{2}-\d{2})\b/);
  return m ? m[1] : null;
}

function extractCleanCardData(card) {
  const explicitIso = extractExplicitIsoFromNode(card);
  const rawFullText = card.textContent || '';
  let isLocked =
    LOCKED_TEXT_RE.test(rawFullText) ||
    Boolean(card.querySelector('.entry-locked, .locked-entry, .encrypted-card, .encrypted-placeholder'));

  const pills = [];
  const seenPills = new Set();
  const badgeTags = [];

  const addPill = (pObj) => {
    if (!pObj) return;
    const key = pObj.text.toLowerCase();
    if (seenPills.has(key)) return;
    seenPills.add(key);
    pills.push(pObj);
    if (pObj.kind === 'arc') badgeTags.push(pObj.text);
  };

  // Clone entire card and semantically harvest + strip ALL metadata pills, action buttons, and lock chrome
  const clone = card.cloneNode(true);
  const title = (clone.querySelector('.entry-title, .stacked-entry-title, h4')?.textContent || '').trim();
  const timeStamp = (clone.querySelector('.entry-time, .stacked-entry-time')?.textContent || '').trim();

  // 1) Remove obvious structural chrome
  clone
    .querySelectorAll(
      'button, nav, input, textarea, select, script, style, svg, .entry-actions, .entry-toolbar, .entry-header, .entry-subheader, .entry-date, .stacked-entry-date, .year-header, .year-col-header, .year-col-actions, .year-col-add-entry-bar, .stacked-entry-header, .stacked-entry-index, .margin-notes, .comments-section'
    )
    .forEach((el) => el.remove());

  // 2) Semantic pass over leaf-ish elements: extract pills (mood, ◎ location, ☁ weather, ratings, #tags) & strip them
  const candidates = Array.from(clone.querySelectorAll('span, a, div, small, label, li, p'));
  candidates.forEach((el) => {
    if (!el.isConnected) return;
    // Only inspect leaf elements or tiny inline wrappers (<= 1 child element)
    if (el.children.length > 1) return;
    const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!txt) return;

    if (LOCKED_TEXT_RE.test(txt)) {
      isLocked = true;
      el.remove();
      return;
    }

    const classified = classifyPillText(txt);
    if (classified) {
      addPill(classified);
      el.remove();
      return;
    }

    if (
      ACTION_CHROME_RE.test(txt) ||
      /^(?:19|20)\d{2}(?:-\d{2}-\d{2})?$/.test(txt) ||
      /^#\d+(\s+of\s+\d+)?$/i.test(txt)
    ) {
      el.remove();
    }
  });

  // 3) Remove any pill wrapper containers that are now empty
  clone
    .querySelectorAll(
      '.entry-pills, .entry-badges, .meta-pills, .pills, .badges, .tags-row, .tag-list, .entry-tags, .entry-meta'
    )
    .forEach((el) => el.remove());

  // If entry is encrypted/locked, return clean metadata pills with empty body so it's NEVER treated as prose
  if (isLocked) {
    return {
      explicitIso,
      isLocked: true,
      title: '',
      body: '',
      pills,
      tags: extractTags('', badgeTags),
      timeStamp,
    };
  }

  // 4) Extract clean paragraph-preserved prose from dedicated body node (if present) or remaining clone
  const bodyNode = clone.querySelector(
    '.entry-body-content, .entry-body, .entry-content, .stacked-entry-body, .year-entry-body, .year-entry-content, .entry-text, .entry-prose, .prose, .markdown-body, .entry-markdown'
  );
  const proseHost = bodyNode && (bodyNode.textContent || '').trim() ? bodyNode : clone;

  proseHost.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
  proseHost.querySelectorAll('p, div, li, blockquote, h1, h2, h3, h4').forEach((blk) => {
    blk.append('\n');
  });

  let cleanBody = (proseHost.textContent || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Final defensive line filter against stray lock banners or unsplit badge rows
  const lines = cleanBody
    .split('\n')
    .map((ln) => ln.trim())
    .filter((ln) => {
      if (!ln) return true;
      if (LOCKED_TEXT_RE.test(ln)) {
        isLocked = true;
        return false;
      }
      if (ACTION_CHROME_RE.test(ln)) return false;
      if (classifyPillText(ln)) {
        addPill(classifyPillText(ln));
        return false;
      }
      // Catch concatenated badge line fallback if DOM ever glued them into a single text node
      if (/^mood:\s*.*(energy:\s*\d\/\d|clarity:\s*\d\/\d|°[CF])/i.test(ln)) return false;
      return true;
    });

  cleanBody = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  return {
    explicitIso,
    isLocked: isLocked && !cleanBody,
    title,
    body: cleanBody,
    pills,
    tags: extractTags(cleanBody, badgeTags),
    timeStamp,
  };
}

function getVisibleDOMSignature() {
  const cols = findPrimaryYearColumns();
  return `${detectCurrentDiaryMMDD()}|${cols
    .map((c) => `${getColumnYear(c) || ''}:${(c.textContent || '').slice(0, 90)}`)
    .join('||')}`;
}

function captureVisibleDOM() {
  const fallbackMmdd = detectCurrentDiaryMMDD();
  if (!fallbackMmdd) return;

  const seenYears = new Set();
  findPrimaryYearColumns().forEach((col) => {
    const yr = getColumnYear(col);
    if (!yr || seenYears.has(yr)) return;
    seenYears.add(yr);

    const colIso = extractExplicitIsoFromNode(col);
    let cards = Array.from(col.querySelectorAll('.stacked-entry-item'));
    if (!cards.length) cards = Array.from(col.querySelectorAll('.entry-card, .year-entry'));
    if (!cards.length) cards = [col];

    const groupedByIso = new Map();
    cards.forEach((card) => {
      const parsed = extractCleanCardData(card);
      const isoDate = parsed.explicitIso || colIso || `${yr}-${fallbackMmdd}`;

      if (parsed.isLocked) {
        // Record locked state ONLY if we don't already have a decrypted entry cached for this date
        const alreadyDecrypted = Array.from(vpSessionCache.keys()).some((k) => k.startsWith(`${isoDate}|`));
        if (!alreadyDecrypted) {
          vpLockedCache.set(isoDate, {
            isoDate,
            year: isoDate.slice(0, 4),
            mmdd: isoDate.slice(5),
            pills: parsed.pills,
            tags: parsed.tags,
          });
        }
        return;
      }

      const norm = normalizeForDedupe(parsed.body);
      if (!parsed.body || !norm) return;

      if (!groupedByIso.has(isoDate)) groupedByIso.set(isoDate, { norms: new Set(), items: [] });
      const bucket = groupedByIso.get(isoDate);
      if (bucket.norms.has(norm)) return;
      bucket.norms.add(norm);
      bucket.items.push(parsed);
    });

    groupedByIso.forEach((bucket, isoDate) => {
      if (!bucket.items.length) return;
      vpLockedCache.delete(isoDate); // decrypted text supersedes any locked placeholder
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
    if ((!text && !rawTitle) || LOCKED_TEXT_RE.test(text)) return;

    const norm = normalizeForDedupe(text || rawTitle);
    const dedupeKey = `${isoDate}|${norm}`;
    if (!norm || seen.has(dedupeKey)) return;
    seen.add(dedupeKey);

    const entryIndex = idx + 1;
    const metaKey = `${isoDate}|${entryIndex}`;
    const customMeta = metaMap[metaKey] || {};
    const title = customMeta.title || rawTitle;
    const description = customMeta.description || '';

    // Normalize pills whether structured objects or strings
    const pills = (Array.isArray(raw.pills) ? raw.pills : [])
      .map((p) => (typeof p === 'string' ? classifyPillText(p) || { kind: 'metric', text: p } : p))
      .filter(Boolean);

    results.push({
      isoDate,
      year: String(year),
      mmdd,
      entryIndex,
      totalInYear,
      title,
      description,
      text: text || title,
      excerpt: makeExcerpt(text || title, 160),
      words: countWords(text),
      tags: extractTags(`${title} ${description} ${text}`, raw.tags || []),
      pills,
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

function triggerMainVaultUnlock() {
  closeAllModals();
  const unlockBtn = document.querySelector(
    '#vault-btn, #btn-vault, #unlock-btn, [data-action="vault"], [data-action="unlock"], button[title*="Vault" i], button[title*="Unlock" i], button[aria-label*="Vault" i]'
  );
  if (unlockBtn) {
    unlockBtn.click();
  } else {
    showToast('Click the Shield (⛨) icon in the top bar to unlock your vault.');
  }
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
    if (setSelectOptionSmart(monthSel, mNum) || setSelectOptionSmart(daySel, dNum)) return true;
  }

  const dateInput = document.querySelector('#date-picker, #current-date-input, input[type="date"]');
  if (dateInput && !dateInput.closest('.plug-backdrop, .vp-backdrop')) {
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
    if (curMmdd === targetMmdd && changedAt > 0 && Date.now() - changedAt >= 150) break;
    if (curMmdd === targetMmdd && Date.now() - start >= 450 && changedAt === 0) break;
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
   4. RANGE-SAFE HIGHLIGHT RENDERER & PILL HTML HELPER
   ========================================================================== */

function renderPillsHtml(pills = []) {
  if (!pills.length) return '';
  const clsMap = {
    mood: 'vp-pill vp-pill-mood',
    loc: 'vp-pill vp-pill-loc',
    arc: 'vp-pill vp-pill-arc',
    metric: 'vp-pill',
  };
  return `<div class="vp-pills-row">${pills
    .map((p) => `<span class="${clsMap[p.kind] || 'vp-pill'}">${esc(p.text)}</span>`)
    .join('')}</div>`;
}

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

  const renderPara = (paraText) => {
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
    if (pos < paraText.length) out += esc(paraText.slice(pos)).replace(/\n/g, '<br/>');
    return `<p>${out}</p>`;
  };

  return paragraphs.map(renderPara).join('');
}

/* ==========================================================================
   5. iOS-SAFE HIDDEN IFRAME PRINTER + BOOK/INDEX HTML GENERATORS
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
          <h2>Contents</h2>
          <ol>
            ${daysGrouped
              .map((g) => {
                const firstTitle = g.entries.find((e) => e.title)?.title || '';
                const words = g.entries.reduce((s, e) => s + e.words, 0);
                return `<li>
                  <span class="toc-date">${esc(g.isoDate)}</span>
                  <span class="toc-title">${esc(firstTitle || formatShortDate(g.isoDate))}</span>
                  <span class="toc-meta">${g.entries.length > 1 ? `${g.entries.length} entries · ` : ''}${words.toLocaleString()}w</span>
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
              const metaLine = opts.includeMeta && e.pills.length
                ? `<div class="print-pills">${e.pills.map((p) => `<span>${esc(p.text)}</span>`).join('')}</div>`
                : '';
              return `
                <div class="entry-block">
                  ${g.entries.length > 1 ? `<div class="entry-num">Entry #${e.entryIndex} of ${g.entries.length}${e.timeStamp ? ` · ${esc(e.timeStamp)}` : ''}</div>` : ''}
                  ${metaLine}
                  ${opts.includeTitles && e.title ? `<h3 class="entry-title">${esc(e.title)}</h3>` : ''}
                  ${opts.includeTitles && e.description ? `<p class="entry-desc">${esc(e.description)}</p>` : ''}
                  <div class="entry-prose">${formatEntryProseWithHighlights(e.text, dayHl, true)}</div>
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
    line-height: 1.68;
    font-size: 11.2pt;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .doc-header { border-bottom: 2px solid #16181d; padding-bottom: 10px; margin-bottom: 22px; }
  .doc-header h1 { margin: 0 0 4px; font-size: 19pt; letter-spacing: -0.01em; }
  .doc-meta { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 9pt; color: #525866; }
  .toc { margin: 0 0 24px; padding: 14px 18px; border: 1px solid #d1d5db; border-radius: 6px; page-break-after: always; }
  .toc h2 { margin: 0 0 10px; font-size: 13pt; }
  .toc ol { margin: 0; padding-left: 18px; }
  .toc li { display: flex; gap: 10px; align-items: baseline; padding: 3px 0; border-bottom: 1px dotted #e5e7eb; font-size: 10pt; }
  .toc-date { font-family: monospace; font-weight: 700; min-width: 84px; }
  .toc-title { flex: 1; }
  .toc-meta { font-family: sans-serif; font-size: 8.5pt; color: #6b7280; }
  .day-section { margin-bottom: 28px; }
  .day-break { page-break-before: always; }
  .day-head { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 1px solid #9ca3af; padding-bottom: 5px; margin-bottom: 12px; page-break-after: avoid; }
  .day-head h2 { margin: 0; font-size: 13.5pt; }
  .day-iso { font-family: monospace; font-size: 9.5pt; color: #4b5563; }
  .print-pills { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 10px; font-family: sans-serif; font-size: 8pt; }
  .print-pills span { padding: 2px 7px; border-radius: 999px; border: 1px solid #d1d5db; color: #374151; background: #f9fafb; }
  .entry-block { margin-bottom: 18px; break-inside: avoid-page; }
  .entry-num { font-family: sans-serif; font-size: 8pt; font-weight: 700; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 5px; }
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

  const renderUnifiedTable = (items) => `
    <table>
      <thead><tr><th style="width:94px;">Date</th><th style="width:80px;">Type</th><th>Title, Description &amp; Content</th></tr></thead>
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
        .map((y) => `<section><h2>${esc(y)} (${byYear.get(y).length} items)</h2>${renderUnifiedTable(byYear.get(y))}</section>`)
        .join('');
    } else if (unified.length) {
      bodySections = `<section><h2>Unified Index Timeline (${unified.length} items)</h2>${renderUnifiedTable(unified)}</section>`;
    }
  } else {
    if (opts.includePinned && payload.pinned.length) {
      bodySections += `<section>
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
      bodySections += `<section>
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
      bodySections += `<section>
        <h2>Diary Entries Directory (${payload.entries.length})</h2>
        <table>
          <thead><tr><th style="width:98px;">Date</th><th>Title, Description${opts.includeExcerpts ? ' &amp; Excerpt' : ''}</th><th style="width:66px;">Words</th></tr></thead>
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
    bodySections += `<section>
      <h2>#Tag Cross-Reference (${payload.tags.length})</h2>
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
  body { font-family: ${fontCss}; color: #16181d; background: #fff; margin: 0; padding: 10px 16px; font-size: 10.5pt; line-height: 1.5; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
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
    backdrop.className = 'vp-backdrop';
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeAllModals();
    });
    document.body.appendChild(backdrop);
  }
  return backdrop;
}

function closeAllModals() {
  vpScanCancelled = true;
  vpState.dayPopOpen = false;
  hideDaySelectionBar();
  document.querySelectorAll('.plug-backdrop.is-open, .vp-backdrop.is-open').forEach((el) => {
    el.classList.remove('is-open');
  });
}

/* ==========================================================================
   7. ONE DAY VIEWER — MINIMAL EDITORIAL READING SHEET
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
      <input type="text" id="vp-sel-title" class="vp-input" style="padding:6px 8px;font-size:0.8rem;" placeholder="Highlight Title (optional)..." />
      <textarea id="vp-sel-desc" class="vp-textarea" style="min-height:46px;padding:6px 8px;font-size:0.8rem;" placeholder="Description or #tags (optional)..."></textarea>
      <div style="display:flex;justify-content:flex-end;gap:6px;">
        <button type="button" id="vp-sel-cancel" class="vp-btn vp-btn-sm">Cancel</button>
        <button type="button" id="vp-sel-save" class="vp-btn vp-btn-primary vp-btn-sm">Save</button>
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
  if (!anchorEl || !anchorEl.closest('.vp-prose')) return hideDaySelectionBar();

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
  vpState.dayPopOpen = false;

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

  const reqId = ++vpActiveDayReqId;
  const existing = collectAllKnownEntries().filter((e) => e.isoDate === vpState.dayDate);
  if (!existing.length && !vpLockedCache.has(vpState.dayDate)) {
    vpState.dayLoading = true;
    renderOneDayViewer();
    await fetchSingleDateIntoCache(vpState.dayDate);
    if (reqId !== vpActiveDayReqId) return;
    vpState.dayLoading = false;
    renderOneDayViewer();
  }
}

async function switchOneDayViewerDate(newIso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(newIso)) return;
  hideDaySelectionBar();
  vpState.dayPinOpen = false;
  vpState.dayPopOpen = false;
  vpState.dayDate = newIso;
  const reqId = ++vpActiveDayReqId;

  const known = collectAllKnownEntries().filter((e) => e.isoDate === newIso);
  if (!known.length && !vpLockedCache.has(newIso)) {
    vpState.dayLoading = true;
    renderOneDayViewer();
    await fetchSingleDateIntoCache(newIso);
    if (reqId !== vpActiveDayReqId) return;
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

  const lockedRecord = !dayEntries.length ? vpLockedCache.get(iso) || null : null;
  const dayHighlights = loadHighlights().filter((h) => h.isoDate === iso);
  const dayPins = loadPinnedDates().filter((p) => p.isoDate === iso);

  const writtenDates = Array.from(new Set(allEntries.map((e) => e.isoDate))).sort();
  const prevWritten = [...writtenDates].reverse().find((d) => d < iso) || null;
  const nextWritten = writtenDates.find((d) => d > iso) || null;

  const sameMmddYears = Array.from(
    new Set([
      ...allEntries.filter((e) => e.mmdd === iso.slice(5)).map((e) => e.year),
      ...(lockedRecord ? [lockedRecord.year] : []),
    ])
  ).sort((a, b) => b.localeCompare(a));

  const sheetClass = `vp-sheet vp-font-${vpState.dayFont} vp-size-${vpState.daySize} vp-theme-${vpState.dayTheme}`;

  let contentHtml = '';
  if (vpState.dayLoading) {
    contentHtml = `<div class="vp-empty">Opening ${esc(formatShortDate(iso))}…</div>`;
  } else if (dayEntries.length) {
    contentHtml = dayEntries
      .map(
        (e) => `
      <article class="vp-entry-item">
        <div class="vp-entry-kicker">
          ${dayEntries.length > 1 ? `<strong>Entry #${e.entryIndex} of ${dayEntries.length}</strong><span>·</span>` : ''}
          ${e.timeStamp ? `<span>${esc(e.timeStamp)}</span><span>·</span>` : ''}
          <span>${e.words.toLocaleString()} words</span>
        </div>
        ${renderPillsHtml(e.pills)}
        ${e.title ? `<h3 class="vp-entry-title">${esc(e.title)}</h3>` : ''}
        ${e.description ? `<p class="vp-entry-desc">${esc(e.description)}</p>` : ''}
        <div class="vp-prose">${formatEntryProseWithHighlights(e.text, dayHighlights, false)}</div>
      </article>`
      )
      .join('');
  } else if (lockedRecord) {
    contentHtml = `
      ${renderPillsHtml(lockedRecord.pills)}
      <div class="vp-locked-card">
        <div class="vp-locked-badge">Encrypted Entry · AES-256-GCM</div>
        <p>This entry is encrypted in your vault. Unlock your diary to read and print it in full.</p>
        <button type="button" class="vp-btn vp-btn-primary" id="vp-unlock-trigger">Unlock Diary</button>
      </div>`;
  } else {
    contentHtml = `
      <div class="vp-empty">
        <p style="margin:0 0 12px;">No entry recorded for <strong>${esc(formatLongDate(iso))}</strong>.</p>
        <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;">
          <button type="button" class="vp-btn vp-btn-sm" id="vp-day-reload">Check Live Diary</button>
          ${prevWritten ? `<button type="button" class="vp-btn vp-btn-sm vp-jump-written" data-iso="${esc(prevWritten)}">← ${esc(formatShortDate(prevWritten))}</button>` : ''}
          ${nextWritten ? `<button type="button" class="vp-btn vp-btn-sm vp-jump-written" data-iso="${esc(nextWritten)}">${esc(formatShortDate(nextWritten))} →</button>` : ''}
        </div>
      </div>`;
  }

  const notesHtml =
    dayPins.length || dayHighlights.length
      ? `<div class="vp-sheet-notes">
          ${
            dayPins.length
              ? `<div style="margin-bottom:14px;">
                  <div class="vp-note-label">Pinned Index Notes</div>
                  ${dayPins
                    .map(
                      (p) => `<div class="vp-note-card"><strong>${esc(p.title)}</strong>${p.description ? `<p>${esc(p.description)}</p>` : ''}</div>`
                    )
                    .join('')}
                </div>`
              : ''
          }
          ${
            dayHighlights.length
              ? `<div>
                  <div class="vp-note-label">Highlights (${dayHighlights.length})</div>
                  ${dayHighlights
                    .map((h) => {
                      const hex = { gold: '#e5b869', blue: '#60a5fa', green: '#34d399', pink: '#f472b6' }[h.color || 'gold'];
                      return `<div class="vp-note-card" style="border-left:3px solid ${hex};">
                        ${h.title ? `<strong>${esc(h.title)}</strong>` : ''}
                        ${h.description ? `<p>${esc(h.description)}</p>` : ''}
                        <div style="font-style:italic;margin-top:3px;">“${esc(h.quote)}”</div>
                      </div>`;
                    })
                    .join('')}
                </div>`
              : ''
          }
        </div>`
      : '';

  const pinBoxHtml = vpState.dayPinOpen
    ? `<div class="vp-quick-pin">
        <div style="display:flex;gap:6px;align-items:center;">
          <input type="text" id="vp-qpin-title" class="vp-input" placeholder="Index Title for ${esc(iso)}..." />
          <button type="button" id="vp-qpin-save" class="vp-btn vp-btn-primary vp-btn-sm">Save</button>
          <button type="button" id="vp-qpin-cancel" class="vp-btn vp-btn-ghost vp-btn-sm">Cancel</button>
        </div>
        <textarea id="vp-qpin-desc" class="vp-textarea" style="min-height:46px;" placeholder="Description or #tags (optional)..."></textarea>
      </div>`
    : '';

  backdrop.innerHTML = `
    <div class="vp-modal vp-modal-day" role="dialog" aria-modal="true" aria-label="One Day Viewer">
      <div class="vp-topbar">
        <div class="vp-topbar-left">
          <button type="button" class="vp-btn vp-btn-ghost vp-btn-icon" id="vp-day-prev" title="Previous day (←)">‹</button>
          <label class="vp-date-pill" title="Pick any date">
            <span>${esc(formatShortDate(iso))}</span>
            <input type="date" id="vp-day-picker" value="${esc(iso)}" />
          </label>
          <button type="button" class="vp-btn vp-btn-ghost vp-btn-icon" id="vp-day-next" title="Next day (→)">›</button>
        </div>

        <div class="vp-topbar-right">
          <button type="button" class="vp-btn vp-btn-ghost ${vpState.dayPopOpen ? 'is-active' : ''}" id="vp-aa-toggle" title="Reading appearance & years">Aa</button>
          <button type="button" class="vp-btn vp-btn-ghost ${vpState.dayPinOpen ? 'is-active' : ''}" id="vp-day-pin-toggle" title="Pin this day to Index">Pin</button>
          <button type="button" class="vp-btn vp-btn-primary" id="vp-day-print">Print</button>
          <button type="button" class="vp-btn vp-btn-ghost vp-btn-icon" id="vp-day-close" title="Close (Esc)">✕</button>
        </div>
      </div>

      <div class="vp-popover ${vpState.dayPopOpen ? 'is-open' : ''}" id="vp-aa-popover">
        <div class="vp-pop-row">
          <span class="vp-pop-label">Surface</span>
          <div class="vp-pop-grid-3">
            <button type="button" class="vp-btn vp-btn-sm ${vpState.dayTheme === 'auto' ? 'is-active' : ''}" data-vp-theme="auto">Midnight</button>
            <button type="button" class="vp-btn vp-btn-sm ${vpState.dayTheme === 'sepia' ? 'is-active' : ''}" data-vp-theme="sepia">Sepia</button>
            <button type="button" class="vp-btn vp-btn-sm ${vpState.dayTheme === 'paper' ? 'is-active' : ''}" data-vp-theme="paper">Paper</button>
          </div>
        </div>
        <div class="vp-pop-row">
          <span class="vp-pop-label">Typography</span>
          <div class="vp-pop-grid-3">
            <button type="button" class="vp-btn vp-btn-sm ${vpState.dayFont === 'serif' ? 'is-active' : ''}" data-vp-font="serif">Serif</button>
            <button type="button" class="vp-btn vp-btn-sm ${vpState.dayFont === 'sans' ? 'is-active' : ''}" data-vp-font="sans">Sans</button>
            <button type="button" class="vp-btn vp-btn-sm ${vpState.dayFont === 'mono' ? 'is-active' : ''}" data-vp-font="mono">Mono</button>
          </div>
        </div>
        <div class="vp-pop-row">
          <span class="vp-pop-label">Text Size</span>
          <div class="vp-pop-grid-3">
            <button type="button" class="vp-btn vp-btn-sm ${vpState.daySize === 'sm' ? 'is-active' : ''}" data-vp-size="sm">Small</button>
            <button type="button" class="vp-btn vp-btn-sm ${vpState.daySize === 'md' ? 'is-active' : ''}" data-vp-size="md">Medium</button>
            <button type="button" class="vp-btn vp-btn-sm ${vpState.daySize === 'lg' ? 'is-active' : ''}" data-vp-size="lg">Large</button>
          </div>
        </div>
        ${
          sameMmddYears.length > 1
            ? `<div class="vp-pop-row">
                <span class="vp-pop-label">Same Day in Other Years</span>
                <div class="vp-chip-row">
                  ${sameMmddYears
                    .map(
                      (y) =>
                        `<button type="button" class="vp-btn vp-btn-sm ${y === iso.slice(0, 4) ? 'is-active' : ''} vp-day-yr-btn" data-yr="${esc(y)}">${esc(y)}</button>`
                    )
                    .join('')}
                </div>
              </div>`
            : ''
        }
        <button type="button" class="vp-btn vp-btn-sm" id="vp-day-open-main" style="width:100%;">Open in Side-by-Side View</button>
      </div>

      <div class="vp-scroll" id="vp-day-scroll-body">
        ${pinBoxHtml}
        <div class="${sheetClass}">
          <div class="vp-sheet-head">
            <h1>${esc(formatLongDate(iso))}</h1>
            <span class="vp-sheet-iso">${esc(iso)}</span>
          </div>
          ${contentHtml}
          ${notesHtml}
        </div>

        <div class="vp-sheet-foot">
          ${
            prevWritten
              ? `<button type="button" class="vp-btn vp-btn-ghost vp-btn-sm vp-jump-written" data-iso="${esc(prevWritten)}">← ${esc(formatShortDate(prevWritten))}</button>`
              : '<span></span>'
          }
          <button type="button" class="vp-btn vp-btn-ghost vp-btn-sm" id="vp-day-today">Today</button>
          ${
            nextWritten
              ? `<button type="button" class="vp-btn vp-btn-ghost vp-btn-sm vp-jump-written" data-iso="${esc(nextWritten)}">${esc(formatShortDate(nextWritten))} →</button>`
              : '<span></span>'
          }
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

  backdrop.querySelector('#vp-aa-toggle').addEventListener('click', (e) => {
    e.stopPropagation();
    vpState.dayPopOpen = !vpState.dayPopOpen;
    backdrop.querySelector('#vp-aa-popover').classList.toggle('is-open', vpState.dayPopOpen);
    backdrop.querySelector('#vp-aa-toggle').classList.toggle('is-active', vpState.dayPopOpen);
  });

  backdrop.querySelectorAll('[data-vp-theme]').forEach((b) =>
    b.addEventListener('click', () => {
      vpState.dayTheme = b.getAttribute('data-vp-theme');
      savePrefs({ dayTheme: vpState.dayTheme });
      renderOneDayViewer();
    })
  );
  backdrop.querySelectorAll('[data-vp-font]').forEach((b) =>
    b.addEventListener('click', () => {
      vpState.dayFont = b.getAttribute('data-vp-font');
      savePrefs({ dayFont: vpState.dayFont });
      renderOneDayViewer();
    })
  );
  backdrop.querySelectorAll('[data-vp-size]').forEach((b) =>
    b.addEventListener('click', () => {
      vpState.daySize = b.getAttribute('data-vp-size');
      savePrefs({ daySize: vpState.daySize });
      renderOneDayViewer();
    })
  );

  backdrop.querySelectorAll('.vp-day-yr-btn').forEach((b) =>
    b.addEventListener('click', () => switchOneDayViewerDate(`${b.getAttribute('data-yr')}-${iso.slice(5)}`))
  );
  backdrop.querySelectorAll('.vp-jump-written').forEach((b) =>
    b.addEventListener('click', () => switchOneDayViewerDate(b.getAttribute('data-iso')))
  );

  backdrop.querySelector('#vp-day-open-main').addEventListener('click', () => {
    navigateUnderlyingDiaryToMMDD(iso.slice(5), iso);
    closeAllModals();
    showToast(`Opened ${formatShortDate(iso)}`);
  });

  backdrop.querySelector('#vp-day-pin-toggle').addEventListener('click', () => {
    vpState.dayPinOpen = !vpState.dayPinOpen;
    vpState.dayPopOpen = false;
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
      if (!title) return showToast('Enter a title for this date.');
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
      showToast(`Pinned "${title}"`);
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

  const unlockBtn = backdrop.querySelector('#vp-unlock-trigger');
  if (unlockBtn) unlockBtn.addEventListener('click', triggerMainVaultUnlock);

  const reloadBtn = backdrop.querySelector('#vp-day-reload');
  if (reloadBtn) {
    reloadBtn.addEventListener('click', async () => {
      const reqId = ++vpActiveDayReqId;
      vpState.dayLoading = true;
      renderOneDayViewer();
      await fetchSingleDateIntoCache(iso);
      if (reqId !== vpActiveDayReqId) return;
      vpState.dayLoading = false;
      renderOneDayViewer();
    });
  }

  backdrop.querySelector('#vp-day-print').addEventListener('click', () => {
    if (!dayEntries.length) {
      return showToast(lockedRecord ? 'Unlock your diary first to print this day.' : 'No entry to print for this day.');
    }
    const html = buildRangePrintDocument([{ isoDate: iso, entries: dayEntries }], {
      docTitle: formatLongDate(iso),
      subtitle: `Single-Day Reading Edition (${iso})`,
      font: vpState.dayFont,
      includeTitles: true,
      includeHighlights: true,
      includeMeta: true,
      pageBreakPerDay: false,
      includeToc: false,
    });
    sendHtmlToIframePrinter(html, `diary-${iso}.html`);
  });

  // Close Aa popover when clicking inside the reading sheet
  const scrollEl = backdrop.querySelector('#vp-day-scroll-body');
  scrollEl.addEventListener('click', () => {
    if (vpState.dayPopOpen) {
      vpState.dayPopOpen = false;
      backdrop.querySelector('#vp-aa-popover')?.classList.remove('is-open');
      backdrop.querySelector('#vp-aa-toggle')?.classList.remove('is-active');
    }
  });

  // Mobile swipe left/right to flip days
  let touchX = 0;
  let touchY = 0;
  scrollEl.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length !== 1) return;
      touchX = e.touches[0].clientX;
      touchY = e.touches[0].clientY;
    },
    { passive: true }
  );
  scrollEl.addEventListener(
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
   8. PRINT STUDIO — CLEAN 2-COLUMN SPLIT + STICKY ACTION FOOTER
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
  renderPrintStudioShell();
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

function getLockedDatesInRange() {
  const out = [];
  vpLockedCache.forEach((_, isoDate) => {
    if ((!vpState.rangeStart || isoDate >= vpState.rangeStart) && (!vpState.rangeEnd || isoDate <= vpState.rangeEnd)) {
      out.push(isoDate);
    }
  });
  return out.sort();
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
  if (!allDates.length) return showToast('Pick a valid Start and End date first.');

  const uniqueMmdds = Array.from(new Set(allDates.map((d) => d.slice(5))));
  if (uniqueMmdds.length > 45) {
    if (!confirm(`Scanning ${uniqueMmdds.length} days from your unlocked diary will take ~${Math.round(uniqueMmdds.length * 0.45)}s. Continue?`)) {
      return;
    }
  }

  const originalMmdd = detectCurrentDiaryMMDD();
  vpScanCancelled = false;
  vpState.rangeScanning = true;
  updateRangeScanControls();

  for (let i = 0; i < uniqueMmdds.length; i++) {
    if (vpScanCancelled) break;
    const mmdd = uniqueMmdds[i];
    vpState.rangeScanProgress = `Scanning ${i + 1} / ${uniqueMmdds.length} (${mmdd})…`;
    updateRangeScanControls();
    const prevSig = getVisibleDOMSignature();
    navigateUnderlyingDiaryToMMDD(mmdd, `${vpState.rangeStart.slice(0, 4)}-${mmdd}`);
    await waitForDiaryDateRender(mmdd, prevSig, 1000);
    updateRangePreviewPanel();
  }

  if (originalMmdd) {
    const prevSig = getVisibleDOMSignature();
    navigateUnderlyingDiaryToMMDD(originalMmdd);
    await waitForDiaryDateRender(originalMmdd, prevSig, 900);
  }

  vpState.rangeScanning = false;
  vpState.rangeScanProgress = '';
  updateRangeScanControls();
  updateRangePreviewPanel();
  showToast(vpScanCancelled ? 'Scan stopped' : 'Range scan complete');
}

function renderPrintStudioShell() {
  const backdrop = ensureModal('vp-print-backdrop');
  backdrop.innerHTML = `
    <div class="vp-modal" role="dialog" aria-modal="true" aria-label="Print Studio">
      <div class="vp-topbar">
        <div class="vp-topbar-left">
          <h2 class="vp-brand-title">Print Studio</h2>
        </div>

        <div class="vp-topbar-center">
          <div class="vp-segmented">
            <button type="button" class="vp-seg-btn" data-vp-tab="range">Date Range</button>
            <button type="button" class="vp-seg-btn" data-vp-tab="indices">Master Index</button>
          </div>
        </div>

        <div class="vp-topbar-right">
          <button type="button" class="vp-btn vp-btn-ghost vp-btn-icon" id="vp-print-close" title="Close (Esc)">✕</button>
        </div>
      </div>

      <div class="vp-scroll" id="vp-print-body"></div>

      <div class="vp-footer">
        <div class="vp-footer-meta" id="vp-footer-meta"></div>
        <div class="vp-footer-actions">
          <button type="button" class="vp-btn" id="vp-footer-dl">Download HTML</button>
          <button type="button" class="vp-btn vp-btn-primary" id="vp-footer-print">Print</button>
        </div>
      </div>
    </div>
  `;

  backdrop.querySelector('#vp-print-close').addEventListener('click', closeAllModals);
  backdrop.querySelectorAll('[data-vp-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      vpState.printTab = btn.getAttribute('data-vp-tab');
      mountPrintTab();
    });
  });

  backdrop.querySelector('#vp-footer-print').addEventListener('click', () => handleStudioPrintAction(false));
  backdrop.querySelector('#vp-footer-dl').addEventListener('click', () => handleStudioPrintAction(true));

  mountPrintTab();
}

function handleStudioPrintAction(isDownload) {
  if (vpState.printTab === 'range') {
    const included = getFilteredRangeGroups().filter((g) => !vpState.rangeExcludedDates.has(g.isoDate));
    if (!included.length) return showToast('No unlocked entries selected in this date range.');
    const customTitle = vpState.rangeDocTitle.trim();
    const html = buildRangePrintDocument(included, {
      docTitle: customTitle || `Diary: ${formatShortDate(vpState.rangeStart)} – ${formatShortDate(vpState.rangeEnd)}`,
      subtitle: vpState.rangeFilter ? `Filtered by "${vpState.rangeFilter}"` : `${vpState.rangeStart} to ${vpState.rangeEnd}`,
      font: vpState.rangeFont,
      includeTitles: vpState.rangeOptTitles,
      includeHighlights: vpState.rangeOptHighlights,
      includeMeta: vpState.rangeOptMeta,
      pageBreakPerDay: vpState.rangeOptPageBreak,
      includeToc: vpState.rangeOptToc,
    });
    const file = `diary-range-${vpState.rangeStart}-to-${vpState.rangeEnd}.html`;
    if (isDownload) downloadPrintableHtml(html, file);
    else sendHtmlToIframePrinter(html, file);
  } else {
    const payload = getFilteredIndexPayload();
    const count =
      (vpState.idxIncludePinned ? payload.pinned.length : 0) +
      (vpState.idxIncludeHighlights ? payload.highlights.length : 0) +
      (vpState.idxIncludeEntries ? payload.entries.length : 0) +
      (vpState.idxIncludeTags ? payload.tags.length : 0);
    if (!count) return showToast('No index items match your selection.');

    const parts = [];
    if (vpState.idxStart || vpState.idxEnd) parts.push(`Range: ${vpState.idxStart || 'Start'} to ${vpState.idxEnd || 'Present'}`);
    if (vpState.idxYear !== 'all') parts.push(`Year: ${vpState.idxYear}`);
    if (vpState.idxQuery.trim()) parts.push(`Filter: "${vpState.idxQuery.trim()}"`);

    const html = buildIndicesPrintDocument(payload, {
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
    const file = `diary-index-${todayISO()}.html`;
    if (isDownload) downloadPrintableHtml(html, file);
    else sendHtmlToIframePrinter(html, file);
  }
}

function mountPrintTab() {
  const backdrop = document.getElementById('vp-print-backdrop');
  if (!backdrop) return;
  backdrop.querySelectorAll('[data-vp-tab]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.getAttribute('data-vp-tab') === vpState.printTab);
  });
  const body = backdrop.querySelector('#vp-print-body');
  const printBtn = backdrop.querySelector('#vp-footer-print');
  if (vpState.printTab === 'range') {
    printBtn.textContent = 'Print Range';
    mountRangeTab(body);
  } else {
    printBtn.textContent = 'Print Index';
    mountIndicesTab(body);
  }
}

/* --- PRINT STUDIO TAB 1: DATE RANGE --- */

function mountRangeTab(container) {
  container.innerHTML = `
    <div class="vp-studio-grid">
      <div class="vp-panel">
        <div class="vp-field">
          <label>Date Range</label>
          <div class="vp-date-pair">
            <input type="date" id="vp-r-start" class="vp-input" value="${esc(vpState.rangeStart)}" />
            <input type="date" id="vp-r-end" class="vp-input" value="${esc(vpState.rangeEnd)}" />
          </div>
          <div class="vp-chip-row" style="margin-top:4px;">
            <button type="button" class="vp-chip-btn vp-preset" data-preset="7">7D</button>
            <button type="button" class="vp-chip-btn vp-preset" data-preset="30">30D</button>
            <button type="button" class="vp-chip-btn vp-preset" data-preset="month">This Month</button>
            <button type="button" class="vp-chip-btn vp-preset" data-preset="year">This Year</button>
          </div>
        </div>

        <div class="vp-field">
          <label>Filter by Keyword or #Tag</label>
          <input type="search" id="vp-r-filter" class="vp-input" placeholder="All entries in range…" value="${esc(vpState.rangeFilter)}" />
        </div>

        <div id="vp-r-scan-box" style="display:flex;flex-direction:column;gap:6px;"></div>

        <details class="vp-accordion">
          <summary><span>Formatting &amp; Layout</span><span style="color:var(--vp-muted);font-weight:500;">▾</span></summary>
          <div class="vp-check-list">
            <div class="vp-field">
              <label>Custom Book Title</label>
              <input type="text" id="vp-r-title" class="vp-input" placeholder="Auto from date range" value="${esc(vpState.rangeDocTitle)}" />
            </div>
            <div class="vp-field">
              <label>Print Typography</label>
              <select id="vp-opt-font" class="vp-select">
                <option value="serif" ${vpState.rangeFont === 'serif' ? 'selected' : ''}>Book Serif (Georgia)</option>
                <option value="sans" ${vpState.rangeFont === 'sans' ? 'selected' : ''}>Clean Sans</option>
                <option value="mono" ${vpState.rangeFont === 'mono' ? 'selected' : ''}>Typewriter Mono</option>
              </select>
            </div>
            <label class="vp-check"><input type="checkbox" id="vp-opt-titles" ${vpState.rangeOptTitles ? 'checked' : ''} /> Index Titles &amp; Descriptions</label>
            <label class="vp-check"><input type="checkbox" id="vp-opt-hl" ${vpState.rangeOptHighlights ? 'checked' : ''} /> Color Text Highlights</label>
            <label class="vp-check"><input type="checkbox" id="vp-opt-meta" ${vpState.rangeOptMeta ? 'checked' : ''} /> Metadata Pills &amp; Word Counts</label>
            <label class="vp-check"><input type="checkbox" id="vp-opt-toc" ${vpState.rangeOptToc ? 'checked' : ''} /> Table of Contents Page</label>
            <label class="vp-check"><input type="checkbox" id="vp-opt-break" ${vpState.rangeOptPageBreak ? 'checked' : ''} /> Page Break Between Days</label>
          </div>
        </details>
      </div>

      <div class="vp-panel" id="vp-r-preview-panel"></div>
    </div>
  `;

  container.querySelector('#vp-r-start').addEventListener('change', (e) => {
    vpState.rangeStart = e.target.value;
    updateRangePreviewPanel();
  });
  container.querySelector('#vp-r-end').addEventListener('change', (e) => {
    vpState.rangeEnd = e.target.value;
    updateRangePreviewPanel();
  });
  container.querySelector('#vp-r-filter').addEventListener('input', (e) => {
    vpState.rangeFilter = e.target.value;
    updateRangePreviewPanel();
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
      updateRangePreviewPanel();
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

  updateRangeScanControls();
  updateRangePreviewPanel();
}

function updateRangeScanControls() {
  const box = document.getElementById('vp-r-scan-box');
  if (!box) return;
  if (vpState.rangeScanning) {
    box.innerHTML = `
      <div class="vp-notice">${esc(vpState.rangeScanProgress || 'Scanning unlocked diary…')}</div>
      <button type="button" id="vp-r-stop" class="vp-btn vp-btn-danger" style="width:100%;">Stop Scan</button>`;
    box.querySelector('#vp-r-stop').addEventListener('click', () => { vpScanCancelled = true; });
  } else {
    box.innerHTML = `
      <button type="button" id="vp-r-scan" class="vp-btn" style="width:100%;">Scan Unlocked Diary for Range</button>
      <span style="font-size:0.74rem;color:var(--vp-muted);line-height:1.4;">Pulls unvisited days in this range from your unlocked vault.</span>`;
    box.querySelector('#vp-r-scan').addEventListener('click', scanUnlockedVaultForRange);
  }
}

function updateRangePreviewPanel() {
  const panel = document.getElementById('vp-r-preview-panel');
  const footerMeta = document.getElementById('vp-footer-meta');
  if (!panel) return;

  const groups = getFilteredRangeGroups();
  const included = groups.filter((g) => !vpState.rangeExcludedDates.has(g.isoDate));
  const lockedDates = getLockedDatesInRange();
  const entriesCount = included.reduce((s, g) => s + g.entries.length, 0);
  const wordsCount = included.reduce((s, g) => s + g.entries.reduce((a, e) => a + e.words, 0), 0);

  if (footerMeta) {
    footerMeta.innerHTML = `<strong>${included.length}</strong> ${included.length === 1 ? 'day' : 'days'} · <strong>${entriesCount}</strong> ${entriesCount === 1 ? 'entry' : 'entries'} · <strong>${wordsCount.toLocaleString()}</strong> words`;
  }

  panel.innerHTML = `
    <div class="vp-preview-head">
      <h3>Selected Days (${included.length}/${groups.length})</h3>
      ${
        groups.length
          ? `<div style="display:flex;gap:5px;">
              <button type="button" id="vp-r-all" class="vp-btn vp-btn-ghost vp-btn-sm">All</button>
              <button type="button" id="vp-r-none" class="vp-btn vp-btn-ghost vp-btn-sm">None</button>
            </div>`
          : ''
      }
    </div>

    ${
      lockedDates.length
        ? `<div class="vp-notice">
            <strong>${lockedDates.length} encrypted ${lockedDates.length === 1 ? 'day' : 'days'} skipped:</strong> Unlock your vault first to include encrypted entries.
            <button type="button" id="vp-r-unlock" class="vp-btn vp-btn-sm" style="margin-left:8px;">Unlock Vault</button>
          </div>`
        : ''
    }

    <div class="vp-day-list">
      ${
        groups.length
          ? groups
              .map((g) => {
                const checked = !vpState.rangeExcludedDates.has(g.isoDate);
                const firstTitle = g.entries.find((e) => e.title)?.title || '';
                const words = g.entries.reduce((s, e) => s + e.words, 0);
                return `
              <div class="vp-day-row ${checked ? '' : 'is-dim'}">
                <div class="vp-day-row-top">
                  <label class="vp-check" style="font-weight:700;">
                    <input type="checkbox" class="vp-day-toggle" data-iso="${esc(g.isoDate)}" ${checked ? 'checked' : ''} />
                    <span style="color:var(--vp-gold);font-family:monospace;">${esc(g.isoDate)}</span>
                    ${firstTitle ? `<span>· ${esc(firstTitle)}</span>` : ''}
                  </label>
                  <div style="display:flex;gap:6px;align-items:center;">
                    <span style="font-size:0.74rem;color:var(--vp-muted);">${words.toLocaleString()}w</span>
                    <button type="button" class="vp-btn vp-btn-ghost vp-btn-sm vp-view-day" data-iso="${esc(g.isoDate)}">View</button>
                  </div>
                </div>
                <p class="vp-day-excerpt">${esc(g.entries[0].excerpt)}</p>
              </div>`;
              })
              .join('')
          : `<div class="vp-empty">No decrypted entries loaded between <strong>${esc(vpState.rangeStart)}</strong> and <strong>${esc(vpState.rangeEnd)}</strong>.<br/>Click <strong>Scan Unlocked Diary for Range</strong> on the left.</div>`
      }
    </div>
  `;

  panel.querySelector('#vp-r-all')?.addEventListener('click', () => {
    vpState.rangeExcludedDates.clear();
    updateRangePreviewPanel();
  });
  panel.querySelector('#vp-r-none')?.addEventListener('click', () => {
    groups.forEach((g) => vpState.rangeExcludedDates.add(g.isoDate));
    updateRangePreviewPanel();
  });
  panel.querySelector('#vp-r-unlock')?.addEventListener('click', triggerMainVaultUnlock);

  panel.querySelectorAll('.vp-day-toggle').forEach((chk) => {
    chk.addEventListener('change', () => {
      const iso = chk.getAttribute('data-iso');
      if (chk.checked) vpState.rangeExcludedDates.delete(iso);
      else vpState.rangeExcludedDates.add(iso);
      updateRangePreviewPanel();
    });
  });

  panel.querySelectorAll('.vp-view-day').forEach((btn) => {
    btn.addEventListener('click', () => openOneDayViewer(btn.getAttribute('data-iso')));
  });
}

/* --- PRINT STUDIO TAB 2: MASTER INDEX --- */

function mountIndicesTab(container) {
  const allYears = Array.from(
    new Set([
      ...loadPinnedDates().map((p) => p.year || p.isoDate.slice(0, 4)),
      ...loadHighlights().map((h) => h.year || h.isoDate.slice(0, 4)),
      ...collectAllKnownEntries().map((e) => e.year),
    ])
  ).sort((a, b) => b.localeCompare(a));

  container.innerHTML = `
    <div class="vp-studio-grid">
      <div class="vp-panel">
        <div class="vp-field">
          <label>Include Sections</label>
          <div class="vp-check-list" style="margin-top:2px;">
            <label class="vp-check"><input type="checkbox" id="vp-idx-pin" ${vpState.idxIncludePinned ? 'checked' : ''} /> Pinned Dates Index</label>
            <label class="vp-check"><input type="checkbox" id="vp-idx-hl" ${vpState.idxIncludeHighlights ? 'checked' : ''} /> Highlighted Passages</label>
            <label class="vp-check"><input type="checkbox" id="vp-idx-ent" ${vpState.idxIncludeEntries ? 'checked' : ''} /> Diary Entries Directory</label>
            <label class="vp-check"><input type="checkbox" id="vp-idx-tag" ${vpState.idxIncludeTags ? 'checked' : ''} /> #Tag Cross-Reference</label>
          </div>
        </div>

        <div class="vp-field">
          <label>Index Layout</label>
          <select id="vp-idx-layout" class="vp-select">
            <option value="section" ${vpState.idxLayout === 'section' ? 'selected' : ''}>Grouped by Section</option>
            <option value="year" ${vpState.idxLayout === 'year' ? 'selected' : ''}>Grouped by Year</option>
            <option value="timeline" ${vpState.idxLayout === 'timeline' ? 'selected' : ''}>Unified Chronological Timeline</option>
          </select>
        </div>

        <div class="vp-field">
          <label>Filter by Keyword or #Tag</label>
          <input type="search" id="vp-idx-q" class="vp-input" placeholder="All index items…" value="${esc(vpState.idxQuery)}" />
        </div>

        <details class="vp-accordion">
          <summary><span>Filters &amp; Formatting</span><span style="color:var(--vp-muted);font-weight:500;">▾</span></summary>
          <div class="vp-check-list">
            <div class="vp-field">
              <label>Date Range (Optional)</label>
              <div class="vp-date-pair">
                <input type="date" id="vp-idx-start" class="vp-input" value="${esc(vpState.idxStart)}" />
                <input type="date" id="vp-idx-end" class="vp-input" value="${esc(vpState.idxEnd)}" />
              </div>
            </div>
            <div class="vp-date-pair">
              <div class="vp-field">
                <label>Year</label>
                <select id="vp-idx-year" class="vp-select">
                  <option value="all" ${vpState.idxYear === 'all' ? 'selected' : ''}>All Years</option>
                  ${allYears.map((y) => `<option value="${esc(y)}" ${vpState.idxYear === y ? 'selected' : ''}>${esc(y)}</option>`).join('')}
                </select>
              </div>
              <div class="vp-field">
                <label>Sort</label>
                <select id="vp-idx-sort" class="vp-select">
                  <option value="oldest" ${vpState.idxSort === 'oldest' ? 'selected' : ''}>Oldest First</option>
                  <option value="newest" ${vpState.idxSort === 'newest' ? 'selected' : ''}>Newest First</option>
                  <option value="title" ${vpState.idxSort === 'title' ? 'selected' : ''}>By Title</option>
                </select>
              </div>
            </div>
            <div class="vp-field">
              <label>Document Title</label>
              <input type="text" id="vp-idx-title" class="vp-input" value="${esc(vpState.idxDocTitle)}" />
            </div>
            <div class="vp-field">
              <label>Print Typography</label>
              <select id="vp-idx-font" class="vp-select">
                <option value="serif" ${vpState.idxFont === 'serif' ? 'selected' : ''}>Book Serif (Georgia)</option>
                <option value="sans" ${vpState.idxFont === 'sans' ? 'selected' : ''}>Clean Sans</option>
                <option value="mono" ${vpState.idxFont === 'mono' ? 'selected' : ''}>Typewriter Mono</option>
              </select>
            </div>
            <label class="vp-check"><input type="checkbox" id="vp-idx-exc" ${vpState.idxIncludeExcerpts ? 'checked' : ''} /> Include text excerpts in Entry Directory</label>
          </div>
        </details>
      </div>

      <div class="vp-panel" id="vp-idx-preview-panel"></div>
    </div>
  `;

  container.querySelector('#vp-idx-pin').addEventListener('change', (e) => { vpState.idxIncludePinned = e.target.checked; updateIndicesPreviewPanel(); });
  container.querySelector('#vp-idx-hl').addEventListener('change', (e) => { vpState.idxIncludeHighlights = e.target.checked; updateIndicesPreviewPanel(); });
  container.querySelector('#vp-idx-ent').addEventListener('change', (e) => { vpState.idxIncludeEntries = e.target.checked; updateIndicesPreviewPanel(); });
  container.querySelector('#vp-idx-tag').addEventListener('change', (e) => { vpState.idxIncludeTags = e.target.checked; updateIndicesPreviewPanel(); });
  container.querySelector('#vp-idx-exc').addEventListener('change', (e) => { vpState.idxIncludeExcerpts = e.target.checked; });
  container.querySelector('#vp-idx-layout').addEventListener('change', (e) => { vpState.idxLayout = e.target.value; updateIndicesPreviewPanel(); });
  container.querySelector('#vp-idx-title').addEventListener('input', (e) => { vpState.idxDocTitle = e.target.value; });
  container.querySelector('#vp-idx-font').addEventListener('change', (e) => {
    vpState.idxFont = e.target.value;
    savePrefs({ idxFont: vpState.idxFont });
  });
  container.querySelector('#vp-idx-start').addEventListener('change', (e) => { vpState.idxStart = e.target.value; updateIndicesPreviewPanel(); });
  container.querySelector('#vp-idx-end').addEventListener('change', (e) => { vpState.idxEnd = e.target.value; updateIndicesPreviewPanel(); });
  container.querySelector('#vp-idx-year').addEventListener('change', (e) => { vpState.idxYear = e.target.value; updateIndicesPreviewPanel(); });
  container.querySelector('#vp-idx-sort').addEventListener('change', (e) => { vpState.idxSort = e.target.value; updateIndicesPreviewPanel(); });
  container.querySelector('#vp-idx-q').addEventListener('input', (e) => {
    vpState.idxQuery = e.target.value;
    updateIndicesPreviewPanel();
  });

  updateIndicesPreviewPanel();
}

function updateIndicesPreviewPanel() {
  const panel = document.getElementById('vp-idx-preview-panel');
  const footerMeta = document.getElementById('vp-footer-meta');
  if (!panel) return;

  const payload = getFilteredIndexPayload();
  const totalSelected =
    (vpState.idxIncludePinned ? payload.pinned.length : 0) +
    (vpState.idxIncludeHighlights ? payload.highlights.length : 0) +
    (vpState.idxIncludeEntries ? payload.entries.length : 0) +
    (vpState.idxIncludeTags ? payload.tags.length : 0);

  if (footerMeta) {
    footerMeta.innerHTML = `<strong>${payload.pinned.length}</strong> Pinned · <strong>${payload.highlights.length}</strong> Highlights · <strong>${payload.entries.length}</strong> Entries · <strong>${payload.tags.length}</strong> Tags`;
  }

  const previewItems = [];
  if (vpState.idxIncludePinned) payload.pinned.forEach((p) => previewItems.push({ ...p, kind: 'Pinned' }));
  if (vpState.idxIncludeHighlights) payload.highlights.forEach((h) => previewItems.push({ ...h, kind: 'Highlight' }));
  if (vpState.idxIncludeEntries) payload.entries.forEach((e) => previewItems.push({ ...e, kind: 'Entry' }));

  panel.innerHTML = `
    <div class="vp-preview-head">
      <h3>Index Preview (${totalSelected} items)</h3>
      <span style="font-size:0.75rem;color:var(--vp-muted);text-transform:capitalize;">${esc(vpState.idxLayout)} layout</span>
    </div>

    <div class="vp-day-list">
      ${
        previewItems.length
          ? previewItems
              .slice(0, 24)
              .map(
                (it) => `
              <div class="vp-day-row">
                <div class="vp-day-row-top">
                  <span style="font-size:0.82rem;font-weight:700;">
                    <span style="color:var(--vp-gold);font-family:monospace;">${esc(it.isoDate)}</span>
                    ${it.title ? ` · ${esc(it.title)}` : ''}
                  </span>
                  <span class="vp-pill">${esc(it.kind)}</span>
                </div>
                ${it.description ? `<p class="vp-day-excerpt" style="margin-left:0;">${esc(it.description)}</p>` : ''}
                ${it.quote ? `<p class="vp-day-excerpt" style="margin-left:0;font-style:italic;">“${esc(makeExcerpt(it.quote, 130))}”</p>` : ''}
                ${!it.quote && it.excerpt ? `<p class="vp-day-excerpt" style="margin-left:0;">${esc(it.excerpt)}</p>` : ''}
              </div>`
              )
              .join('')
          : totalSelected > 0
          ? `<div class="vp-empty">Ready to print <strong>${payload.tags.length} #Tags</strong> in a clean 2-column cross-reference grid.</div>`
          : `<div class="vp-empty">No index items match your current selection or filter.</div>`
      }
      ${previewItems.length > 24 ? `<div style="text-align:center;font-size:0.76rem;color:var(--vp-muted);padding:6px;">+${previewItems.length - 24} more items included in print output</div>` : ''}
    </div>
  `;
}

/* ==========================================================================
   9. TRIGGER INJECTION & BOOTSTRAP
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
  dayBtn.textContent = 'Day View';
  dayBtn.title = 'Focused Single-Day Reading Sheet';
  dayBtn.addEventListener('click', () => openOneDayViewer());

  const printBtn = document.createElement('button');
  printBtn.type = 'button';
  printBtn.id = 'vp-print-trigger';
  printBtn.className = 'plug-trigger-btn';
  printBtn.textContent = 'Print';
  printBtn.title = 'Print Date Range or Master Index';
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
    const relevant = muts.some((m) => !m.target?.closest?.('.plug-backdrop, .vp-backdrop, #pdx-sel-bar, #vp-day-sel-bar, #plug-toast'));
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

