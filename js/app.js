/**
 * js/app.js — Perpetual Side-by-Side Diary Main Application Controller (Phase 6B)
 * Integrates:
 * - Phase 1: Split-Repo Vault (Public App + Private Data Repo) & Repo Health / PAT Expiry Radar
 * - Phase 2: v2 Envelope Encryption (DEK/KEK Key Slots) & Instant Password Rotation
 * - Phase 3: v3 AES-GCM AAD Tamper Binding, Sleep-Aware Auto-Lock & Panic Hotkey (Ctrl+Shift+L)
 * - Phase 4: Shared-Computer Zero-Footprint Mode & Emergency Paper Recovery Kit
 * - Phase 5: Atomic Multi-File Commits (Git Trees API) & Interactive 3-Way Conflict Resolver
 * - Phase 6B: Browser-Side WebP Compression, Encrypted Media Vault (.enc) & Batch Photo Migration
 */

import {
  encryptText,
  decryptText,
  isEncryptedPayload,
  getPayloadVersion,
  buildEntryAad,
  buildCommentAad,
  createEnvelopeVault,
  attachPaperRecoverySlot,
  unlockVault,
  rotateVaultPassword,
  rotateVaultPasswordWithKeyring,
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
import { GitHubClient, SyncConflictError, recalculateIndexForDay } from './github.js';
import {
  LocalMediaStore,
  processImageFile,
  prepareMediaPayloadForStorage,
  resolveMediaAsset,
  revokeAllManagedMediaUrls,
  formatBytesCompact,
  getSavedWebpPreset,
  saveWebpPreset,
  AlignmentStudio,
  attachInlineAlignController,
} from './media.js';
import { migratePlaintextMediaToEncryptedVault } from './media-vault.js';
import { openPrintableRecoveryCard, buildOfflineDecryptorHtml } from './recovery.js';
import { renderDiffHtml, buildThreeWayMerge, mergeTags } from './conflict.js';

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
const AUTOLOCK_STORAGE_KEY = 'perpetual_diary_autolock_min_v1';

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

function formatCountdown(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${pad2(mins)}:${pad2(secs)}`;
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

    const savedAutoLock = Number(window.localStorage.getItem(AUTOLOCK_STORAGE_KEY));

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
      dayShas: {},
      sandboxRamDays: null,
      ramMediaUrls: new Map(),
      vaultMeta: null,
      keyring: null,
      cryptoKey: null,
      unlocked: true,
      zeroFootprint: false,
      recentRecoveryCode: null,
      autoLockMinutes: Number.isFinite(savedAutoLock) && savedAutoLock >= 0 ? savedAutoLock : 15,
      pendingQuote: null,
      editingCommentId: null,
      commentDraftPhoto: null,
      editingEntryKey: null,
      editingBaseEntry: null,
      entryDraftPhoto: null,
      activeConflict: null,
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
    this.autoLockInterval = null;
    this.lastActivityAt = Date.now();
    this.lastThrottledPing = 0;
    this.autoLockWarned = false;
  }

  /* ========================================================================
     ZERO-FOOTPRINT STORAGE & MANAGED MEDIA MEMORY GATEWAYS
     ======================================================================== */
  storageSet(key, value) {
    if (this.state.zeroFootprint) return false;
    try {
      window.localStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  }

  storageGet(key) {
    if (this.state.zeroFootprint) return null;
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  storageRemove(key) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // ignore storage errors
    }
  }

  setZeroFootprintMode(enabled, notify = false) {
    const next = Boolean(enabled);
    this.state.zeroFootprint = next;

    const badge = document.getElementById('zero-footprint-badge');
    if (badge) badge.hidden = !next;

    const lockCb = document.getElementById('lock-zero-footprint-checkbox');
    if (lockCb) lockCb.checked = next;

    const ghCb = document.getElementById('gh-zero-footprint-checkbox');
    if (ghCb) ghCb.checked = next;

    const draftStatus = document.getElementById('entry-draft-status');
    if (draftStatus) {
      draftStatus.textContent = next
        ? 'Zero-Footprint: drafts kept in RAM only'
        : 'Drafts auto-saved locally';
    }

    if (notify) {
      this.showToast(
        next
          ? 'Zero-Footprint Mode ON — keys, PAT, photos, and drafts stay strictly in RAM.'
          : 'Zero-Footprint Mode OFF — local browser persistence re-enabled.',
        'info'
      );
    }
  }

  revokeRamMediaUrls() {
    for (const val of this.state.ramMediaUrls.values()) {
      if (typeof val === 'string' && val.startsWith('blob:')) {
        try {
          URL.revokeObjectURL(val);
        } catch {
          // ignore
        }
      }
    }
    this.state.ramMediaUrls.clear();
    revokeAllManagedMediaUrls();
  }

  async resolveMediaAssetSafe(src) {
    return resolveMediaAsset(
      src,
      this.gh,
      this.state.zeroFootprint ? null : this.mediaStore,
      this.state.keyring || this.state.cryptoKey,
      this.state.ramMediaUrls
    );
  }

  async resolveMediaUrlSafe(src) {
    const asset = await this.resolveMediaAssetSafe(src);
    return asset.status === 'ok' ? asset.url : '';
  }

  async storeLocalMediaBuffer(mediaSubpath, buffer, mime, isEncrypted = false) {
    if (this.state.zeroFootprint) {
      const ramKey = `ram:${mediaSubpath}`;
      if (isEncrypted) {
        const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
        this.state.ramMediaUrls.set(ramKey, bytes);
      } else {
        const blobUrl = URL.createObjectURL(new Blob([buffer], { type: mime || 'image/webp' }));
        this.state.ramMediaUrls.set(ramKey, blobUrl);
      }
      return ramKey;
    }
    await this.mediaStore.putImage(mediaSubpath, buffer, mime);
    return `idb:${mediaSubpath}`;
  }

  async wipeAllLocalBrowserTraces() {
    const keysToRemove = [];
    try {
      for (let i = 0; i < window.localStorage.length; i += 1) {
        const k = window.localStorage.key(i);
        if (k && (k.startsWith('perpetual_') || k.startsWith('diary_'))) {
          keysToRemove.push(k);
        }
      }
      keysToRemove.forEach((k) => window.localStorage.removeItem(k));
    } catch {
      // ignore
    }

    try {
      window.sessionStorage.clear();
    } catch {
      // ignore
    }

    try {
      await new Promise((resolve) => {
        const req = window.indexedDB.deleteDatabase('PerpetualDiaryMediaDB');
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
      });
    } catch {
      // ignore
    }

    this.revokeRamMediaUrls();
  }

  /* ========================================================================
     VAULT SESSION, AUTO-LOCK MONITOR & PANIC LOCK
     ======================================================================== */
  hasActiveSessionKey() {
    return Boolean(this.state.keyring?.dek || this.state.keyring?.legacyKey || this.state.cryptoKey);
  }

  hasConfiguredVault() {
    return Boolean(
      this.state.vaultMeta && (this.state.vaultMeta.canary || this.state.vaultMeta.canaryCipher)
    );
  }

  setActiveKeyring(keyring) {
    this.state.keyring = keyring || null;
    this.state.cryptoKey = keyring ? keyring.dek || keyring.legacyKey || null : null;
    if (this.hasActiveSessionKey()) {
      this.lastActivityAt = Date.now();
      this.autoLockWarned = false;
      this.startAutoLockMonitor();
    } else {
      this.stopAutoLockMonitor();
    }
  }

  getEffectiveAutoLockMinutes() {
    if (Number.isFinite(Number(this.state.vaultMeta?.autoLockMinutes))) {
      return Math.max(0, Number(this.state.vaultMeta.autoLockMinutes));
    }
    return Math.max(0, Number(this.state.autoLockMinutes) || 0);
  }

  recordUserActivity(throttled = false) {
    const now = Date.now();
    if (throttled && now - this.lastThrottledPing < 1000) return;
    this.lastThrottledPing = now;
    this.lastActivityAt = now;
    this.autoLockWarned = false;
  }

  startAutoLockMonitor() {
    this.stopAutoLockMonitor();
    const pill = document.getElementById('autolock-pill');
    const minutes = this.getEffectiveAutoLockMinutes();

    if (!this.hasActiveSessionKey() || minutes <= 0) {
      if (pill) pill.hidden = true;
      return;
    }

    const tick = () => {
      if (!this.hasActiveSessionKey()) {
        this.stopAutoLockMonitor();
        return;
      }
      const limitMs = minutes * 60000;
      const elapsed = Date.now() - this.lastActivityAt;
      const remaining = limitMs - elapsed;

      if (remaining <= 0) {
        this.lockDiaryNow('inactivity');
        return;
      }

      if (pill) {
        pill.hidden = false;
        pill.textContent = formatCountdown(remaining);
        pill.classList.toggle('is-expiring', remaining <= 60000);
      }

      if (remaining <= 60000 && !this.autoLockWarned) {
        this.autoLockWarned = true;
        this.showToast('Vault will auto-lock in under 1 minute due to inactivity.', 'warn');
      }
    };

    tick();
    this.autoLockInterval = window.setInterval(tick, 1000);
  }

  stopAutoLockMonitor() {
    if (this.autoLockInterval) {
      window.clearInterval(this.autoLockInterval);
      this.autoLockInterval = null;
    }
    const pill = document.getElementById('autolock-pill');
    if (pill) {
      pill.hidden = true;
      pill.classList.remove('is-expiring');
    }
  }

  scrubSensitiveDom() {
    const clearHtmlIds = [
      'columns-stage',
      'comments-list',
      'archive-results',
      'entry-preview-pane',
      'vault-recovery-code-display',
      'conflict-local-diff',
      'conflict-remote-diff',
    ];
    for (const id of clearHtmlIds) {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '';
    }

    const recBox = document.getElementById('vault-recovery-code-box');
    if (recBox) recBox.hidden = true;

    const clearValueIds = [
      'entry-title-input',
      'entry-mood-input',
      'entry-tags-input',
      'entry-body-input',
      'comment-body-input',
      'vault-current-password',
      'vault-new-password',
      'vault-confirm-password',
      'gh-token-input',
      'conflict-merged-title',
      'conflict-merged-mood',
      'conflict-merged-tags',
      'conflict-merged-body',
    ];
    for (const id of clearValueIds) {
      const el = document.getElementById(id);
      if (el) el.value = '';
    }

    const modalIds = [
      'composer-modal',
      'github-modal',
      'vault-modal',
      'conflict-modal',
      'confirm-modal',
    ];
    for (const id of modalIds) {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    }

    const quotePill = document.getElementById('selection-quote-pill');
    if (quotePill) quotePill.hidden = true;
    this.closeConfirm(false);
  }

  lockDiaryNow(reason = 'manual') {
    if (!this.hasConfiguredVault() && !this.hasActiveSessionKey()) {
      this.showToast('Configure a Vault password first to lock the diary.', 'warn');
      return;
    }

    const composerOpen = !document.getElementById('composer-modal')?.hidden;
    if (composerOpen && !this.state.zeroFootprint) {
      const diaryDate = document.getElementById('entry-date-input')?.value;
      const bodyVal = document.getElementById('entry-body-input')?.value || '';
      if (diaryDate && bodyVal.trim() && !this.state.editingEntryKey) {
        this.storageSet(
          `perpetual_draft_${diaryDate}`,
          JSON.stringify({
            diaryDate,
            title: document.getElementById('entry-title-input')?.value || '',
            mood: document.getElementById('entry-mood-input')?.value || '',
            tags: document.getElementById('entry-tags-input')?.value || '',
            body: bodyVal,
            savedAt: new Date().toISOString(),
          })
        );
      }
    }

    this.setActiveKeyring(null);
    this.state.recentRecoveryCode = null;
    this.state.activeConflict = null;
    this.state.unlocked = false;
    this.state.dayCache = {};
    this.state.dayShas = {};
    this.revokeRamMediaUrls();

    if (this.state.zeroFootprint) {
      this.gh.updateConfig({ token: '' });
    }

    this.scrubSensitiveDom();

    const reasonBadge = document.getElementById('lock-reason-badge');
    if (reasonBadge) {
      if (reason === 'panic') {
        reasonBadge.textContent = this.state.zeroFootprint
          ? 'PANIC LOCK (ZERO-FOOTPRINT) · RAM, MEDIA & PAT WIPED'
          : 'PANIC LOCK ACTIVATED (CTRL+SHIFT+L) · KEYS & MEDIA WIPED';
        reasonBadge.hidden = false;
      } else if (reason === 'inactivity') {
        const mins = this.getEffectiveAutoLockMinutes();
        reasonBadge.textContent = `AUTO-LOCKED AFTER ${mins}M OF INACTIVITY`;
        reasonBadge.hidden = false;
      } else if (reason === 'manual') {
        reasonBadge.textContent = this.state.zeroFootprint
          ? 'LOCKED · ZERO-FOOTPRINT RAM & PAT WIPED'
          : 'LOCKED · SESSION KEY & DECRYPTED MEDIA WIPED';
        reasonBadge.hidden = false;
      } else {
        reasonBadge.hidden = true;
      }
    }

    const lockScreen = document.getElementById('lock-screen');
    if (lockScreen) lockScreen.hidden = false;
    const passInput = document.getElementById('lock-password-input');
    if (passInput) {
      passInput.value = '';
      passInput.focus();
    }
    this.updateModeBadge();
  }

  /* ========================================================================
     INITIALIZATION & UI PRIMITIVES
     ======================================================================== */
  async init() {
    this.initTheme();
    this.populateDateSelectors();
    this.initAlignmentStudios();
    this.bindEvents();

    if (!this.state.zeroFootprint) {
      try {
        await this.mediaStore.open();
      } catch {
        // IndexedDB fallback handled gracefully
      }
    }

    await this.loadVaultAndIndex();
    this.applyHashRoute();
    if (this.state.unlocked) {
      await this.renderActiveView();
    }
    this.updateModeBadge();
  }

  initTheme() {
    const savedTheme = this.storageGet('perpetual_diary_theme') || 'dark';
    this.setTheme(savedTheme, false);
  }

  setTheme(theme, persist = true) {
    const next = theme === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    if (persist) this.storageSet('perpetual_diary_theme', next);
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
      lockNowBtn.hidden = !this.hasActiveSessionKey() && !this.hasConfiguredVault();
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
    }, 3600);
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

  /* ========================================================================
     DATA LOADING & PERSISTENCE
     ======================================================================== */
  async loadVaultAndIndex() {
    const localVaultRaw = this.storageGet('perpetual_diary_vault_local_v1');
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
    if (Number.isFinite(Number(vaultMeta?.autoLockMinutes))) {
      this.state.autoLockMinutes = Number(vaultMeta.autoLockMinutes);
      this.storageSet(AUTOLOCK_STORAGE_KEY, String(this.state.autoLockMinutes));
    }

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

    const sandboxIdxRaw = this.storageGet('perpetual_diary_sandbox_index_v1');
    if (sandboxIdxRaw) {
      try {
        this.state.indexData = JSON.parse(sandboxIdxRaw);
        return;
      } catch {
        // fall back to seed
      }
    }

    this.state.indexData = JSON.parse(JSON.stringify(SANDBOX_SEED_INDEX));
    this.storageSet('perpetual_diary_sandbox_index_v1', JSON.stringify(this.state.indexData));
  }

  async getDayDocument(dayStr, forceRefresh = false) {
    if (!forceRefresh && this.state.dayCache[dayStr]) {
      return this.state.dayCache[dayStr];
    }

    if (this.gh.hasToken() || this.gh.isConfigured()) {
      const { data: remoteDoc, sha } = await this.gh.readJsonWithMeta(`days/${dayStr}.json`, null);
      if (sha) this.state.dayShas[dayStr] = sha;
      if (remoteDoc && typeof remoteDoc === 'object') {
        const normalized = {
          day: dayStr,
          entries: remoteDoc.entries || {},
          comments: Array.isArray(remoteDoc.comments) ? remoteDoc.comments : [],
        };
        this.state.dayCache[dayStr] = normalized;
        return normalized;
      }
      if (this.gh.hasToken()) {
        const emptyRemote = { day: dayStr, entries: {}, comments: [] };
        this.state.dayCache[dayStr] = emptyRemote;
        return emptyRemote;
      }
    }

    let sandboxDays = this.state.sandboxRamDays;
    if (!sandboxDays) {
      const sandboxDaysRaw = this.storageGet('perpetual_diary_sandbox_days_v1');
      if (sandboxDaysRaw) {
        try {
          sandboxDays = JSON.parse(sandboxDaysRaw);
        } catch {
          sandboxDays = JSON.parse(JSON.stringify(SANDBOX_SEED_DAYS));
        }
      } else {
        sandboxDays = JSON.parse(JSON.stringify(SANDBOX_SEED_DAYS));
        this.storageSet('perpetual_diary_sandbox_days_v1', JSON.stringify(sandboxDays));
      }
      this.state.sandboxRamDays = sandboxDays;
    }

    const doc = sandboxDays[dayStr] || { day: dayStr, entries: {}, comments: [] };
    this.state.dayCache[dayStr] = doc;
    return doc;
  }

  async persistSandboxDay(dayStr, nextDoc) {
    const normalized = {
      day: dayStr,
      entries: nextDoc.entries || {},
      comments: Array.isArray(nextDoc.comments) ? nextDoc.comments : [],
    };
    this.state.dayCache[dayStr] = normalized;

    const sandboxDays = this.state.sandboxRamDays || JSON.parse(JSON.stringify(SANDBOX_SEED_DAYS));
    if (Object.keys(normalized.entries).length === 0 && normalized.comments.length === 0) {
      delete sandboxDays[dayStr];
    } else {
      sandboxDays[dayStr] = normalized;
    }
    this.state.sandboxRamDays = sandboxDays;
    this.storageSet('perpetual_diary_sandbox_days_v1', JSON.stringify(sandboxDays));

    this.state.indexData = recalculateIndexForDay(this.state.indexData, dayStr, normalized);
    this.storageSet('perpetual_diary_sandbox_index_v1', JSON.stringify(this.state.indexData));
    return normalized;
  }

  async persistDayDocument(dayStr, nextDoc, commitMessage) {
    const normalized = {
      day: dayStr,
      entries: nextDoc.entries || {},
      comments: Array.isArray(nextDoc.comments) ? nextDoc.comments : [],
    };

    if (this.gh.hasToken()) {
      const res = await this.gh.updateDayAndIndex(dayStr, normalized, commitMessage);
      this.state.dayCache[dayStr] = normalized;
      if (res.daySha) this.state.dayShas[dayStr] = res.daySha;
      this.state.indexData = res.index;
      return { doc: normalized, commitSha: res.commitSha };
    }

    await this.persistSandboxDay(dayStr, normalized);
    return { doc: normalized, commitSha: '' };
  }

  async persistVaultMeta(vaultMeta, commitMessage = 'diary: update envelope vault') {
    this.state.vaultMeta = vaultMeta;
    if (Number.isFinite(Number(vaultMeta?.autoLockMinutes))) {
      this.state.autoLockMinutes = Number(vaultMeta.autoLockMinutes);
      this.storageSet(AUTOLOCK_STORAGE_KEY, String(this.state.autoLockMinutes));
    }
    this.storageSet('perpetual_diary_vault_local_v1', JSON.stringify(vaultMeta));
    if (this.gh.hasToken()) {
      await this.gh.putJson('vault.json', vaultMeta, commitMessage);
    }
  }

  async decryptFieldDetailed(value, isEncrypted, aad = '') {
    if (!isEncrypted && !isEncryptedPayload(value)) {
      return { status: 'plain', text: String(value ?? ''), version: 0 };
    }
    const version = getPayloadVersion(value);
    if (!this.hasActiveSessionKey()) {
      return { status: 'locked', text: null, version };
    }
    try {
      const text = await decryptText(value, this.state.keyring || this.state.cryptoKey, aad);
      return { status: 'ok', text, version };
    } catch (err) {
      if (err?.code === 'AAD_TAMPER_ERROR' || version === 3) {
        return { status: 'tampered', text: null, version, error: err.message };
      }
      return { status: 'locked', text: null, version, error: err.message };
    }
  }

  async decryptFieldIfNeeded(value, isEncrypted, aad = '') {
    const res = await this.decryptFieldDetailed(value, isEncrypted, aad);
    return res.status === 'plain' || res.status === 'ok' ? res.text : null;
  }

  /* ========================================================================
     ROUTING & VIEW RENDERING
     ======================================================================== */
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
    if (!this.state.unlocked) return;
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
    if (!this.state.unlocked) return;
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
    const expectedDate = `${yearKey}-${dayStr}`;
    const resolvedDate = entry.diaryDate || expectedDate;
    col.dataset.year = String(entry.year);
    col.dataset.diaryDate = resolvedDate;

    const backdatedDays = diffCalendarDays(entry.diaryDate, entry.writtenAt);
    const backdateBadge =
      backdatedDays > 0
        ? `<span class="badge-backdated">BACKDATED +${backdatedDays}d</span>`
        : '';

    const bodyAad = buildEntryAad(expectedDate, yearKey, 'body');
    const titleAad = buildEntryAad(expectedDate, yearKey, 'title');

    const bodyResult = await this.decryptFieldDetailed(entry.body, Boolean(entry.encrypted), bodyAad);
    const titleResult = await this.decryptFieldDetailed(
      entry.title || '',
      Boolean(entry.encrypted),
      titleAad
    );

    const isTampered = bodyResult.status === 'tampered' || titleResult.status === 'tampered';
    const isLockedEntry = !isTampered && bodyResult.status === 'locked';
    const decryptedBody = bodyResult.text;
    const decryptedTitle = titleResult.text;

    let bodyHtml = '';
    let plainWords = 0;

    if (isTampered) {
      bodyHtml = `
        <div class="tamper-alert-card" role="alert">
          <div class="mono-label">⚠ CRYPTOGRAPHIC INTEGRITY ALERT · AAD MISMATCH</div>
          <p>
            Decryption rejected this entry because its AES-GCM Additional Authenticated Data (AAD) does not match
            <code>${escapeHtml(expectedDate)}</code>.
          </p>
        </div>
      `;
    } else if (isLockedEntry) {
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

    // Phase 6B: Encrypted (.enc) & Plaintext Media Resolution
    let mediaHtml = '';
    if (!isLockedEntry && !isTampered && entry.image && entry.image.src) {
      const asset = await this.resolveMediaAssetSafe(entry.image.src);
      if (asset.status === 'locked') {
        mediaHtml = `
          <div class="encrypted-media-card">
            <span class="mono-label">🔒 ENCRYPTED PHOTO (.ENC)</span>
            <p class="section-subtext">Unlock the Vault to decrypt and view this photo in RAM.</p>
          </div>
        `;
      } else if (asset.status === 'tampered') {
        mediaHtml = `
          <div class="tamper-alert-card" role="alert">
            <div class="mono-label">⚠ PHOTO INTEGRITY ALERT · AAD MISMATCH</div>
            <p>Encrypted photo failed AES-GCM AAD verification and was blocked from rendering.</p>
          </div>
        `;
      } else if (asset.status === 'ok' && asset.url) {
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
                src="${escapeHtml(asset.url)}"
                alt="${escapeHtml(entry.image.caption || `Photo from ${resolvedDate}`)}"
                style="object-position:${posX}% ${posY}%;"
              />
              ${asset.encrypted ? '<span class="media-enc-badge" title="Decrypted from AES-256-GCM .enc blob in RAM">🔒 .ENC</span>' : ''}
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
    const encBadge =
      payloadVer === 3
        ? ' · <span class="aad-verified-tag">v3 AAD</span>'
        : payloadVer
          ? ` · v${payloadVer}`
          : '';

    col.innerHTML = `
      <header class="year-col-header">
        <div class="year-col-title-row">
          <span class="year-heading">${escapeHtml(String(entry.year))}</span>
          ${backdateBadge}
        </div>
        <div class="year-col-actions">
          <button type="button" class="btn btn-ghost btn-sm col-quote-btn" title="Quote in margin comment" ${isTampered || isLockedEntry ? 'disabled' : ''}>❝ Quote</button>
          <button type="button" class="btn btn-ghost btn-sm col-pin-btn ${isPinned ? 'is-pinned' : ''}" title="Pin column to left">
            ${isPinned ? 'Pinned' : 'Pin'}
          </button>
          <button type="button" class="btn btn-ghost btn-sm col-edit-btn" ${isTampered ? 'disabled title="Cannot edit tampered ciphertext"' : ''}>Edit</button>
          <button type="button" class="btn btn-ghost btn-sm col-delete-btn">Delete</button>
        </div>
      </header>
      <div class="mono-meta year-col-date">${escapeHtml(resolvedDate)}${encBadge}</div>
      ${!isLockedEntry && !isTampered && decryptedTitle ? `<h3 class="entry-title">${escapeHtml(decryptedTitle)}</h3>` : ''}
      ${metaChipsHtml}
      <div class="entry-prose-wrap">
        ${mediaHtml}
        <div class="prose-body">${bodyHtml}</div>
      </div>
      <footer class="year-col-footer mono-meta">
        <span>${isTampered ? 'Integrity Failed' : isLockedEntry ? 'Encrypted' : `${plainWords} words`}</span>
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
      if (isTampered || isLockedEntry) return;
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
        diaryDate: resolvedDate,
      });
    });

    col.querySelector('.col-edit-btn').addEventListener('click', () => {
      if (isTampered) return;
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
              const saved = await this.persistDayDocument(
                dayStr,
                latestDoc,
                `diary: realign photo ${resolvedDate}`
              );
              const shortSha = saved.commitSha ? ` (#${saved.commitSha.slice(0, 7)})` : '';
              this.showToast(`Photo alignment saved atomically${shortSha}.`, 'success');
              await this.renderReader();
            }
          }
        );
      });
    }

    return col;
  }

  /* ========================================================================
     MARGIN COMMENTS & ENCRYPTED COMMENT MEDIA
     ======================================================================== */
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
      const cmtAad = buildCommentAad(dayStr, cmt.id, 'body');
      const res = await this.decryptFieldDetailed(cmt.body, Boolean(cmt.encrypted), cmtAad);
      const isTampered = res.status === 'tampered';
      const isLocked = res.status === 'locked';
      const plainBody = res.text;

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
      if (!isLocked && !isTampered && cmt.image && cmt.image.src) {
        const asset = await this.resolveMediaAssetSafe(cmt.image.src);
        if (asset.status === 'locked') {
          photoHtml = `<div class="encrypted-media-card"><span class="mono-label">🔒 ENCRYPTED COMMENT PHOTO (.ENC)</span></div>`;
        } else if (asset.status === 'tampered') {
          photoHtml = `<div class="tamper-alert-card" role="alert"><div class="mono-label">⚠ COMMENT PHOTO AAD MISMATCH</div></div>`;
        } else if (asset.status === 'ok' && asset.url) {
          photoHtml = `
            <figure class="comment-figure">
              <div class="comment-figure-frame">
                <img
                  src="${escapeHtml(asset.url)}"
                  alt="${escapeHtml(cmt.image.caption || 'Comment attachment')}"
                  style="object-position:${cmt.image.posX ?? 50}% ${cmt.image.posY ?? 50}%;max-height:${cmt.image.height ?? 200}px;"
                />
                ${asset.encrypted ? '<span class="media-enc-badge">🔒 .ENC</span>' : ''}
              </div>
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

      const bodyMarkup = isTampered
        ? `<div class="tamper-alert-card" role="alert"><div class="mono-label">⚠ AAD INTEGRITY MISMATCH</div><p>This margin note failed cryptographic AAD verification for ${escapeHtml(dayStr)}.</p></div>`
        : isLocked
          ? '<em>Encrypted note — unlock Vault to view.</em>'
          : renderMarkdown(plainBody);

      card.innerHTML = `
        <div class="comment-card-top">
          <div class="comment-author-meta">
            <span class="comment-author">${escapeHtml(cmt.author || 'Self')}</span>
            <span class="mono-meta">${escapeHtml(timestamp)}${res.version === 3 ? ' · v3 AAD' : ''}</span>
          </div>
          <div class="comment-actions">
            <button type="button" class="btn btn-ghost btn-sm cmt-edit-btn" ${isTampered ? 'disabled' : ''}>Edit</button>
            <button type="button" class="btn btn-ghost btn-sm cmt-delete-btn">Delete</button>
          </div>
        </div>
        ${quoteCardHtml}
        <div class="prose-body comment-body">${bodyMarkup}</div>
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
        if (isTampered) return;
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
    const cmtStats = document.getElementById('comment-photo-stats');
    if (cmtStats) cmtStats.hidden = true;

    if (this.state.commentDraftPhoto) {
      this.resolveMediaUrlSafe(this.state.commentDraftPhoto.src).then((src) => {
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
    const cmtStats = document.getElementById('comment-photo-stats');
    if (cmtStats) {
      cmtStats.textContent = '';
      cmtStats.hidden = true;
    }
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

    const targetCommentId = this.state.editingCommentId || `cmt-${Date.now()}`;
    const shouldEncrypt = document.getElementById('comment-encrypt-checkbox').checked;
    if (shouldEncrypt) {
      if (!this.hasActiveSessionKey()) {
        this.showToast('Unlock the Vault first to encrypt margin notes.', 'warn');
        return;
      }
      const cmtAad = buildCommentAad(dayStr, targetCommentId, 'body');
      body = await encryptText(body, this.state.keyring || this.state.cryptoKey, cmtAad);
    }

    const caption = document.getElementById('comment-photo-caption').value.trim();
    const photoUrl = document.getElementById('comment-photo-url').value.trim();
    let imagePayload = this.state.commentDraftPhoto ? { ...this.state.commentDraftPhoto } : null;
    const mediaUploads = [];

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
        const encryptPhoto = Boolean(
          document.getElementById('comment-photo-encrypt-checkbox')?.checked &&
            this.hasActiveSessionKey()
        );
        const prepared = await prepareMediaPayloadForStorage({
          buffer: imagePayload._pendingBuffer,
          mime: imagePayload._mime || 'image/webp',
          ext: imagePayload._ext || 'webp',
          datePrefix: getTodayIsoDate(),
          encrypt: encryptPhoto,
          keyring: this.state.keyring || this.state.cryptoKey,
        });
        imagePayload.encrypted = prepared.encrypted;

        if (this.gh.hasToken()) {
          mediaUploads.push({ subpath: prepared.mediaSubpath, buffer: prepared.uploadBuffer });
          imagePayload.src = `${this.gh.getDataTarget().basePath}/${prepared.mediaSubpath}`;
        } else {
          imagePayload.src = await this.storeLocalMediaBuffer(
            prepared.mediaSubpath,
            prepared.uploadBuffer,
            prepared.uploadMime,
            prepared.encrypted
          );
        }
        delete imagePayload._pendingBuffer;
        delete imagePayload._ext;
        delete imagePayload._mime;
      }
    }

    const nowIso = new Date().toISOString();
    const existingDoc = await this.getDayDocument(dayStr, false);
    const existingComment = (existingDoc.comments || []).find(
      (c) => c.id === this.state.editingCommentId
    );

    const commentObj = {
      id: targetCommentId,
      author,
      body,
      createdAt: existingComment?.createdAt || nowIso,
      updatedAt: nowIso,
      encrypted: shouldEncrypt,
      quote: this.state.pendingQuote ? { ...this.state.pendingQuote } : null,
      image: imagePayload,
    };

    try {
      if (this.gh.hasToken()) {
        const op = this.state.editingCommentId ? 'edit' : 'add';
        const res = await this.gh.commitAtomicDayMutations({
          dayMutations: [
            {
              dayStr,
              mode: 'comment',
              commentMutation: { op, comment: commentObj },
            },
          ],
          mediaUploads,
          commitMessage: `diary: ${op} comment on ${dayStr}`,
        });
        this.state.dayCache[dayStr] = res.docs[dayStr];
        if (res.dayShas?.[dayStr]) this.state.dayShas[dayStr] = res.dayShas[dayStr];
        this.state.indexData = res.index;
        const shortSha = res.commitSha ? ` (#${res.commitSha.slice(0, 7)})` : '';
        this.showToast(
          `${this.state.editingCommentId ? 'Margin note updated' : 'Margin note posted'} atomically${shortSha}.`,
          'success'
        );
      } else {
        const doc = await this.getDayDocument(dayStr, true);
        const comments = Array.isArray(doc.comments) ? [...doc.comments] : [];
        if (this.state.editingCommentId) {
          const idx = comments.findIndex((c) => c.id === this.state.editingCommentId);
          if (idx !== -1) comments[idx] = commentObj;
        } else {
          comments.push(commentObj);
        }
        await this.persistSandboxDay(dayStr, { ...doc, comments });
        this.showToast(
          this.state.editingCommentId ? 'Margin note updated.' : 'Margin note posted.',
          'success'
        );
      }

      this.resetCommentComposer();
      await this.renderComments(dayStr);
    } catch (err) {
      this.showToast(err.message || 'Failed to save margin note.', 'error');
    }
  }

  async handleDeleteComment(dayStr, commentObj) {
    const confirmed = await this.openConfirm({
      title: 'Delete Margin Note',
      message: 'Remove this margin note permanently from the day log?',
      confirmLabel: 'Delete Note',
    });
    if (!confirmed) return;

    try {
      if (this.gh.hasToken()) {
        const mediaDeletes = [];
        const basePrefix = `${this.gh.getDataTarget().basePath}/`;
        if (commentObj.image?.src?.startsWith(basePrefix)) {
          mediaDeletes.push(commentObj.image.src.slice(basePrefix.length));
        }

        const res = await this.gh.commitAtomicDayMutations({
          dayMutations: [
            {
              dayStr,
              mode: 'comment',
              commentMutation: { op: 'delete', id: commentObj.id },
            },
          ],
          mediaDeletes,
          commitMessage: `diary: delete comment on ${dayStr}`,
        });
        this.state.dayCache[dayStr] = res.docs[dayStr];
        if (res.dayShas?.[dayStr]) this.state.dayShas[dayStr] = res.dayShas[dayStr];
        this.state.indexData = res.index;
        const shortSha = res.commitSha ? ` (#${res.commitSha.slice(0, 7)})` : '';
        this.showToast(`Margin note deleted atomically${shortSha}.`, 'success');
      } else {
        const doc = await this.getDayDocument(dayStr, true);
        doc.comments = (doc.comments || []).filter((c) => c.id !== commentObj.id);
        await this.persistSandboxDay(dayStr, doc);
        this.showToast('Margin note deleted.', 'success');
      }

      await this.renderComments(dayStr);
    } catch (err) {
      this.showToast(err.message || 'Failed to delete margin note.', 'error');
    }
  }

  /* ========================================================================
     ENTRY COMPOSER, WEBP UPLOAD & ATOMIC SAVE / 3-WAY CONFLICT RESOLVER
     ======================================================================== */
  openComposer({ presetDate = null, editEntry = null, dayStr = null, yearKey = null } = {}) {
    const modal = document.getElementById('composer-modal');
    const dateInput = document.getElementById('entry-date-input');
    const titleInput = document.getElementById('entry-title-input');
    const moodInput = document.getElementById('entry-mood-input');
    const tagsInput = document.getElementById('entry-tags-input');
    const bodyInput = document.getElementById('entry-body-input');
    const encryptCb = document.getElementById('entry-encrypt-checkbox');
    const photoEncryptCb = document.getElementById('entry-photo-encrypt-checkbox');
    const photoStatsEl = document.getElementById('entry-photo-stats');
    const deleteBtn = document.getElementById('entry-delete-btn');

    document.getElementById('entry-photo-url').value = '';
    document.getElementById('entry-photo-caption').value = '';
    document.getElementById('entry-photo-remove-btn').hidden = true;
    if (photoStatsEl) {
      photoStatsEl.textContent = '';
      photoStatsEl.hidden = true;
    }
    if (photoEncryptCb) photoEncryptCb.checked = this.hasActiveSessionKey();
    this.entryStudio.clear();

    if (editEntry) {
      const origDay = dayStr || editEntry.diaryDate.slice(5);
      this.state.editingEntryKey = {
        originalDayStr: origDay,
        originalYearKey: yearKey || String(editEntry.year),
        originalWrittenAt: editEntry.writtenAt || new Date().toISOString(),
        originalUpdatedAt: editEntry.updatedAt || '',
        expectedDaySha: this.state.dayShas[origDay] || null,
      };
      this.state.editingBaseEntry = {
        diaryDate: editEntry.diaryDate || `${yearKey}-${origDay}`,
        title: editEntry.title || '',
        mood: editEntry.mood || '',
        tags: Array.isArray(editEntry.tags) ? [...editEntry.tags] : [],
        body: editEntry.body || '',
        updatedAt: editEntry.updatedAt || '',
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
        this.resolveMediaUrlSafe(editEntry.image.src).then((resolved) => {
          this.entryStudio.setMedia(resolved, editEntry.image);
        });
      } else {
        this.state.entryDraftPhoto = null;
      }
    } else {
      this.state.editingEntryKey = null;
      this.state.editingBaseEntry = null;
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

    const statusEl = document.getElementById('entry-draft-status');
    if (statusEl) {
      statusEl.textContent = this.state.zeroFootprint
        ? 'Zero-Footprint: drafts kept in RAM only'
        : 'Drafts auto-saved locally';
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
    if (this.state.zeroFootprint) return;
    if (this.draftSaveTimer) window.clearTimeout(this.draftSaveTimer);
    this.draftSaveTimer = window.setTimeout(() => {
      if (this.state.zeroFootprint) return;
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
      this.storageSet(`perpetual_draft_${diaryDate}`, JSON.stringify(draftPayload));
      const statusEl = document.getElementById('entry-draft-status');
      if (statusEl) statusEl.textContent = 'Draft saved locally';
    }, 800);
  }

  checkDraftBanner(diaryDate) {
    const banner = document.getElementById('draft-recovery-banner');
    if (!banner || this.state.editingEntryKey || this.state.zeroFootprint) {
      if (banner) banner.hidden = true;
      return;
    }
    const raw = this.storageGet(`perpetual_draft_${diaryDate}`);
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

  async openConflictResolverModal({
    conflictErr,
    localPlain,
    encryptFlag,
    imageObj,
    mediaUploads,
    editingEntryKey,
  }) {
    const { dayStr, yearKey, remoteEntry, remoteSha } = conflictErr;
    const expectedDate = `${yearKey}-${dayStr}`;

    let remotePlainTitle = '';
    let remotePlainBody = '';
    if (remoteEntry) {
      remotePlainBody =
        (await this.decryptFieldIfNeeded(
          remoteEntry.body,
          Boolean(remoteEntry.encrypted),
          buildEntryAad(expectedDate, yearKey, 'body')
        )) ?? '[Unable to decrypt remote entry]';
      remotePlainTitle =
        (await this.decryptFieldIfNeeded(
          remoteEntry.title || '',
          Boolean(remoteEntry.encrypted),
          buildEntryAad(expectedDate, yearKey, 'title')
        )) ?? '';
    }

    const remotePlain = {
      diaryDate: remoteEntry?.diaryDate || expectedDate,
      title: remotePlainTitle,
      mood: remoteEntry?.mood || '',
      tags: Array.isArray(remoteEntry?.tags) ? [...remoteEntry.tags] : [],
      body: remotePlainBody,
      updatedAt: remoteEntry?.updatedAt || '',
      writtenAt: remoteEntry?.writtenAt || editingEntryKey?.originalWrittenAt || '',
      image: remoteEntry?.image || null,
    };

    const basePlain = this.state.editingBaseEntry || {
      title: '',
      mood: '',
      tags: [],
      body: '',
    };

    const autoMerge = buildThreeWayMerge(basePlain.body, localPlain.body, remotePlain.body);

    this.state.activeConflict = {
      dayStr,
      yearKey,
      remoteSha,
      basePlain,
      localPlain,
      remotePlain,
      autoMerge,
      encryptFlag,
      imageObj,
      mediaUploads,
      editingEntryKey,
    };

    document.getElementById('conflict-modal-title').textContent =
      `Sync Conflict · ${expectedDate}`;
    document.getElementById('conflict-summary-banner').textContent = autoMerge.hasConflicts
      ? `Another device updated ${expectedDate} while you were editing (${autoMerge.conflictCount} overlapping section(s) marked below). Compare both versions and commit your merged result.`
      : `Another device updated ${expectedDate} while you were editing. Non-overlapping paragraphs were merged cleanly below—review and commit.`;

    document.getElementById('conflict-local-meta').textContent =
      `${countWords(stripMarkdown(localPlain.body))} words · Unsaved`;
    document.getElementById('conflict-remote-meta').textContent = remotePlain.updatedAt
      ? `Saved ${new Date(remotePlain.updatedAt).toLocaleString()}`
      : 'Latest on GitHub';

    document.getElementById('conflict-local-diff').innerHTML = renderDiffHtml(
      remotePlain.body,
      localPlain.body
    );
    document.getElementById('conflict-remote-diff').innerHTML = renderDiffHtml(
      localPlain.body,
      remotePlain.body
    );

    this.populateConflictMergeFields('merge');
    document.getElementById('conflict-modal').hidden = false;
  }

  populateConflictMergeFields(strategy = 'merge') {
    const c = this.state.activeConflict;
    if (!c) return;

    if (strategy === 'local') {
      document.getElementById('conflict-merged-title').value = c.localPlain.title;
      document.getElementById('conflict-merged-mood').value = c.localPlain.mood;
      document.getElementById('conflict-merged-tags').value = c.localPlain.tags.join(', ');
      document.getElementById('conflict-merged-body').value = c.localPlain.body;
    } else if (strategy === 'remote') {
      document.getElementById('conflict-merged-title').value = c.remotePlain.title;
      document.getElementById('conflict-merged-mood').value = c.remotePlain.mood;
      document.getElementById('conflict-merged-tags').value = c.remotePlain.tags.join(', ');
      document.getElementById('conflict-merged-body').value = c.remotePlain.body;
    } else {
      const mergedTitle =
        c.localPlain.title && c.localPlain.title !== c.basePlain.title
          ? c.localPlain.title
          : c.remotePlain.title || c.localPlain.title;
      const mergedMood =
        c.localPlain.mood && c.localPlain.mood !== c.basePlain.mood
          ? c.localPlain.mood
          : c.remotePlain.mood || c.localPlain.mood;
      const mergedTags = mergeTags(c.localPlain.tags, c.remotePlain.tags);

      document.getElementById('conflict-merged-title').value = mergedTitle;
      document.getElementById('conflict-merged-mood').value = mergedMood;
      document.getElementById('conflict-merged-tags').value = mergedTags.join(', ');
      document.getElementById('conflict-merged-body').value = c.autoMerge.mergedText;
    }
  }

  async handleConflictCommit(ev) {
    ev.preventDefault();
    const c = this.state.activeConflict;
    if (!c) return;

    const mergedBody = document.getElementById('conflict-merged-body').value;
    if (!mergedBody.trim()) {
      this.showToast('Merged prose cannot be empty.', 'warn');
      return;
    }
    if (mergedBody.includes('<<<<<<<') || mergedBody.includes('>>>>>>>')) {
      const proceed = await this.openConfirm({
        title: 'Conflict Markers Still Present',
        message: 'Your merged prose still contains <<<<<<< / >>>>>>> markers. Commit anyway?',
        confirmLabel: 'Commit Anyway',
      });
      if (!proceed) return;
    }

    const mergedTitle = document.getElementById('conflict-merged-title').value.trim();
    const mergedMood = document.getElementById('conflict-merged-mood').value.trim();
    const mergedTags = document
      .getElementById('conflict-merged-tags')
      .value.split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    const diaryDate = `${c.yearKey}-${c.dayStr}`;
    let storedTitle = mergedTitle;
    let storedBody = mergedBody;

    if (c.encryptFlag) {
      if (!this.hasActiveSessionKey()) {
        this.showToast('Unlock the Vault before committing encrypted merges.', 'warn');
        return;
      }
      const keyCtx = this.state.keyring || this.state.cryptoKey;
      storedTitle = mergedTitle
        ? await encryptText(mergedTitle, keyCtx, buildEntryAad(diaryDate, c.yearKey, 'title'))
        : '';
      storedBody = await encryptText(
        mergedBody,
        keyCtx,
        buildEntryAad(diaryDate, c.yearKey, 'body')
      );
    }

    const nowIso = new Date().toISOString();
    const entryRecord = {
      year: Number(c.yearKey),
      diaryDate,
      title: storedTitle,
      body: storedBody,
      tags: mergedTags,
      mood: mergedMood,
      image: c.imageObj || c.remotePlain.image || null,
      writtenAt: c.remotePlain.writtenAt || c.editingEntryKey?.originalWrittenAt || nowIso,
      updatedAt: nowIso,
      encrypted: Boolean(c.encryptFlag),
    };

    try {
      const dayMutations = [];
      if (c.editingEntryKey) {
        const { originalDayStr, originalYearKey } = c.editingEntryKey;
        if (originalDayStr !== c.dayStr || originalYearKey !== c.yearKey) {
          dayMutations.push({
            dayStr: originalDayStr,
            mode: 'entry-delete',
            yearKey: originalYearKey,
          });
        }
      }

      dayMutations.push({
        dayStr: c.dayStr,
        mode: 'entry-save',
        yearKey: c.yearKey,
        entryRecord,
        expectedSha: c.remoteSha,
        expectedUpdatedAt: c.remotePlain.updatedAt,
      });

      const res = await this.gh.commitAtomicDayMutations({
        dayMutations,
        mediaUploads: c.mediaUploads || [],
        commitMessage: `diary: resolve 3-way conflict ${diaryDate}`,
      });

      for (const [dKey, doc] of Object.entries(res.docs || {})) {
        this.state.dayCache[dKey] = doc;
      }
      Object.assign(this.state.dayShas, res.dayShas || {});
      this.state.indexData = res.index;
      this.state.activeConflict = null;
      this.storageRemove(`perpetual_draft_${diaryDate}`);

      document.getElementById('conflict-modal').hidden = true;
      this.closeComposer();
      this.state.activeDay = c.dayStr;
      const shortSha = res.commitSha ? ` (#${res.commitSha.slice(0, 7)})` : '';
      this.showToast(`Conflict resolved & committed atomically${shortSha}.`, 'success');
      await this.renderReader();
    } catch (err) {
      this.showToast(err.message || 'Failed to commit merged resolution.', 'error');
    }
  }

  async handleEntrySave(ev) {
    ev.preventDefault();
    const diaryDate = document.getElementById('entry-date-input').value;
    const [yrStr, mm, dd] = diaryDate.split('-');
    const yearNum = Number(yrStr);
    const newDayStr = `${mm}-${dd}`;
    const newYearKey = String(yearNum);

    const rawTitle = document.getElementById('entry-title-input').value.trim();
    const mood = document.getElementById('entry-mood-input').value.trim();
    const tags = document
      .getElementById('entry-tags-input')
      .value.split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const rawBody = document.getElementById('entry-body-input').value;
    const encryptFlag = document.getElementById('entry-encrypt-checkbox').checked;

    if (!rawBody.trim()) {
      this.showToast('Please write some diary prose before saving.', 'warn');
      return;
    }

    let title = rawTitle;
    let body = rawBody;
    if (encryptFlag) {
      if (!this.hasActiveSessionKey()) {
        this.showToast('Unlock or configure the Vault password before encrypting entries.', 'warn');
        return;
      }
      const keyCtx = this.state.keyring || this.state.cryptoKey;
      const titleAad = buildEntryAad(diaryDate, newYearKey, 'title');
      const bodyAad = buildEntryAad(diaryDate, newYearKey, 'body');
      title = rawTitle ? await encryptText(rawTitle, keyCtx, titleAad) : '';
      body = await encryptText(rawBody, keyCtx, bodyAad);
    }

    const caption = document.getElementById('entry-photo-caption').value.trim();
    const photoUrl = document.getElementById('entry-photo-url').value.trim();
    let imageObj = this.state.entryDraftPhoto ? { ...this.state.entryDraftPhoto } : null;
    const mediaUploads = [];

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
        const encryptPhoto = Boolean(
          document.getElementById('entry-photo-encrypt-checkbox')?.checked &&
            this.hasActiveSessionKey()
        );
        const prepared = await prepareMediaPayloadForStorage({
          buffer: imageObj._pendingBuffer,
          mime: imageObj._mime || 'image/webp',
          ext: imageObj._ext || 'webp',
          datePrefix: diaryDate,
          encrypt: encryptPhoto,
          keyring: this.state.keyring || this.state.cryptoKey,
        });
        imageObj.encrypted = prepared.encrypted;

        if (this.gh.hasToken()) {
          mediaUploads.push({ subpath: prepared.mediaSubpath, buffer: prepared.uploadBuffer });
          imageObj.src = `${this.gh.getDataTarget().basePath}/${prepared.mediaSubpath}`;
        } else {
          imageObj.src = await this.storeLocalMediaBuffer(
            prepared.mediaSubpath,
            prepared.uploadBuffer,
            prepared.uploadMime,
            prepared.encrypted
          );
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
      if (this.gh.hasToken()) {
        const dayMutations = [];
        let commitMsg = `diary: save entry ${diaryDate}`;

        if (this.state.editingEntryKey) {
          const { originalDayStr, originalYearKey } = this.state.editingEntryKey;
          if (originalDayStr !== newDayStr || originalYearKey !== newYearKey) {
            dayMutations.push({
              dayStr: originalDayStr,
              mode: 'entry-delete',
              yearKey: originalYearKey,
            });
            commitMsg = `diary: move ${originalYearKey}-${originalDayStr} -> ${diaryDate}`;
          }
        }

        const isSameSlotEdit = Boolean(
          this.state.editingEntryKey &&
            this.state.editingEntryKey.originalDayStr === newDayStr &&
            this.state.editingEntryKey.originalYearKey === newYearKey
        );

        dayMutations.push({
          dayStr: newDayStr,
          mode: 'entry-save',
          yearKey: newYearKey,
          entryRecord,
          expectedSha: isSameSlotEdit
            ? this.state.editingEntryKey.expectedDaySha
            : this.state.dayShas[newDayStr] || null,
          expectedUpdatedAt: isSameSlotEdit
            ? this.state.editingEntryKey.originalUpdatedAt
            : null,
        });

        const res = await this.gh.commitAtomicDayMutations({
          dayMutations,
          mediaUploads,
          commitMessage: commitMsg,
        });

        for (const [dKey, doc] of Object.entries(res.docs || {})) {
          this.state.dayCache[dKey] = doc;
        }
        Object.assign(this.state.dayShas, res.dayShas || {});
        this.state.indexData = res.index;

        this.storageRemove(`perpetual_draft_${diaryDate}`);
        this.state.activeDay = newDayStr;
        this.closeComposer();
        const shortSha = res.commitSha ? ` (#${res.commitSha.slice(0, 7)})` : '';
        this.showToast(
          `Saved ${diaryDate} in 1 atomic commit${shortSha}${encryptFlag ? ' · v3 AAD' : ''}.`,
          'success'
        );
        await this.renderReader();
      } else {
        if (this.state.editingEntryKey) {
          const { originalDayStr, originalYearKey } = this.state.editingEntryKey;
          if (originalDayStr !== newDayStr || originalYearKey !== newYearKey) {
            const oldDoc = await this.getDayDocument(originalDayStr, true);
            const nextOldEntries = { ...(oldDoc.entries || {}) };
            delete nextOldEntries[originalYearKey];
            await this.persistSandboxDay(originalDayStr, { ...oldDoc, entries: nextOldEntries });
          }
        }
        const targetDoc = await this.getDayDocument(newDayStr, true);
        const nextEntries = { ...(targetDoc.entries || {}), [newYearKey]: entryRecord };
        await this.persistSandboxDay(newDayStr, { ...targetDoc, entries: nextEntries });

        this.storageRemove(`perpetual_draft_${diaryDate}`);
        this.state.activeDay = newDayStr;
        this.closeComposer();
        this.showToast(
          `Saved entry for ${diaryDate}${encryptFlag ? ' (v3 AAD verified)' : ''}.`,
          'success'
        );
        await this.renderReader();
      }
    } catch (err) {
      if (err instanceof SyncConflictError || err?.code === 'SYNC_CONFLICT') {
        await this.openConflictResolverModal({
          conflictErr: err,
          localPlain: { diaryDate, title: rawTitle, mood, tags, body: rawBody },
          encryptFlag,
          imageObj,
          mediaUploads,
          editingEntryKey: this.state.editingEntryKey,
        });
        return;
      }
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
      if (this.gh.hasToken()) {
        const mediaDeletes = [];
        const basePrefix = `${this.gh.getDataTarget().basePath}/`;
        if (entryObj?.image?.src?.startsWith(basePrefix)) {
          mediaDeletes.push(entryObj.image.src.slice(basePrefix.length));
        }

        const res = await this.gh.commitAtomicDayMutations({
          dayMutations: [{ dayStr, mode: 'entry-delete', yearKey }],
          mediaDeletes,
          commitMessage: `diary: delete entry ${entryObj.diaryDate || `${yearKey}-${dayStr}`}`,
        });

        this.state.dayCache[dayStr] = res.docs[dayStr];
        if (res.dayShas?.[dayStr]) this.state.dayShas[dayStr] = res.dayShas[dayStr];
        this.state.indexData = res.index;
        this.closeComposer();
        const shortSha = res.commitSha ? ` (#${res.commitSha.slice(0, 7)})` : '';
        this.showToast(`Entry deleted in 1 atomic commit${shortSha}.`, 'success');
        await this.renderReader();
      } else {
        const doc = await this.getDayDocument(dayStr, true);
        const nextEntries = { ...(doc.entries || {}) };
        delete nextEntries[yearKey];
        await this.persistSandboxDay(dayStr, { ...doc, entries: nextEntries });
        this.closeComposer();
        this.showToast('Entry deleted.', 'success');
        await this.renderReader();
      }
    } catch (err) {
      this.showToast(err.message || 'Failed to delete entry.', 'error');
    }
  }

  /* ========================================================================
     366-DAY HEATMAP, ARCHIVE & EXPORTS
     ======================================================================== */
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
          const expectedDate = `${yr}-${dayStr}`;
          const bodyText =
            (await this.decryptFieldIfNeeded(
              e.body,
              Boolean(e.encrypted),
              buildEntryAad(expectedDate, String(yr), 'body')
            )) || '';
          const titleText =
            (await this.decryptFieldIfNeeded(
              e.title,
              Boolean(e.encrypted),
              buildEntryAad(expectedDate, String(yr), 'title')
            )) || '';
          const hay =
            `${titleText} ${bodyText} ${(e.tags || []).join(' ')} ${e.mood || ''}`.toLowerCase();
          if (hay.includes(query)) {
            matches.push({
              dayStr,
              year: yr,
              diaryDate: e.diaryDate || expectedDate,
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
        const expectedDate = `${yr}-${k}`;
        const body =
          (await this.decryptFieldIfNeeded(
            e.body,
            Boolean(e.encrypted),
            buildEntryAad(expectedDate, yr, 'body')
          )) || '[Encrypted / Tampered]';
        const title =
          (await this.decryptFieldIfNeeded(
            e.title,
            Boolean(e.encrypted),
            buildEntryAad(expectedDate, yr, 'title')
          )) || '';
        lines.push(`### ${yr}${title ? ` — ${title}` : ''}`, '', body, '');
      }
      if (Array.isArray(doc.comments) && doc.comments.length) {
        lines.push('#### Margin Notes', '');
        for (const c of doc.comments) {
          const cBody =
            (await this.decryptFieldIfNeeded(
              c.body,
              Boolean(c.encrypted),
              buildCommentAad(k, c.id, 'body')
            )) || '[Encrypted / Tampered]';
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

  /* ========================================================================
     GITHUB SETTINGS & VAULT MODALS
     ======================================================================== */
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
    document.getElementById('gh-zero-footprint-checkbox').checked = this.state.zeroFootprint;
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
    const commitLabel = document.getElementById('health-commit-label');
    const expiryWarn = document.getElementById('health-expiry-warning');

    const health = await this.gh.getRepoHealth();
    modePill.textContent =
      health.mode === 'live-api'
        ? this.state.zeroFootprint
          ? 'LIVE API · RAM ONLY'
          : 'LIVE API · ATOMIC GIT'
        : health.mode === 'public-api'
          ? 'PUBLIC API · READ-ONLY'
          : 'LOCAL SANDBOX';

    repoLabel.textContent = `${health.vaultRepoName} ${health.vaultPrivate ? '(Private)' : '(Public)'}`;
    fill.style.width = `${health.usagePercent}%`;
    fill.classList.toggle('is-warn', health.usagePercent >= 75);

    const mbUsed = (health.totalSizeKb / 1024).toFixed(2);
    sizeLabel.textContent = `${mbUsed} MB / 1,024 MB Pages limit (${health.usagePercent}%)`;

    if (commitLabel) {
      commitLabel.textContent = health.lastCommitSha
        ? `Last Atomic Commit: #${health.lastCommitSha.slice(0, 7)} (Git Trees API)`
        : 'Atomic Commit Engine: Git Trees API ready';
    }

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
    const hasConfiguredVault = this.hasConfiguredVault();
    const isV2 = Number(vm?.version) === 2;
    const isLegacyV1 = hasConfiguredVault && !isV2;
    const enabled = Boolean(vm?.enabled);
    const unlockedViaRecovery = this.state.keyring?.unlockedVia === 'recovery';

    const statusBanner = document.getElementById('vault-status-banner');
    statusBanner.className = `status-callout ${enabled ? 'is-ok' : ''}`;
    statusBanner.textContent = unlockedViaRecovery
      ? 'Unlocked via Paper Recovery Key — you can set a new Master Password directly below without your old password.'
      : enabled
        ? `Vault Lock is ACTIVE (${this.hasActiveSessionKey() ? 'Unlocked in session' : 'Locked'}) · ${isV2 ? 'v2 Envelope + v3 AAD + .enc Media' : 'v1 Legacy'}`
        : hasConfiguredVault
          ? `Vault configured (${isV2 ? 'v2 Envelope + v3 AAD' : 'v1 Legacy'}) — Full Lock Screen currently OFF.`
          : 'No Vault password configured yet. Set a master password to initialize v2 Envelope Encryption + AAD.';

    const archPanel = document.getElementById('vault-arch-panel');
    const slotsList = document.getElementById('vault-slots-list');
    if (isV2) {
      archPanel.hidden = false;
      document.getElementById('vault-version-pill').textContent = 'V2 ENVELOPE · V3 AAD';
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
          const spec =
            s.type === 'recovery'
              ? '256-bit Raw Hex Recovery Slot'
              : `${s.kdf || 'PBKDF2-SHA256'} (${Number(s.iterations || 250000).toLocaleString()} iter)`;
          return `
            <div class="vault-slot-card">
              <div>
                <strong>${escapeHtml(s.label || 'Key Slot')}</strong>
                <span class="mono-meta"> · ${escapeHtml(spec)}</span>
              </div>
              <span class="mono-meta">${s.type === 'recovery' ? 'Issued' : 'Rotated'} ${escapeHtml(rotDate)}</span>
            </div>
          `;
        })
        .join('');
    } else {
      archPanel.hidden = true;
      slotsList.innerHTML = '';
    }

    const recoveryPanel = document.getElementById('vault-recovery-panel');
    const recSlot = (vm?.keySlots || []).find((s) => s && s.type === 'recovery');
    recoveryPanel.hidden = !isV2;
    if (isV2) {
      document.getElementById('vault-recovery-slot-status').textContent = recSlot
        ? `Slot active (${new Date(recSlot.createdAt).toLocaleDateString()})`
        : 'No recovery slot yet';
      document.getElementById('vault-gen-recovery-btn').textContent = recSlot
        ? 'Regenerate Recovery Key'
        : 'Generate Recovery Key';

      const codeBox = document.getElementById('vault-recovery-code-box');
      const codeDisplay = document.getElementById('vault-recovery-code-display');
      const printBtn = document.getElementById('vault-print-card-btn');
      if (this.state.recentRecoveryCode) {
        codeBox.hidden = false;
        codeDisplay.textContent = this.state.recentRecoveryCode;
        printBtn.disabled = false;
      } else {
        codeBox.hidden = true;
        codeDisplay.textContent = '';
        printBtn.disabled = true;
      }
    }

    document.getElementById('vault-upgrade-banner').hidden = !isLegacyV1;
    document.getElementById('vault-migrate-banner').hidden = !(isV2 && this.state.keyring?.dek);
    document.getElementById('vault-migrate-status').hidden = true;

    const mediaMigrateBanner = document.getElementById('vault-media-migrate-banner');
    if (mediaMigrateBanner) mediaMigrateBanner.hidden = !this.hasActiveSessionKey();
    const mediaMigrateStatus = document.getElementById('vault-media-migrate-status');
    if (mediaMigrateStatus) mediaMigrateStatus.hidden = true;

    document.getElementById('vault-lock-enabled-checkbox').checked = enabled;
    document.getElementById('vault-autolock-select').value = String(
      this.getEffectiveAutoLockMinutes()
    );
    document.getElementById('vault-current-pass-group').hidden =
      !hasConfiguredVault || unlockedViaRecovery;
    document.getElementById('vault-new-pass-label').textContent = unlockedViaRecovery
      ? 'Set New Master Password (Recovery Reset — instant)'
      : hasConfiguredVault
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

  async handleGenerateRecoveryKey() {
    if (!this.state.keyring?.dek || Number(this.state.vaultMeta?.version) !== 2) {
      this.showToast('Unlock your v2 Envelope Vault first to generate a Paper Recovery Key.', 'warn');
      return;
    }

    const hasExisting = (this.state.vaultMeta?.keySlots || []).some(
      (s) => s && s.type === 'recovery'
    );
    if (hasExisting) {
      const ok = await this.openConfirm({
        title: 'Regenerate Paper Recovery Key',
        message:
          'Generating a new Paper Recovery Key immediately invalidates your previously printed sheet. Continue?',
        confirmLabel: 'Regenerate Key',
      });
      if (!ok) return;
    }

    try {
      const { recoveryCode, vaultMeta } = await attachPaperRecoverySlot(
        this.state.vaultMeta,
        this.state.keyring
      );
      await this.persistVaultMeta(vaultMeta, 'diary: update paper recovery key slot');
      this.state.recentRecoveryCode = recoveryCode;
      this.showToast('256-bit Paper Recovery Key generated. Print or save it now.', 'success');
      this.openVaultModal();
    } catch (err) {
      this.showToast(err.message || 'Failed to generate recovery key.', 'error');
    }
  }

  async handleMigrateLegacyEntriesToV3Aad() {
    if (!this.state.keyring?.dek) {
      this.showToast('Unlock your v2 Envelope vault first to upgrade entries to v3 AAD.', 'warn');
      return;
    }

    const statusEl = document.getElementById('vault-migrate-status');
    const btn = document.getElementById('vault-migrate-entries-btn');
    btn.disabled = true;
    statusEl.hidden = false;

    try {
      const dayKeys = Object.keys(this.state.indexData?.days || {}).sort();
      const batchChanges = [];
      let migratedDays = 0;
      let migratedItems = 0;

      for (let i = 0; i < dayKeys.length; i += 1) {
        const dayStr = dayKeys[i];
        statusEl.textContent = `Scanning ${i + 1}/${dayKeys.length} (${dayStr})...`;
        const doc = await this.getDayDocument(dayStr, true);
        let dirty = false;

        for (const [yrKey, entry] of Object.entries(doc.entries || {})) {
          if (!entry || !entry.encrypted) continue;
          const bodyVer = getPayloadVersion(entry.body);
          const titleVer = entry.title ? getPayloadVersion(entry.title) : 3;
          if (
            bodyVer === 1 ||
            bodyVer === 2 ||
            (entry.title && (titleVer === 1 || titleVer === 2))
          ) {
            const expectedDate = `${yrKey}-${dayStr}`;
            const plainBody = await decryptText(entry.body, this.state.keyring);
            const plainTitle = entry.title ? await decryptText(entry.title, this.state.keyring) : '';
            doc.entries[yrKey] = {
              ...entry,
              body: await encryptText(
                plainBody,
                this.state.keyring.dek,
                buildEntryAad(expectedDate, yrKey, 'body')
              ),
              title: plainTitle
                ? await encryptText(
                    plainTitle,
                    this.state.keyring.dek,
                    buildEntryAad(expectedDate, yrKey, 'title')
                  )
                : '',
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
            if (!cmt || !cmt.encrypted) continue;
            const cVer = getPayloadVersion(cmt.body);
            if (cVer === 1 || cVer === 2) {
              const plainCmt = await decryptText(cmt.body, this.state.keyring);
              doc.comments[cIdx] = {
                ...cmt,
                body: await encryptText(
                  plainCmt,
                  this.state.keyring.dek,
                  buildCommentAad(dayStr, cmt.id, 'body')
                ),
                encrypted: true,
                updatedAt: new Date().toISOString(),
              };
              dirty = true;
              migratedItems += 1;
            }
          }
        }

        if (dirty) {
          migratedDays += 1;
          this.state.dayCache[dayStr] = doc;
          if (this.gh.hasToken()) {
            batchChanges.push({
              subpath: `days/${dayStr}.json`,
              content: `${JSON.stringify(doc, null, 2)}\n`,
              isBase64: false,
            });
          } else {
            await this.persistSandboxDay(dayStr, doc);
          }
        }
      }

      if (this.state.vaultMeta?.wrappedLegacyKey) {
        const cleanedVault = {
          ...this.state.vaultMeta,
          wrappedLegacyKey: null,
          aadSupported: true,
          updatedAt: new Date().toISOString(),
        };
        this.state.vaultMeta = cleanedVault;
        this.storageSet('perpetual_diary_vault_local_v1', JSON.stringify(cleanedVault));
        this.setActiveKeyring({ ...this.state.keyring, legacyKey: null });
        if (this.gh.hasToken()) {
          batchChanges.push({
            subpath: 'vault.json',
            content: `${JSON.stringify(cleanedVault, null, 2)}\n`,
            isBase64: false,
          });
        }
      }

      let shortSha = '';
      if (this.gh.hasToken() && batchChanges.length > 0) {
        statusEl.textContent = `Committing ${batchChanges.length} file(s) in 1 atomic Git commit...`;
        const res = await this.gh.commitBatch(
          batchChanges,
          `diary: batch upgrade ${migratedItems} item(s) to v3 AAD`
        );
        for (const [sub, sha] of Object.entries(res.fileShas || {})) {
          const m = /^days\/(\d{2}-\d{2})\.json$/.exec(sub);
          if (m) this.state.dayShas[m[1]] = sha;
        }
        shortSha = res.commitSha ? ` (#${res.commitSha.slice(0, 7)})` : '';
      }

      statusEl.textContent =
        migratedItems > 0
          ? `Upgraded ${migratedItems} item(s) across ${migratedDays} day(s) to v3 AAD in 1 atomic commit${shortSha}.`
          : 'All encrypted entries are already protected with v3 AAD.';
      this.showToast(statusEl.textContent, 'success');
      await this.renderActiveView();
    } catch (err) {
      statusEl.textContent = `Upgrade interrupted: ${err.message}`;
      this.showToast(err.message || 'Batch upgrade failed.', 'error');
    } finally {
      btn.disabled = false;
    }
  }

  /* ========================================================================
     EVENT BINDINGS
     ======================================================================== */
  bindEvents() {
    const wipeOnUnload = () => {
      this.revokeRamMediaUrls();
      if (!this.state.zeroFootprint) return;
      this.setActiveKeyring(null);
      this.state.recentRecoveryCode = null;
      this.state.activeConflict = null;
      this.state.dayCache = {};
      this.state.dayShas = {};
      this.gh.updateConfig({ token: '' });
      this.scrubSensitiveDom();
    };
    window.addEventListener('pagehide', wipeOnUnload);
    window.addEventListener('beforeunload', wipeOnUnload);

    document.addEventListener('pointerdown', () => this.recordUserActivity(false), { passive: true });
    document.addEventListener('keydown', () => this.recordUserActivity(false), { passive: true });
    document.addEventListener('touchstart', () => this.recordUserActivity(false), { passive: true });
    document.addEventListener('mousemove', () => this.recordUserActivity(true), { passive: true });
    document.addEventListener('scroll', () => this.recordUserActivity(true), { passive: true });

    const checkSleepWakeLock = () => {
      if (!this.hasActiveSessionKey()) return;
      const mins = this.getEffectiveAutoLockMinutes();
      if (mins <= 0) return;
      if (Date.now() - this.lastActivityAt >= mins * 60000) {
        this.lockDiaryNow('inactivity');
      }
    };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') checkSleepWakeLock();
    });
    window.addEventListener('focus', checkSleepWakeLock);

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

    // Phase 6B: WebP Compression Preset Sync & Photo Upload Listeners
    const webpPresetEl = document.getElementById('entry-webp-preset');
    if (webpPresetEl) {
      webpPresetEl.value = getSavedWebpPreset(this.state.zeroFootprint);
      webpPresetEl.addEventListener('change', (e) => {
        saveWebpPreset(e.target.value, this.state.zeroFootprint);
      });
    }

    document.getElementById('comment-photo-file')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const preset = getSavedWebpPreset(this.state.zeroFootprint);
        const processed = await processImageFile(file, { preset });
        const statsText =
          processed.savedPercent > 0
            ? `${processed.formatLabel} · ${formatBytesCompact(processed.compressedBytes)} (−${processed.savedPercent}%)`
            : `${processed.formatLabel} · ${formatBytesCompact(processed.compressedBytes)}`;

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
        const statsEl = document.getElementById('comment-photo-stats');
        if (statsEl) {
          statsEl.textContent = statsText;
          statsEl.hidden = false;
        }
        document.getElementById('comment-photo-remove-btn').hidden = false;
        this.commentStudio.setMedia(processed.dataUrl, this.state.commentDraftPhoto, statsText);
      } catch (err) {
        this.showToast(err.message || 'Image error.', 'error');
      }
    });

    document.getElementById('comment-photo-remove-btn')?.addEventListener('click', () => {
      this.state.commentDraftPhoto = null;
      document.getElementById('comment-photo-file').value = '';
      document.getElementById('comment-photo-url').value = '';
      document.getElementById('comment-photo-remove-btn').hidden = true;
      const statsEl = document.getElementById('comment-photo-stats');
      if (statsEl) {
        statsEl.textContent = '';
        statsEl.hidden = true;
      }
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
      const raw = this.storageGet(`perpetual_draft_${diaryDate}`);
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
      this.storageRemove(`perpetual_draft_${diaryDate}`);
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
        const preset = document.getElementById('entry-webp-preset')?.value || 'balanced';
        const processed = await processImageFile(file, { preset });
        const statsText =
          processed.savedPercent > 0
            ? `${processed.formatLabel} · ${formatBytesCompact(processed.originalBytes)} → ${formatBytesCompact(processed.compressedBytes)} (−${processed.savedPercent}%)`
            : `${processed.formatLabel} · ${formatBytesCompact(processed.compressedBytes)}`;

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
        const statsEl = document.getElementById('entry-photo-stats');
        if (statsEl) {
          statsEl.textContent = statsText;
          statsEl.hidden = false;
        }
        document.getElementById('entry-photo-remove-btn').hidden = false;
        this.entryStudio.setMedia(processed.dataUrl, this.state.entryDraftPhoto, statsText);
      } catch (err) {
        this.showToast(err.message || 'Could not process image.', 'error');
      }
    });

    document.getElementById('entry-photo-remove-btn')?.addEventListener('click', () => {
      this.state.entryDraftPhoto = null;
      document.getElementById('entry-photo-file').value = '';
      document.getElementById('entry-photo-url').value = '';
      document.getElementById('entry-photo-remove-btn').hidden = true;
      const statsEl = document.getElementById('entry-photo-stats');
      if (statsEl) {
        statsEl.textContent = '';
        statsEl.hidden = true;
      }
      this.entryStudio.clear();
    });

    // Interactive 3-Way Conflict Resolver Events
    document.getElementById('conflict-close-btn')?.addEventListener('click', () => {
      document.getElementById('conflict-modal').hidden = true;
    });
    document.getElementById('conflict-cancel-btn')?.addEventListener('click', () => {
      document.getElementById('conflict-modal').hidden = true;
    });
    document.getElementById('conflict-pick-local-btn')?.addEventListener('click', () => {
      this.populateConflictMergeFields('local');
    });
    document.getElementById('conflict-pick-remote-btn')?.addEventListener('click', () => {
      this.populateConflictMergeFields('remote');
    });
    document.getElementById('conflict-pick-merge-btn')?.addEventListener('click', () => {
      this.populateConflictMergeFields('merge');
    });
    document.getElementById('conflict-form')?.addEventListener('submit', (e) => {
      this.handleConflictCommit(e);
    });

    // GitHub Settings, Split-Repo & Zero-Footprint Events
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

    document.getElementById('lock-zero-footprint-checkbox')?.addEventListener('change', (e) => {
      this.setZeroFootprintMode(e.target.checked, true);
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
      if (!this.state.zeroFootprint) {
        GitHubClient.saveConfig(this.gh.config, window.localStorage);
      }
      this.updateModeBadge();
      this.refreshRepoHealthPanel();
      this.showToast('Cleared token from browser.', 'info');
    });

    document.getElementById('gh-wipe-local-btn')?.addEventListener('click', async () => {
      const ok = await this.openConfirm({
        title: 'Wipe Local Browser Traces',
        message:
          'Erase all locally stored GitHub config, PAT, cached drafts, and IndexedDB media from this browser? (Your GitHub repository data is untouched.)',
        confirmLabel: 'Wipe This Browser',
      });
      if (!ok) return;
      await this.wipeAllLocalBrowserTraces();
      this.gh.updateConfig({ token: '' });
      this.setZeroFootprintMode(true, false);
      this.updateModeBadge();
      this.refreshRepoHealthPanel();
      this.showToast(
        'All local browser traces wiped. Switched to Zero-Footprint RAM mode.',
        'success'
      );
    });

    document.getElementById('github-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const nextZeroFootprint = Boolean(
        document.getElementById('gh-zero-footprint-checkbox').checked
      );
      this.setZeroFootprintMode(nextZeroFootprint, false);

      const nextCfg = collectGitHubFormConfig();
      this.gh.updateConfig(nextCfg);
      if (!this.state.zeroFootprint) {
        GitHubClient.saveConfig(nextCfg, window.localStorage);
      }
      this.state.dayCache = {};
      this.state.dayShas = {};
      this.updateModeBadge();
      await this.loadVaultAndIndex();
      await this.renderActiveView();
      await this.refreshRepoHealthPanel();
      document.getElementById('github-modal').hidden = true;
      this.showToast(
        this.state.zeroFootprint
          ? 'Settings applied in RAM only (Zero-Footprint Mode).'
          : 'GitHub & Split-Repo settings saved.',
        'success'
      );
    });

    // Envelope Vault, AAD Migration, .enc Media Migration & Paper Recovery Kit Events
    document.getElementById('vault-btn')?.addEventListener('click', () => this.openVaultModal());
    document.getElementById('vault-close-btn')?.addEventListener('click', () => {
      document.getElementById('vault-modal').hidden = true;
    });
    document.getElementById('vault-cancel-btn')?.addEventListener('click', () => {
      document.getElementById('vault-modal').hidden = true;
    });

    document.getElementById('vault-gen-recovery-btn')?.addEventListener('click', () => {
      this.handleGenerateRecoveryKey();
    });

    document.getElementById('vault-print-card-btn')?.addEventListener('click', () => {
      if (!this.state.recentRecoveryCode) {
        this.showToast('Generate a Paper Recovery Key first so it can be printed.', 'warn');
        return;
      }
      const res = openPrintableRecoveryCard({
        recoveryCode: this.state.recentRecoveryCode,
        vaultMeta: this.state.vaultMeta,
        repoConfig: this.gh.config,
      });
      if (!res.openedWindow) {
        this.showToast('Popup blocked — downloaded printable recovery card HTML instead.', 'info');
      }
    });

    document.getElementById('vault-download-decryptor-btn')?.addEventListener('click', () => {
      const html = buildOfflineDecryptorHtml({
        vaultMeta: this.state.vaultMeta,
        repoConfig: this.gh.config,
      });
      this.downloadFile('perpetual-offline-decryptor.html', html, 'text/html;charset=utf-8');
      this.showToast('Downloaded standalone offline decryptor (.HTML).', 'success');
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
        const autoLockMinutes = Number(document.getElementById('vault-autolock-select').value) || 0;
        const res = await upgradeLegacyVaultToEnvelope(this.state.vaultMeta, currentPass, {
          enabled: Boolean(document.getElementById('vault-lock-enabled-checkbox').checked),
          autoLockMinutes,
          encryptPat,
          patToken: this.gh.hasToken() ? this.gh.config.token : null,
        });
        this.setActiveKeyring(res.keyring);
        await this.persistVaultMeta(res.vaultMeta, 'diary: upgrade vault to v2 envelope');
        this.showToast('Upgraded to v2 Envelope Encryption with v3 AAD & Recovery Kit.', 'success');
        this.openVaultModal();
      } catch (err) {
        errBox.textContent = err.message;
        errBox.hidden = false;
      }
    });

    document.getElementById('vault-migrate-entries-btn')?.addEventListener('click', async () => {
      await this.handleMigrateLegacyEntriesToV3Aad();
    });

    document.getElementById('vault-migrate-media-btn')?.addEventListener('click', async () => {
      const btn = document.getElementById('vault-migrate-media-btn');
      const statusEl = document.getElementById('vault-media-migrate-status');
      btn.disabled = true;
      statusEl.hidden = false;
      try {
        const res = await migratePlaintextMediaToEncryptedVault({
          app: this,
          onProgress: (msg) => {
            statusEl.textContent = msg;
          },
        });
        const shaTxt = res.commitSha ? ` (#${res.commitSha.slice(0, 7)})` : '';
        statusEl.textContent =
          res.encryptedCount > 0
            ? `Encrypted ${res.encryptedCount} photo(s) across ${res.updatedDays} day(s) into .enc vault${shaTxt}.`
            : 'No unencrypted local/GitHub photos found — all vault media is already encrypted.';
        this.showToast(statusEl.textContent, 'success');
        await this.renderActiveView();
      } catch (err) {
        statusEl.textContent = `Migration error: ${err.message}`;
        this.showToast(err.message || 'Media encryption failed.', 'error');
      } finally {
        btn.disabled = false;
      }
    });

    document.getElementById('vault-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errBox = document.getElementById('vault-error');
      errBox.hidden = true;

      const lockEnabled = Boolean(document.getElementById('vault-lock-enabled-checkbox').checked);
      const autoLockMinutes = Number(document.getElementById('vault-autolock-select').value) || 0;
      const currentPass = document.getElementById('vault-current-password').value;
      const newPass = document.getElementById('vault-new-password').value;
      const confirmPass = document.getElementById('vault-confirm-password').value;
      const encryptPat = Boolean(document.getElementById('vault-encrypt-pat-checkbox').checked);

      const hasExistingVault = this.hasConfiguredVault();
      const unlockedViaRecovery = this.state.keyring?.unlockedVia === 'recovery';

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
            autoLockMinutes,
            patToken: encryptPat && this.gh.hasToken() ? this.gh.config.token : null,
          });
          this.setActiveKeyring(created.keyring);
          await this.persistVaultMeta(created.vaultMeta, 'diary: initialize v2 envelope vault');
          this.showToast('v2 Envelope Vault initialized with v3 AAD protection.', 'success');
        } else if (newPass) {
          if (newPass !== confirmPass) {
            throw new Error('New password and confirmation do not match.');
          }

          let rotated;
          if (unlockedViaRecovery && this.state.keyring?.dek) {
            rotated = await rotateVaultPasswordWithKeyring(
              this.state.vaultMeta,
              this.state.keyring,
              newPass,
              {
                enabled: lockEnabled,
                autoLockMinutes,
                encryptPat,
                patToken: encryptPat && this.gh.hasToken() ? this.gh.config.token : null,
              }
            );
          } else {
            if (!currentPass) {
              throw new Error('Enter your Current Master Password (or Recovery Key) to rotate.');
            }
            rotated = await rotateVaultPassword(this.state.vaultMeta, currentPass, newPass, {
              enabled: lockEnabled,
              autoLockMinutes,
              encryptPat,
              patToken: encryptPat && this.gh.hasToken() ? this.gh.config.token : null,
            });
          }

          this.setActiveKeyring(rotated.keyring);
          await this.persistVaultMeta(rotated.vaultMeta, 'diary: rotate master password key slot');
          this.showToast(
            'Password rotated instantly — DEK unchanged, 0 diary entries re-encrypted.',
            'success'
          );
        } else {
          const nextVault = {
            ...this.state.vaultMeta,
            enabled: lockEnabled,
            autoLockMinutes,
            aadSupported: true,
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
          await this.persistVaultMeta(nextVault, 'diary: update vault & auto-lock preferences');
          this.startAutoLockMonitor();
          this.showToast('Vault & auto-lock settings saved.', 'success');
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
      const zfChecked = Boolean(document.getElementById('lock-zero-footprint-checkbox')?.checked);
      errEl.hidden = true;

      try {
        this.setZeroFootprintMode(zfChecked, false);
        const res = await unlockVault(passInput.value, this.state.vaultMeta);
        if (!res.ok) {
          errEl.textContent = res.error || 'Incorrect password or recovery key';
          errEl.hidden = false;
          return;
        }

        this.setActiveKeyring(res.keyring);

        if (res.pat && !this.gh.hasToken()) {
          this.gh.updateConfig({ token: res.pat });
          if (!this.state.zeroFootprint) {
            GitHubClient.saveConfig(this.gh.config, window.localStorage);
          }
        }

        passInput.value = '';
        this.state.unlocked = true;
        const reasonBadge = document.getElementById('lock-reason-badge');
        if (reasonBadge) reasonBadge.hidden = true;
        document.getElementById('lock-screen').hidden = true;
        this.updateModeBadge();
        await this.renderActiveView();

        if (res.unlockedVia === 'recovery') {
          this.showToast(
            'Unlocked via Paper Recovery Key. Open Vault (⛨) to set a new Master Password.',
            'warn'
          );
        } else {
          this.showToast(
            this.state.zeroFootprint
              ? 'Vault unlocked in Zero-Footprint Mode (RAM only).'
              : res.version === 2
                ? 'Envelope Vault unlocked.'
                : 'Legacy v1 Vault unlocked.',
            'success'
          );
        }
      } catch {
        errEl.textContent = 'Incorrect password or recovery key';
        errEl.hidden = false;
      }
    });

    document.getElementById('lock-now-btn')?.addEventListener('click', () => {
      this.lockDiaryNow('manual');
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

    // Global Hotkeys (GitHub Settings: Ctrl+Shift+G, Panic Lock: Ctrl+Shift+L / Cmd+Shift+L, Escape)
    document.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      if (mod && e.shiftKey && key === 'l') {
        e.preventDefault();
        this.lockDiaryNow('panic');
      } else if (mod && e.shiftKey && key === 'g') {
        e.preventDefault();
        this.openGitHubModal();
      } else if (e.key === 'Escape') {
        document.getElementById('composer-modal').hidden = true;
        document.getElementById('github-modal').hidden = true;
        document.getElementById('vault-modal').hidden = true;
        document.getElementById('conflict-modal').hidden = true;
        this.closeConfirm(false);
      }
    });
  }
}

const app = new PerpetualDiaryApp();
app.init();
