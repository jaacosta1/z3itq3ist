// js/app.js — Perpetual Side-by-Side Diary Main Application Controller (Phase 2: Envelope Encryption)

import {
  encryptText,
  decryptText,
  isEncryptedPayload,
  getPayloadVersion,
  createEnvelopeVault,
  unlockVault,
  rotateVaultPassword,
  upgradeLegacyVaultToEnvelope,
  encryptPatToken,
} from './crypto.js';
import {
  renderMarkdown,
  stripMarkdown,
  countWords,
  countChars,
  extractDefaultQuote,
} from './markdown.js';
import { GitHubClient, recalculateIndexForDay } from './github.js';
import {
  LocalMediaStore,
  processImageFile,
  resolveMediaSrc,
  AlignmentStudio,
  attachInlineAlignController,
} from './media.js';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatDayKey(month, day) {
  return `${pad2(month)}-${pad2(day)}`;
}

function parseDayKey(dayStr) {
  const match = /^(\d{2})-(\d{2})$/.exec(String(dayStr || '').trim());
  if (!match) return { month: 11, day: 24 };
  const month = Math.min(12, Math.max(1, Number(match[1])));
  const maxDay = DAYS_IN_MONTH[month - 1];
  const day = Math.min(maxDay, Math.max(1, Number(match[2])));
  return { month, day };
}

function formatReadableDay(dayStr) {
  const { month, day } = parseDayKey(dayStr);
  return `${MONTHS[month - 1]} ${day}`;
}

function getTodayIsoDate() {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

function getTodayDayKey() {
  return getTodayIsoDate().slice(5);
}

function diffCalendarDays(diaryDateStr, writtenAtIso) {
  if (!diaryDateStr || !writtenAtIso) return 0;
  const [y, m, d] = diaryDateStr.split('-').map(Number);
  if (!y || !m || !d) return 0;
  const writtenDate = new Date(writtenAtIso);
  if (Number.isNaN(writtenDate.getTime())) return 0;
  const diaryUtc = Date.UTC(y, m - 1, d);
  const writtenUtc = Date.UTC(
    writtenDate.getUTCFullYear(),
    writtenDate.getUTCMonth(),
    writtenDate.getUTCDate()
  );
  return Math.round((writtenUtc - diaryUtc) / 86400000);
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getAll366Days() {
  const list = [];
  for (let m = 1; m <= 12; m += 1) {
    for (let d = 1; d <= DAYS_IN_MONTH[m - 1]; d += 1) {
      list.push(formatDayKey(m, d));
    }
  }
  return list;
}

const SANDBOX_SEED_INDEX = {
  updatedAt: '2026-11-24T00:00:00Z',
  days: {
    '11-24': {
      years: [2024, 2025, 2026],
      tags: ['reflection', 'beginnings', 'craft', 'continuity'],
      wordCounts: { 2024: 72, 2025: 84, 2026: 68 },
      commentCount: 1,
    },
  },
};

const SANDBOX_SEED_DAYS = {
  '11-24': {
    day: '11-24',
    entries: {
      2024: {
        year: 2024,
        diaryDate: '2024-11-24',
        title: 'First frost & a quiet ledger',
        body:
          'Started keeping a perpetual diary today instead of letting notebooks vanish into boxes.\n\n> The value of a daily record is rarely visible in the same week you write it; it reveals itself three Novembers later.\n\nWalked around the block after rain and wrote down three anchors:\n- Keep notes honest rather than theatrical\n- Measure progress in seasons, not hours\n- Return to this exact page next year',
        tags: ['reflection', 'beginnings'],
        mood: 'grounded',
        image: null,
        writtenAt: '2024-11-25T05:10:00Z',
        updatedAt: '2024-11-25T05:10:00Z',
        encrypted: false,
      },
      2025: {
        year: 2025,
        diaryDate: '2025-11-24',
        title: 'One year later on the same page',
        body:
          'Reading **2024** side by side shows how much noise drops away over twelve months. What felt urgent last autumn barely registers now, while small daily habits carried the whole year.',
        tags: ['continuity', 'reflection'],
        mood: 'clear',
        image: null,
        writtenAt: '2025-11-27T08:00:00Z',
        updatedAt: '2025-11-27T08:00:00Z',
        encrypted: false,
      },
      2026: {
        year: 2026,
        diaryDate: '2026-11-24',
        title: 'Three layers of November 24',
        body:
          'Having **2024**, **2025**, and **2026** in parallel columns turns single-day journaling into a longitudinal mirror. Even short entries compound into a quiet map of who you were becoming.',
        tags: ['craft', 'continuity'],
        mood: 'focused',
        image: null,
        writtenAt: '2026-11-24T14:30:00Z',
        updatedAt: '2026-11-24T14:30:00Z',
        encrypted: false,
      },
    },
    comments: [
      {
        id: 'cmt-seed-1124-1',
        author: 'Self',
        body: 'Notice how the 2024 promise to "measure progress in seasons, not hours" echoed right into the 2025 reflection.',
        createdAt: '2026-11-24T15:05:00Z',
        updatedAt: '2026-11-24T15:05:00Z',
        encrypted: false,
        quote: {
          text: 'The value of a daily record is rarely visible in the same week you write it; it reveals itself three Novembers later.',
          year: 2024,
          diaryDate: '2024-11-24',
        },
        image: null,
      },
    ],
  },
};

class PerpetualDiaryApp {
  constructor() {
    this.mediaStore = new LocalMediaStore();
    const savedCfg = GitHubClient.loadConfig(window.localStorage);
    this.gh = new GitHubClient(savedCfg);

    this.state = {
      activeDay: '11-24',
      sortOrder: 'asc',
      colMode: 'fit',
      pinnedYear: null,
      mobileMode: 'swipe',
      mobileSelectedYear: null,
      compare2Active: false,
      compareDateA: '2024-11-24',
      compareDateB: '2026-11-24',
      indexData: { updatedAt: '', days: {} },
      dayCache: {},
      vaultMeta: null,
      keyring: null,
      cryptoKey: null,
      unlocked: true,
      pendingQuote: null,
      editingCommentId: null,
      commentDraftPhoto: null,
      editingEntryKey: null,
      entryDraftPhoto: null,
      editorMode: 'write',
      archiveSearch: '',
      archiveYear: '',
      archiveTag: '',
      confirmResolver: null,
      inlineAlignCleanup: null,
    };

    this.entryStudio = null;
    this.commentStudio = null;
    this.draftSaveTimer = null;
  }

  hasActiveSessionKey() {
    return Boolean(this.state.keyring?.dek || this.state.keyring?.legacyKey || this.state.cryptoKey);
  }

  setActiveKeyring(keyring) {
    this.state.keyring = keyring || null;
    this.state.cryptoKey = keyring ? keyring.dek || keyring.legacyKey || null : null;
  }

  async init() {
    this.initTheme();
    this.populateDateSelectors();
    this.initAlignmentStudios();
    this.bindEvents();

    try {
      await this.mediaStore.open();
    } catch {
      // IndexedDB fallback handled gracefully
    }

    await this.loadVaultAndIndex();
    this.applyHashRoute();
    await this.renderActiveView();
    this.updateModeBadge();
  }

  initTheme() {
    const savedTheme = window.localStorage.getItem('perpetual_diary_theme') || 'dark';
    this.setTheme(savedTheme);
  }

  setTheme(theme) {
    const next = theme === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    window.localStorage.setItem('perpetual_diary_theme', next);
    const icon = document.getElementById('theme-icon');
    if (icon) icon.textContent = next === 'dark' ? '☀' : '☾';
  }

  updateModeBadge() {
    const badge = document.getElementById('mode-badge');
    const lockNowBtn = document.getElementById('lock-now-btn');
    if (!badge) return;

    const target = this.gh.getDataTarget();
    if (this.gh.hasToken()) {
      badge.textContent = target.isSplitVault ? 'SPLIT VAULT · LIVE' : 'GITHUB LIVE';
      badge.classList.add('is-live');
    } else if (this.gh.isConfigured()) {
      badge.textContent = target.isSplitVault ? 'SPLIT VAULT · READ' : 'GITHUB READ';
      badge.classList.remove('is-live');
    } else {
      badge.textContent = 'SANDBOX';
      badge.classList.remove('is-live');
    }

    if (lockNowBtn) {
      lockNowBtn.hidden = !this.hasActiveSessionKey() && !this.state.vaultMeta?.enabled;
    }
  }

  showToast(message, type = 'info') {
    const stack = document.getElementById('toast-container');
    if (!stack) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    stack.appendChild(toast);
    window.setTimeout(() => {
      toast.classList.add('is-leaving');
      window.setTimeout(() => toast.remove(), 220);
    }, 3400);
  }

  openConfirm({ title = 'Confirm Action', message = 'Are you sure?', confirmLabel = 'Confirm' }) {
    return new Promise((resolve) => {
      this.state.confirmResolver = resolve;
      const modal = document.getElementById('confirm-modal');
      document.getElementById('confirm-modal-title').textContent = title;
      document.getElementById('confirm-modal-message').textContent = message;
      document.getElementById('confirm-ok-btn').textContent = confirmLabel;
      modal.hidden = false;
    });
  }

  closeConfirm(result = false) {
    const modal = document.getElementById('confirm-modal');
    if (modal) modal.hidden = true;
    const resolver = this.state.confirmResolver;
    this.state.confirmResolver = null;
    if (resolver) resolver(Boolean(result));
  }

  populateDateSelectors() {
    const monthSel = document.getElementById('month-select');
    const daySel = document.getElementById('day-select');
    if (!monthSel || !daySel) return;

    monthSel.innerHTML = MONTHS.map(
      (name, idx) =>
        `<option value="${pad2(idx + 1)}">${pad2(idx + 1)} · ${name.slice(0, 3).toUpperCase()}</option>`
    ).join('');

    this.syncDaySelectorOptions(11, 24);
  }

  syncDaySelectorOptions(month, selectedDay = 1) {
    const daySel = document.getElementById('day-select');
    if (!daySel) return;
    const maxDay = DAYS_IN_MONTH[month - 1] || 31;
    const clampedDay = Math.min(maxDay, Math.max(1, Number(selectedDay) || 1));
    daySel.innerHTML = Array.from({ length: maxDay }, (_, i) => {
      const d = i + 1;
      return `<option value="${pad2(d)}">${pad2(d)}</option>`;
    }).join('');
    daySel.value = pad2(clampedDay);
  }

  initAlignmentStudios() {
    this.entryStudio = new AlignmentStudio(document.getElementById('entry-alignment-host'), {
      onChange: (layout) => {
        if (this.state.entryDraftPhoto) {
          this.state.entryDraftPhoto = { ...this.state.entryDraftPhoto, ...layout };
          this.scheduleDraftAutosave();
        }
      },
    });

    this.commentStudio = new AlignmentStudio(document.getElementById('comment-alignment-host'), {
      onChange: (layout) => {
        if (this.state.commentDraftPhoto) {
          this.state.commentDraftPhoto = { ...this.state.commentDraftPhoto, ...layout };
        }
      },
    });
  }

  async loadVaultAndIndex() {
    const localVaultRaw = window.localStorage.getItem('perpetual_diary_vault_local_v1');
    let vaultMeta = null;

    if (this.gh.hasToken() || this.gh.isConfigured()) {
      try {
        vaultMeta = await this.gh.readJson('vault.json', null);
      } catch {
        vaultMeta = null;
      }
    }

    if (!vaultMeta && localVaultRaw) {
      try {
        vaultMeta = JSON.parse(localVaultRaw);
      } catch {
        vaultMeta = null;
      }
    }

    this.state.vaultMeta = vaultMeta;

    if (vaultMeta && vaultMeta.enabled && !this.hasActiveSessionKey()) {
      this.state.unlocked = false;
      const lockScreen = document.getElementById('lock-screen');
      if (lockScreen) lockScreen.hidden = false;
    } else {
      this.state.unlocked = true;
      const lockScreen = document.getElementById('lock-screen');
      if (lockScreen) lockScreen.hidden = true;
    }

    if (this.gh.hasToken() || this.gh.isConfigured()) {
      const remoteIndex = await this.gh.readJson('index.json', null);
      if (remoteIndex && remoteIndex.days) {
        this.state.indexData = remoteIndex;
        return;
      }
    }

    const sandboxIdxRaw = window.localStorage.getItem('perpetual_diary_sandbox_index_v1');
    if (sandboxIdxRaw) {
      try {
        this.state.indexData = JSON.parse(sandboxIdxRaw);
        return;
      } catch {
        // fall back to seed
      }
    }

    this.state.indexData = JSON.parse(JSON.stringify(SANDBOX_SEED_INDEX));
    window.localStorage.setItem(
      'perpetual_diary_sandbox_index_v1',
      JSON.stringify(this.state.indexData)
    );
  }

  async getDayDocument(dayStr, forceRefresh = false) {
    if (!forceRefresh && this.state.dayCache[dayStr]) {
      return this.state.dayCache[dayStr];
    }

    if (this.gh.hasToken() || this.gh.isConfigured()) {
      const remoteDoc = await this.gh.readJson(`days/${dayStr}.json`, null);
      if (remoteDoc && typeof remoteDoc === 'object') {
        const normalized = {
          day: dayStr,
          entries: remoteDoc.entries || {},
          comments: Array.isArray(remoteDoc.comments) ? remoteDoc.comments : [],
        };
        this.state.dayCache[dayStr] = normalized;
        return normalized;
      }
    }

    const sandboxDaysRaw = window.localStorage.getItem('perpetual_diary_sandbox_days_v1');
    let sandboxDays = {};
    if (sandboxDaysRaw) {
      try {
        sandboxDays = JSON.parse(sandboxDaysRaw);
      } catch {
        sandboxDays = {};
      }
    } else {
      sandboxDays = JSON.parse(JSON.stringify(SANDBOX_SEED_DAYS));
      window.localStorage.setItem('perpetual_diary_sandbox_days_v1', JSON.stringify(sandboxDays));
    }

    const doc = sandboxDays[dayStr] || {
      day: dayStr,
      entries: {},
      comments: [],
    };
    this.state.dayCache[dayStr] = doc;
    return doc;
  }

  async persistDayDocument(dayStr, nextDoc, commitMessage) {
    const normalized = {
      day: dayStr,
      entries: nextDoc.entries || {},
      comments: Array.isArray(nextDoc.comments) ? nextDoc.comments : [],
    };

    this.state.dayCache[dayStr] = normalized;

    if (this.gh.hasToken()) {
      const { index } = await this.gh.updateDayAndIndex(dayStr, normalized, commitMessage);
      this.state.indexData = index;
      return normalized;
    }

    const sandboxDaysRaw = window.localStorage.getItem('perpetual_diary_sandbox_days_v1');
    let sandboxDays = {};
    try {
      sandboxDays = sandboxDaysRaw ? JSON.parse(sandboxDaysRaw) : {};
    } catch {
      sandboxDays = {};
    }

    if (Object.keys(normalized.entries).length === 0 && normalized.comments.length === 0) {
      delete sandboxDays[dayStr];
    } else {
      sandboxDays[dayStr] = normalized;
    }

    window.localStorage.setItem('perpetual_diary_sandbox_days_v1', JSON.stringify(sandboxDays));
    this.state.indexData = recalculateIndexForDay(this.state.indexData, dayStr, normalized);
    window.localStorage.setItem(
      'perpetual_diary_sandbox_index_v1',
      JSON.stringify(this.state.indexData)
    );
    return normalized;
  }

  async persistVaultMeta(vaultMeta, commitMessage = 'diary: update envelope vault') {
    this.state.vaultMeta = vaultMeta;
    window.localStorage.setItem('perpetual_diary_vault_local_v1', JSON.stringify(vaultMeta));
    if (this.gh.hasToken()) {
      await this.gh.putJson('vault.json', vaultMeta, commitMessage);
    }
  }

  async decryptFieldIfNeeded(value, isEncrypted) {
    if (!isEncrypted && !isEncryptedPayload(value)) {
      return String(value ?? '');
    }
    if (!this.hasActiveSessionKey()) {
      return null;
    }
    try {
      return await decryptText(value, this.state.keyring || this.state.cryptoKey);
    } catch {
      return null;
    }
  }

  applyHashRoute() {
    const rawHash = (window.location.hash || '').replace(/^#/, '');
    if (!rawHash || rawHash === 'today') {
      this.state.activeDay = getTodayDayKey();
      return;
    }

    if (rawHash.startsWith('compare?')) {
      const params = new URLSearchParams(rawHash.slice('compare?'.length));
      const a = params.get('a');
      const b = params.get('b');
      if (a && b) {
        this.state.compare2Active = true;
        this.state.compareDateA = a;
        this.state.compareDateB = b;
        this.state.activeDay = a.slice(5);
        return;
      }
    }

    const [dayPart] = rawHash.split('?');
    if (/^\d{2}-\d{2}$/.test(dayPart)) {
      this.state.activeDay = dayPart;
    }
  }

  syncHashRoute() {
    if (this.state.compare2Active) {
      const a = encodeURIComponent(this.state.compareDateA);
      const b = encodeURIComponent(this.state.compareDateB);
      window.history.replaceState(null, '', `#compare?a=${a}&b=${b}`);
    } else {
      window.history.replaceState(null, '', `#${this.state.activeDay}`);
    }
  }

  switchView(viewName) {
    document.querySelectorAll('.nav-tab').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.view === viewName);
    });
    document.querySelectorAll('.view-section').forEach((sec) => {
      sec.classList.toggle('is-active', sec.id === `view-${viewName}`);
    });

    if (viewName === 'heatmap') {
      this.renderHeatmap();
    } else if (viewName === 'archive') {
      this.renderArchive();
    } else {
      this.renderReader();
    }
  }

  async renderActiveView() {
    const activeTab = document.querySelector('.nav-tab.is-active')?.dataset.view || 'reader';
    if (activeTab === 'heatmap') {
      this.renderHeatmap();
    } else if (activeTab === 'archive') {
      await this.renderArchive();
    } else {
      await this.renderReader();
    }
  }

  async renderReader() {
    const { month, day } = parseDayKey(this.state.activeDay);
    const monthSel = document.getElementById('month-select');
    if (monthSel) monthSel.value = pad2(month);
    this.syncDaySelectorOptions(month, day);

    document.getElementById('active-date-title').textContent = formatReadableDay(
      this.state.activeDay
    );

    const comparePanel = document.getElementById('compare2-panel');
    if (comparePanel) {
      comparePanel.hidden = !this.state.compare2Active;
      if (this.state.compare2Active) {
        document.getElementById('compare-date-a').value = this.state.compareDateA;
        document.getElementById('compare-date-b').value = this.state.compareDateB;
      }
    }

    const stage = document.getElementById('columns-stage');
    stage.className = `columns-stage col-mode-${this.state.colMode}${
      this.state.mobileMode === 'tabs' ? ' mobile-mode-tabs' : ''
    }`;

    if (this.state.compare2Active) {
      const mobileTabs = document.getElementById('mobile-year-tabs');
      if (mobileTabs) mobileTabs.hidden = true;
      await this.renderCompare2Columns(stage);
    } else {
      await this.renderDayColumns(stage, this.state.activeDay);
    }

    await this.renderComments(this.state.activeDay);
    this.syncHashRoute();
  }

  async renderCompare2Columns(stage) {
    const pairs = [
      { label: 'Date A', iso: this.state.compareDateA },
      { label: 'Date B', iso: this.state.compareDateB },
    ];
    document.getElementById('recorded-years-count').textContent = 'COMPARE 2';
    stage.innerHTML = '';

    for (const item of pairs) {
      const [yrStr, mm, dd] = String(item.iso || '2026-11-24').split('-');
      const dayKey = `${mm}-${dd}`;
      const doc = await this.getDayDocument(dayKey);
      const entry = doc.entries?.[yrStr] || {
        year: Number(yrStr) || 2026,
        diaryDate: item.iso,
        title: `${item.label} (${item.iso})`,
        body: '_No entry recorded on this exact date._',
        tags: [],
        mood: '',
        image: null,
        encrypted: false,
      };
      const card = await this.buildEntryColumnCard(entry, dayKey, yrStr);
      stage.appendChild(card);
    }
  }

  async renderDayColumns(stage, dayStr) {
    const doc = await this.getDayDocument(dayStr);
    const entries = doc.entries || {};
    let years = Object.keys(entries)
      .map((y) => Number(y))
      .filter((n) => Number.isFinite(n));

    years.sort((a, b) => (this.state.sortOrder === 'asc' ? a - b : b - a));

    if (this.state.pinnedYear && years.includes(Number(this.state.pinnedYear))) {
      const pinNum = Number(this.state.pinnedYear);
      years = [pinNum, ...years.filter((y) => y !== pinNum)];
    }

    document.getElementById('recorded-years-count').textContent =
      `${years.length} ${years.length === 1 ? 'YEAR' : 'YEARS'}`;

    const mobileTabs = document.getElementById('mobile-year-tabs');
    if (years.length > 0 && !years.includes(Number(this.state.mobileSelectedYear))) {
      this.state.mobileSelectedYear = years[0];
    }

    if (mobileTabs) {
      if (this.state.mobileMode === 'tabs' && years.length > 0) {
        mobileTabs.hidden = false;
        mobileTabs.innerHTML = years
          .map(
            (yr) =>
              `<button type="button" class="mobile-year-tab ${
                Number(this.state.mobileSelectedYear) === yr ? 'is-active' : ''
              }" role="tab" data-mobile-year="${yr}">${yr}</button>`
          )
          .join('');
        mobileTabs.querySelectorAll('.mobile-year-tab').forEach((tabBtn) => {
          tabBtn.addEventListener('click', () => {
            this.state.mobileSelectedYear = Number(tabBtn.dataset.mobileYear);
            this.renderReader();
          });
        });
      } else {
        mobileTabs.hidden = true;
        mobileTabs.innerHTML = '';
      }
    }

    stage.innerHTML = '';

    for (const yr of years) {
      const entry = entries[String(yr)];
      const card = await this.buildEntryColumnCard(entry, dayStr, String(yr));
      if (
        this.state.mobileMode === 'tabs' &&
        Number(this.state.mobileSelectedYear) !== Number(yr)
      ) {
        card.classList.add('mobile-tab-hidden');
      }
      stage.appendChild(card);
    }

    const addCard = document.createElement('article');
    addCard.className = 'year-column add-year-card';
    const defaultNewYear = new Date().getFullYear();
    addCard.innerHTML = `
      <div class="add-year-inner">
        <div class="mono-label">+ ADD RETROACTIVE YEAR</div>
        <p class="section-subtext">Transcribe or backdate an entry for ${escapeHtml(formatReadableDay(dayStr))}.</p>
        <div class="add-year-controls">
          <input type="number" class="input-text input-year" min="1900" max="2100" value="${defaultNewYear}" aria-label="Target Year" />
          <button type="button" class="btn btn-primary btn-sm add-year-go-btn">Open Composer</button>
        </div>
      </div>
    `;
    addCard.querySelector('.add-year-go-btn').addEventListener('click', () => {
      const yrVal = Number(addCard.querySelector('.input-year').value) || defaultNewYear;
      const { month, day } = parseDayKey(dayStr);
      const iso = `${yrVal}-${pad2(month)}-${pad2(day)}`;
      this.openComposer({ presetDate: iso });
    });
    stage.appendChild(addCard);
  }

  async buildEntryColumnCard(entry, dayStr, yearKey) {
    const col = document.createElement('article');
    const isPinned = Number(this.state.pinnedYear) === Number(entry.year);
    col.className = `year-column${isPinned ? ' is-pinned' : ''}`;
    col.dataset.year = String(entry.year);
    col.dataset.diaryDate = entry.diaryDate || `${entry.year}-${dayStr}`;

    const backdatedDays = diffCalendarDays(entry.diaryDate, entry.writtenAt);
    const backdateBadge =
      backdatedDays > 0
        ? `<span class="badge-backdated">BACKDATED +${backdatedDays}d</span>`
        : '';

    const decryptedBody = await this.decryptFieldIfNeeded(entry.body, Boolean(entry.encrypted));
    const decryptedTitle = await this.decryptFieldIfNeeded(
      entry.title || '',
      Boolean(entry.encrypted)
    );
    const isLockedEntry = decryptedBody === null;

    let bodyHtml = '';
    let plainWords = 0;

    if (isLockedEntry) {
      bodyHtml = `
        <div class="encrypted-card">
          <div class="mono-label">ENCRYPTED ENTRY · AES-256-GCM</div>
          <p>Encrypted Entry — Unlock the Vault to read this prose.</p>
          <button type="button" class="btn btn-outline btn-sm unlock-inline-btn">Unlock Vault</button>
        </div>
      `;
    } else {
      bodyHtml = renderMarkdown(decryptedBody);
      plainWords = countWords(stripMarkdown(decryptedBody));
    }

    let mediaHtml = '';
    if (!isLockedEntry && entry.image && entry.image.src) {
      const resolvedSrc = await resolveMediaSrc(entry.image.src, this.gh, this.mediaStore);
      if (resolvedSrc) {
        const align = entry.image.align || 'full';
        const posX = Number.isFinite(Number(entry.image.posX)) ? Number(entry.image.posX) : 50;
        const posY = Number.isFinite(Number(entry.image.posY)) ? Number(entry.image.posY) : 50;
        const widthPct = Number.isFinite(Number(entry.image.width))
          ? Number(entry.image.width)
          : 100;
        const heightPx = Number.isFinite(Number(entry.image.height))
          ? Number(entry.image.height)
          : 240;

        mediaHtml = `
          <figure class="entry-figure align-${escapeHtml(align)}" style="width:${widthPct}%;max-width:100%;">
            <div class="entry-figure-frame" style="height:${heightPx}px;">
              <img
                src="${escapeHtml(resolvedSrc)}"
                alt="${escapeHtml(entry.image.caption || `Photo from ${entry.diaryDate}`)}"
                style="object-position:${posX}% ${posY}%;"
              />
              <button type="button" class="btn btn-ghost btn-sm inline-realign-btn" title="Adjust photo pan & alignment">
                ⇄ Drag Align
              </button>
            </div>
            ${entry.image.caption ? `<figcaption class="figure-caption">${escapeHtml(entry.image.caption)}</figcaption>` : ''}
          </figure>
        `;
      }
    }

    const tagsHtml =
      Array.isArray(entry.tags) && entry.tags.length
        ? entry.tags.map((t) => `<span class="tag-chip">#${escapeHtml(t)}</span>`).join('')
        : '';

    const moodHtml = entry.mood
      ? `<span class="mood-chip">mood: ${escapeHtml(entry.mood)}</span>`
      : '';

    const metaChipsHtml =
      moodHtml || tagsHtml ? `<div class="entry-meta-chips">${moodHtml}${tagsHtml}</div>` : '';

    const loggedLabel = entry.writtenAt
      ? `Logged ${new Date(entry.writtenAt).toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        })}`
      : '';

    const payloadVer = entry.encrypted ? getPayloadVersion(entry.body) : 0;
    const encBadge = payloadVer ? ` · v${payloadVer}` : '';

    col.innerHTML = `
      <header class="year-col-header">
        <div class="year-col-title-row">
          <span class="year-heading">${escapeHtml(String(entry.year))}</span>
          ${backdateBadge}
        </div>
        <div class="year-col-actions">
          <button type="button" class="btn btn-ghost btn-sm col-quote-btn" title="Quote in margin comment">❝ Quote</button>
          <button type="button" class="btn btn-ghost btn-sm col-pin-btn ${isPinned ? 'is-pinned' : ''}" title="Pin column to left">
            ${isPinned ? 'Pinned' : 'Pin'}
          </button>
          <button type="button" class="btn btn-ghost btn-sm col-edit-btn">Edit</button>
          <button type="button" class="btn btn-ghost btn-sm col-delete-btn">Delete</button>
        </div>
      </header>
      <div class="mono-meta year-col-date">${escapeHtml(entry.diaryDate || `${entry.year}-${dayStr}`)}${encBadge}</div>
      ${!isLockedEntry && decryptedTitle ? `<h3 class="entry-title">${escapeHtml(decryptedTitle)}</h3>` : ''}
      ${metaChipsHtml}
      <div class="entry-prose-wrap">
        ${mediaHtml}
        <div class="prose-body">${bodyHtml}</div>
      </div>
      <footer class="year-col-footer mono-meta">
        <span>${isLockedEntry ? 'Encrypted' : `${plainWords} words`}</span>
        <span>${escapeHtml(loggedLabel)}</span>
      </footer>
    `;

    const unlockBtn = col.querySelector('.unlock-inline-btn');
    if (unlockBtn) {
      unlockBtn.addEventListener('click', () => {
        document.getElementById('lock-screen').hidden = false;
        document.getElementById('lock-password-input').focus();
      });
    }

    col.querySelector('.col-pin-btn').addEventListener('click', () => {
      this.state.pinnedYear =
        Number(this.state.pinnedYear) === Number(entry.year) ? null : Number(entry.year);
      this.renderReader();
    });

    col.querySelector('.col-quote-btn').addEventListener('click', () => {
      const sel = window.getSelection()?.toString().trim();
      const insideCol =
        sel &&
        window.getSelection()?.anchorNode &&
        col.contains(window.getSelection().anchorNode);
      const quoteText = insideCol ? sel : extractDefaultQuote(decryptedBody || '');
      if (!quoteText) {
        this.showToast('No text available to quote from this entry.', 'warn');
        return;
      }
      this.attachQuoteToComment({
        text: quoteText,
        year: Number(entry.year),
        diaryDate: entry.diaryDate || `${entry.year}-${dayStr}`,
      });
    });

    col.querySelector('.col-edit-btn').addEventListener('click', () => {
      this.openComposer({
        editEntry: {
          ...entry,
          body: decryptedBody ?? entry.body,
          title: decryptedTitle ?? entry.title,
        },
        dayStr,
        yearKey,
      });
    });

    col.querySelector('.col-delete-btn').addEventListener('click', async () => {
      await this.handleDeleteEntry(dayStr, yearKey, entry);
    });

    const realignBtn = col.querySelector('.inline-realign-btn');
    if (realignBtn && entry.image) {
      realignBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (this.state.inlineAlignCleanup) {
          this.state.inlineAlignCleanup();
          this.state.inlineAlignCleanup = null;
        }
        const figureEl = col.querySelector('.entry-figure');
        this.state.inlineAlignCleanup = attachInlineAlignController(
          figureEl,
          entry.image,
          async (updatedLayout) => {
            const latestDoc = await this.getDayDocument(dayStr, true);
            if (latestDoc.entries[yearKey]) {
              latestDoc.entries[yearKey].image = {
                ...latestDoc.entries[yearKey].image,
                ...updatedLayout,
              };
              latestDoc.entries[yearKey].updatedAt = new Date().toISOString();
              await this.persistDayDocument(
                dayStr,
                latestDoc,
                `diary: realign photo ${entry.diaryDate || yearKey}`
              );
              this.showToast('Photo alignment saved.', 'success');
              await this.renderReader();
            }
          }
        );
      });
    }

    return col;
  }

  attachQuoteToComment(quoteObj) {
    this.state.pendingQuote = quoteObj;
    const box = document.getElementById('comment-quote-attachment');
    document.getElementById('comment-quote-source').textContent =
      `QUOTING ${quoteObj.year} · ${quoteObj.diaryDate}`;
    document.getElementById('comment-quote-preview').textContent = quoteObj.text;
    box.hidden = false;

    const pill = document.getElementById('selection-quote-pill');
    if (pill) pill.hidden = true;

    const section = document.getElementById('comments-section');
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    window.setTimeout(() => {
      document.getElementById('comment-body-input')?.focus();
    }, 250);
  }

  async renderComments(dayStr) {
    const doc = await this.getDayDocument(dayStr);
    const comments = Array.isArray(doc.comments) ? doc.comments : [];
    document.getElementById('header-comment-count').textContent = String(comments.length);
    document.getElementById('comments-total-label').textContent =
      `${comments.length} ${comments.length === 1 ? 'NOTE' : 'NOTES'}`;

    const listEl = document.getElementById('comments-list');
    listEl.innerHTML = '';

    if (comments.length === 0) {
      listEl.innerHTML = `<div class="empty-comments mono-meta">No margin notes on ${formatReadableDay(dayStr)} yet.</div>`;
      return;
    }

    for (const cmt of comments) {
      const card = document.createElement('article');
      card.className = 'comment-card';
      const plainBody = await this.decryptFieldIfNeeded(cmt.body, Boolean(cmt.encrypted));
      const isLocked = plainBody === null;

      let quoteCardHtml = '';
      if (cmt.quote && cmt.quote.text) {
        quoteCardHtml = `
          <button
            type="button"
            class="quoted-citation-card"
            data-jump-year="${escapeHtml(String(cmt.quote.year || ''))}"
            data-jump-date="${escapeHtml(String(cmt.quote.diaryDate || ''))}"
          >
            <div class="mono-label">QUOTING ${escapeHtml(String(cmt.quote.year || ''))} · ${escapeHtml(String(cmt.quote.diaryDate || ''))}</div>
            <div class="quoted-citation-text">“${escapeHtml(cmt.quote.text)}”</div>
          </button>
        `;
      }

      let photoHtml = '';
      if (!isLocked && cmt.image && cmt.image.src) {
        const resolved = await resolveMediaSrc(cmt.image.src, this.gh, this.mediaStore);
        if (resolved) {
          photoHtml = `
            <figure class="comment-figure">
              <img
                src="${escapeHtml(resolved)}"
                alt="${escapeHtml(cmt.image.caption || 'Comment attachment')}"
                style="object-position:${cmt.image.posX ?? 50}% ${cmt.image.posY ?? 50}%;max-height:${cmt.image.height ?? 200}px;"
              />
              ${cmt.image.caption ? `<figcaption class="figure-caption">${escapeHtml(cmt.image.caption)}</figcaption>` : ''}
            </figure>
          `;
        }
      }

      const timestamp = cmt.createdAt
        ? new Date(cmt.createdAt).toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })
        : '';

      card.innerHTML = `
        <div class="comment-card-top">
          <div class="comment-author-meta">
            <span class="comment-author">${escapeHtml(cmt.author || 'Self')}</span>
            <span class="mono-meta">${escapeHtml(timestamp)}</span>
          </div>
          <div class="comment-actions">
            <button type="button" class="btn btn-ghost btn-sm cmt-edit-btn">Edit</button>
            <button type="button" class="btn btn-ghost btn-sm cmt-delete-btn">Delete</button>
          </div>
        </div>
        ${quoteCardHtml}
        <div class="prose-body comment-body">
          ${isLocked ? '<em>Encrypted note — unlock Vault to view.</em>' : renderMarkdown(plainBody)}
        </div>
        ${photoHtml}
      `;

      const jumpBtn = card.querySelector('.quoted-citation-card');
      if (jumpBtn) {
        jumpBtn.addEventListener('click', () => {
          const targetYear = jumpBtn.dataset.jumpYear;
          const targetCol = document.querySelector(`.year-column[data-year="${targetYear}"]`);
          if (targetCol) {
            targetCol.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
            targetCol.classList.remove('flash-highlight');
            void targetCol.offsetWidth;
            targetCol.classList.add('flash-highlight');
          }
        });
      }

      card.querySelector('.cmt-edit-btn').addEventListener('click', () => {
        this.startEditingComment(cmt, plainBody ?? cmt.body);
      });

      card.querySelector('.cmt-delete-btn').addEventListener('click', async () => {
        await this.handleDeleteComment(dayStr, cmt);
      });

      listEl.appendChild(card);
    }
  }

  startEditingComment(cmt, bodyText) {
    this.state.editingCommentId = cmt.id;
    document.getElementById('comment-editing-banner').hidden = false;
    document.getElementById('comment-author-input').value = cmt.author || 'Self';
    document.getElementById('comment-body-input').value = bodyText || '';
    document.getElementById('comment-encrypt-checkbox').checked = Boolean(cmt.encrypted);
    document.getElementById('comment-submit-btn').textContent = 'Save Note Changes';

    if (cmt.quote && cmt.quote.text) {
      this.state.pendingQuote = { ...cmt.quote };
      document.getElementById('comment-quote-source').textContent =
        `QUOTING ${cmt.quote.year} · ${cmt.quote.diaryDate}`;
      document.getElementById('comment-quote-preview').textContent = cmt.quote.text;
      document.getElementById('comment-quote-attachment').hidden = false;
    } else {
      this.clearCommentQuote();
    }

    this.state.commentDraftPhoto = cmt.image ? { ...cmt.image } : null;
    document.getElementById('comment-photo-remove-btn').hidden = !this.state.commentDraftPhoto;
    document.getElementById('comment-photo-caption').value = cmt.image?.caption || '';
    if (this.state.commentDraftPhoto) {
      resolveMediaSrc(this.state.commentDraftPhoto.src, this.gh, this.mediaStore).then((src) => {
        this.commentStudio.setMedia(src, this.state.commentDraftPhoto);
      });
    } else {
      this.commentStudio.clear();
    }

    document.getElementById('comment-body-input').focus();
  }

  resetCommentComposer() {
    this.state.editingCommentId = null;
    this.state.commentDraftPhoto = null;
    document.getElementById('comment-editing-banner').hidden = true;
    document.getElementById('comment-body-input').value = '';
    document.getElementById('comment-photo-url').value = '';
    document.getElementById('comment-photo-caption').value = '';
    document.getElementById('comment-photo-remove-btn').hidden = true;
    document.getElementById('comment-submit-btn').textContent = 'Post Margin Note';
    this.clearCommentQuote();
    this.commentStudio.clear();
  }

  clearCommentQuote() {
    this.state.pendingQuote = null;
    document.getElementById('comment-quote-attachment').hidden = true;
    document.getElementById('comment-quote-preview').textContent = '';
    document.getElementById('comment-quote-source').textContent = '';
  }

  async handleCommentSubmit(ev) {
    ev.preventDefault();
    const dayStr = this.state.activeDay;
    const author = document.getElementById('comment-author-input').value.trim() || 'Self';
    let body = document.getElementById('comment-body-input').value.trim();
    if (!body) return;

    const shouldEncrypt = document.getElementById('comment-encrypt-checkbox').checked;
    if (shouldEncrypt) {
      if (!this.hasActiveSessionKey()) {
        this.showToast('Unlock the Vault first to encrypt margin notes.', 'warn');
        return;
      }
      body = await encryptText(body, this.state.keyring || this.state.cryptoKey);
    }

    const caption = document.getElementById('comment-photo-caption').value.trim();
    const photoUrl = document.getElementById('comment-photo-url').value.trim();
    let imagePayload = this.state.commentDraftPhoto ? { ...this.state.commentDraftPhoto } : null;

    if (!imagePayload && photoUrl && /^https:\/\//i.test(photoUrl)) {
      imagePayload = {
        src: photoUrl,
        caption,
        align: 'full',
        posX: 50,
        posY: 50,
        width: 100,
        height: 220,
      };
    } else if (imagePayload) {
      imagePayload.caption = caption;
      if (imagePayload._pendingBuffer) {
        const mediaSubpath = `media/${getTodayIsoDate()}-${Date.now()}.${imagePayload._ext || 'jpg'}`;
        if (this.gh.hasToken()) {
          await this.gh.uploadBinaryMedia(
            mediaSubpath,
            imagePayload._pendingBuffer,
            `diary: attach comment media ${mediaSubpath}`
          );
          imagePayload.src = `${this.gh.getDataTarget().basePath}/${mediaSubpath}`;
        } else {
          await this.mediaStore.putImage(
            mediaSubpath,
            imagePayload._pendingBuffer,
            imagePayload._mime
          );
          imagePayload.src = `idb:${mediaSubpath}`;
        }
        delete imagePayload._pendingBuffer;
        delete imagePayload._ext;
        delete imagePayload._mime;
      }
    }

    const doc = await this.getDayDocument(dayStr, true);
    const comments = Array.isArray(doc.comments) ? [...doc.comments] : [];
    const nowIso = new Date().toISOString();

    if (this.state.editingCommentId) {
      const idx = comments.findIndex((c) => c.id === this.state.editingCommentId);
      if (idx !== -1) {
        comments[idx] = {
          ...comments[idx],
          author,
          body,
          updatedAt: nowIso,
          encrypted: shouldEncrypt,
          quote: this.state.pendingQuote ? { ...this.state.pendingQuote } : null,
          image: imagePayload,
        };
      }
      doc.comments = comments;
      await this.persistDayDocument(dayStr, doc, `diary: edit comment on ${dayStr}`);
      this.showToast('Margin note updated.', 'success');
    } else {
      comments.push({
        id: `cmt-${Date.now()}`,
        author,
        body,
        createdAt: nowIso,
        updatedAt: nowIso,
        encrypted: shouldEncrypt,
        quote: this.state.pendingQuote ? { ...this.state.pendingQuote } : null,
        image: imagePayload,
      });
      doc.comments = comments;
      await this.persistDayDocument(dayStr, doc, `diary: add comment on ${dayStr}`);
      this.showToast('Margin note posted.', 'success');
    }

    this.resetCommentComposer();
    await this.renderComments(dayStr);
  }

  async handleDeleteComment(dayStr, commentObj) {
    const confirmed = await this.openConfirm({
      title: 'Delete Margin Note',
      message: 'Remove this margin note permanently from the day log?',
      confirmLabel: 'Delete Note',
    });
    if (!confirmed) return;

    const doc = await this.getDayDocument(dayStr, true);
    doc.comments = (doc.comments || []).filter((c) => c.id !== commentObj.id);
    await this.persistDayDocument(dayStr, doc, `diary: delete comment on ${dayStr}`);

    if (commentObj.image?.src?.startsWith('data/media/') && this.gh.hasToken()) {
      const sub = commentObj.image.src.replace(/^data\//, '');
      await this.gh.deleteFile(sub, `diary: remove comment media ${sub}`).catch(() => {});
    }

    this.showToast('Margin note deleted.', 'success');
    await this.renderComments(dayStr);
  }

  openComposer({ presetDate = null, editEntry = null, dayStr = null, yearKey = null } = {}) {
    const modal = document.getElementById('composer-modal');
    const dateInput = document.getElementById('entry-date-input');
    const titleInput = document.getElementById('entry-title-input');
    const moodInput = document.getElementById('entry-mood-input');
    const tagsInput = document.getElementById('entry-tags-input');
    const bodyInput = document.getElementById('entry-body-input');
    const encryptCb = document.getElementById('entry-encrypt-checkbox');
    const deleteBtn = document.getElementById('entry-delete-btn');

    document.getElementById('entry-photo-url').value = '';
    document.getElementById('entry-photo-caption').value = '';
    document.getElementById('entry-photo-remove-btn').hidden = true;
    this.entryStudio.clear();

    if (editEntry) {
      this.state.editingEntryKey = {
        originalDayStr: dayStr || editEntry.diaryDate.slice(5),
        originalYearKey: yearKey || String(editEntry.year),
        originalWrittenAt: editEntry.writtenAt || new Date().toISOString(),
      };
      document.getElementById('composer-modal-title').textContent =
        `Edit Entry · ${editEntry.diaryDate}`;
      dateInput.value = editEntry.diaryDate || getTodayIsoDate();
      titleInput.value = editEntry.title || '';
      moodInput.value = editEntry.mood || '';
      tagsInput.value = Array.isArray(editEntry.tags) ? editEntry.tags.join(', ') : '';
      bodyInput.value = editEntry.body || '';
      encryptCb.checked = Boolean(editEntry.encrypted);
      deleteBtn.hidden = false;

      if (editEntry.image && editEntry.image.src) {
        this.state.entryDraftPhoto = { ...editEntry.image };
        document.getElementById('entry-photo-caption').value = editEntry.image.caption || '';
        document.getElementById('entry-photo-remove-btn').hidden = false;
        resolveMediaSrc(editEntry.image.src, this.gh, this.mediaStore).then((resolved) => {
          this.entryStudio.setMedia(resolved, editEntry.image);
        });
      } else {
        this.state.entryDraftPhoto = null;
      }
    } else {
      this.state.editingEntryKey = null;
      this.state.entryDraftPhoto = null;
      document.getElementById('composer-modal-title').textContent = 'New Diary Entry';
      let defaultDate = presetDate;
      if (!defaultDate) {
        const { month, day } = parseDayKey(this.state.activeDay);
        defaultDate = `${new Date().getFullYear()}-${pad2(month)}-${pad2(day)}`;
      }
      dateInput.value = defaultDate;
      titleInput.value = '';
      moodInput.value = '';
      tagsInput.value = '';
      bodyInput.value = '';
      encryptCb.checked = this.hasActiveSessionKey();
      deleteBtn.hidden = true;
    }

    this.updateEditorCounts();
    this.checkDraftBanner(dateInput.value);
    modal.hidden = false;
    bodyInput.focus();
  }

  closeComposer() {
    document.getElementById('composer-modal').hidden = true;
    document.getElementById('draft-recovery-banner').hidden = true;
  }

  scheduleDraftAutosave() {
    if (this.draftSaveTimer) window.clearTimeout(this.draftSaveTimer);
    this.draftSaveTimer = window.setTimeout(() => {
      const diaryDate = document.getElementById('entry-date-input')?.value;
      if (!diaryDate) return;
      const draftPayload = {
        diaryDate,
        title: document.getElementById('entry-title-input').value,
        mood: document.getElementById('entry-mood-input').value,
        tags: document.getElementById('entry-tags-input').value,
        body: document.getElementById('entry-body-input').value,
        savedAt: new Date().toISOString(),
      };
      window.localStorage.setItem(`perpetual_draft_${diaryDate}`, JSON.stringify(draftPayload));
      const statusEl = document.getElementById('entry-draft-status');
      if (statusEl) statusEl.textContent = 'Draft saved locally';
    }, 800);
  }

  checkDraftBanner(diaryDate) {
    const banner = document.getElementById('draft-recovery-banner');
    if (!banner || this.state.editingEntryKey) {
      if (banner) banner.hidden = true;
      return;
    }
    const raw = window.localStorage.getItem(`perpetual_draft_${diaryDate}`);
    if (!raw) {
      banner.hidden = true;
      return;
    }
    try {
      const draft = JSON.parse(raw);
      const currentBody = document.getElementById('entry-body-input').value.trim();
      if (draft && draft.body && draft.body.trim() && draft.body.trim() !== currentBody) {
        banner.hidden = false;
      } else {
        banner.hidden = true;
      }
    } catch {
      banner.hidden = true;
    }
  }

  updateEditorCounts() {
    const body = document.getElementById('entry-body-input')?.value || '';
    const words = countWords(stripMarkdown(body));
    const chars = countChars(body);
    const el = document.getElementById('entry-word-count');
    if (el) el.textContent = `${words} words · ${chars} chars`;

    if (this.state.editorMode === 'split' || this.state.editorMode === 'preview') {
      const previewPane = document.getElementById('entry-preview-pane');
      if (previewPane) previewPane.innerHTML = renderMarkdown(body);
    }
  }

  applyMarkdownSnippet(kind) {
    const textarea = document.getElementById('entry-body-input');
    if (!textarea) return;
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? textarea.value.length;
    const selected = textarea.value.slice(start, end);

    const templates = {
      bold: `**${selected || 'bold text'}**`,
      italic: `*${selected || 'italic text'}*`,
      h2: `\n## ${selected || 'Section Heading'}\n`,
      quote: `\n> ${selected || 'Quoted thought'}\n`,
      list: `\n- ${selected || 'List item'}\n`,
      code: `\`${selected || 'code'}\``,
    };

    const insert = templates[kind] || selected;
    textarea.setRangeText(insert, start, end, 'select');
    textarea.focus();
    this.updateEditorCounts();
    this.scheduleDraftAutosave();
  }

  async handleEntrySave(ev) {
    ev.preventDefault();
    const diaryDate = document.getElementById('entry-date-input').value;
    const [yrStr, mm, dd] = diaryDate.split('-');
    const yearNum = Number(yrStr);
    const newDayStr = `${mm}-${dd}`;
    const newYearKey = String(yearNum);

    let title = document.getElementById('entry-title-input').value.trim();
    const mood = document.getElementById('entry-mood-input').value.trim();
    const tags = document
      .getElementById('entry-tags-input')
      .value.split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    let body = document.getElementById('entry-body-input').value;
    const encryptFlag = document.getElementById('entry-encrypt-checkbox').checked;

    if (!body.trim()) {
      this.showToast('Please write some diary prose before saving.', 'warn');
      return;
    }

    if (encryptFlag) {
      if (!this.hasActiveSessionKey()) {
        this.showToast('Unlock or configure the Vault password before encrypting entries.', 'warn');
        return;
      }
      const keyCtx = this.state.keyring || this.state.cryptoKey;
      title = title ? await encryptText(title, keyCtx) : '';
      body = await encryptText(body, keyCtx);
    }

    const caption = document.getElementById('entry-photo-caption').value.trim();
    const photoUrl = document.getElementById('entry-photo-url').value.trim();
    let imageObj = this.state.entryDraftPhoto ? { ...this.state.entryDraftPhoto } : null;

    if (!imageObj && photoUrl && /^https:\/\//i.test(photoUrl)) {
      imageObj = {
        src: photoUrl,
        caption,
        align: 'full',
        posX: 50,
        posY: 50,
        width: 100,
        height: 240,
      };
    } else if (imageObj) {
      imageObj.caption = caption;
      if (imageObj._pendingBuffer) {
        const mediaSubpath = `media/${diaryDate}-${Date.now()}.${imageObj._ext || 'jpg'}`;
        if (this.gh.hasToken()) {
          await this.gh.uploadBinaryMedia(
            mediaSubpath,
            imageObj._pendingBuffer,
            `diary: upload media ${mediaSubpath}`
          );
          imageObj.src = `${this.gh.getDataTarget().basePath}/${mediaSubpath}`;
        } else {
          await this.mediaStore.putImage(mediaSubpath, imageObj._pendingBuffer, imageObj._mime);
          imageObj.src = `idb:${mediaSubpath}`;
        }
        delete imageObj._pendingBuffer;
        delete imageObj._ext;
        delete imageObj._mime;
      }
    }

    const nowIso = new Date().toISOString();
    const writtenAt = this.state.editingEntryKey?.originalWrittenAt || nowIso;

    const entryRecord = {
      year: yearNum,
      diaryDate,
      title,
      body,
      tags,
      mood,
      image: imageObj,
      writtenAt,
      updatedAt: nowIso,
      encrypted: encryptFlag,
    };

    try {
      if (this.state.editingEntryKey) {
        const { originalDayStr, originalYearKey } = this.state.editingEntryKey;
        if (originalDayStr !== newDayStr || originalYearKey !== newYearKey) {
          const oldDoc = await this.getDayDocument(originalDayStr, true);
          const nextOldEntries = { ...(oldDoc.entries || {}) };
          delete nextOldEntries[originalYearKey];
          await this.persistDayDocument(
            originalDayStr,
            { ...oldDoc, entries: nextOldEntries },
            `diary: move ${originalYearKey}-${originalDayStr} out`
          );
        }
      }

      const targetDoc = await this.getDayDocument(newDayStr, true);
      const nextEntries = { ...(targetDoc.entries || {}), [newYearKey]: entryRecord };
      await this.persistDayDocument(
        newDayStr,
        { ...targetDoc, entries: nextEntries },
        `diary: save entry ${diaryDate}`
      );

      window.localStorage.removeItem(`perpetual_draft_${diaryDate}`);
      this.state.activeDay = newDayStr;
      this.closeComposer();
      this.showToast(`Saved entry for ${diaryDate}.`, 'success');
      await this.renderReader();
    } catch (err) {
      this.showToast(err.message || 'Failed to save entry.', 'error');
    }
  }

  async handleDeleteEntry(dayStr, yearKey, entryObj) {
    const confirmed = await this.openConfirm({
      title: 'Delete Diary Entry',
      message: `Permanently delete the ${entryObj.year} entry (${entryObj.diaryDate || dayStr})?`,
      confirmLabel: 'Delete Entry',
    });
    if (!confirmed) return;

    try {
      const doc = await this.getDayDocument(dayStr, true);
      const nextEntries = { ...(doc.entries || {}) };
      delete nextEntries[yearKey];
      await this.persistDayDocument(
        dayStr,
        { ...doc, entries: nextEntries },
        `diary: delete entry ${entryObj.diaryDate || `${yearKey}-${dayStr}`}`
      );

      if (entryObj?.image?.src?.startsWith('data/media/') && this.gh.hasToken()) {
        const sub = entryObj.image.src.replace(/^data\//, '');
        await this.gh.deleteFile(sub, `diary: delete media ${sub}`).catch(() => {});
      }

      this.closeComposer();
      this.showToast('Entry deleted.', 'success');
      await this.renderReader();
    } catch (err) {
      this.showToast(err.message || 'Failed to delete entry.', 'error');
    }
  }

  renderHeatmap() {
    const grid = document.getElementById('heatmap-grid');
    const readout = document.getElementById('heatmap-hover-readout');
    if (!grid) return;

    const allDays = getAll366Days();
    const daysMap = this.state.indexData?.days || {};
    grid.innerHTML = '';

    for (const dayStr of allDays) {
      const info = daysMap[dayStr];
      const count = info?.years?.length || 0;
      const lvl = Math.min(4, count);
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = `hm-cell hm-lvl-${lvl}`;
      cell.setAttribute('aria-label', `${formatReadableDay(dayStr)}: ${count} years`);

      const summaryText =
        count > 0
          ? `${formatReadableDay(dayStr)} (${dayStr}) — ${count} year(s): ${info.years.join(', ')}`
          : `${formatReadableDay(dayStr)} (${dayStr}) — No entries yet`;

      cell.addEventListener('mouseenter', () => {
        if (readout) readout.textContent = summaryText;
      });
      cell.addEventListener('focus', () => {
        if (readout) readout.textContent = summaryText;
      });
      cell.addEventListener('click', () => {
        this.state.activeDay = dayStr;
        this.state.compare2Active = false;
        this.switchView('reader');
      });

      grid.appendChild(cell);
    }
  }

  async renderArchive() {
    const yearSelect = document.getElementById('archive-year-select');
    const tagCloud = document.getElementById('archive-tag-cloud');
    const resultsEl = document.getElementById('archive-results');
    const daysMap = this.state.indexData?.days || {};

    const yearsSet = new Set();
    const tagCounts = new Map();

    for (const info of Object.values(daysMap)) {
      for (const y of info.years || []) yearsSet.add(Number(y));
      for (const t of info.tags || []) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
    }

    const prevYearVal = yearSelect.value;
    yearSelect.innerHTML =
      '<option value="">All Years</option>' +
      Array.from(yearsSet)
        .sort((a, b) => b - a)
        .map((y) => `<option value="${y}">${y}</option>`)
        .join('');
    yearSelect.value = prevYearVal;

    tagCloud.innerHTML = Array.from(tagCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([tag, cnt]) => {
        const active = this.state.archiveTag === tag ? 'is-active' : '';
        return `<button type="button" class="tag-pill ${active}" data-tag="${escapeHtml(tag)}">#${escapeHtml(tag)} <span class="mono-meta">${cnt}</span></button>`;
      })
      .join('');

    tagCloud.querySelectorAll('.tag-pill').forEach((btn) => {
      btn.addEventListener('click', () => {
        const t = btn.dataset.tag;
        this.state.archiveTag = this.state.archiveTag === t ? '' : t;
        this.renderArchive();
      });
    });

    const query = (this.state.archiveSearch || '').trim().toLowerCase();
    const selectedYear = this.state.archiveYear;
    const selectedTag = this.state.archiveTag;

    const matches = [];
    const sortedDayKeys = Object.keys(daysMap).sort();

    for (const dayStr of sortedDayKeys) {
      const info = daysMap[dayStr];
      const dayYears = info.years || [];
      if (selectedYear && !dayYears.includes(Number(selectedYear))) continue;
      if (selectedTag && !(info.tags || []).includes(selectedTag)) continue;

      if (!query) {
        for (const yr of dayYears) {
          matches.push({ dayStr, year: yr, diaryDate: `${yr}-${dayStr}`, tags: info.tags || [] });
        }
        continue;
      }

      const doc = this.state.dayCache[dayStr];
      if (doc && doc.entries) {
        for (const yr of dayYears) {
          const e = doc.entries[String(yr)];
          if (!e) continue;
          const bodyText = (await this.decryptFieldIfNeeded(e.body, Boolean(e.encrypted))) || '';
          const titleText = (await this.decryptFieldIfNeeded(e.title, Boolean(e.encrypted))) || '';
          const hay =
            `${titleText} ${bodyText} ${(e.tags || []).join(' ')} ${e.mood || ''}`.toLowerCase();
          if (hay.includes(query)) {
            matches.push({
              dayStr,
              year: yr,
              diaryDate: e.diaryDate || `${yr}-${dayStr}`,
              title: titleText,
              tags: e.tags || [],
            });
          }
        }
      } else if (
        dayStr.includes(query) ||
        (info.tags || []).some((t) => t.toLowerCase().includes(query))
      ) {
        for (const yr of dayYears) {
          matches.push({ dayStr, year: yr, diaryDate: `${yr}-${dayStr}`, tags: info.tags || [] });
        }
      }
    }

    resultsEl.innerHTML = matches.length
      ? matches
          .map(
            (m) => `
          <button type="button" class="archive-item" data-day="${escapeHtml(m.dayStr)}">
            <div>
              <span class="mono-meta">${escapeHtml(m.diaryDate)}</span>
              <strong>${escapeHtml(m.title || `${formatReadableDay(m.dayStr)} · ${m.year}`)}</strong>
            </div>
            <div class="mono-meta">${(m.tags || []).map((t) => `#${escapeHtml(t)}`).join(' ')}</div>
          </button>
        `
          )
          .join('')
      : '<div class="empty-comments mono-meta">No matching entries found. Click "Load All Indexed Days" for deep text search across all recorded dates.</div>';

    resultsEl.querySelectorAll('.archive-item').forEach((item) => {
      item.addEventListener('click', () => {
        this.state.activeDay = item.dataset.day;
        this.state.compare2Active = false;
        this.switchView('reader');
      });
    });
  }

  async loadAllIndexedDaysForSearch() {
    const keys = Object.keys(this.state.indexData?.days || {});
    for (const dayStr of keys) {
      await this.getDayDocument(dayStr, false);
    }
    this.showToast(`Loaded ${keys.length} indexed day(s) for search.`, 'success');
    await this.renderArchive();
  }

  async exportArchiveJson() {
    const keys = Object.keys(this.state.indexData?.days || {}).sort();
    const days = {};
    for (const k of keys) {
      days[k] = await this.getDayDocument(k, false);
    }
    const payload = {
      exportedAt: new Date().toISOString(),
      index: this.state.indexData,
      days,
    };
    this.downloadFile(
      'perpetual-diary-archive.json',
      JSON.stringify(payload, null, 2),
      'application/json'
    );
  }

  async exportArchiveMarkdown() {
    const keys = Object.keys(this.state.indexData?.days || {}).sort();
    const lines = [
      '# Perpetual Side-by-Side Diary Export',
      `Generated: ${new Date().toISOString()}`,
      '',
    ];

    for (const k of keys) {
      const doc = await this.getDayDocument(k, false);
      lines.push(`## ${formatReadableDay(k)} (${k})`, '');
      const years = Object.keys(doc.entries || {}).sort();
      for (const yr of years) {
        const e = doc.entries[yr];
        const body =
          (await this.decryptFieldIfNeeded(e.body, Boolean(e.encrypted))) || '[Encrypted]';
        const title = (await this.decryptFieldIfNeeded(e.title, Boolean(e.encrypted))) || '';
        lines.push(`### ${yr}${title ? ` — ${title}` : ''}`, '', body, '');
      }
      if (Array.isArray(doc.comments) && doc.comments.length) {
        lines.push('#### Margin Notes', '');
        for (const c of doc.comments) {
          const cBody =
            (await this.decryptFieldIfNeeded(c.body, Boolean(c.encrypted))) || '[Encrypted]';
          lines.push(`- **${c.author || 'Self'}**: ${cBody}`);
        }
        lines.push('');
      }
    }

    this.downloadFile('perpetual-diary-book.md', lines.join('\n'), 'text/markdown');
  }

  downloadFile(filename, text, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async openGitHubModal() {
    const cfg = this.gh.config;
    document.getElementById('gh-owner-input').value = cfg.owner || '';
    document.getElementById('gh-repo-input').value = cfg.repo || '';
    document.getElementById('gh-branch-input').value = cfg.branch || 'main';
    document.getElementById('gh-datapath-input').value = cfg.dataPath || 'data';

    const useVault = Boolean(cfg.usePrivateVault);
    document.getElementById('gh-use-private-vault').checked = useVault;
    document.getElementById('split-vault-fields').hidden = !useVault;
    document.getElementById('gh-vault-owner-input').value = cfg.vaultOwner || '';
    document.getElementById('gh-vault-repo-input').value =
      cfg.vaultRepo || 'perpetual-diary-vault';
    document.getElementById('gh-vault-branch-input').value = cfg.vaultBranch || 'main';
    document.getElementById('gh-vault-path-input').value = cfg.vaultPath || 'data';

    document.getElementById('gh-token-input').value = cfg.token || '';
    document.getElementById('gh-token-expiry-input').value = cfg.tokenExpiresAt
      ? String(cfg.tokenExpiresAt).slice(0, 10)
      : '';
    document.getElementById('gh-read-api-checkbox').checked = Boolean(cfg.readFromApiWhenAuthed);
    document.getElementById('gh-test-result').hidden = true;

    document.getElementById('github-modal').hidden = false;
    await this.refreshRepoHealthPanel();
  }

  async refreshRepoHealthPanel() {
    const modePill = document.getElementById('health-mode-pill');
    const repoLabel = document.getElementById('health-repo-label');
    const fill = document.getElementById('quota-bar-fill');
    const sizeLabel = document.getElementById('health-size-label');
    const patStatus = document.getElementById('health-pat-status');
    const expiryWarn = document.getElementById('health-expiry-warning');

    const health = await this.gh.getRepoHealth();
    modePill.textContent =
      health.mode === 'live-api'
        ? 'LIVE API · READ/WRITE'
        : health.mode === 'public-api'
          ? 'PUBLIC API · READ-ONLY'
          : 'LOCAL SANDBOX';

    repoLabel.textContent = `${health.vaultRepoName} ${health.vaultPrivate ? '(Private)' : '(Public)'}`;
    fill.style.width = `${health.usagePercent}%`;
    fill.classList.toggle('is-warn', health.usagePercent >= 75);

    const mbUsed = (health.totalSizeKb / 1024).toFixed(2);
    sizeLabel.textContent = `${mbUsed} MB / 1,024 MB Pages limit (${health.usagePercent}%)`;

    const expiryStr = this.gh.config.tokenExpiresAt || health.tokenExpiry || '';
    if (!this.gh.hasToken()) {
      patStatus.textContent = 'PAT: Not configured';
      expiryWarn.hidden = true;
    } else if (!expiryStr) {
      patStatus.textContent = 'PAT: Active (no expiry date entered)';
      expiryWarn.hidden = true;
    } else {
      const expDate = new Date(expiryStr);
      const daysLeft = Math.ceil((expDate.getTime() - Date.now()) / 86400000);
      patStatus.textContent = `PAT expires: ${String(expiryStr).slice(0, 10)}`;
      if (daysLeft <= 0) {
        expiryWarn.hidden = false;
        expiryWarn.textContent =
          'Fine-Grained PAT has expired. Rotate and update it in GitHub.';
      } else if (daysLeft <= 14) {
        expiryWarn.hidden = false;
        expiryWarn.textContent = `PAT expires in ${daysLeft} day(s) (${String(expiryStr).slice(0, 10)}). Renew soon to avoid write interruptions.`;
      } else {
        expiryWarn.hidden = true;
      }
    }
  }

  openVaultModal() {
    const vm = this.state.vaultMeta;
    const hasConfiguredVault = Boolean(vm && (vm.canary || vm.canaryCipher));
    const isV2 = Number(vm?.version) === 2;
    const isLegacyV1 = hasConfiguredVault && !isV2;
    const enabled = Boolean(vm?.enabled);

    const statusBanner = document.getElementById('vault-status-banner');
    statusBanner.className = `status-callout ${enabled ? 'is-ok' : ''}`;
    statusBanner.textContent = enabled
      ? `Vault Lock is ACTIVE (${this.hasActiveSessionKey() ? 'Unlocked in session' : 'Locked'}) · ${isV2 ? 'v2 Envelope DEK/KEK' : 'v1 Legacy'}`
      : hasConfiguredVault
        ? `Vault configured (${isV2 ? 'v2 Envelope' : 'v1 Legacy'}) — Full Lock Screen currently OFF.`
        : 'No Vault password configured yet. Set a master password to initialize v2 Envelope Encryption.';

    const archPanel = document.getElementById('vault-arch-panel');
    const slotsList = document.getElementById('vault-slots-list');
    if (isV2) {
      archPanel.hidden = false;
      document.getElementById('vault-version-pill').textContent = 'V2 ENVELOPE · DEK/KEK';
      document.getElementById('vault-fingerprint-label').textContent =
        `DEK: ${vm.dekFingerprint || this.state.keyring?.dekFingerprint || 'ACTIVE'}`;

      const slots = Array.isArray(vm.keySlots) ? vm.keySlots : [];
      slotsList.innerHTML = slots
        .map((s) => {
          const rotDate = s.rotatedAt
            ? new Date(s.rotatedAt).toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })
            : '—';
          return `
            <div class="vault-slot-card">
              <div>
                <strong>${escapeHtml(s.label || 'Key Slot')}</strong>
                <span class="mono-meta"> · ${escapeHtml(s.kdf || 'PBKDF2-SHA256')} (${Number(s.iterations || 250000).toLocaleString()} iter)</span>
              </div>
              <span class="mono-meta">Rotated ${escapeHtml(rotDate)}</span>
            </div>
          `;
        })
        .join('');
    } else {
      archPanel.hidden = true;
      slotsList.innerHTML = '';
    }

    document.getElementById('vault-upgrade-banner').hidden = !isLegacyV1;
    document.getElementById('vault-migrate-banner').hidden = !(
      isV2 &&
      vm?.wrappedLegacyKey &&
      this.state.keyring?.dek &&
      this.state.keyring?.legacyKey
    );
    document.getElementById('vault-migrate-status').hidden = true;

    document.getElementById('vault-lock-enabled-checkbox').checked = enabled;
    document.getElementById('vault-current-pass-group').hidden = !hasConfiguredVault;
    document.getElementById('vault-new-pass-label').textContent = hasConfiguredVault
      ? 'Rotate Master Password (Instant — re-wraps DEK only)'
      : 'Set Master Password (initializes v2 Envelope Vault)';
    document.getElementById('vault-save-btn').textContent = hasConfiguredVault
      ? 'Save / Rotate Vault'
      : 'Initialize v2 Vault';

    document.getElementById('vault-current-password').value = '';
    document.getElementById('vault-new-password').value = '';
    document.getElementById('vault-confirm-password').value = '';
    document.getElementById('vault-encrypt-pat-checkbox').checked = Boolean(vm?.encryptedPat);
    document.getElementById('vault-error').hidden = true;
    document.getElementById('vault-modal').hidden = false;
  }

  async handleMigrateLegacyEntriesToV2() {
    if (!this.state.keyring?.dek || !this.state.keyring?.legacyKey) {
      this.showToast('Unlock your upgraded v2 vault first to migrate legacy entries.', 'warn');
      return;
    }

    const statusEl = document.getElementById('vault-migrate-status');
    const btn = document.getElementById('vault-migrate-entries-btn');
    btn.disabled = true;
    statusEl.hidden = false;

    try {
      const dayKeys = Object.keys(this.state.indexData?.days || {}).sort();
      let migratedDays = 0;
      let migratedItems = 0;

      for (let i = 0; i < dayKeys.length; i += 1) {
        const dayStr = dayKeys[i];
        statusEl.textContent = `Scanning ${i + 1}/${dayKeys.length} (${dayStr})...`;
        const doc = await this.getDayDocument(dayStr, true);
        let dirty = false;

        for (const [yrKey, entry] of Object.entries(doc.entries || {})) {
          if (!entry) continue;
          if (getPayloadVersion(entry.body) === 1 || getPayloadVersion(entry.title) === 1) {
            const plainBody = await decryptText(entry.body, this.state.keyring);
            const plainTitle = entry.title
              ? await decryptText(entry.title, this.state.keyring)
              : '';
            doc.entries[yrKey] = {
              ...entry,
              body: await encryptText(plainBody, this.state.keyring.dek),
              title: plainTitle ? await encryptText(plainTitle, this.state.keyring.dek) : '',
              encrypted: true,
              updatedAt: new Date().toISOString(),
            };
            dirty = true;
            migratedItems += 1;
          }
        }

        if (Array.isArray(doc.comments)) {
          for (let cIdx = 0; cIdx < doc.comments.length; cIdx += 1) {
            const cmt = doc.comments[cIdx];
            if (cmt && getPayloadVersion(cmt.body) === 1) {
              const plainCmt = await decryptText(cmt.body, this.state.keyring);
              doc.comments[cIdx] = {
                ...cmt,
                body: await encryptText(plainCmt, this.state.keyring.dek),
                encrypted: true,
                updatedAt: new Date().toISOString(),
              };
              dirty = true;
              migratedItems += 1;
            }
          }
        }

        if (dirty) {
          await this.persistDayDocument(dayStr, doc, `diary: migrate ${dayStr} to v2 DEK`);
          migratedDays += 1;
        }
      }

      // Retire the legacy key bridge from vault.json once migration completes
      const cleanedVault = {
        ...this.state.vaultMeta,
        wrappedLegacyKey: null,
        updatedAt: new Date().toISOString(),
      };
      await this.persistVaultMeta(cleanedVault, 'diary: retire v1 legacy key bridge');
      this.setActiveKeyring({
        ...this.state.keyring,
        legacyKey: null,
      });

      statusEl.textContent = `Migrated ${migratedItems} item(s) across ${migratedDays} day(s). Legacy bridge retired.`;
      this.showToast(`Migrated ${migratedItems} legacy item(s) to v2 DEK.`, 'success');
      this.openVaultModal();
      await this.renderActiveView();
    } catch (err) {
      statusEl.textContent = `Migration interrupted: ${err.message}`;
      this.showToast(err.message || 'Migration failed.', 'error');
    } finally {
      btn.disabled = false;
    }
  }

  bindEvents() {
    document.getElementById('theme-toggle-btn')?.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme');
      this.setTheme(current === 'dark' ? 'light' : 'dark');
    });

    document.getElementById('brand-home-link')?.addEventListener('click', (e) => {
      e.preventDefault();
      this.state.activeDay = getTodayDayKey();
      this.state.compare2Active = false;
      this.switchView('reader');
    });

    document.querySelectorAll('.nav-tab').forEach((btn) => {
      btn.addEventListener('click', () => this.switchView(btn.dataset.view));
    });

    document.getElementById('month-select')?.addEventListener('change', (e) => {
      const m = Number(e.target.value);
      const { day } = parseDayKey(this.state.activeDay);
      this.syncDaySelectorOptions(m, day);
      const clampedDay = Number(document.getElementById('day-select').value);
      this.state.activeDay = formatDayKey(m, clampedDay);
      this.state.compare2Active = false;
      this.renderReader();
    });

    document.getElementById('day-select')?.addEventListener('change', (e) => {
      const { month } = parseDayKey(this.state.activeDay);
      this.state.activeDay = formatDayKey(month, Number(e.target.value));
      this.state.compare2Active = false;
      this.renderReader();
    });

    const stepDay = (delta) => {
      const all = getAll366Days();
      const idx = all.indexOf(this.state.activeDay);
      const nextIdx = (idx + delta + all.length) % all.length;
      this.state.activeDay = all[nextIdx];
      this.state.compare2Active = false;
      this.renderReader();
    };

    document.getElementById('prev-day-btn')?.addEventListener('click', () => stepDay(-1));
    document.getElementById('next-day-btn')?.addEventListener('click', () => stepDay(1));

    document.getElementById('today-btn')?.addEventListener('click', () => {
      this.state.activeDay = getTodayDayKey();
      this.state.compare2Active = false;
      this.renderReader();
    });

    document.getElementById('next-recorded-btn')?.addEventListener('click', () => {
      const all = getAll366Days();
      const startIdx = all.indexOf(this.state.activeDay);
      for (let offset = 1; offset <= all.length; offset += 1) {
        const candidate = all[(startIdx + offset) % all.length];
        if (this.state.indexData?.days?.[candidate]?.years?.length) {
          this.state.activeDay = candidate;
          this.state.compare2Active = false;
          this.renderReader();
          return;
        }
      }
      this.showToast('No recorded days found yet.', 'info');
    });

    document.getElementById('random-day-btn')?.addEventListener('click', () => {
      const recordedKeys = Object.keys(this.state.indexData?.days || {}).filter(
        (k) => (this.state.indexData.days[k]?.years?.length || 0) > 0
      );
      const pool = recordedKeys.length ? recordedKeys : getAll366Days();
      this.state.activeDay = pool[Math.floor(Math.random() * pool.length)];
      this.state.compare2Active = false;
      this.renderReader();
    });

    document.getElementById('jump-comments-btn')?.addEventListener('click', () => {
      document.getElementById('comments-section')?.scrollIntoView({ behavior: 'smooth' });
    });

    document.querySelectorAll('#col-width-group .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document
          .querySelectorAll('#col-width-group .seg-btn')
          .forEach((b) => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        this.state.colMode = btn.dataset.colMode;
        this.renderReader();
      });
    });

    document.querySelectorAll('#mobile-view-toggle .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document
          .querySelectorAll('#mobile-view-toggle .seg-btn')
          .forEach((b) => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        this.state.mobileMode = btn.dataset.mobileMode;
        this.renderReader();
      });
    });

    document.getElementById('sort-order-btn')?.addEventListener('click', (e) => {
      const btn = e.currentTarget;
      this.state.sortOrder = this.state.sortOrder === 'asc' ? 'desc' : 'asc';
      btn.textContent = this.state.sortOrder === 'asc' ? 'Oldest → Newest' : 'Newest → Oldest';
      this.renderReader();
    });

    document.getElementById('toggle-compare2-btn')?.addEventListener('click', () => {
      this.state.compare2Active = !this.state.compare2Active;
      this.renderReader();
    });

    document.getElementById('compare-swap-btn')?.addEventListener('click', () => {
      const aEl = document.getElementById('compare-date-a');
      const bEl = document.getElementById('compare-date-b');
      const tmp = aEl.value;
      aEl.value = bEl.value;
      bEl.value = tmp;
    });

    document.getElementById('compare-run-btn')?.addEventListener('click', () => {
      this.state.compareDateA = document.getElementById('compare-date-a').value;
      this.state.compareDateB = document.getElementById('compare-date-b').value;
      this.state.compare2Active = true;
      this.renderReader();
    });

    document.getElementById('compare-exit-btn')?.addEventListener('click', () => {
      this.state.compare2Active = false;
      this.renderReader();
    });

    document.getElementById('copy-permalink-btn')?.addEventListener('click', () => {
      navigator.clipboard?.writeText(window.location.href).then(
        () => this.showToast('Permalink copied to clipboard.', 'success'),
        () => this.showToast('Could not copy link automatically.', 'warn')
      );
    });

    // Selection -> Quote Pill
    const quotePill = document.getElementById('selection-quote-pill');
    document.addEventListener('selectionchange', () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        if (quotePill) quotePill.hidden = true;
        return;
      }
      const range = sel.getRangeAt(0);
      const col = range.startContainer.parentElement?.closest('.year-column');
      if (!col || !quotePill) {
        if (quotePill) quotePill.hidden = true;
        return;
      }
      const rect = range.getBoundingClientRect();
      quotePill.style.top = `${Math.max(12, rect.top + window.scrollY - 40)}px`;
      quotePill.style.left = `${Math.max(12, rect.left + window.scrollX)}px`;
      quotePill.dataset.quoteText = sel.toString().trim();
      quotePill.dataset.quoteYear = col.dataset.year || '';
      quotePill.dataset.quoteDate = col.dataset.diaryDate || '';
      quotePill.hidden = false;
    });

    quotePill?.addEventListener('click', () => {
      this.attachQuoteToComment({
        text: quotePill.dataset.quoteText,
        year: Number(quotePill.dataset.quoteYear),
        diaryDate: quotePill.dataset.quoteDate,
      });
    });

    document.getElementById('comment-clear-quote-btn')?.addEventListener('click', () => {
      this.clearCommentQuote();
    });

    document.getElementById('comment-cancel-edit-btn')?.addEventListener('click', () => {
      this.resetCommentComposer();
    });

    document.getElementById('comment-form')?.addEventListener('submit', (e) => {
      this.handleCommentSubmit(e);
    });

    document.getElementById('comment-photo-file')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const processed = await processImageFile(file);
        this.state.commentDraftPhoto = {
          src: processed.dataUrl,
          caption: document.getElementById('comment-photo-caption').value.trim(),
          align: 'full',
          posX: 50,
          posY: 50,
          width: 100,
          height: 220,
          _pendingBuffer: processed.arrayBuffer,
          _ext: processed.ext,
          _mime: processed.mime,
        };
        document.getElementById('comment-photo-remove-btn').hidden = false;
        this.commentStudio.setMedia(processed.dataUrl, this.state.commentDraftPhoto);
      } catch (err) {
        this.showToast(err.message || 'Image error.', 'error');
      }
    });

    document.getElementById('comment-photo-remove-btn')?.addEventListener('click', () => {
      this.state.commentDraftPhoto = null;
      document.getElementById('comment-photo-file').value = '';
      document.getElementById('comment-photo-url').value = '';
      document.getElementById('comment-photo-remove-btn').hidden = true;
      this.commentStudio.clear();
    });

    // Composer Modal Events
    document
      .getElementById('open-composer-btn')
      ?.addEventListener('click', () => this.openComposer());
    document
      .getElementById('composer-close-btn')
      ?.addEventListener('click', () => this.closeComposer());
    document
      .getElementById('entry-cancel-btn')
      ?.addEventListener('click', () => this.closeComposer());
    document.getElementById('entry-form')?.addEventListener('submit', (e) => this.handleEntrySave(e));

    document.getElementById('entry-delete-btn')?.addEventListener('click', async () => {
      if (!this.state.editingEntryKey) return;
      const { originalDayStr, originalYearKey } = this.state.editingEntryKey;
      const doc = await this.getDayDocument(originalDayStr, false);
      const targetEntry = doc.entries?.[originalYearKey] || {
        year: Number(originalYearKey),
        diaryDate: `${originalYearKey}-${originalDayStr}`,
      };
      await this.handleDeleteEntry(originalDayStr, originalYearKey, targetEntry);
    });

    document.getElementById('entry-body-input')?.addEventListener('input', () => {
      this.updateEditorCounts();
      this.scheduleDraftAutosave();
    });

    document.getElementById('entry-date-input')?.addEventListener('change', (e) => {
      this.checkDraftBanner(e.target.value);
    });

    document.getElementById('draft-restore-btn')?.addEventListener('click', () => {
      const diaryDate = document.getElementById('entry-date-input').value;
      const raw = window.localStorage.getItem(`perpetual_draft_${diaryDate}`);
      if (raw) {
        const draft = JSON.parse(raw);
        document.getElementById('entry-title-input').value = draft.title || '';
        document.getElementById('entry-mood-input').value = draft.mood || '';
        document.getElementById('entry-tags-input').value = draft.tags || '';
        document.getElementById('entry-body-input').value = draft.body || '';
        this.updateEditorCounts();
      }
      document.getElementById('draft-recovery-banner').hidden = true;
    });

    document.getElementById('draft-discard-btn')?.addEventListener('click', () => {
      const diaryDate = document.getElementById('entry-date-input').value;
      window.localStorage.removeItem(`perpetual_draft_${diaryDate}`);
      document.getElementById('draft-recovery-banner').hidden = true;
    });

    document.querySelectorAll('.md-btn').forEach((btn) => {
      btn.addEventListener('click', () => this.applyMarkdownSnippet(btn.dataset.md));
    });

    document.querySelectorAll('#editor-mode-group .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document
          .querySelectorAll('#editor-mode-group .seg-btn')
          .forEach((b) => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        const mode = btn.dataset.editorMode;
        this.state.editorMode = mode;
        const ws = document.getElementById('editor-workspace');
        const preview = document.getElementById('entry-preview-pane');
        ws.className = `editor-workspace mode-${mode}`;
        preview.hidden = mode === 'write';
        this.updateEditorCounts();
      });
    });

    document.getElementById('entry-photo-file')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const processed = await processImageFile(file);
        this.state.entryDraftPhoto = {
          src: processed.dataUrl,
          caption: document.getElementById('entry-photo-caption').value.trim(),
          align: 'full',
          posX: 50,
          posY: 50,
          width: 100,
          height: 240,
          _pendingBuffer: processed.arrayBuffer,
          _ext: processed.ext,
          _mime: processed.mime,
        };
        document.getElementById('entry-photo-remove-btn').hidden = false;
        this.entryStudio.setMedia(processed.dataUrl, this.state.entryDraftPhoto);
      } catch (err) {
        this.showToast(err.message || 'Could not process image.', 'error');
      }
    });

    document.getElementById('entry-photo-remove-btn')?.addEventListener('click', () => {
      this.state.entryDraftPhoto = null;
      document.getElementById('entry-photo-file').value = '';
      document.getElementById('entry-photo-url').value = '';
      document.getElementById('entry-photo-remove-btn').hidden = true;
      this.entryStudio.clear();
    });

    // GitHub Settings & Split-Repo Events
    document
      .getElementById('github-settings-btn')
      ?.addEventListener('click', () => this.openGitHubModal());
    document
      .getElementById('lock-open-settings-btn')
      ?.addEventListener('click', () => this.openGitHubModal());
    document.getElementById('github-close-btn')?.addEventListener('click', () => {
      document.getElementById('github-modal').hidden = true;
    });

    document.getElementById('gh-use-private-vault')?.addEventListener('change', (e) => {
      document.getElementById('split-vault-fields').hidden = !e.target.checked;
    });

    const collectGitHubFormConfig = () => ({
      owner: document.getElementById('gh-owner-input').value.trim(),
      repo: document.getElementById('gh-repo-input').value.trim(),
      branch: document.getElementById('gh-branch-input').value.trim() || 'main',
      dataPath: document.getElementById('gh-datapath-input').value.trim() || 'data',
      usePrivateVault: Boolean(document.getElementById('gh-use-private-vault').checked),
      vaultOwner: document.getElementById('gh-vault-owner-input').value.trim(),
      vaultRepo:
        document.getElementById('gh-vault-repo-input').value.trim() || 'perpetual-diary-vault',
      vaultBranch: document.getElementById('gh-vault-branch-input').value.trim() || 'main',
      vaultPath: document.getElementById('gh-vault-path-input').value.trim() || 'data',
      token: document.getElementById('gh-token-input').value.trim(),
      tokenExpiresAt: document.getElementById('gh-token-expiry-input').value.trim(),
      readFromApiWhenAuthed: Boolean(document.getElementById('gh-read-api-checkbox').checked),
    });

    document.getElementById('gh-test-btn')?.addEventListener('click', async () => {
      const testBox = document.getElementById('gh-test-result');
      testBox.hidden = false;
      testBox.className = 'status-callout';
      testBox.textContent = 'Testing connection to GitHub...';
      this.gh.updateConfig(collectGitHubFormConfig());
      try {
        const res = await this.gh.testConnection();
        testBox.className = 'status-callout is-ok';
        testBox.textContent = `Connected to ${res.fullName} (${res.isPrivate ? 'Private' : 'Public'}) — Write access: ${res.canPush ? 'YES' : 'READ-ONLY'}.`;
        await this.refreshRepoHealthPanel();
      } catch (err) {
        testBox.className = 'status-callout is-err';
        testBox.textContent = err.message;
      }
    });

    document.getElementById('gh-clear-token-btn')?.addEventListener('click', () => {
      document.getElementById('gh-token-input').value = '';
      this.gh.updateConfig({ token: '', tokenExpiresAt: '' });
      GitHubClient.saveConfig(this.gh.config, window.localStorage);
      this.updateModeBadge();
      this.refreshRepoHealthPanel();
      this.showToast('Cleared token from browser.', 'info');
    });

    document.getElementById('github-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const nextCfg = collectGitHubFormConfig();
      this.gh.updateConfig(nextCfg);
      GitHubClient.saveConfig(nextCfg, window.localStorage);
      this.state.dayCache = {};
      this.updateModeBadge();
      await this.loadVaultAndIndex();
      await this.renderActiveView();
      await this.refreshRepoHealthPanel();
      document.getElementById('github-modal').hidden = true;
      this.showToast('GitHub & Split-Repo settings saved.', 'success');
    });

    // Envelope Vault, Instant Rotation & Legacy Migration Events
    document.getElementById('vault-btn')?.addEventListener('click', () => this.openVaultModal());
    document.getElementById('vault-close-btn')?.addEventListener('click', () => {
      document.getElementById('vault-modal').hidden = true;
    });
    document.getElementById('vault-cancel-btn')?.addEventListener('click', () => {
      document.getElementById('vault-modal').hidden = true;
    });

    document.getElementById('vault-upgrade-btn')?.addEventListener('click', async () => {
      const errBox = document.getElementById('vault-error');
      errBox.hidden = true;
      const currentPass = document.getElementById('vault-current-password').value;
      if (!currentPass) {
        errBox.textContent = 'Enter your Current Master Password below to upgrade to v2 Envelope.';
        errBox.hidden = false;
        return;
      }
      try {
        const encryptPat = Boolean(document.getElementById('vault-encrypt-pat-checkbox').checked);
        const res = await upgradeLegacyVaultToEnvelope(this.state.vaultMeta, currentPass, {
          enabled: Boolean(document.getElementById('vault-lock-enabled-checkbox').checked),
          encryptPat,
          patToken: this.gh.hasToken() ? this.gh.config.token : null,
        });
        this.setActiveKeyring(res.keyring);
        await this.persistVaultMeta(res.vaultMeta, 'diary: upgrade vault to v2 envelope');
        this.showToast(
          'Upgraded to v2 Envelope Encryption. Password rotations are now instant.',
          'success'
        );
        this.openVaultModal();
      } catch (err) {
        errBox.textContent = err.message;
        errBox.hidden = false;
      }
    });

    document.getElementById('vault-migrate-entries-btn')?.addEventListener('click', async () => {
      await this.handleMigrateLegacyEntriesToV2();
    });

    document.getElementById('vault-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errBox = document.getElementById('vault-error');
      errBox.hidden = true;

      const lockEnabled = Boolean(document.getElementById('vault-lock-enabled-checkbox').checked);
      const currentPass = document.getElementById('vault-current-password').value;
      const newPass = document.getElementById('vault-new-password').value;
      const confirmPass = document.getElementById('vault-confirm-password').value;
      const encryptPat = Boolean(document.getElementById('vault-encrypt-pat-checkbox').checked);

      const hasExistingVault = Boolean(
        this.state.vaultMeta && (this.state.vaultMeta.canary || this.state.vaultMeta.canaryCipher)
      );

      try {
        if (!hasExistingVault) {
          if (!newPass) {
            throw new Error('Please enter a master password to initialize your vault.');
          }
          if (newPass !== confirmPass) {
            throw new Error('Master password and confirmation do not match.');
          }
          const created = await createEnvelopeVault(newPass, {
            enabled: lockEnabled,
            patToken: encryptPat && this.gh.hasToken() ? this.gh.config.token : null,
          });
          this.setActiveKeyring(created.keyring);
          await this.persistVaultMeta(created.vaultMeta, 'diary: initialize v2 envelope vault');
          this.showToast('v2 Envelope Vault initialized.', 'success');
        } else if (newPass) {
          if (!currentPass) {
            throw new Error('Enter your Current Master Password to rotate to a new password.');
          }
          if (newPass !== confirmPass) {
            throw new Error('New password and confirmation do not match.');
          }
          const rotated = await rotateVaultPassword(this.state.vaultMeta, currentPass, newPass, {
            enabled: lockEnabled,
            encryptPat,
            patToken: encryptPat && this.gh.hasToken() ? this.gh.config.token : null,
          });
          this.setActiveKeyring(rotated.keyring);
          await this.persistVaultMeta(rotated.vaultMeta, 'diary: rotate master password key slot');
          this.showToast(
            'Password rotated instantly — DEK unchanged, 0 diary entries re-encrypted.',
            'success'
          );
        } else {
          // Only toggling Lock Screen or Encrypted PAT without changing password
          const nextVault = {
            ...this.state.vaultMeta,
            enabled: lockEnabled,
            updatedAt: new Date().toISOString(),
          };
          if (encryptPat && this.gh.hasToken()) {
            if (!this.hasActiveSessionKey()) {
              throw new Error('Unlock your vault first to encrypt your GitHub PAT.');
            }
            nextVault.encryptedPat = await encryptPatToken(
              this.gh.config.token,
              this.state.keyring || this.state.cryptoKey
            );
          } else if (!encryptPat) {
            nextVault.encryptedPat = null;
          }
          await this.persistVaultMeta(nextVault, 'diary: update vault preferences');
          this.showToast('Vault preferences updated.', 'success');
        }

        this.state.unlocked = true;
        document.getElementById('lock-screen').hidden = true;
        document.getElementById('vault-modal').hidden = true;
        this.updateModeBadge();
        await this.renderActiveView();
      } catch (err) {
        errBox.textContent = err.message;
        errBox.hidden = false;
      }
    });

    document.getElementById('vault-disable-btn')?.addEventListener('click', async () => {
      const nextVault = {
        ...(this.state.vaultMeta || {}),
        enabled: false,
        updatedAt: new Date().toISOString(),
      };
      this.setActiveKeyring(null);
      this.state.unlocked = true;
      await this.persistVaultMeta(nextVault, 'diary: disable vault lock').catch(() => {});
      document.getElementById('lock-screen').hidden = true;
      document.getElementById('vault-modal').hidden = true;
      this.updateModeBadge();
      await this.renderActiveView();
      this.showToast('Vault lock screen disabled.', 'info');
    });

    document.getElementById('lock-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = document.getElementById('lock-error');
      const passInput = document.getElementById('lock-password-input');
      errEl.hidden = true;

      try {
        const res = await unlockVault(passInput.value, this.state.vaultMeta);
        if (!res.ok) {
          errEl.textContent = res.error || 'Incorrect password';
          errEl.hidden = false;
          return;
        }

        this.setActiveKeyring(res.keyring);

        if (res.pat && !this.gh.hasToken()) {
          this.gh.updateConfig({ token: res.pat });
          GitHubClient.saveConfig(this.gh.config, window.localStorage);
        }

        passInput.value = '';
        this.state.unlocked = true;
        document.getElementById('lock-screen').hidden = true;
        this.updateModeBadge();
        await this.renderActiveView();
        this.showToast(
          res.version === 2 ? 'Envelope Vault unlocked.' : 'Legacy v1 Vault unlocked.',
          'success'
        );
      } catch {
        errEl.textContent = 'Incorrect password';
        errEl.hidden = false;
      }
    });

    document.getElementById('lock-now-btn')?.addEventListener('click', () => {
      this.setActiveKeyring(null);
      this.state.unlocked = false;
      document.getElementById('lock-screen').hidden = false;
      document.getElementById('lock-password-input')?.focus();
      this.updateModeBadge();
    });

    // Archive & Export Events
    document.getElementById('archive-search-input')?.addEventListener('input', (e) => {
      this.state.archiveSearch = e.target.value;
      this.renderArchive();
    });

    document.getElementById('archive-year-select')?.addEventListener('change', (e) => {
      this.state.archiveYear = e.target.value;
      this.renderArchive();
    });

    document.getElementById('load-all-days-btn')?.addEventListener('click', () => {
      this.loadAllIndexedDaysForSearch();
    });

    document.getElementById('export-json-btn')?.addEventListener('click', () => {
      this.exportArchiveJson();
    });

    document.getElementById('export-md-btn')?.addEventListener('click', () => {
      this.exportArchiveMarkdown();
    });

    // Confirm Modal Events
    document
      .getElementById('confirm-close-btn')
      ?.addEventListener('click', () => this.closeConfirm(false));
    document
      .getElementById('confirm-cancel-btn')
      ?.addEventListener('click', () => this.closeConfirm(false));
    document
      .getElementById('confirm-ok-btn')
      ?.addEventListener('click', () => this.closeConfirm(true));

    // Global Hotkeys
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        this.openGitHubModal();
      } else if (e.key === 'Escape') {
        document.getElementById('composer-modal').hidden = true;
        document.getElementById('github-modal').hidden = true;
        document.getElementById('vault-modal').hidden = true;
        this.closeConfirm(false);
      }
    });
  }
}

const app = new PerpetualDiaryApp();
app.init();
