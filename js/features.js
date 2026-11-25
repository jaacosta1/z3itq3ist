/**
 * js/features.js — Perpetual Side-by-Side Web Diary Editorial & Utility Engine (File 7 of 11 · Final Build)
 *
 * Consolidates Phases 13–15, 17, 19, and 20 into one zero-dependency ES6 module:
 * - Phase 13: Bi-Directional Wiki-Link Backlinks & Story Arcs (`arc:...`) "Book View"
 * - Phase 14: Perpetual "On This Week / Season" Views & Time Capsules (`sealedUntil`)
 * - Phase 15: Year-in-Review Auto-Dossier & Word Velocity / Mood Matrix Analytics
 * - Phase 17: Reusable Entry Templates, Curated Prompt Decks & Command Palette (`Ctrl+K`) scorer
 * - Phase 19: Cultural Artifacts Strip, Opt-In Location & Weather Stamp (Open-Meteo),
 *             Custom Daily Check-In Metrics & Multi-Metric Heatmaps
 * - Phase 20: Editorial Theme Presets (4 themes), Offline Commit Queue, Print-to-Book &
 *             8-Page Foldable Mini-Zine Imposition, and Migration Importers (Perpetual / Day One / Journey / Markdown)
 */

import { extractWikiLinks, renderMarkdown, stripMarkdown, countWords } from './markdown.js';

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const CUSTOM_TEMPLATES_KEY = 'perpetual_diary_custom_templates_v1';
const CUSTOM_METRICS_KEY = 'perpetual_diary_checkin_metrics_v1';
const OFFLINE_QUEUE_KEY = 'perpetual_diary_offline_queue_v1';
const THEME_STORAGE_KEY = 'perpetual_diary_theme';

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

export function getAll366DayKeys() {
  const keys = [];
  for (let m = 1; m <= 12; m += 1) {
    for (let d = 1; d <= DAYS_IN_MONTH[m - 1]; d += 1) {
      keys.push(`${pad2(m)}-${pad2(d)}`);
    }
  }
  return keys;
}

export function formatReadableDayKey(dayStr) {
  const m = /^(\d{2})-(\d{2})$/.exec(String(dayStr || ''));
  if (!m) return String(dayStr || '');
  const monthIdx = Math.min(11, Math.max(0, Number(m[1]) - 1));
  return `${MONTHS_SHORT_SAFE(monthIdx, false)} ${Number(m[2])}`;
}

function MONTHS_SHORT_SAFE(idx, short = false) {
  const full = MONTH_NAMES[idx] || 'January';
  return short ? full.slice(0, 3) : full;
}

/* ============================================================================
   PHASE 13: BI-DIRECTIONAL WIKI-LINK BACKLINKS & STORY ARCS ("BOOK VIEW")
   ============================================================================ */

/**
 * Computes all incoming backlinks pointing to a given calendar day (`MM-DD`) or exact date (`YYYY-MM-DD`).
 * Scans all currently loaded/decrypted plain entries without requiring extra GitHub API calls.
 *
 * @param {string} targetDayStr - e.g. "11-24"
 * @param {string | number | null} targetYear - optional specific year, e.g. "2024"
 * @param {Array<{ diaryDate: string, dayStr: string, year: number, title: string, body: string }>} plainEntries
 * @returns {Array<{ sourceDate: string, sourceDayStr: string, sourceYear: number, sourceTitle: string, snippet: string, matchedLabel: string }>}
 */
export function computeBacklinksForDate(targetDayStr, targetYear, plainEntries = []) {
  const cleanDay = String(targetDayStr || '').trim();
  const cleanYear = targetYear ? String(targetYear).trim() : '';
  const exactTarget = cleanYear ? `${cleanYear}-${cleanDay}` : '';

  const results = [];
  const seen = new Set();

  for (const entry of plainEntries) {
    if (!entry || !entry.body) continue;
    // Skip self-links from the exact same entry
    if (exactTarget && entry.diaryDate === exactTarget) continue;

    const links = extractWikiLinks(entry.body);
    for (const link of links) {
      const matchesExact = Boolean(exactTarget && link.target === exactTarget);
      const matchesDayWide = !link.year && link.dayStr === cleanDay;
      const matchesAnyYearOnDay = !cleanYear && link.dayStr === cleanDay;

      if (!matchesExact && !matchesDayWide && !matchesAnyYearOnDay) continue;

      const dedupeKey = `${entry.diaryDate}::${link.target}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const plainText = stripMarkdown(entry.body);
      const snippet =
        plainText.length > 140 ? `${plainText.slice(0, 140).trim()}…` : plainText;

      results.push({
        sourceDate: entry.diaryDate,
        sourceDayStr: entry.dayStr || entry.diaryDate.slice(5),
        sourceYear: Number(entry.year) || Number(entry.diaryDate.slice(0, 4)),
        sourceTitle: entry.title || `${formatReadableDayKey(entry.dayStr)} · ${entry.year}`,
        snippet,
        matchedLabel: link.label,
      });
    }
  }

  return results.sort((a, b) => b.sourceDate.localeCompare(a.sourceDate));
}

/**
 * Extracts all Story Arcs (`arc:<name>`) across the manifest index and loaded entries.
 *
 * @param {Object} indexData
 * @returns {Array<{ slug: string, label: string, tag: string, entryCount: number, days: string[], years: number[] }>}
 */
export function extractStoryArcs(indexData) {
  const daysMap = indexData?.days || {};
  const arcMap = new Map();

  for (const [dayStr, info] of Object.entries(daysMap)) {
    const tags = Array.isArray(info?.tags) ? info.tags : [];
    const years = Array.isArray(info?.years) ? info.years : [];

    for (const rawTag of tags) {
      const t = String(rawTag || '').trim();
      if (!t.toLowerCase().startsWith('arc:')) continue;
      const slug = t.slice(4).trim();
      if (!slug) continue;

      const key = slug.toLowerCase();
      if (!arcMap.has(key)) {
        arcMap.set(key, {
          slug,
          label: slug
            .split(/[-_]+/)
            .filter(Boolean)
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
            .join(' '),
          tag: t,
          daySet: new Set(),
          yearSet: new Set(),
        });
      }
      const bucket = arcMap.get(key);
      bucket.daySet.add(dayStr);
      years.forEach((y) => bucket.yearSet.add(Number(y)));
    }
  }

  return Array.from(arcMap.values())
    .map((b) => ({
      slug: b.slug,
      label: b.label,
      tag: b.tag,
      entryCount: b.daySet.size,
      days: Array.from(b.daySet).sort(),
      years: Array.from(b.yearSet).sort((a, bYear) => a - bYear),
    }))
    .sort((a, b) => b.entryCount - a.entryCount || a.label.localeCompare(b.label));
}

/**
 * Assembles a chronological "Book View" for a given Story Arc (`arc:<slug>`).
 *
 * @param {string} arcSlug
 * @param {Array<Object>} plainEntries
 * @returns {{ slug: string, title: string, chapters: Array<Object>, totalWords: number, dateSpan: string }}
 */
export function buildStoryArcBook(arcSlug, plainEntries = []) {
  const targetTag = `arc:${String(arcSlug || '').trim().toLowerCase()}`;
  const chapters = plainEntries
    .filter((e) =>
      Array.isArray(e?.tags) &&
      e.tags.some((t) => String(t || '').trim().toLowerCase() === targetTag)
    )
    .sort((a, b) => String(a.diaryDate || '').localeCompare(String(b.diaryDate || '')));

  let totalWords = 0;
  for (const ch of chapters) {
    totalWords += countWords(ch.body || '');
  }

  const firstDate = chapters[0]?.diaryDate || '';
  const lastDate = chapters[chapters.length - 1]?.diaryDate || '';
  const dateSpan =
    firstDate && lastDate
      ? firstDate === lastDate
        ? firstDate
        : `${firstDate} → ${lastDate}`
      : 'No chapters loaded';

  const title = String(arcSlug || '')
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

  return {
    slug: arcSlug,
    title: title || arcSlug,
    chapters,
    totalWords,
    dateSpan,
  };
}

/* ============================================================================
   PHASE 14: PERPETUAL "ON THIS WEEK / SEASON" VIEWS & TIME CAPSULES
   ============================================================================ */

export const SEASONS = Object.freeze({
  spring: { id: 'spring', label: 'Spring (Mar – May)', months: [3, 4, 5], glyph: '❀' },
  summer: { id: 'summer', label: 'Summer (Jun – Aug)', months: [6, 7, 8], glyph: '☀' },
  autumn: { id: 'autumn', label: 'Autumn (Sep – Nov)', months: [9, 10, 11], glyph: '🍂' },
  winter: { id: 'winter', label: 'Winter (Dec – Feb)', months: [12, 1, 2], glyph: '❄' },
});

/**
 * Returns a rolling perpetual calendar window around `centerDayStr` (e.g. radius 3 = 7 days),
 * wrapping cleanly across Dec 31 ↔ Jan 1.
 * @param {string} centerDayStr
 * @param {number} [radius=3]
 * @returns {string[]}
 */
export function getCalendarDaysWindow(centerDayStr, radius = 3) {
  const all = getAll366DayKeys();
  const centerIdx = Math.max(0, all.indexOf(centerDayStr));
  const out = [];
  for (let offset = -radius; offset <= radius; offset += 1) {
    const idx = (centerIdx + offset + all.length) % all.length;
    out.push(all[idx]);
  }
  return out;
}

/**
 * Determines the meteorological season for any `MM-DD` day string.
 * @param {string} dayStr
 */
export function getSeasonForDay(dayStr) {
  const month = Number(String(dayStr || '01-01').slice(0, 2)) || 1;
  if (month >= 3 && month <= 5) return SEASONS.spring;
  if (month >= 6 && month <= 8) return SEASONS.summer;
  if (month >= 9 && month <= 11) return SEASONS.autumn;
  return SEASONS.winter;
}

/**
 * Returns all `MM-DD` keys belonging to a given season (`spring` | `summer` | `autumn` | `winter`).
 * @param {string} seasonId
 * @returns {string[]}
 */
export function getSeasonDayKeys(seasonId) {
  const season = SEASONS[seasonId] || SEASONS.autumn;
  const out = [];
  for (const m of season.months) {
    for (let d = 1; d <= DAYS_IN_MONTH[m - 1]; d += 1) {
      out.push(`${pad2(m)}-${pad2(d)}`);
    }
  }
  return out;
}

/**
 * Collects indexed entries within a list of perpetual calendar `MM-DD` keys.
 * @param {Object} indexData
 * @param {string[]} dayKeys
 * @returns {Array<{ dayStr: string, readableDay: string, years: number[], tags: string[], wordCounts: Object }>}
 */
export function collectIndexedWindowEntries(indexData, dayKeys = []) {
  const daysMap = indexData?.days || {};
  const results = [];
  for (const dayStr of dayKeys) {
    const info = daysMap[dayStr];
    if (!info || !Array.isArray(info.years) || info.years.length === 0) continue;
    results.push({
      dayStr,
      readableDay: formatReadableDayKey(dayStr),
      years: [...info.years].sort((a, b) => a - b),
      tags: Array.isArray(info.tags) ? info.tags : [],
      wordCounts: info.wordCounts || {},
    });
  }
  return results;
}

/**
 * Evaluates whether a Time Capsule entry (`entry.sealedUntil = "YYYY-MM-DD"`) is still sealed.
 * @param {Object | null} entry
 * @param {Date} [nowDate=new Date()]
 * @returns {{ hasCapsule: boolean, isSealed: boolean, sealedUntil: string, daysRemaining: number, isNewlyUnlocked: boolean }}
 */
export function getTimeCapsuleStatus(entry, nowDate = new Date()) {
  const raw = String(entry?.sealedUntil || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return {
      hasCapsule: false,
      isSealed: false,
      sealedUntil: '',
      daysRemaining: 0,
      isNewlyUnlocked: false,
    };
  }

  const todayIso = `${nowDate.getFullYear()}-${pad2(nowDate.getMonth() + 1)}-${pad2(
    nowDate.getDate()
  )}`;

  const [sy, sm, sd] = raw.split('-').map(Number);
  const [ty, tm, td] = todayIso.split('-').map(Number);
  const sealUtc = Date.UTC(sy, sm - 1, sd);
  const todayUtc = Date.UTC(ty, tm - 1, td);
  const diffDays = Math.ceil((sealUtc - todayUtc) / 86400000);

  return {
    hasCapsule: true,
    isSealed: diffDays > 0,
    sealedUntil: raw,
    daysRemaining: Math.max(0, diffDays),
    isNewlyUnlocked: diffDays <= 0 && diffDays >= -7,
  };
}

/* ============================================================================
   PHASE 15: YEAR-IN-REVIEW AUTO-DOSSIER & WORD VELOCITY / MOOD MATRIX ANALYTICS
   ============================================================================ */

/**
 * Computes longitudinal analytics across the entire diary manifest and any loaded plain entries.
 * @param {Object} indexData
 * @param {Array<Object>} [plainEntries=[]]
 */
export function computeDiaryAnalytics(indexData, plainEntries = []) {
  const daysMap = indexData?.days || {};
  const yearStats = new Map();
  const monthlyWords = Array(12).fill(0);
  const monthlyEntries = Array(12).fill(0);
  const moodCounts = new Map();
  const moodByYear = new Map();
  const tagCounts = new Map();
  const recordedIsoDates = [];

  let totalEntries = 0;
  let totalWords = 0;
  let totalComments = 0;
  let sealedCapsules = 0;

  // Build quick lookup from loaded plain entries for accurate encrypted word counts & moods
  const plainByIso = new Map();
  for (const e of plainEntries) {
    if (e?.diaryDate) plainByIso.set(e.diaryDate, e);
  }

  for (const [dayStr, info] of Object.entries(daysMap)) {
    const monthIdx = Math.min(11, Math.max(0, (Number(dayStr.slice(0, 2)) || 1) - 1));
    totalComments += Number(info?.commentCount || 0);

    for (const tag of info?.tags || []) {
      const clean = String(tag || '').trim();
      if (clean) tagCounts.set(clean, (tagCounts.get(clean) || 0) + 1);
    }

    for (const yr of info?.years || []) {
      const yrNum = Number(yr);
      const yrKey = String(yrNum);
      const iso = `${yrKey}-${dayStr}`;
      recordedIsoDates.push(iso);

      const loadedPlain = plainByIso.get(iso);
      const words = loadedPlain
        ? countWords(loadedPlain.body || '')
        : Number(info?.wordCounts?.[yrKey] || 0);
      const mood = String(loadedPlain?.mood || info?.moods?.[yrKey] || '')
        .trim()
        .toLowerCase();

      if (info?.sealed?.[yrKey]) {
        const capStatus = getTimeCapsuleStatus({ sealedUntil: info.sealed[yrKey] });
        if (capStatus.isSealed) sealedCapsules += 1;
      }

      totalEntries += 1;
      totalWords += words;
      monthlyWords[monthIdx] += words;
      monthlyEntries[monthIdx] += 1;

      if (!yearStats.has(yrNum)) {
        yearStats.set(yrNum, { year: yrNum, entries: 0, words: 0, activeMonths: new Set() });
      }
      const ys = yearStats.get(yrNum);
      ys.entries += 1;
      ys.words += words;
      ys.activeMonths.add(monthIdx);

      if (mood) {
        moodCounts.set(mood, (moodCounts.get(mood) || 0) + 1);
        if (!moodByYear.has(yrNum)) moodByYear.set(yrNum, new Map());
        const ym = moodByYear.get(yrNum);
        ym.set(mood, (ym.get(mood) || 0) + 1);
      }
    }
  }

  // Compute longest consecutive-day writing streak across all recorded ISO dates
  recordedIsoDates.sort();
  let longestStreak = 0;
  let currentStreak = 0;
  let prevUtc = null;

  for (const iso of recordedIsoDates) {
    const [y, m, d] = iso.split('-').map(Number);
    if (!y || !m || !d) continue;
    const utc = Date.UTC(y, m - 1, d);
    if (prevUtc !== null && utc - prevUtc === 86400000) {
      currentStreak += 1;
    } else if (prevUtc !== utc) {
      currentStreak = 1;
    }
    if (currentStreak > longestStreak) longestStreak = currentStreak;
    prevUtc = utc;
  }

  const yearsBreakdown = Array.from(yearStats.values())
    .map((y) => ({
      year: y.year,
      entries: y.entries,
      words: y.words,
      avgWords: y.entries > 0 ? Math.round(y.words / y.entries) : 0,
      activeMonths: y.activeMonths.size,
    }))
    .sort((a, b) => a.year - b.year);

  const topMoods = Array.from(moodCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([mood, count]) => ({ mood, count }));

  const topTags = Array.from(tagCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 16)
    .map(([tag, count]) => ({ tag, count }));

  const calendarCoveragePct = Number(
    ((Object.keys(daysMap).length / 366) * 100).toFixed(1)
  );

  return {
    totalEntries,
    totalWords,
    totalComments,
    sealedCapsules,
    uniqueCalendarDays: Object.keys(daysMap).length,
    calendarCoveragePct,
    avgWordsPerEntry: totalEntries > 0 ? Math.round(totalWords / totalEntries) : 0,
    longestStreak,
    yearsBreakdown,
    monthlyWords,
    monthlyEntries,
    topMoods,
    moodByYear,
    topTags,
  };
}

/**
 * Generates a Year-in-Review Auto-Dossier for a single calendar year.
 * @param {number | string} year
 * @param {Object} indexData
 * @param {Array<Object>} [plainEntries=[]]
 */
export function generateYearInReviewDossier(year, indexData, plainEntries = []) {
  const yrNum = Number(year);
  const yrKey = String(yrNum);
  const daysMap = indexData?.days || {};

  const monthCounts = Array(12).fill(0);
  const monthWords = Array(12).fill(0);
  const moodMap = new Map();
  const tagMap = new Map();
  const arcSet = new Set();
  const yearPlainEntries = plainEntries
    .filter((e) => Number(e?.year) === yrNum)
    .sort((a, b) => String(a.diaryDate || '').localeCompare(String(b.diaryDate || '')));

  const plainLookup = new Map(yearPlainEntries.map((e) => [e.diaryDate, e]));

  let entryCount = 0;
  let totalWords = 0;
  let longestEntry = null;
  let firstEntryDate = '';
  let lastEntryDate = '';

  for (const [dayStr, info] of Object.entries(daysMap)) {
    if (!Array.isArray(info?.years) || !info.years.includes(yrNum)) continue;
    const iso = `${yrKey}-${dayStr}`;
    const mIdx = Math.min(11, Math.max(0, (Number(dayStr.slice(0, 2)) || 1) - 1));
    const plain = plainLookup.get(iso);

    const words = plain
      ? countWords(plain.body || '')
      : Number(info?.wordCounts?.[yrKey] || 0);
    const mood = String(plain?.mood || info?.moods?.[yrKey] || '').trim().toLowerCase();
    const tags = Array.isArray(plain?.tags) ? plain.tags : info?.tags || [];

    entryCount += 1;
    totalWords += words;
    monthCounts[mIdx] += 1;
    monthWords[mIdx] += words;

    if (!firstEntryDate || iso < firstEntryDate) firstEntryDate = iso;
    if (!lastEntryDate || iso > lastEntryDate) lastEntryDate = iso;

    if (!longestEntry || words > longestEntry.words) {
      longestEntry = {
        diaryDate: iso,
        dayStr,
        title: plain?.title || formatReadableDayKey(dayStr),
        words,
      };
    }

    if (mood) moodMap.set(mood, (moodMap.get(mood) || 0) + 1);
    for (const t of tags) {
      const clean = String(t || '').trim();
      if (!clean) continue;
      tagMap.set(clean, (tagMap.get(clean) || 0) + 1);
      if (clean.toLowerCase().startsWith('arc:')) arcSet.add(clean.slice(4).trim());
    }
  }

  let busiestMonthIdx = 0;
  for (let i = 1; i < 12; i += 1) {
    if (monthWords[i] > monthWords[busiestMonthIdx]) busiestMonthIdx = i;
  }

  // Pull up to 6 notable highlights (blockquotes or titled entries) from loaded plain entries
  const highlights = [];
  for (const e of yearPlainEntries) {
    if (highlights.length >= 6) break;
    const quoteMatch = /^\s*>\s*(?!\[!)(.+)$/m.exec(e.body || '');
    if (quoteMatch) {
      highlights.push({
        diaryDate: e.diaryDate,
        dayStr: e.dayStr || e.diaryDate.slice(5),
        title: e.title || formatReadableDayKey(e.diaryDate.slice(5)),
        excerpt: stripMarkdown(quoteMatch[1]),
      });
    } else if (e.title && countWords(e.body || '') >= 25) {
      const plain = stripMarkdown(e.body || '');
      highlights.push({
        diaryDate: e.diaryDate,
        dayStr: e.dayStr || e.diaryDate.slice(5),
        title: e.title,
        excerpt: plain.length > 160 ? `${plain.slice(0, 160).trim()}…` : plain,
      });
    }
  }

  return {
    year: yrNum,
    entryCount,
    totalWords,
    avgWords: entryCount > 0 ? Math.round(totalWords / entryCount) : 0,
    firstEntryDate,
    lastEntryDate,
    busiestMonth: MONTH_NAMES[busiestMonthIdx],
    busiestMonthWords: monthWords[busiestMonthIdx],
    monthCounts,
    monthWords,
    longestEntry,
    topMoods: Array.from(moodMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([mood, count]) => ({ mood, count })),
    topTags: Array.from(tagMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([tag, count]) => ({ tag, count })),
    storyArcs: Array.from(arcSet),
    highlights,
  };
}

/**
 * Formats a Year-in-Review Dossier as a clean archival Markdown document for download.
 */
export function renderYearDossierMarkdown(dossier) {
  if (!dossier) return '';
  const lines = [
    `# ${dossier.year} — Year-in-Review Dossier`,
    `Generated by Perpetual Side-by-Side Diary on ${new Date().toISOString().slice(0, 10)}`,
    '',
    '## Overview',
    `- **Entries Recorded:** ${dossier.entryCount}`,
    `- **Total Words:** ${dossier.totalWords.toLocaleString()} (avg ${dossier.avgWords} words/entry)`,
    `- **Active Span:** ${dossier.firstEntryDate || '—'} to ${dossier.lastEntryDate || '—'}`,
    `- **Busiest Month:** ${dossier.busiestMonth} (${dossier.busiestMonthWords.toLocaleString()} words)`,
  ];

  if (dossier.longestEntry) {
    lines.push(
      `- **Longest Entry:** ${dossier.longestEntry.diaryDate} — *${dossier.longestEntry.title}* (${dossier.longestEntry.words} words)`
    );
  }

  if (dossier.topMoods.length) {
    lines.push(
      '',
      '## Dominant Moods',
      ...dossier.topMoods.map((m) => `- **${m.mood}** (${m.count})`)
    );
  }

  if (dossier.topTags.length) {
    lines.push(
      '',
      '## Recurring Themes & Tags',
      dossier.topTags.map((t) => `#${t.tag} (${t.count})`).join(' · ')
    );
  }

  if (dossier.highlights.length) {
    lines.push('', '## Notable Excerpts & Quotes');
    for (const h of dossier.highlights) {
      lines.push('', `### ${h.diaryDate} — ${h.title}`, `> ${h.excerpt}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

/* ============================================================================
   PHASE 17: ENTRY TEMPLATES, CURATED PROMPT DECKS & COMMAND PALETTE SCORER
   ============================================================================ */

export const BUILT_IN_TEMPLATES = Object.freeze([
  {
    id: 'tpl-daily-anchor',
    name: 'Daily Anchor',
    mood: 'grounded',
    tags: 'reflection, daily',
    preserveWhitespace: false,
    body: [
      '## What mattered today',
      '',
      '',
      '> [!reflection] One quiet observation',
      '> ',
      '',
      '## Three small anchors',
      '- ',
      '- ',
      '- ',
    ].join('\n'),
  },
  {
    id: 'tpl-evening-examen',
    name: 'Evening Examen',
    mood: 'reflective',
    tags: 'evening, gratitude',
    preserveWhitespace: false,
    body: [
      '### Moments of energy',
      '- ',
      '',
      '### Friction or lesson',
      '- ',
      '',
      '### Carrying into tomorrow',
      '- [ ] ',
    ].join('\n'),
  },
  {
    id: 'tpl-verse-sheet',
    name: 'Verse / Formalist Prose',
    mood: 'contemplative',
    tags: 'verse, writing',
    preserveWhitespace: true,
    body: [
      'First line of the stanza,',
      '    indented echo beneath it,',
      '        holding its exact breath.',
      '',
      'Second stanza begins here.',
    ].join('\n'),
  },
  {
    id: 'tpl-time-capsule',
    name: 'Letter to Future Self (Time Capsule)',
    mood: 'hopeful',
    tags: 'time-capsule, letter',
    preserveWhitespace: false,
    body: [
      '> [!milestone] Sealed for my future self',
      '> Remember how this season actually felt from the inside.',
      '',
      'Dear Future Me,',
      '',
      'Right now I am focused on…',
      '',
      'Questions I hope you can answer by the time this unseals:',
      '1. ',
      '2. ',
    ].join('\n'),
  },
  {
    id: 'tpl-cultural-notes',
    name: 'Reading & Craft Log',
    mood: 'curious',
    tags: 'craft, reading',
    preserveWhitespace: false,
    body: [
      '## Notes & Marginalia',
      '',
      '> Paste a line worth keeping here.^[Add a margin sidenote on why it stayed with you.]',
      '',
      'How this connects to what I am building:[^1]',
      '',
      '[^1]: Reference or page number.',
    ].join('\n'),
  },
]);

export function loadCustomTemplates(zeroFootprint = false) {
  if (zeroFootprint) return [];
  try {
    const raw = window.localStorage.getItem(CUSTOM_TEMPLATES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveCustomTemplate(tpl, zeroFootprint = false) {
  const clean = {
    id: tpl.id || `tpl-custom-${Date.now().toString(36)}`,
    name: String(tpl.name || 'Custom Template').trim(),
    mood: String(tpl.mood || '').trim(),
    tags: String(tpl.tags || '').trim(),
    preserveWhitespace: Boolean(tpl.preserveWhitespace),
    body: String(tpl.body || ''),
    custom: true,
  };
  const existing = loadCustomTemplates(zeroFootprint).filter((t) => t.id !== clean.id);
  const next = [clean, ...existing];
  if (!zeroFootprint) {
    try {
      window.localStorage.setItem(CUSTOM_TEMPLATES_KEY, JSON.stringify(next));
    } catch {
      // ignore storage errors
    }
  }
  return next;
}

export function deleteCustomTemplate(tplId, zeroFootprint = false) {
  const next = loadCustomTemplates(zeroFootprint).filter((t) => t.id !== tplId);
  if (!zeroFootprint) {
    try {
      window.localStorage.setItem(CUSTOM_TEMPLATES_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  }
  return next;
}

export const PROMPT_DECKS = Object.freeze({
  longitudinal: {
    label: 'Longitudinal / Time',
    prompts: [
      'What feels urgent today that probably will not matter twelve months from now?',
      'Which small habit from earlier this year quietly compounded into today?',
      'If you reread this page three years from today, what sensory detail do you hope you wrote down?',
      'What belief or routine have you outgrown without noticing until recently?',
      'What is one conversation from this week you want to remember verbatim?',
    ],
  },
  inquiry: {
    label: 'Self-Inquiry',
    prompts: [
      'Where did you feel most like yourself today, and what were you doing?',
      'What have you been postponing simply because the first step feels slightly uncomfortable?',
      'Who quietly made your week lighter, and have you told them?',
      'What boundary protected your peace recently?',
      'If today were a chapter title in a memoir, what would you call it?',
    ],
  },
  craft: {
    label: 'Craft & Work',
    prompts: [
      'What problem became clearer once you stepped away from the screen?',
      'What is one thing you built, fixed, or refined today that you are quietly proud of?',
      'Which distraction cost the most focus today, and how can tomorrow start cleaner?',
      'What skill are you noticeably better at today than on this same date last year?',
    ],
  },
  senses: {
    label: 'Memory & Senses',
    prompts: [
      'Describe the weather, light, and ambient sound around you right now.',
      'What meal, coffee, or small ritual anchored the middle of your day?',
      'Capture a brief street scene or detail you noticed in passing today.',
      'What song, book, or film colored the mood of this week?',
    ],
  },
});

export function drawRandomPrompt(category = 'all', excludeText = '') {
  let pool = [];
  if (category && PROMPT_DECKS[category]) {
    pool = PROMPT_DECKS[category].prompts.map((text) => ({
      category,
      categoryLabel: PROMPT_DECKS[category].label,
      text,
    }));
  } else {
    for (const [catId, deck] of Object.entries(PROMPT_DECKS)) {
      for (const text of deck.prompts) {
        pool.push({ category: catId, categoryLabel: deck.label, text });
      }
    }
  }

  const filtered = pool.filter((p) => p.text !== excludeText);
  const source = filtered.length ? filtered : pool;
  return source[Math.floor(Math.random() * source.length)] || null;
}

/**
 * Scores and filters Command Palette (`Ctrl+K`) actions with fuzzy token matching.
 * @param {Array<{ id: string, title: string, subtitle?: string, keywords?: string, group?: string, shortcut?: string, run: Function }>} commands
 * @param {string} query
 */
export function filterCommands(commands, query = '') {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return commands;

  const tokens = q.split(/\s+/).filter(Boolean);
  const scored = [];

  for (const cmd of commands) {
    const title = String(cmd.title || '').toLowerCase();
    const hay = `${title} ${cmd.subtitle || ''} ${cmd.keywords || ''} ${cmd.group || ''}`.toLowerCase();

    let score = 0;
    let matchedAll = true;
    for (const tok of tokens) {
      const idx = hay.indexOf(tok);
      if (idx === -1) {
        matchedAll = false;
        break;
      }
      score += title.startsWith(tok) ? 40 : title.includes(tok) ? 20 : 8;
    }

    if (matchedAll) {
      scored.push({ cmd, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.cmd);
}

/* ============================================================================
   PHASE 19: CULTURAL ARTIFACTS, WEATHER/LOCATION STAMP & DAILY CHECK-IN METRICS
   ============================================================================ */

export const ARTIFACT_FIELDS = Object.freeze([
  { key: 'reading', label: 'Reading', icon: '📖', placeholder: 'Book or essay' },
  { key: 'listening', label: 'Listening', icon: '♫', placeholder: 'Album or track' },
  { key: 'watching', label: 'Watching', icon: '▣', placeholder: 'Film or series' },
  { key: 'drinking', label: 'Ritual', icon: '☕', placeholder: 'Coffee, tea, or meal' },
  { key: 'quote', label: 'Anchor Line', icon: '❝', placeholder: 'Overheard line or thought' },
]);

export function normalizeArtifacts(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const f of ARTIFACT_FIELDS) {
    const val = String(raw[f.key] || '').trim();
    if (val) out[f.key] = val;
  }
  return Object.keys(out).length > 0 ? out : null;
}

const WMO_WEATHER_LABELS = Object.freeze({
  0: { label: 'Clear Sky', icon: '☀' },
  1: { label: 'Mainly Clear', icon: '🌤' },
  2: { label: 'Partly Cloudy', icon: '⛅' },
  3: { label: 'Overcast', icon: '☁' },
  45: { label: 'Foggy', icon: '🌫' },
  48: { label: 'Rime Fog', icon: '🌫' },
  51: { label: 'Light Drizzle', icon: '🌦' },
  53: { label: 'Drizzle', icon: '🌦' },
  55: { label: 'Dense Drizzle', icon: '🌧' },
  61: { label: 'Light Rain', icon: '🌧' },
  63: { label: 'Rain', icon: '🌧' },
  65: { label: 'Heavy Rain', icon: '⛈' },
  71: { label: 'Light Snow', icon: '❄' },
  73: { label: 'Snow', icon: '❄' },
  75: { label: 'Heavy Snow', icon: '❄' },
  80: { label: 'Rain Showers', icon: '🌦' },
  81: { label: 'Heavy Showers', icon: '🌧' },
  95: { label: 'Thunderstorm', icon: '⛈' },
});

/**
 * Strictly opt-in one-click Location & Weather Stamp using Browser Geolocation +
 * keyless Open-Meteo API and OpenStreetMap Nominatim reverse geocoding.
 * Never called automatically; only runs when the user clicks "Stamp Weather & Place".
 *
 * @returns {Promise<{ place: string, weather: string, tempC: number, icon: string, stampText: string }>}
 */
export async function fetchCurrentLocationAndWeather() {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    throw new Error('Browser geolocation is unavailable on this device.');
  }

  const pos = await new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: false,
      timeout: 10000,
      maximumAge: 300000,
    });
  }).catch((err) => {
    throw new Error(
      err?.code === 1
        ? 'Location permission was denied. You can still type location & weather manually.'
        : 'Could not determine current coordinates.'
    );
  });

  const lat = Number(pos.coords.latitude.toFixed(3));
  const lon = Number(pos.coords.longitude.toFixed(3));

  const [weatherRes, geoRes] = await Promise.allSettled([
    fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&timezone=auto`,
      { cache: 'no-store' }
    ).then((r) => (r.ok ? r.json() : null)),
    fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=10`,
      { headers: { Accept: 'application/json' }, cache: 'no-store' }
    ).then((r) => (r.ok ? r.json() : null)),
  ]);

  const wData = weatherRes.status === 'fulfilled' ? weatherRes.value : null;
  const gData = geoRes.status === 'fulfilled' ? geoRes.value : null;

  const tempC =
    wData?.current && Number.isFinite(Number(wData.current.temperature_2m))
      ? Math.round(Number(wData.current.temperature_2m))
      : null;
  const wmoCode = Number(wData?.current?.weather_code);
  const wmoInfo = WMO_WEATHER_LABELS[wmoCode] || { label: 'Fair', icon: '⛅' };

  const addr = gData?.address || {};
  const city = addr.city || addr.town || addr.village || addr.municipality || addr.county || '';
  const region = addr.state || addr.country || '';
  const place =
    city && region
      ? `${city}, ${region}`
      : city || region || `${lat.toFixed(2)}, ${lon.toFixed(2)}`;

  const weatherText =
    tempC !== null ? `${wmoInfo.icon} ${tempC}°C · ${wmoInfo.label}` : `${wmoInfo.icon} ${wmoInfo.label}`;

  return {
    place,
    weather: weatherText,
    tempC,
    icon: wmoInfo.icon,
    stampText: `${place} · ${weatherText}`,
  };
}

export const DEFAULT_CHECKIN_METRICS = Object.freeze([
  { id: 'energy', label: 'Energy', max: 5 },
  { id: 'clarity', label: 'Clarity', max: 5 },
  { id: 'calm', label: 'Calm', max: 5 },
  { id: 'sleep', label: 'Sleep', max: 5 },
]);

export function loadMetricDefinitions(zeroFootprint = false) {
  if (zeroFootprint) return DEFAULT_CHECKIN_METRICS.map((m) => ({ ...m }));
  try {
    const raw = window.localStorage.getItem(CUSTOM_METRICS_KEY);
    if (!raw) return DEFAULT_CHECKIN_METRICS.map((m) => ({ ...m }));
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0
      ? parsed
      : DEFAULT_CHECKIN_METRICS.map((m) => ({ ...m }));
  } catch {
    return DEFAULT_CHECKIN_METRICS.map((m) => ({ ...m }));
  }
}

export function saveMetricDefinitions(defs, zeroFootprint = false) {
  const cleaned = (Array.isArray(defs) ? defs : [])
    .map((m) => ({
      id: String(m.id || '')
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, ''),
      label: String(m.label || '').trim(),
      max: Math.min(10, Math.max(3, Number(m.max) || 5)),
    }))
    .filter((m) => m.id && m.label);

  const finalDefs = cleaned.length > 0 ? cleaned : DEFAULT_CHECKIN_METRICS.map((m) => ({ ...m }));
  if (!zeroFootprint) {
    try {
      window.localStorage.setItem(CUSTOM_METRICS_KEY, JSON.stringify(finalDefs));
    } catch {
      // ignore
    }
  }
  return finalDefs;
}

export function normalizeEntryMetrics(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const num = Number(v);
    if (Number.isFinite(num) && num > 0) {
      out[k] = Math.min(10, Math.max(1, Math.round(num)));
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Computes a 0–4 heatmap intensity level for any day summary across modes:
 * - `'years'`: number of recorded years (default)
 * - `'words'`: total word count on this calendar day
 * - `'metric:<id>'`: average check-in score for a specific daily metric (e.g. `metric:energy`)
 */
export function getHeatmapLevelForMode(daySummary, mode = 'years') {
  if (!daySummary) return { level: 0, valueLabel: 'No entries' };

  if (mode === 'words') {
    const totalW = Object.values(daySummary.wordCounts || {}).reduce(
      (sum, w) => sum + (Number(w) || 0),
      0
    );
    const level =
      totalW <= 0 ? 0 : totalW < 100 ? 1 : totalW < 300 ? 2 : totalW < 700 ? 3 : 4;
    return { level, valueLabel: `${totalW.toLocaleString()} words across years` };
  }

  if (String(mode).startsWith('metric:')) {
    const metricId = mode.slice('metric:'.length);
    const vals = [];
    for (const mObj of Object.values(daySummary.metrics || {})) {
      const v = Number(mObj?.[metricId]);
      if (Number.isFinite(v) && v > 0) vals.push(v);
    }
    if (vals.length === 0) return { level: 0, valueLabel: `No ${metricId} score` };
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const level = Math.min(4, Math.max(1, Math.round((avg / 5) * 4)));
    return { level, valueLabel: `Avg ${metricId}: ${avg.toFixed(1)}/5` };
  }

  const yrCount = Array.isArray(daySummary.years) ? daySummary.years.length : 0;
  return {
    level: Math.min(4, yrCount),
    valueLabel: yrCount > 0 ? `${yrCount} year(s): ${daySummary.years.join(', ')}` : 'No entries yet',
  };
}

/* ============================================================================
   PHASE 20A: EDITORIAL THEME PRESETS (4 CURATED THEMES)
   ============================================================================ */

export const THEME_PRESETS = Object.freeze([
  { id: 'dark', label: 'Obsidian & Amber', themeColor: '#0d0d0d' },
  { id: 'light', label: 'Archival Paper', themeColor: '#f6f4ef' },
  { id: 'sepia', label: 'Sunlit Parchment', themeColor: '#f3ead8' },
  { id: 'nordic', label: 'Midnight Slate', themeColor: '#111824' },
]);

export function getSavedThemePreset(zeroFootprint = false) {
  if (zeroFootprint) return 'dark';
  try {
    const val = window.localStorage.getItem(THEME_STORAGE_KEY);
    return THEME_PRESETS.some((t) => t.id === val) ? val : 'dark';
  } catch {
    return 'dark';
  }
}

export function applyThemePreset(themeId, persist = true, zeroFootprint = false) {
  const preset = THEME_PRESETS.find((t) => t.id === themeId) || THEME_PRESETS[0];
  document.documentElement.setAttribute('data-theme', preset.id);
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) metaTheme.setAttribute('content', preset.themeColor);
  if (persist && !zeroFootprint) {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, preset.id);
    } catch {
      // ignore
    }
  }
  return preset;
}

/* ============================================================================
   PHASE 20B: OFFLINE COMMIT QUEUE (AUTOMATIC SYNC WHEN ONLINE)
   ============================================================================ */

export class OfflineCommitQueue {
  constructor() {
    this.ramQueue = [];
  }

  load(zeroFootprint = false) {
    if (zeroFootprint) return [...this.ramQueue];
    try {
      const raw = window.localStorage.getItem(OFFLINE_QUEUE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  _save(list, zeroFootprint = false) {
    if (zeroFootprint) {
      this.ramQueue = [...list];
      return;
    }
    try {
      window.localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(list));
    } catch {
      this.ramQueue = [...list];
    }
  }

  count(zeroFootprint = false) {
    return this.load(zeroFootprint).length;
  }

  enqueue(serializedTx, zeroFootprint = false) {
    const list = this.load(zeroFootprint);
    list.push(serializedTx);
    this._save(list, zeroFootprint);
    return list.length;
  }

  clear(zeroFootprint = false) {
    this.ramQueue = [];
    if (!zeroFootprint) {
      try {
        window.localStorage.removeItem(OFFLINE_QUEUE_KEY);
      } catch {
        // ignore
      }
    }
  }

  /**
   * Replays all queued offline transactions sequentially in FIFO order.
   * Stops cleanly if the connection drops mid-flush, preserving remaining queued commits.
   */
  async flush({ ghClient, cloakAdapter = null, zeroFootprint = false, onItemSynced = null }) {
    const list = this.load(zeroFootprint);
    if (list.length === 0) return { synced: 0, remaining: 0, errors: [] };
    if (!ghClient || !ghClient.hasToken()) {
      return { synced: 0, remaining: list.length, errors: ['GitHub token is required to flush queue.'] };
    }

    const remaining = [];
    const errors = [];
    let synced = 0;

    for (let i = 0; i < list.length; i += 1) {
      const tx = list[i];
      try {
        const res = await ghClient.replayQueuedTransaction(tx, cloakAdapter);
        synced += 1;
        if (typeof onItemSynced === 'function') onItemSynced(tx, res);
      } catch (err) {
        errors.push(err?.message || 'Queue sync failed.');
        // Keep this failed tx and everything behind it in order
        remaining.push(...list.slice(i));
        break;
      }
    }

    this._save(remaining, zeroFootprint);
    return { synced, remaining: remaining.length, errors };
  }
}

/* ============================================================================
   PHASE 20C: PRINT-TO-BOOK & 8-PAGE FOLDABLE MINI-ZINE GENERATOR
   ============================================================================ */

/**
 * Opens a print-ready editorial Book window (or downloads HTML if popup is blocked).
 * @param {{ title: string, subtitle?: string, entries: Array<Object> }} options
 */
export function openPrintBookWindow({ title = 'Perpetual Diary', subtitle = '', entries = [] }) {
  const sorted = [...entries].sort((a, b) =>
    String(a.diaryDate || '').localeCompare(String(b.diaryDate || ''))
  );

  const tocHtml = sorted
    .map(
      (e, idx) =>
        `<li><span>${escapeHtml(e.diaryDate)} — ${escapeHtml(
          e.title || formatReadableDayKey(e.dayStr || e.diaryDate.slice(5))
        )}</span><span class="toc-num">${idx + 1}</span></li>`
    )
    .join('');

  const chaptersHtml = sorted
    .map((e) => {
      const metaParts = [e.diaryDate];
      if (e.mood) metaParts.push(`mood: ${e.mood}`);
      if (e.location) metaParts.push(e.location);
      if (e.weather) metaParts.push(e.weather);
      const rendered = renderMarkdown(e.body || '', {
        preserveWhitespace: Boolean(e.preserveWhitespace),
        scopeId: `bk-${String(e.diaryDate || '').replace(/[^0-9]/g, '')}`,
      });
      return `
        <article class="book-entry">
          <div class="book-meta">${escapeHtml(metaParts.join(' · '))}</div>
          ${e.title ? `<h2 class="book-entry-title">${escapeHtml(e.title)}</h2>` : ''}
          <div class="book-prose">${rendered}</div>
        </article>
      `;
    })
    .join('\n');

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${escapeHtml(title)} — Print Edition</title>
  <style>
    @page { size: auto; margin: 20mm 18mm; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px;
      background: #f5f2eb;
      color: #161412;
      font-family: Georgia, "Times New Roman", serif;
      line-height: 1.65;
    }
    .toolbar {
      max-width: 720px;
      margin: 0 auto 18px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-family: ui-monospace, monospace;
      font-size: 12px;
    }
    .print-btn {
      background: #161412;
      color: #ffffff;
      border: none;
      padding: 8px 16px;
      cursor: pointer;
      font-family: ui-monospace, monospace;
    }
    .book-sheet {
      max-width: 720px;
      margin: 0 auto;
      background: #ffffff;
      padding: 44px 52px;
      box-shadow: 0 4px 28px rgba(0, 0, 0, 0.08);
    }
    .cover {
      text-align: center;
      padding: 48px 0 42px;
      border-bottom: 2px solid #161412;
      margin-bottom: 32px;
      page-break-after: always;
    }
    .kicker {
      font-family: ui-monospace, monospace;
      font-size: 11px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: #666;
    }
    .cover h1 { font-size: 34px; margin: 12px 0 8px; font-weight: 500; }
    .cover p { color: #444; font-style: italic; }
    .toc { margin-bottom: 32px; page-break-after: always; }
    .toc h2 { font-family: ui-monospace, monospace; font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; }
    .toc ol { list-style: none; padding: 0; margin: 12px 0 0; }
    .toc li {
      display: flex;
      justify-content: space-between;
      padding: 5px 0;
      border-bottom: 1px dotted #ccc;
      font-size: 14px;
    }
    .toc-num { font-family: ui-monospace, monospace; color: #666; }
    .book-entry {
      margin-bottom: 34px;
      padding-bottom: 24px;
      border-bottom: 1px solid #e2ddd3;
      break-inside: avoid-page;
    }
    .book-meta {
      font-family: ui-monospace, monospace;
      font-size: 11px;
      letter-spacing: 0.06em;
      color: #666;
      text-transform: uppercase;
    }
    .book-entry-title { font-size: 22px; margin: 6px 0 10px; font-weight: 500; }
    .book-prose blockquote {
      margin: 12px 0;
      padding: 6px 14px;
      border-left: 3px solid #b8862b;
      font-style: italic;
      color: #333;
    }
    .book-prose .prose-verse { white-space: pre-wrap; }
    @media print {
      body { background: #ffffff; padding: 0; }
      .toolbar { display: none; }
      .book-sheet { box-shadow: none; padding: 0; max-width: none; }
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <span>PRINT-TO-BOOK EDITION · ${sorted.length} ENTRIES</span>
    <button class="print-btn" onclick="window.print()">Print / Save PDF Book</button>
  </div>
  <main class="book-sheet">
    <section class="cover">
      <div class="kicker">PERPETUAL SIDE-BY-SIDE DIARY</div>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(subtitle || `${sorted.length} Entries · Printed ${new Date().toISOString().slice(0, 10)}`)}</p>
    </section>
    <section class="toc">
      <h2>Contents</h2>
      <ol>${tocHtml}</ol>
    </section>
    ${chaptersHtml}
  </main>
</body>
</html>`;

  return openOrDownloadHtmlWindow(html, 'perpetual-diary-book.html');
}

/**
 * Generates a genuine 1-sheet 8-Page Foldable Pocket Mini-Zine layout!
 * Standard 4×2 landscape imposition:
 *   Top Row (rotated 180°):   [Page 5] [Page 4] [Page 3] [Page 2]
 *   Bottom Row (upright):     [Page 6] [Page 7] [Back/8] [Cover/1]
 * Print landscape on 1 sheet of Letter/A4 paper, fold in half & quarters, cut center slit, and fold into a booklet.
 */
export function openMiniZineWindow({ title = 'Perpetual Mini-Zine', subtitle = '', entries = [] }) {
  const pages = [];

  // Page 1: Cover
  pages.push({
    num: '1 · COVER',
    html: `
      <div class="zine-cover">
        <div class="zine-kicker">PERPETUAL ZINE</div>
        <h1>${escapeHtml(title)}</h1>
        <p>${escapeHtml(subtitle || new Date().toISOString().slice(0, 10))}</p>
        <div class="zine-rule"></div>
        <div class="zine-small">${entries.length} selected reflection(s)</div>
      </div>
    `,
  });

  // Pages 2..7: Up to 6 selected entries (trimmed cleanly to fit pocket zine panels)
  const sliceEntries = entries.slice(0, 6);
  for (let i = 0; i < 6; i += 1) {
    const e = sliceEntries[i];
    if (e) {
      const plain = stripMarkdown(e.body || '');
      const excerpt = plain.length > 420 ? `${plain.slice(0, 420).trim()}…` : plain;
      pages.push({
        num: `${i + 2}`,
        html: `
          <div class="zine-meta">${escapeHtml(e.diaryDate || '')}${e.mood ? ` · ${escapeHtml(e.mood)}` : ''}</div>
          <h3>${escapeHtml(e.title || formatReadableDayKey(e.dayStr || String(e.diaryDate || '').slice(5)))}</h3>
          <p class="zine-body">${escapeHtml(excerpt)}</p>
        `,
      });
    } else {
      pages.push({
        num: `${i + 2}`,
        html: `<div class="zine-blank"><span class="zine-kicker">NOTES</span></div>`,
      });
    }
  }

  // Page 8: Back Cover & Folding Guide
  pages.push({
    num: '8 · BACK',
    html: `
      <div class="zine-back">
        <div class="zine-kicker">COLOPHON</div>
        <p>Printed from Perpetual Side-by-Side Web Diary.</p>
        <p class="zine-small">Fold hot-dog, fold hamburger, fold quarters, snip the center fold between panels 3–4 &amp; 6–7, then pinch into an 8-page pocket booklet.</p>
      </div>
    `,
  });

  // Standard 8-page mini-zine imposition map:
  // Top row (upside down): pages[4] (p5), pages[3] (p4), pages[2] (p3), pages[1] (p2)
  // Bottom row (upright):  pages[5] (p6), pages[6] (p7), pages[7] (p8), pages[0] (p1)
  const renderPanel = (pageObj, flipped) => `
    <section class="zine-panel${flipped ? ' is-flipped' : ''}">
      <div class="zine-panel-inner">
        ${pageObj.html}
      </div>
      <div class="zine-page-num">${escapeHtml(pageObj.num)}</div>
    </section>
  `;

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${escapeHtml(title)} — 8-Page Foldable Mini-Zine</title>
  <style>
    @page { size: landscape; margin: 6mm; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 16px;
      background: #eae6dd;
      color: #151412;
      font-family: Georgia, serif;
    }
    .toolbar {
      max-width: 1080px;
      margin: 0 auto 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-family: ui-monospace, monospace;
      font-size: 12px;
    }
    .print-btn {
      background: #151412;
      color: #fff;
      border: none;
      padding: 7px 14px;
      cursor: pointer;
      font-family: ui-monospace, monospace;
    }
    .zine-sheet {
      width: 100%;
      max-width: 1080px;
      aspect-ratio: 11 / 8.5;
      margin: 0 auto;
      background: #ffffff;
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      grid-template-rows: repeat(2, 1fr);
      border: 1px solid #999;
    }
    .zine-panel {
      position: relative;
      border: 1px dashed #bdb8ad;
      padding: 14px 12px 22px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      overflow: hidden;
    }
    .zine-panel.is-flipped { transform: rotate(180deg); }
    .zine-kicker {
      font-family: ui-monospace, monospace;
      font-size: 9px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: #666;
    }
    .zine-meta {
      font-family: ui-monospace, monospace;
      font-size: 9px;
      color: #666;
      margin-bottom: 4px;
    }
    .zine-cover {
      height: 100%;
      display: flex;
      flex-direction: column;
      justify-content: center;
      text-align: center;
      padding: 8px;
    }
    .zine-cover h1 { font-size: 20px; margin: 8px 0 6px; line-height: 1.2; }
    .zine-rule { width: 42px; height: 2px; background: #151412; margin: 12px auto; }
    .zine-panel h3 { font-size: 13px; margin: 0 0 6px; line-height: 1.25; }
    .zine-body { font-size: 10.5px; line-height: 1.48; margin: 0; white-space: pre-wrap; }
    .zine-small { font-size: 9.5px; color: #555; line-height: 1.4; }
    .zine-blank {
      height: 100%;
      border: 1px dotted #ddd;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .zine-back {
      height: 100%;
      display: flex;
      flex-direction: column;
      justify-content: flex-end;
      gap: 6px;
    }
    .zine-page-num {
      position: absolute;
      bottom: 5px;
      right: 8px;
      font-family: ui-monospace, monospace;
      font-size: 8px;
      color: #888;
    }
    @media print {
      body { background: #fff; padding: 0; }
      .toolbar { display: none; }
      .zine-sheet { max-width: none; width: 100vw; height: 100vh; aspect-ratio: auto; border: none; }
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <span>8-PAGE FOLDABLE MINI-ZINE · PRINT LANDSCAPE ON 1 SHEET (SCALE 100%)</span>
    <button class="print-btn" onclick="window.print()">Print Mini-Zine</button>
  </div>
  <main class="zine-sheet">
    ${renderPanel(pages[4], true)}
    ${renderPanel(pages[3], true)}
    ${renderPanel(pages[2], true)}
    ${renderPanel(pages[1], true)}
    ${renderPanel(pages[5], false)}
    ${renderPanel(pages[6], false)}
    ${renderPanel(pages[7], false)}
    ${renderPanel(pages[0], false)}
  </main>
</body>
</html>`;

  return openOrDownloadHtmlWindow(html, 'perpetual-mini-zine.html');
}

function openOrDownloadHtmlWindow(html, fallbackFilename) {
  const popup = window.open('', '_blank', 'noopener,noreferrer');
  if (popup) {
    popup.document.open();
    popup.document.write(html);
    popup.document.close();
    return { openedWindow: true };
  }
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fallbackFilename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
  return { openedWindow: false, downloadedFallback: true };
}

/* ============================================================================
   PHASE 20D: MIGRATION IMPORTERS (PERPETUAL JSON, DAY ONE, JOURNEY, MARKDOWN)
   ============================================================================ */

function isoDateFromUnknown(val) {
  if (!val) return null;
  if (typeof val === 'number') {
    const d = new Date(val);
    if (!Number.isNaN(d.getTime())) {
      return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    }
  }
  const str = String(val).trim();
  const direct = /^(\d{4})-(\d{2})-(\d{2})/.exec(str);
  if (direct) return `${direct[1]}-${direct[2]}-${direct[3]}`;
  const parsed = new Date(str);
  if (!Number.isNaN(parsed.getTime())) {
    return `${parsed.getFullYear()}-${pad2(parsed.getMonth() + 1)}-${pad2(parsed.getDate())}`;
  }
  return null;
}

/**
 * Parses an imported `.json` or `.md` file from:
 * - Perpetual Diary `.json` export (`{ days: { "MM-DD": { entries: ... } } }`)
 * - Day One `.json` export (`{ entries: [{ creationDate, text, tags, weather, location }] }`)
 * - Journey `.json` export (`[{ date_journal, text, mood, tags }]` or single object)
 * - Plain Markdown `.md` journal (splits on headings containing `YYYY-MM-DD`, or YAML frontmatter)
 *
 * Returns a normalized array of ready-to-save plain entry objects.
 *
 * @param {string} filename
 * @param {string} rawText
 * @returns {{ format: string, entries: Array<{ diaryDate: string, year: number, dayStr: string, title: string, body: string, tags: string[], mood: string, location?: string, weather?: string, writtenAt: string }> }}
 */
export function parseImportedDiaryFile(filename, rawText) {
  const text = String(rawText || '').trim();
  if (!text) throw new Error('Imported file is empty.');

  const lowerName = String(filename || '').toLowerCase();

  // 1. JSON Importers (Perpetual / Day One / Journey)
  if (lowerName.endsWith('.json') || text.startsWith('{') || text.startsWith('[')) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('Could not parse JSON file. Check for valid JSON syntax.');
    }

    // 1A. Perpetual Diary native export
    if (parsed && typeof parsed === 'object' && parsed.days && typeof parsed.days === 'object') {
      const entries = [];
      for (const [dayStr, doc] of Object.entries(parsed.days)) {
        for (const [yrKey, e] of Object.entries(doc?.entries || {})) {
          if (!e || !e.body) continue;
          const diaryDate = isoDateFromUnknown(e.diaryDate) || `${yrKey}-${dayStr}`;
          entries.push({
            diaryDate,
            year: Number(diaryDate.slice(0, 4)),
            dayStr: diaryDate.slice(5),
            title: String(e.title || ''),
            body: String(e.body || ''),
            tags: Array.isArray(e.tags) ? e.tags : [],
            mood: String(e.mood || ''),
            location: String(e.location || ''),
            weather: String(e.weather || ''),
            artifacts: e.artifacts || null,
            metrics: e.metrics || null,
            preserveWhitespace: Boolean(e.preserveWhitespace),
            writtenAt: e.writtenAt || new Date().toISOString(),
          });
        }
      }
      return { format: 'Perpetual Diary JSON', entries };
    }

    // 1B. Day One JSON export
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.entries)) {
      const entries = [];
      for (const item of parsed.entries) {
        const diaryDate = isoDateFromUnknown(item.creationDate || item.date);
        const rawBody = String(item.text || item.body || '').trim();
        if (!diaryDate || !rawBody) continue;

        // Day One often starts `text` with a `# Title` first line
        let title = String(item.title || '').trim();
        let body = rawBody;
        const h1Match = /^#\s+(.+)\n+([\s\S]*)$/.exec(rawBody);
        if (!title && h1Match) {
          title = h1Match[1].trim();
          body = h1Match[2].trim();
        }

        const locObj = item.location || {};
        const location = [locObj.placeName, locObj.localityName, locObj.country]
          .filter(Boolean)
          .join(', ');
        const wObj = item.weather || {};
        const weather = wObj.conditionsDescription
          ? `${wObj.temperatureCelsius !== undefined ? `${Math.round(wObj.temperatureCelsius)}°C · ` : ''}${wObj.conditionsDescription}`
          : '';

        entries.push({
          diaryDate,
          year: Number(diaryDate.slice(0, 4)),
          dayStr: diaryDate.slice(5),
          title,
          body,
          tags: Array.isArray(item.tags) ? item.tags.map(String) : ['imported-dayone'],
          mood: String(item.mood || ''),
          location,
          weather,
          writtenAt: item.creationDate || new Date().toISOString(),
        });
      }
      return { format: 'Day One JSON', entries };
    }

    // 1C. Journey JSON export (array or single entry object with `date_journal`)
    const journeyArr = Array.isArray(parsed)
      ? parsed
      : parsed && parsed.date_journal
        ? [parsed]
        : null;
    if (journeyArr) {
      const entries = [];
      for (const item of journeyArr) {
        const diaryDate = isoDateFromUnknown(item.date_journal || item.date_modified);
        const body = String(item.text || '')
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<\/p>\s*<p>/gi, '\n\n')
          .replace(/<[^>]+>/g, '')
          .trim();
        if (!diaryDate || !body) continue;

        entries.push({
          diaryDate,
          year: Number(diaryDate.slice(0, 4)),
          dayStr: diaryDate.slice(5),
          title: String(item.title || ''),
          body,
          tags: Array.isArray(item.tags) ? item.tags.map(String) : ['imported-journey'],
          mood: String(item.sentiment || item.mood || ''),
          location: String(item.address || ''),
          weather: item.weather?.description
            ? `${item.weather.degree_c !== undefined ? `${Math.round(item.weather.degree_c)}°C · ` : ''}${item.weather.description}`
            : '',
          writtenAt: item.date_journal
            ? new Date(item.date_journal).toISOString()
            : new Date().toISOString(),
        });
      }
      return { format: 'Journey JSON', entries };
    }

    throw new Error('Unrecognized JSON archive structure.');
  }

  // 2. Markdown Importer (multi-entry `# YYYY-MM-DD` headings or single dated note)
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const entries = [];
  let current = null;

  const flushCurrent = () => {
    if (!current) return;
    const body = current.bodyLines.join('\n').trim();
    if (current.diaryDate && body) {
      entries.push({
        diaryDate: current.diaryDate,
        year: Number(current.diaryDate.slice(0, 4)),
        dayStr: current.diaryDate.slice(5),
        title: current.title,
        body,
        tags: ['imported-md'],
        mood: '',
        writtenAt: new Date().toISOString(),
      });
    }
    current = null;
  };

  for (const line of lines) {
    const headingDate = /^#{1,3}\s+(\d{4}-\d{2}-\d{2})(?:\s*[—–-]\s*(.*))?$/.exec(line.trim());
    if (headingDate) {
      flushCurrent();
      current = {
        diaryDate: headingDate[1],
        title: (headingDate[2] || '').trim(),
        bodyLines: [],
      };
      continue;
    }
    if (current) {
      current.bodyLines.push(line);
    }
  }
  flushCurrent();

  // Fallback for single Markdown file with filename or frontmatter date
  if (entries.length === 0) {
    const fmMatch = /date:\s*(\d{4}-\d{2}-\d{2})/i.exec(text);
    const fnMatch = /(\d{4}-\d{2}-\d{2})/.exec(filename || '');
    const diaryDate =
      (fmMatch && fmMatch[1]) ||
      (fnMatch && fnMatch[1]) ||
      new Date().toISOString().slice(0, 10);

    const cleanedBody = text.replace(/^---[\s\S]*?---\n*/, '').trim();
    entries.push({
      diaryDate,
      year: Number(diaryDate.slice(0, 4)),
      dayStr: diaryDate.slice(5),
      title: String(filename || '').replace(/\.[^.]+$/, ''),
      body: cleanedBody,
      tags: ['imported-md'],
      mood: '',
      writtenAt: new Date().toISOString(),
    });
  }

  return { format: 'Markdown (.md)', entries };
}
