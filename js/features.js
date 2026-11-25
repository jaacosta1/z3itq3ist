/**
 * js/features.js — Perpetual Side-by-Side Web Diary Editorial & Utility Engine (File 2 of 5 · Clean Build)
 *
 * Consolidates Phases 13–15, 17, 19, 20, Multi-Entry Per Day, and Word Trend Explorer:
 * - Phase 13: Bi-Directional Wiki-Link Backlinks & Story Arcs (`arc:...`) "Book View"
 * - Phase 14: Perpetual "On This Week / Season" Views & Time Capsules (`sealedUntil`)
 * - Phase 15: Year-in-Review Auto-Dossier, Word/Mood Analytics & Word/Phrase Trend Analyzer (`computeWordTrend`)
 * - Phase 17: Reusable Entry Templates, Curated Prompt Decks & Command Palette (`Ctrl+K`) scorer
 * - Phase 19: Cultural Artifacts Strip, Opt-In Location & Weather Stamp (Open-Meteo),
 *             Custom Daily Check-In Metrics & Multi-Metric Heatmaps
 * - Phase 20: Editorial Theme Presets (4 themes), Offline Commit Queue, Print-to-Book &
 *             8-Page Foldable Mini-Zine Imposition, and Migration Importers (Perpetual / Day One / Journey / Markdown)
 */

import { extractWikiLinks, renderMarkdown, stripMarkdown, countWords } from './markdown.js';
import { getYearEntriesList } from './github.js';

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const CUSTOM_TEMPLATES_KEY = 'perpetual_diary_custom_templates_v1';
const CUSTOM_METRICS_KEY = 'perpetual_diary_checkin_metrics_v1';
const OFFLINE_QUEUE_KEY = 'perpetual_diary_offline_queue_v1';
const THEME_STORAGE_KEY = 'perpetual_diary_theme';

const STOP_WORDS = new Set([
  'the', 'and', 'that', 'have', 'for', 'not', 'with', 'you', 'this', 'but',
  'his', 'from', 'they', 'say', 'her', 'she', 'will', 'one', 'all', 'would',
  'there', 'their', 'what', 'out', 'about', 'who', 'get', 'which', 'when',
  'make', 'can', 'like', 'time', 'just', 'him', 'know', 'take', 'into', 'year',
  'your', 'some', 'could', 'them', 'see', 'other', 'than', 'then', 'now', 'look',
  'only', 'come', 'its', 'over', 'think', 'also', 'back', 'after', 'use', 'two',
  'how', 'our', 'work', 'first', 'well', 'way', 'even', 'new', 'want', 'because',
  'any', 'these', 'give', 'day', 'most', 'was', 'were', 'been', 'being', 'had',
  'has', 'did', 'does', 'are', 'more', 'very', 'still', 'much', 'here', 'today',
]);

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
  return `${MONTH_NAMES[monthIdx] || 'January'} ${Number(m[2])}`;
}

/* ============================================================================
   PHASE 13: BI-DIRECTIONAL WIKI-LINK BACKLINKS & STORY ARCS ("BOOK VIEW")
   ============================================================================ */

export function computeBacklinksForDate(
  targetDayStr,
  targetYear,
  plainEntries = [],
  excludeEntryId = ''
) {
  const cleanDay = String(targetDayStr || '').trim();
  const cleanYear = targetYear ? String(targetYear).trim() : '';
  const exactTarget = cleanYear ? `${cleanYear}-${cleanDay}` : '';

  const results = [];
  const seen = new Set();

  for (const entry of plainEntries) {
    if (!entry || !entry.body) continue;
    if (excludeEntryId && entry.id === excludeEntryId) continue;
    if (!excludeEntryId && exactTarget && entry.diaryDate === exactTarget) continue;

    const links = extractWikiLinks(entry.body);
    for (const link of links) {
      const matchesExact = Boolean(exactTarget && link.target === exactTarget);
      const matchesDayWide = !link.year && link.dayStr === cleanDay;
      const matchesAnyYearOnDay = !cleanYear && link.dayStr === cleanDay;

      if (!matchesExact && !matchesDayWide && !matchesAnyYearOnDay) continue;

      const sourceIdentity = entry.id || entry.diaryDate;
      const dedupeKey = `${sourceIdentity}::${link.target}`;
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

export function buildStoryArcBook(arcSlug, plainEntries = []) {
  const targetTag = `arc:${String(arcSlug || '').trim().toLowerCase()}`;
  const chapters = plainEntries
    .filter(
      (e) =>
        Array.isArray(e?.tags) &&
        e.tags.some((t) => String(t || '').trim().toLowerCase() === targetTag)
    )
    .sort(
      (a, b) =>
        String(a.diaryDate || '').localeCompare(String(b.diaryDate || '')) ||
        String(a.writtenAt || '').localeCompare(String(b.writtenAt || ''))
    );

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
  spring: { id: 'spring', label: 'Spring (Mar–May)', glyph: '⚘', months: [3, 4, 5] },
  summer: { id: 'summer', label: 'Summer (Jun–Aug)', glyph: '☀', months: [6, 7, 8] },
  autumn: { id: 'autumn', label: 'Autumn (Sep–Nov)', glyph: '❧', months: [9, 10, 11] },
  winter: { id: 'winter', label: 'Winter (Dec–Feb)', glyph: '❄', months: [12, 1, 2] },
});

export function getCalendarDaysWindow(centerDayStr, radiusDays = 3) {
  const all = getAll366DayKeys();
  const idx = all.indexOf(centerDayStr);
  if (idx === -1) return [centerDayStr];
  const out = [];
  for (let offset = -radiusDays; offset <= radiusDays; offset += 1) {
    const wrapped = (idx + offset + all.length) % all.length;
    out.push(all[wrapped]);
  }
  return out;
}

export function getSeasonForDay(dayStr) {
  const month = Number(String(dayStr || '01-01').slice(0, 2)) || 1;
  if (month >= 3 && month <= 5) return SEASONS.spring;
  if (month >= 6 && month <= 8) return SEASONS.summer;
  if (month >= 9 && month <= 11) return SEASONS.autumn;
  return SEASONS.winter;
}

export function getSeasonDayKeys(seasonId) {
  const season = SEASONS[seasonId] || SEASONS.autumn;
  const keys = [];
  for (const m of season.months) {
    for (let d = 1; d <= DAYS_IN_MONTH[m - 1]; d += 1) {
      keys.push(`${pad2(m)}-${pad2(d)}`);
    }
  }
  return keys;
}

export function collectIndexedWindowEntries(indexData, dayKeys) {
  const daysMap = indexData?.days || {};
  const list = [];
  for (const dayStr of dayKeys) {
    const info = daysMap[dayStr];
    if (!info || !Array.isArray(info.years) || info.years.length === 0) continue;
    list.push({
      dayStr,
      readableDay: formatReadableDayKey(dayStr),
      years: [...info.years].sort((a, b) => a - b),
      tags: Array.isArray(info.tags) ? info.tags : [],
      wordCounts: info.wordCounts || {},
      entryCounts: info.entryCounts || {},
    });
  }
  return list;
}

export function getTimeCapsuleStatus(entry, todayIso = new Date().toISOString().slice(0, 10)) {
  const sealedUntil = String(entry?.sealedUntil || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sealedUntil)) {
    return { isSealed: false, isNewlyUnlocked: false, sealedUntil: '', daysRemaining: 0 };
  }
  if (todayIso < sealedUntil) {
    const targetMs = Date.parse(`${sealedUntil}T00:00:00Z`);
    const nowMs = Date.parse(`${todayIso}T00:00:00Z`);
    const daysRemaining = Math.max(1, Math.ceil((targetMs - nowMs) / 86400000));
    return { isSealed: true, isNewlyUnlocked: false, sealedUntil, daysRemaining };
  }
  return { isSealed: false, isNewlyUnlocked: true, sealedUntil, daysRemaining: 0 };
}

/* ============================================================================
   PHASE 15: ANALYTICS, WORD/PHRASE TREND EXPLORER & YEAR-IN-REVIEW DOSSIER
   ============================================================================ */

export function computeDiaryAnalytics(indexData, plainEntries = []) {
  const daysMap = indexData?.days || {};
  const recordedDayKeys = Object.keys(daysMap).sort();

  const yearStats = new Map();
  const moodCounts = new Map();
  const tagCounts = new Map();
  let totalEntries = 0;
  let totalWords = 0;
  let sealedCapsules = 0;
  const todayIso = new Date().toISOString().slice(0, 10);

  for (const info of Object.values(daysMap)) {
    const years = Array.isArray(info?.years) ? info.years : [];
    const wc = info?.wordCounts || {};
    const ec = info?.entryCounts || {};
    const moods = info?.moods || {};
    const sealed = info?.sealed || {};

    for (const yr of years) {
      const yrKey = String(yr);
      const countForYear = Math.max(1, Number(ec[yrKey]) || 1);
      totalEntries += countForYear;
      const w = Number(wc[yrKey]) || 0;
      totalWords += w;

      if (!yearStats.has(yr)) {
        yearStats.set(yr, { year: Number(yr), entries: 0, words: 0, days: 0 });
      }
      const ys = yearStats.get(yr);
      ys.entries += countForYear;
      ys.words += w;
      ys.days += 1;

      const moodVal = String(moods[yrKey] || '').trim().toLowerCase();
      if (moodVal) {
        moodCounts.set(moodVal, (moodCounts.get(moodVal) || 0) + 1);
      }

      if (sealed[yrKey] && todayIso < sealed[yrKey]) {
        sealedCapsules += 1;
      }
    }

    for (const t of Array.isArray(info?.tags) ? info.tags : []) {
      const cleaned = String(t || '').trim();
      if (cleaned) tagCounts.set(cleaned, (tagCounts.get(cleaned) || 0) + 1);
    }
  }

  for (const e of plainEntries) {
    const moodVal = String(e?.mood || '').trim().toLowerCase();
    if (moodVal && !moodCounts.has(moodVal)) {
      moodCounts.set(moodVal, 1);
    }
  }

  const all366 = getAll366DayKeys();
  const recordedSet = new Set(recordedDayKeys);
  let longestStreak = 0;
  let currentStreak = 0;
  for (const k of all366) {
    if (recordedSet.has(k)) {
      currentStreak += 1;
      if (currentStreak > longestStreak) longestStreak = currentStreak;
    } else {
      currentStreak = 0;
    }
  }

  const yearsBreakdown = Array.from(yearStats.values()).sort((a, b) => a.year - b.year);
  const topMoods = Array.from(moodCounts.entries())
    .map(([mood, count]) => ({ mood, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
  const topTags = Array.from(tagCounts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);

  return {
    totalEntries,
    totalWords,
    recordedDaysCount: recordedDayKeys.length,
    calendarCoveragePct: Number(((recordedDayKeys.length / 366) * 100).toFixed(1)),
    avgWordsPerEntry: totalEntries > 0 ? Math.round(totalWords / totalEntries) : 0,
    longestStreak,
    sealedCapsules,
    yearsBreakdown,
    topMoods,
    topTags,
  };
}

/**
 * Word & Phrase Trend Analyzer:
 * Tracks occurrences of any keyword or multi-word phrase across every year & month,
 * plus extracts top recurring vocabulary across your loaded entries.
 *
 * @param {string} queryTerm
 * @param {Array<Object>} plainEntries
 */
export function computeWordTrend(queryTerm, plainEntries = []) {
  const cleanQuery = String(queryTerm || '').trim().toLowerCase();
  const vocabCounts = new Map();
  const yearBuckets = new Map();
  const monthCounts = new Array(12).fill(0);
  const matches = [];

  for (const entry of plainEntries) {
    if (!entry) continue;
    const plain = stripMarkdown(`${entry.title || ''}\n${entry.body || ''}`);
    const lower = plain.toLowerCase();
    const yr = Number(entry.year) || Number(String(entry.diaryDate || '').slice(0, 4)) || 0;
    const mm = Number(String(entry.diaryDate || '').slice(5, 7)) || 0;

    if (yr > 0 && !yearBuckets.has(yr)) {
      yearBuckets.set(yr, { year: yr, occurrences: 0, entryHits: 0, totalEntries: 0 });
    }
    if (yr > 0) {
      yearBuckets.get(yr).totalEntries += 1;
    }

    const tokens = lower.match(/[a-z\u00c0-\u024f']{4,}/g) || [];
    for (const tok of tokens) {
      const normalized = tok.replace(/^'+|'+$/g, '');
      if (normalized.length >= 4 && !STOP_WORDS.has(normalized)) {
        vocabCounts.set(normalized, (vocabCounts.get(normalized) || 0) + 1);
      }
    }

    if (!cleanQuery) continue;

    const escaped = cleanQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(?:^|[^a-z0-9_])${escaped}(?=$|[^a-z0-9_])`, 'gi');
    const found = plain.match(regex);
    const hitCount = found ? found.length : 0;

    if (hitCount > 0) {
      if (yr > 0) {
        const b = yearBuckets.get(yr);
        b.occurrences += hitCount;
        b.entryHits += 1;
      }
      if (mm >= 1 && mm <= 12) {
        monthCounts[mm - 1] += hitCount;
      }

      const firstIdx = lower.indexOf(cleanQuery);
      const start = Math.max(0, firstIdx - 55);
      const end = Math.min(plain.length, firstIdx + cleanQuery.length + 75);
      const excerpt = `${start > 0 ? '…' : ''}${plain.slice(start, end).trim()}${
        end < plain.length ? '…' : ''
      }`;

      matches.push({
        id: entry.id || entry.diaryDate,
        diaryDate: entry.diaryDate,
        dayStr: entry.dayStr || entry.diaryDate.slice(5),
        year: yr,
        title: entry.title || formatReadableDayKey(entry.dayStr || entry.diaryDate.slice(5)),
        occurrences: hitCount,
        excerpt,
      });
    }
  }

  const topWords = Array.from(vocabCounts.entries())
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word))
    .slice(0, 14);

  const byYear = Array.from(yearBuckets.values()).sort((a, b) => a.year - b.year);
  const totalOccurrences = byYear.reduce((acc, y) => acc + y.occurrences, 0);
  const peakYearObj = byYear.reduce(
    (best, cur) => (cur.occurrences > (best?.occurrences || 0) ? cur : best),
    null
  );

  matches.sort((a, b) => b.diaryDate.localeCompare(a.diaryDate));

  return {
    query: cleanQuery,
    totalOccurrences,
    matchingEntriesCount: matches.length,
    peakYear: peakYearObj && peakYearObj.occurrences > 0 ? peakYearObj.year : null,
    byYear,
    byMonth: monthCounts.map((count, idx) => ({
      month: MONTH_NAMES[idx].slice(0, 3),
      count,
    })),
    matches: matches.slice(0, 20),
    topWords,
  };
}

export function generateYearInReviewDossier(targetYear, indexData, plainEntries = []) {
  const yrNum = Number(targetYear);
  const yrKey = String(yrNum);
  const daysMap = indexData?.days || {};

  const monthWordTotals = new Array(12).fill(0);
  const monthEntryCounts = new Array(12).fill(0);
  const moodCounts = new Map();
  const tagCounts = new Map();
  let entryCount = 0;
  let totalWords = 0;

  for (const [dayStr, info] of Object.entries(daysMap)) {
    if (!Array.isArray(info?.years) || !info.years.includes(yrNum)) continue;
    const countForDay = Math.max(1, Number(info?.entryCounts?.[yrKey]) || 1);
    entryCount += countForDay;
    const w = Number(info?.wordCounts?.[yrKey]) || 0;
    totalWords += w;

    const monthIdx = Math.min(11, Math.max(0, Number(dayStr.slice(0, 2)) - 1));
    monthWordTotals[monthIdx] += w;
    monthEntryCounts[monthIdx] += countForDay;

    const mood = String(info?.moods?.[yrKey] || '').trim().toLowerCase();
    if (mood) moodCounts.set(mood, (moodCounts.get(mood) || 0) + 1);

    for (const t of Array.isArray(info?.tags) ? info.tags : []) {
      const cleaned = String(t || '').trim();
      if (cleaned) tagCounts.set(cleaned, (tagCounts.get(cleaned) || 0) + 1);
    }
  }

  let busiestMonthIdx = 0;
  for (let i = 1; i < 12; i += 1) {
    if (monthWordTotals[i] > monthWordTotals[busiestMonthIdx]) busiestMonthIdx = i;
  }

  const yearPlainEntries = plainEntries
    .filter((e) => Number(e?.year) === yrNum)
    .sort((a, b) => String(a.diaryDate).localeCompare(String(b.diaryDate)));

  const highlights = yearPlainEntries
    .map((e) => {
      const words = countWords(e.body || '');
      const plain = stripMarkdown(e.body || '');
      return {
        diaryDate: e.diaryDate,
        title: e.title || formatReadableDayKey(e.dayStr || e.diaryDate.slice(5)),
        words,
        excerpt: plain.length > 160 ? `${plain.slice(0, 160).trim()}…` : plain,
      };
    })
    .sort((a, b) => b.words - a.words)
    .slice(0, 5);

  return {
    year: yrNum,
    entryCount,
    totalWords,
    avgWords: entryCount > 0 ? Math.round(totalWords / entryCount) : 0,
    busiestMonth: MONTH_NAMES[busiestMonthIdx],
    busiestMonthWords: monthWordTotals[busiestMonthIdx],
    monthWordTotals,
    monthEntryCounts,
    topMoods: Array.from(moodCounts.entries())
      .map(([mood, count]) => ({ mood, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5),
    topTags: Array.from(tagCounts.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
    highlights,
  };
}

export function renderYearDossierMarkdown(dossier) {
  const lines = [
    `# ${dossier.year} — Year-in-Review Dossier`,
    '',
    `- **Recorded Entries:** ${dossier.entryCount}`,
    `- **Total Words Written:** ${dossier.totalWords.toLocaleString()} (avg ${dossier.avgWords} words/entry)`,
    `- **Most Active Month:** ${dossier.busiestMonth} (${dossier.busiestMonthWords.toLocaleString()} words)`,
    dossier.topMoods.length
      ? `- **Dominant Moods:** ${dossier.topMoods.map((m) => `${m.mood} (${m.count})`).join(', ')}`
      : '',
    dossier.topTags.length
      ? `- **Recurring Themes:** ${dossier.topTags.map((t) => `#${t.tag} (${t.count})`).join(', ')}`
      : '',
    '',
    '## Notable Entries & Excerpts',
    '',
  ].filter((l) => l !== '');

  if (dossier.highlights.length === 0) {
    lines.push('_Unlock & load entries in the Archive tab to populate decrypted highlights._');
  } else {
    for (const h of dossier.highlights) {
      lines.push(`### ${h.diaryDate} — ${h.title} (${h.words} words)`, '', `> ${h.excerpt}`, '');
    }
  }
  return lines.join('\n');
}

/* ============================================================================
   PHASE 17: TEMPLATES, PROMPT DECKS & COMMAND PALETTE SCORER
   ============================================================================ */

export const BUILT_IN_TEMPLATES = Object.freeze([
  {
    id: 'tpl-evening-examen',
    name: 'Evening Examen (3 Anchors)',
    mood: 'reflective',
    tags: 'examen, daily',
    body: [
      '### What carried weight today',
      '- ',
      '',
      '### One quiet moment worth keeping',
      '> ',
      '',
      '### Note to my future self on this date',
      '',
    ].join('\n'),
  },
  {
    id: 'tpl-perpetual-checkin',
    name: 'Annual Perpetual Check-In',
    mood: 'grounded',
    tags: 'annual-checkin, milestone',
    body: [
      '- **Where I am living & working:** ',
      '- **What occupies my mornings:** ',
      '- **What I am learning or building:** ',
      '- **What I hope next year’s column notices:** ',
    ].join('\n'),
  },
  {
    id: 'tpl-morning-pages',
    name: 'Unedited Morning Pages',
    mood: 'clear',
    tags: 'morning-pages',
    body: 'First thoughts before checking messages:\n\n',
  },
  {
    id: 'tpl-field-notes',
    name: 'Place & Sensory Field Note',
    mood: 'observant',
    tags: 'field-notes, senses',
    body: [
      '**Light & weather:** ',
      '**Sounds in the room / street:** ',
      '**Conversation or line remembered:** ',
      '',
      '---',
      '',
    ].join('\n'),
  },
  {
    id: 'tpl-verse-stanza',
    name: 'Verse / Formalist Poem',
    mood: 'contemplative',
    tags: 'verse, poetry',
    preserveWhitespace: true,
    body: [
      'First line against the margin,',
      '    indented second line holding the turn,',
      '        and a quiet third line.',
      '',
    ].join('\n'),
  },
]);

export const PROMPT_DECKS = Object.freeze({
  longitudinal: {
    label: 'Longitudinal / Time',
    prompts: [
      'What problem felt urgent one year ago today that has now completely dissolved?',
      'What habit or promise from an earlier year on this date are you still keeping?',
      'If your future self reads only three sentences from today five years from now, what should they say?',
      'What has quietly changed about your daily routine over the last twelve months?',
    ],
  },
  inquiry: {
    label: 'Self-Inquiry',
    prompts: [
      'Where did your energy expand today, and where did it leak away?',
      'What truth are you circling around instead of stating plainly?',
      'What are you currently saying “yes” to out of inertia rather than conviction?',
      'Which conversation today lingered in your mind after it ended?',
    ],
  },
  craft: {
    label: 'Craft & Work',
    prompts: [
      'What small, unglamorous detail did you get right today?',
      'What obstacle in your current project actually points to a simpler design?',
      'What would tomorrow look like if you protected your first two hours before opening any inbox?',
    ],
  },
  senses: {
    label: 'Memory & Senses',
    prompts: [
      'Describe the exact quality of light, temperature, and background sound around you right now.',
      'What object on your desk or table tells the clearest story about this season of your life?',
      'Capture one fleeting detail from today that a photograph would miss.',
    ],
  },
});

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

export function saveCustomTemplate(templateObj, zeroFootprint = false) {
  if (zeroFootprint) return loadCustomTemplates(true);
  const existing = loadCustomTemplates(false);
  const next = [
    {
      id: `tpl-custom-${Date.now().toString(36)}`,
      name: String(templateObj.name || 'Custom Template').trim(),
      mood: String(templateObj.mood || '').trim(),
      tags: String(templateObj.tags || '').trim(),
      preserveWhitespace: Boolean(templateObj.preserveWhitespace),
      body: String(templateObj.body || ''),
      custom: true,
    },
    ...existing,
  ];
  try {
    window.localStorage.setItem(CUSTOM_TEMPLATES_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
  return next;
}

export function drawRandomPrompt(category = 'all', excludeText = '') {
  const pool = [];
  for (const [catKey, deck] of Object.entries(PROMPT_DECKS)) {
    if (category !== 'all' && category !== catKey) continue;
    for (const text of deck.prompts) {
      pool.push({ category: catKey, categoryLabel: deck.label, text });
    }
  }
  if (pool.length === 0) return null;
  const filtered = pool.filter((p) => p.text !== excludeText);
  const candidates = filtered.length > 0 ? filtered : pool;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

export function filterCommands(commands, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return commands;
  const tokens = q.split(/\s+/).filter(Boolean);

  return commands
    .map((cmd) => {
      const hay = `${cmd.title || ''} ${cmd.subtitle || ''} ${cmd.keywords || ''}`.toLowerCase();
      let score = 0;
      for (const tok of tokens) {
        if (hay.includes(tok)) {
          score += cmd.title.toLowerCase().startsWith(tok) ? 4 : 2;
        } else {
          return null;
        }
      }
      return { cmd, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.cmd);
}

/* ============================================================================
   PHASE 19: CULTURAL ARTIFACTS, LOCATION & WEATHER STAMP, DAILY CHECK-IN METRICS
   ============================================================================ */

export const ARTIFACT_FIELDS = Object.freeze([
  { key: 'reading', label: 'Reading', icon: '📖' },
  { key: 'listening', label: 'Listening', icon: '♫' },
  { key: 'watching', label: 'Watching', icon: '▣' },
  { key: 'drinking', label: 'Ritual / Food', icon: '☕' },
  { key: 'quote', label: 'Anchor Line', icon: '❝' },
]);

export function normalizeArtifacts(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  let hasAny = false;
  for (const f of ARTIFACT_FIELDS) {
    const val = String(raw[f.key] || '').trim();
    if (val) {
      out[f.key] = val;
      hasAny = true;
    }
  }
  return hasAny ? out : null;
}

const WMO_WEATHER_LABELS = Object.freeze({
  0: '☀ Clear Sky',
  1: '🌤 Mainly Clear',
  2: '⛅ Partly Cloudy',
  3: '☁ Overcast',
  45: '🌫 Fog',
  48: '🌫 Rime Fog',
  51: '🌦 Light Drizzle',
  53: '🌦 Drizzle',
  61: '🌧 Light Rain',
  63: '🌧 Rain',
  65: '🌧 Heavy Rain',
  71: '❄ Light Snow',
  73: '❄ Snow',
  80: '🌦 Rain Showers',
  95: '⛈ Thunderstorm',
});

export async function fetchCurrentLocationAndWeather() {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    throw new Error('Geolocation is unavailable in this browser.');
  }

  const coords = await new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(pos.coords),
      (err) =>
        reject(
          new Error(
            err.code === 1
              ? 'Location permission denied. You can still enter location & weather manually.'
              : 'Could not determine device coordinates.'
          )
        ),
      { enableHighAccuracy: false, timeout: 9000, maximumAge: 300000 }
    );
  });

  const lat = Number(coords.latitude.toFixed(4));
  const lon = Number(coords.longitude.toFixed(4));

  const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&temperature_unit=celsius`;
  const weatherRes = await fetch(weatherUrl);
  if (!weatherRes.ok) {
    throw new Error('Weather service unreachable right now.');
  }
  const weatherJson = await weatherRes.json();
  const tempC = Math.round(Number(weatherJson?.current?.temperature_2m ?? 0));
  const code = Number(weatherJson?.current?.weather_code ?? 0);
  const condition = WMO_WEATHER_LABELS[code] || '☁ Local Weather';

  let place = `${lat.toFixed(2)}°, ${lon.toFixed(2)}°`;
  try {
    const geoRes = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=10`
    );
    if (geoRes.ok) {
      const geoJson = await geoRes.json();
      const addr = geoJson?.address || {};
      const city = addr.city || addr.town || addr.village || addr.municipality || addr.county;
      const country = addr.country;
      if (city && country) place = `${city}, ${country}`;
      else if (city || country) place = city || country;
    }
  } catch {
    // Keep coordinate stamp fallback
  }

  const weather = `${condition} · ${tempC}°C`;
  return {
    place,
    weather,
    stampText: `${place} · ${weather}`,
  };
}

export const DEFAULT_CHECKIN_METRICS = Object.freeze([
  { id: 'energy', label: 'Energy', min: 1, max: 5 },
  { id: 'clarity', label: 'Clarity', min: 1, max: 5 },
  { id: 'calm', label: 'Calm', min: 1, max: 5 },
  { id: 'sleep', label: 'Sleep', min: 1, max: 5 },
]);

export function loadMetricDefinitions(zeroFootprint = false) {
  if (zeroFootprint) return [...DEFAULT_CHECKIN_METRICS];
  try {
    const raw = window.localStorage.getItem(CUSTOM_METRICS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : [...DEFAULT_CHECKIN_METRICS];
  } catch {
    return [...DEFAULT_CHECKIN_METRICS];
  }
}

export function saveMetricDefinitions(defs, zeroFootprint = false) {
  if (!zeroFootprint) {
    try {
      window.localStorage.setItem(CUSTOM_METRICS_KEY, JSON.stringify(defs));
    } catch {
      // ignore
    }
  }
  return defs;
}

export function normalizeEntryMetrics(rawMetrics) {
  if (!rawMetrics || typeof rawMetrics !== 'object') return null;
  const out = {};
  let hasAny = false;
  for (const [k, v] of Object.entries(rawMetrics)) {
    const num = Number(v);
    if (Number.isFinite(num) && num >= 1 && num <= 10) {
      out[String(k).trim()] = Math.round(num);
      hasAny = true;
    }
  }
  return hasAny ? out : null;
}

export function getHeatmapLevelForMode(daySummary, mode = 'years') {
  if (!daySummary || !Array.isArray(daySummary.years) || daySummary.years.length === 0) {
    return { level: 0, valueLabel: 'No entries' };
  }

  if (mode === 'words') {
    const totalW = Object.values(daySummary.wordCounts || {}).reduce(
      (acc, v) => acc + (Number(v) || 0),
      0
    );
    const level = totalW === 0 ? 1 : totalW < 150 ? 1 : totalW < 450 ? 2 : totalW < 900 ? 3 : 4;
    return { level, valueLabel: `${totalW.toLocaleString()} words` };
  }

  if (mode.startsWith('metric:')) {
    const metricId = mode.slice('metric:'.length);
    const vals = Object.values(daySummary.metrics || {})
      .map((m) => Number(m?.[metricId]))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (vals.length === 0) {
      return { level: 1, valueLabel: `${daySummary.years.length} yr(s) · no ${metricId} score` };
    }
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const level = avg < 2 ? 1 : avg < 3 ? 2 : avg < 4.2 ? 3 : 4;
    return { level, valueLabel: `${metricId}: ${avg.toFixed(1)}/5` };
  }

  const count = daySummary.years.length;
  return {
    level: Math.min(4, count),
    valueLabel: `${count} ${count === 1 ? 'year' : 'years'} (${daySummary.years.join(', ')})`,
  };
}

/* ============================================================================
   PHASE 20: THEME PRESETS, OFFLINE COMMIT QUEUE, PRINT-TO-BOOK, MINI-ZINE & IMPORTERS
   ============================================================================ */

export const THEME_PRESETS = Object.freeze({
  dark: { id: 'dark', label: 'Obsidian & Amber', metaColor: '#0d0d0d' },
  light: { id: 'light', label: 'Archival Paper', metaColor: '#f6f4ef' },
  sepia: { id: 'sepia', label: 'Sunlit Parchment', metaColor: '#f3ead8' },
  nordic: { id: 'nordic', label: 'Midnight Slate', metaColor: '#0f1621' },
});

export function getSavedThemePreset(zeroFootprint = false) {
  if (zeroFootprint) return 'dark';
  try {
    const val = window.localStorage.getItem(THEME_STORAGE_KEY);
    return val && THEME_PRESETS[val] ? val : 'dark';
  } catch {
    return 'dark';
  }
}

export function applyThemePreset(themeId, persist = true, zeroFootprint = false) {
  const chosen = THEME_PRESETS[themeId] ? themeId : 'dark';
  document.documentElement.setAttribute('data-theme', chosen);
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) metaTheme.setAttribute('content', THEME_PRESETS[chosen].metaColor);
  if (persist && !zeroFootprint) {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, chosen);
    } catch {
      // ignore
    }
  }
  return chosen;
}

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
      return [...this.ramQueue];
    }
  }

  save(items, zeroFootprint = false) {
    this.ramQueue = [...items];
    if (!zeroFootprint) {
      try {
        window.localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(items));
      } catch {
        // ignore quota errors
      }
    }
  }

  enqueue(serializedTx, zeroFootprint = false) {
    const list = this.load(zeroFootprint);
    list.push(serializedTx);
    this.save(list, zeroFootprint);
    return list.length;
  }

  count(zeroFootprint = false) {
    return this.load(zeroFootprint).length;
  }

  clear(zeroFootprint = false) {
    this.save([], zeroFootprint);
  }

  async flush({ ghClient, cloakAdapter = null, zeroFootprint = false, onItemSynced = null }) {
    const list = this.load(zeroFootprint);
    if (list.length === 0) return { synced: 0, remaining: 0, errors: [] };

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
        errors.push(err.message || 'Sync error');
        remaining.push(...list.slice(i));
        break;
      }
    }

    this.save(remaining, zeroFootprint);
    return { synced, remaining: remaining.length, errors };
  }
}

/**
 * Triggers the native browser Print Preview / Save as PDF dialog using a hidden iframe.
 * Avoids `window.open(..., 'noopener')` returning null and bypasses async popup blockers
 * in desktop browsers, mobile browsers, and installed standalone PWAs.
 *
 * @param {string} html
 * @param {string} [fallbackFilename='perpetual-diary-print.html']
 * @returns {{ ok: boolean, method: 'iframe' | 'download' }}
 */
function printHtmlDocument(html, fallbackFilename = 'perpetual-diary-print.html') {
  try {
    const existing = document.getElementById('perpetual-print-iframe');
    if (existing) existing.remove();

    const iframe = document.createElement('iframe');
    iframe.id = 'perpetual-print-iframe';
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.position = 'fixed';
    iframe.style.right = '0';
    iframe.style.bottom = '0';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';
    iframe.style.visibility = 'hidden';

    let printed = false;
    const cleanup = () => {
      window.setTimeout(() => {
        if (iframe.parentNode) iframe.remove();
      }, 1000);
    };

    const runPrint = () => {
      if (printed) return;
      printed = true;
      try {
        const win = iframe.contentWindow;
        if (!win) throw new Error('Print frame unavailable.');
        win.addEventListener('afterprint', cleanup, { once: true });
        win.focus();
        win.print();
        // Safety cleanup in case a browser does not fire afterprint
        window.setTimeout(cleanup, 60000);
      } catch {
        cleanup();
      }
    };

    iframe.onload = () => {
      window.requestAnimationFrame(() => window.setTimeout(runPrint, 60));
    };

    document.body.appendChild(iframe);
    const doc = iframe.contentDocument || iframe.contentWindow?.document;
    if (doc) {
      doc.open();
      doc.write(html);
      doc.close();
      // Fallback trigger if onload already fired synchronously on doc.close()
      window.setTimeout(runPrint, 180);
    } else {
      iframe.srcdoc = html;
    }

    return { ok: true, method: 'iframe' };
  } catch {
    // Fallback: download a self-contained print-ready HTML file
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fallbackFilename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
    return { ok: true, method: 'download' };
  }
}

export function openPrintBookWindow({
  title = 'Perpetual Side-by-Side Diary',
  subtitle = '',
  entries = [],
}) {
  const sorted = [...entries].sort(
    (a, b) =>
      String(a.diaryDate || '').localeCompare(String(b.diaryDate || '')) ||
      String(a.writtenAt || '').localeCompare(String(b.writtenAt || ''))
  );
  if (sorted.length === 0) {
    return { ok: false, count: 0, reason: 'empty' };
  }

  const generatedAt = new Date().toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const tocHtml = sorted
    .map(
      (e, idx) =>
        `<li><span class="toc-date">${escapeHtml(e.diaryDate)}</span> — <span>${escapeHtml(
          e.title || `Entry #${idx + 1}`
        )}</span></li>`
    )
    .join('');

  const chaptersHtml = sorted
    .map((e) => {
      const renderedBody = renderMarkdown(e.body || '', {
        preserveWhitespace: Boolean(e.preserveWhitespace),
        scopeId: `book-${e.id || e.diaryDate}`,
      });
      const metaParts = [
        e.diaryDate,
        e.mood ? `mood: ${e.mood}` : '',
        e.location || '',
        e.weather || '',
      ].filter(Boolean);

      return `
        <article class="book-entry">
          <div class="book-entry-meta">${escapeHtml(metaParts.join(' · '))}</div>
          ${e.title ? `<h2>${escapeHtml(e.title)}</h2>` : ''}
          <div class="book-prose">${renderedBody}</div>
        </article>
      `;
    })
    .join('');

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${escapeHtml(title)} — Print Edition</title>
  <style>
    @page { margin: 18mm; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 0;
      font-family: Georgia, "Times New Roman", serif;
      color: #161513;
      background: #ffffff;
      line-height: 1.65;
    }
    .book-sheet {
      max-width: 740px;
      margin: 0 auto;
      background: #ffffff;
    }
    .title-page {
      border-bottom: 2px solid #161513;
      padding-bottom: 24px;
      margin-bottom: 24px;
    }
    .kicker {
      font-family: ui-monospace, monospace;
      font-size: 11px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: #666;
    }
    h1 { font-size: 28px; margin: 8px 0 6px; font-weight: 500; }
    .toc { margin-bottom: 28px; font-size: 13px; }
    .toc ol { padding-left: 20px; columns: 2; column-gap: 24px; }
    .toc li { margin-bottom: 4px; break-inside: avoid; }
    .toc-date { font-family: ui-monospace, monospace; font-size: 11.5px; }
    .book-entry {
      padding: 18px 0;
      border-top: 1px solid #e4e0d6;
      break-inside: avoid-page;
    }
    .book-entry-meta {
      font-family: ui-monospace, monospace;
      font-size: 11px;
      color: #5f5b52;
      margin-bottom: 4px;
    }
    .book-entry h2 { font-size: 19px; margin: 2px 0 10px; font-weight: 600; }
    .book-prose blockquote {
      margin: 12px 0;
      padding-left: 14px;
      border-left: 2px solid #8a6d3b;
      font-style: italic;
      color: #3a3730;
    }
  </style>
</head>
<body>
  <main class="book-sheet">
    <header class="title-page">
      <div class="kicker">PERPETUAL ARCHIVE EDITION · ${escapeHtml(generatedAt)}</div>
      <h1>${escapeHtml(title)}</h1>
      ${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ''}
    </header>
    <section class="toc">
      <div class="kicker" style="margin-bottom:8px;">CONTENTS (${sorted.length} ENTRIES)</div>
      <ol>${tocHtml}</ol>
    </section>
    ${chaptersHtml}
  </main>
</body>
</html>`;

  const result = printHtmlDocument(
    html,
    `perpetual-book-${new Date().toISOString().slice(0, 10)}.html`
  );
  return { ...result, count: sorted.length };
}

export function openMiniZineWindow({ title = 'Perpetual Mini-Zine', entries = [] }) {
  const chosen = [...entries].slice(0, 6);
  if (chosen.length === 0) {
    return { ok: false, count: 0, reason: 'empty' };
  }

  const pages = new Array(8).fill(null).map((_, idx) => ({
    pageNum: idx + 1,
    heading: idx === 0 ? title : idx === 7 ? 'Colophon' : '',
    meta: idx === 0 ? new Date().toISOString().slice(0, 10) : '',
    body:
      idx === 0
        ? 'An 8-page pocket booklet folded from one sheet of paper.'
        : idx === 7
          ? 'Printed from Perpetual Side-by-Side Web Diary. Fold lengthwise, then accordion-fold into quarters and slit the center spine.'
          : '',
  }));

  chosen.forEach((e, i) => {
    const slot = pages[i + 1];
    slot.heading = e.title || e.diaryDate;
    slot.meta = `${e.diaryDate}${e.mood ? ` · ${e.mood}` : ''}`;
    const plain = stripMarkdown(e.body || '');
    slot.body = plain.length > 340 ? `${plain.slice(0, 340).trim()}…` : plain;
  });

  const renderPanel = (p, upsideDown = false) => `
    <section class="zine-cell${upsideDown ? ' is-inverted' : ''}">
      <div class="zine-meta">${escapeHtml(p.meta || `PAGE ${p.pageNum}`)}</div>
      ${p.heading ? `<h3>${escapeHtml(p.heading)}</h3>` : ''}
      <p>${escapeHtml(p.body)}</p>
      <div class="zine-num">${p.pageNum}</div>
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
      padding: 0;
      font-family: Georgia, serif;
      background: #ffffff;
      color: #111111;
    }
    .zine-sheet {
      width: 100vw;
      height: 96vh;
      background: #ffffff;
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      grid-template-rows: repeat(2, 1fr);
    }
    .zine-cell {
      border: 1px dashed #cccccc;
      padding: 14px 12px;
      position: relative;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .zine-cell.is-inverted { transform: rotate(180deg); }
    .zine-meta { font-family: ui-monospace, monospace; font-size: 9.5px; color: #555; }
    .zine-cell h3 { font-size: 13px; margin: 4px 0 6px; }
    .zine-cell p { font-size: 10.5px; line-height: 1.42; margin: 0; }
    .zine-num {
      position: absolute;
      bottom: 6px;
      right: 8px;
      font-family: ui-monospace, monospace;
      font-size: 9px;
      color: #777;
    }
  </style>
</head>
<body>
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

  const result = printHtmlDocument(
    html,
    `perpetual-mini-zine-${new Date().toISOString().slice(0, 10)}.html`
  );
  return { ...result, count: chosen.length };
}

export function parseImportedDiaryFile(filename, rawText) {
  const name = String(filename || '').toLowerCase();
  const text = String(rawText ?? '').trim();
  if (!text) return { format: 'empty', entries: [] };

  if (name.endsWith('.json') || text.startsWith('{') || text.startsWith('[')) {
    const parsed = JSON.parse(text);

    if (parsed && parsed.days && typeof parsed.days === 'object') {
      const entries = [];
      for (const [dayStr, doc] of Object.entries(parsed.days)) {
        for (const [yrKey, slot] of Object.entries(doc?.entries || {})) {
          const list = getYearEntriesList(slot, yrKey, dayStr);
          for (const e of list) {
            if (!e?.body) continue;
            const diaryDate = e.diaryDate || `${yrKey}-${dayStr}`;
            entries.push({
              diaryDate,
              dayStr: diaryDate.slice(5),
              year: Number(yrKey),
              title: e.title || '',
              body: e.body,
              mood: e.mood || '',
              tags: Array.isArray(e.tags) ? e.tags : [],
              location: e.location || '',
              weather: e.weather || '',
              artifacts: e.artifacts || null,
              metrics: e.metrics || null,
              preserveWhitespace: Boolean(e.preserveWhitespace),
              writtenAt: e.writtenAt || new Date().toISOString(),
            });
          }
        }
      }
      return { format: 'Perpetual Diary JSON', entries };
    }

    if (parsed && Array.isArray(parsed.entries)) {
      const entries = parsed.entries
        .map((e) => {
          const iso = String(e.creationDate || e.date || '').slice(0, 10);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
          const rawBody = String(e.text || e.body || '').trim();
          if (!rawBody) return null;
          const lines = rawBody.split('\n');
          let title = '';
          let body = rawBody;
          if (lines[0].startsWith('# ')) {
            title = lines[0].slice(2).trim();
            body = lines.slice(1).join('\n').trim();
          }
          const place =
            e.location?.placeName || e.location?.localityName || e.address || '';
          return {
            diaryDate: iso,
            dayStr: iso.slice(5),
            year: Number(iso.slice(0, 4)),
            title,
            body,
            mood: String(e.mood || '').toLowerCase(),
            tags: Array.isArray(e.tags) ? e.tags : [],
            location: String(place || ''),
            weather: '',
            writtenAt: e.creationDate || new Date().toISOString(),
          };
        })
        .filter(Boolean);
      return { format: 'Day One / Journey JSON', entries };
    }
  }

  const sections = text.split(/^#{1,3}\s+(\d{4}-\d{2}-\d{2})(?:\s+[—-]\s+(.*))?$/gm);
  const entries = [];
  if (sections.length > 1) {
    for (let i = 1; i < sections.length; i += 3) {
      const iso = sections[i];
      const title = (sections[i + 1] || '').trim();
      const body = (sections[i + 2] || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || !body) continue;
      entries.push({
        diaryDate: iso,
        dayStr: iso.slice(5),
        year: Number(iso.slice(0, 4)),
        title,
        body,
        mood: '',
        tags: [],
        writtenAt: new Date().toISOString(),
      });
    }
    return { format: 'Markdown Journal', entries };
  }

  const dateFromFilename = /(\d{4}-\d{2}-\d{2})/.exec(name);
  const fallbackDate = dateFromFilename ? dateFromFilename[1] : new Date().toISOString().slice(0, 10);
  return {
    format: 'Single Markdown Note',
    entries: [
      {
        diaryDate: fallbackDate,
        dayStr: fallbackDate.slice(5),
        year: Number(fallbackDate.slice(0, 4)),
        title: '',
        body: text,
        mood: '',
        tags: [],
        writtenAt: new Date().toISOString(),
      },
    ],
  };
}
