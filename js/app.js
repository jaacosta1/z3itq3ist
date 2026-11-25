/**
 * js/app.js — Perpetual Side-by-Side Web Diary Master Controller (Clean Final Build)
 * Covers all 20 phases + Stacked Multi-Entries per Day + Word Trend Explorer + Right-Click Shortcuts
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
  rotateVaultPassword,
  rotateVaultPasswordWithKeyring,
  upgradeLegacyVaultToEnvelope,
  upgradePasswordSlotKdf,
  encryptPatToken,
} from './crypto.js';
import { ARGON2ID_PRESETS } from './kdf.js';
import {
  parseShareHash,
  loadShareRecords,
  createRevocableShareLink,
  fetchAndDecryptShareLink,
  revokeShareLink,
} from './share.js';
import {
  recordSandboxRevision,
  fetchDayCommitHistory,
  fetchEntryAtRevision,
  saveCloudDraft,
  listCloudDrafts,
  loadCloudDraft,
  deleteCloudDraft,
} from './history.js';
import {
  renderMarkdown,
  stripMarkdown,
  countWords,
  countChars,
  extractDefaultQuote,
} from './markdown.js';
import {
  GitHubClient,
  SyncConflictError,
  isNetworkOfflineError,
  getYearEntriesList,
  recalculateIndexForDay,
} from './github.js';
import {
  LocalMediaStore,
  processImageFile,
  prepareMediaPayloadForStorage,
  prepareAudioPayloadForStorage,
  resolveMediaAsset,
  revokeAllManagedMediaUrls,
  normalizeEntryImages,
  openMediaLightbox,
  closeMediaLightbox,
  InkSketchPad,
  VoiceNoteRecorder,
  isAudioRecordingSupported,
  formatBytesCompact,
  formatDurationSec,
  getSavedWebpPreset,
  saveWebpPreset,
  AlignmentStudio,
  attachInlineAlignController,
} from './media.js';
import { migratePlaintextMediaToEncryptedVault } from './media-vault.js';
import {
  isShardPointer,
  parseShardPointer,
  buildShardPointer,
  resolveShardRepoName,
  computeFileShortHash,
  downloadOriginalForColdArchive,
} from './media-sharding.js';
import { openPrintableRecoveryCard, buildOfflineDecryptorHtml } from './recovery.js';
import { renderDiffHtml, buildThreeWayMerge, mergeTags } from './conflict.js';
import {
  computeDayShardSubpath,
  decryptManifestIndex,
  unsealDayDocument,
  createCloakAdapter,
  migrateRepositoryToCloakedMode,
} from './cloak.js';
import {
  isDoubleLockedPayload,
  buildDoubleLockAad,
  encryptDoubleLockedText,
  decryptDoubleLockedText,
  isWebAuthnSupported,
  hasPasskeySlots,
  registerPasskeySlot,
  unlockVaultWithPasskey,
  removePasskeySlot,
  configureDecoyVault,
  removeDecoyVault,
  unlockVaultOrDecoy,
} from './vault-auth.js';
import {
  getAll366DayKeys,
  formatReadableDayKey,
  computeBacklinksForDate,
  extractStoryArcs,
  buildStoryArcBook,
  getCalendarDaysWindow,
  getSeasonForDay,
  getSeasonDayKeys,
  collectIndexedWindowEntries,
  getTimeCapsuleStatus,
  computeDiaryAnalytics,
  computeWordTrend,
  generateYearInReviewDossier,
  renderYearDossierMarkdown,
  BUILT_IN_TEMPLATES,
  loadCustomTemplates,
  saveCustomTemplate,
  drawRandomPrompt,
  filterCommands,
  ARTIFACT_FIELDS,
  normalizeArtifacts,
  fetchCurrentLocationAndWeather,
  loadMetricDefinitions,
  normalizeEntryMetrics,
  getHeatmapLevelForMode,
  getSavedThemePreset,
  applyThemePreset,
  OfflineCommitQueue,
  openPrintBookWindow,
  openMiniZineWindow,
  parseImportedDiaryFile,
} from './features.js';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
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
  const m = /^(\d{2})-(\d{2})$/.exec(String(dayStr || '').trim());
  if (!m) return { month: 11, day: 24 };
  const month = Math.min(12, Math.max(1, Number(m[1])));
  const day = Math.min(DAYS_IN_MONTH[month - 1], Math.max(1, Number(m[2])));
  return { month, day };
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
  return `${pad2(Math.floor(totalSec / 60))}:${pad2(totalSec % 60)}`;
}

function diffCalendarDays(diaryDateStr, writtenAtIso) {
  if (!diaryDateStr || !writtenAtIso) return 0;
  const [y, m, d] = diaryDateStr.split('-').map(Number);
  if (!y || !m || !d) return 0;
  const wDate = new Date(writtenAtIso);
  if (Number.isNaN(wDate.getTime())) return 0;
  const diaryUtc = Date.UTC(y, m - 1, d);
  const writtenUtc = Date.UTC(wDate.getUTCFullYear(), wDate.getUTCMonth(), wDate.getUTCDate());
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

const SANDBOX_SEED_INDEX = {
  version: 1,
  updatedAt: '2026-11-24T00:00:00Z',
  days: {
    '11-24': {
      years: [2024, 2025, 2026],
      tags: ['reflection', 'beginnings', 'craft', 'continuity', 'arc:perpetual-ledger'],
      arcs: ['perpetual-ledger'],
      wordCounts: { 2024: 74, 2025: 56, 2026: 96 },
      entryCounts: { 2024: 1, 2025: 1, 2026: 2 },
      moods: { 2024: 'grounded', 2025: 'clear', 2026: 'focused' },
      metrics: {
        2024: { energy: 4, clarity: 4, calm: 5, sleep: 4 },
        2025: { energy: 4, clarity: 5, calm: 4, sleep: 4 },
        2026: { energy: 5, clarity: 5, calm: 5, sleep: 4 },
      },
      commentCount: 1,
    },
  },
};

const SANDBOX_SEED_DAYS = {
  '11-24': {
    day: '11-24',
    entries: {
      2024: {
        id: 'ent-2024-1124-1',
        year: 2024,
        diaryDate: '2024-11-24',
        title: 'First frost & a quiet ledger',
        body:
          'Started keeping a perpetual diary today instead of letting notebooks vanish into boxes.\n\n> The value of a daily record is rarely visible in the same week you write it; it reveals itself three Novembers later.\n\nWalked around the block after rain and wrote down three anchors:\n- Keep notes honest rather than theatrical\n- Measure progress in seasons, not hours\n- Return to this exact page next year',
        tags: ['reflection', 'beginnings', 'arc:perpetual-ledger'],
        mood: 'grounded',
        location: 'Home Desk',
        weather: '⛅ 14°C · Crisp',
        artifacts: { reading: 'The Notebooks of Samuel Butler', drinking: 'Pour-over coffee' },
        metrics: { energy: 4, clarity: 4, calm: 5, sleep: 4 },
        images: [],
        image: null,
        writtenAt: '2024-11-25T05:10:00Z',
        updatedAt: '2024-11-25T05:10:00Z',
        encrypted: false,
      },
      2025: {
        id: 'ent-2025-1124-1',
        year: 2025,
        diaryDate: '2025-11-24',
        title: 'One year later on the same page',
        body:
          'Reading [[2024-11-24]] side by side shows how much noise drops away over twelve months.^[Notice how small daily habits carried the whole year.]\n\n> [!reflection] Continuity\n> What felt urgent last autumn barely registers now.',
        tags: ['continuity', 'reflection', 'arc:perpetual-ledger'],
        mood: 'clear',
        metrics: { energy: 4, clarity: 5, calm: 4, sleep: 4 },
        images: [],
        image: null,
        writtenAt: '2025-11-27T08:00:00Z',
        updatedAt: '2025-11-27T08:00:00Z',
        encrypted: false,
      },
      2026: [
        {
          id: 'ent-2026-1124-1',
          year: 2026,
          diaryDate: '2026-11-24',
          title: 'Morning pages · Three layers of November 24',
          body:
            'Having **2024**, **2025**, and **2026** in parallel columns turns single-day journaling into a longitudinal mirror. Even short entries compound into a quiet map of who you were becoming.',
          tags: ['craft', 'continuity', 'arc:perpetual-ledger'],
          mood: 'focused',
          metrics: { energy: 5, clarity: 5, calm: 5, sleep: 4 },
          images: [],
          image: null,
          writtenAt: '2026-11-24T08:30:00Z',
          updatedAt: '2026-11-24T08:30:00Z',
          encrypted: false,
        },
        {
          id: 'ent-2026-1124-2',
          year: 2026,
          diaryDate: '2026-11-24',
          title: 'Evening note · Stacked multiple entries',
          body:
            'Added a second evening reflection inside the same **2026** column. You can stack unlimited entries per day, track recurring words in **Insights & Arcs**, or **right-click anywhere** for quick shortcuts.',
          tags: ['craft', 'evening'],
          mood: 'calm',
          images: [],
          image: null,
          writtenAt: '2026-11-24T21:15:00Z',
          updatedAt: '2026-11-24T21:15:00Z',
          encrypted: false,
        },
      ],
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
    this.gh = new GitHubClient(GitHubClient.loadConfig(window.localStorage));
    this.offlineQueue = new OfflineCommitQueue();
    const savedAutoLock = Number(window.localStorage.getItem(AUTOLOCK_STORAGE_KEY));

    this.state = {
      activeDay: '11-24',
      sortOrder: 'asc',
      colMode: 'fit',
      windowScope: 'day',
      heatmapMode: 'years',
      pinnedYear: null,
      mobileMode: 'swipe',
      mobileSelectedYear: null,
      compare2Active: false,
      compareDateA: '2024-11-24',
      compareDateB: '2026-11-24',
      indexData: { version: 1, updatedAt: '', days: {} },
      dayCache: {},
      dayShas: {},
      decryptedEntryCache: new Map(),
      sandboxRamDays: null,
      ramMediaUrls: new Map(),
      vaultMeta: null,
      keyring: null,
      cryptoKey: null,
      unlocked: true,
      isDecoySession: false,
      decoyPolicy: null,
      doubleLockUnlocked: new Map(),
      zeroFootprint: false,
      recentRecoveryCode: null,
      autoLockMinutes: Number.isFinite(savedAutoLock) && savedAutoLock >= 0 ? savedAutoLock : 15,
      pendingQuote: null,
      editingCommentId: null,
      commentDraftPhoto: null,
      editingEntryKey: null,
      editingBaseEntry: null,
      entryDraftGallery: [],
      entryDraftVoice: null,
      activePromptText: '',
      zenMode: false,
      pendingShareEntry: null,
      activeConflict: null,
      activeHistory: null,
      historyViewMode: 'diff',
      activeCloudDraftDate: null,
      editorMode: 'write',
      archiveSearch: '',
      archiveYear: '',
      archiveTag: '',
      wordTrendQuery: '',
      selectedArcSlug: '',
      selectedDossierYear: new Date().getFullYear(),
      cmdkItems: [],
      cmdkSelectedIndex: 0,
      confirmResolver: null,
      inlineAlignCleanup: null,
      swRegistration: null,
    };

    this.entryStudio = null;
    this.commentStudio = null;
    this.sketchPad = null;
    this.voiceRecorder = null;
    this.draftSaveTimer = null;
    this.autoLockInterval = null;
    this.lastActivityAt = Date.now();
    this.lastThrottledPing = 0;
    this.autoLockWarned = false;
  }

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
      // ignore
    }
  }

  syncServiceWorkerZeroFootprint(enabled) {
    const ctrl = navigator.serviceWorker?.controller;
    if (ctrl) {
      ctrl.postMessage({ type: 'SET_ZERO_FOOTPRINT', enabled: Boolean(enabled) });
    }
  }

  async registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    const isSecure =
      window.location.protocol === 'https:' ||
      window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1';
    if (!isSecure) return;

    try {
      const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
      this.state.swRegistration = reg;
      this.syncServiceWorkerZeroFootprint(this.state.zeroFootprint);
    } catch {
      // Non-fatal if SW registration fails
    }
  }

  updateOfflineQueuePill() {
    const pill = document.getElementById('offline-queue-pill');
    if (!pill) return;
    const count = this.offlineQueue.count(this.state.zeroFootprint);
    pill.textContent = `QUEUED: ${count}`;
    pill.hidden = count === 0;
  }

  async flushOfflineQueueIfReady(notifyEmpty = false) {
    const count = this.offlineQueue.count(this.state.zeroFootprint);
    if (count === 0) {
      if (notifyEmpty) this.showToast('Offline commit queue is empty.', 'info');
      this.updateOfflineQueuePill();
      return;
    }
    if (navigator.onLine === false) {
      this.showToast(`Device still offline (${count} queued commit(s) waiting).`, 'warn');
      return;
    }
    if (!this.gh.hasToken()) {
      this.showToast('Connect your GitHub PAT to sync queued offline commits.', 'warn');
      return;
    }

    const res = await this.offlineQueue.flush({
      ghClient: this.gh,
      cloakAdapter: this.buildCloakTxAdapter(),
      zeroFootprint: this.state.zeroFootprint,
      onItemSynced: (_tx, commitRes) => {
        if (commitRes?.docs) {
          for (const [dKey, doc] of Object.entries(commitRes.docs)) {
            this.state.dayCache[dKey] = doc;
          }
        }
        if (commitRes?.index) this.state.indexData = commitRes.index;
      },
    });

    this.updateOfflineQueuePill();
    if (res.synced > 0) {
      this.showToast(
        `Synced ${res.synced} queued offline commit(s) to GitHub${
          res.remaining ? ` (${res.remaining} remaining)` : ''
        }.`,
        'success'
      );
      await this.renderActiveView();
    } else if (res.errors.length > 0) {
      this.showToast(`Queue sync paused: ${res.errors[0]}`, 'warn');
    }
  }

  triggerPrintEdition(printFn, payload, label = 'Print edition') {
    try {
      const res = printFn(payload);
      if (!res || !res.ok) {
        this.showToast(
          `No entries available to print for ${label}. Write or load entries first.`,
          'warn'
        );
        return;
      }
      if (res.method === 'download') {
        this.showToast(
          `Print dialog was blocked; downloaded ${label} as an HTML file to open and print.`,
          'warn'
        );
      } else {
        this.showToast(`Preparing ${label} print preview…`, 'info');
      }
    } catch (err) {
      this.showToast(err?.message || `Failed to open ${label} print preview.`, 'error');
    }
  }

  setZeroFootprintMode(enabled, notify = false) {
    const next = Boolean(enabled);
    this.state.zeroFootprint = next;
    this.syncServiceWorkerZeroFootprint(next);

    const badge = document.getElementById('zero-footprint-badge');
    if (badge) badge.hidden = !next;
    const lockCb = document.getElementById('lock-zero-footprint-checkbox');
    if (lockCb) lockCb.checked = next;
    const ghCb = document.getElementById('gh-zero-footprint-checkbox');
    if (ghCb) ghCb.checked = next;

    this.updateOfflineQueuePill();
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
    try {
      const keys = [];
      for (let i = 0; i < window.localStorage.length; i += 1) {
        const k = window.localStorage.key(i);
        if (k && (k.startsWith('perpetual_') || k.startsWith('diary_'))) keys.push(k);
      }
      keys.forEach((k) => window.localStorage.removeItem(k));
    } catch {
      // ignore
    }
    try {
      window.sessionStorage.clear();
    } catch {
      // ignore
    }
    if (navigator.serviceWorker?.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_ALL_CACHES' });
    }
    try {
      await new Promise((resolve) => {
        const req = window.indexedDB.deleteDatabase('PerpetualDiaryMediaDB');
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
      });
    } catch {
      // ignore
    }
    this.offlineQueue.clear(false);
    this.revokeRamMediaUrls();
  }

  hasActiveSessionKey() {
    return Boolean(this.state.keyring?.dek || this.state.keyring?.legacyKey || this.state.cryptoKey);
  }

  hasConfiguredVault() {
    return Boolean(
      this.state.vaultMeta && (this.state.vaultMeta.canary || this.state.vaultMeta.canaryCipher)
    );
  }

  isMetadataCloakingActive() {
    return Boolean(
      this.state.vaultMeta?.metadataCloaking &&
        Number(this.state.vaultMeta?.version) === 2 &&
        this.hasActiveSessionKey()
    );
  }

  isGenericCommitsActive() {
    return Boolean(
      this.state.vaultMeta?.genericCommitMessages ||
        this.state.vaultMeta?.metadataCloaking ||
        this.gh.config.genericCommitMessages
    );
  }

  buildCloakTxAdapter() {
    if (!this.isMetadataCloakingActive()) return null;
    return createCloakAdapter(
      this.state.keyring || this.state.cryptoKey,
      this.isGenericCommitsActive()
    );
  }

  saveGitHubConfigLocally() {
    if (!this.state.zeroFootprint) {
      GitHubClient.saveConfig(this.gh.config, window.localStorage);
    }
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
      const remaining = minutes * 60000 - (Date.now() - this.lastActivityAt);
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
    closeMediaLightbox();
    this.hideContextShortcutMenu();
    if (this.voiceRecorder?.isRecording()) this.voiceRecorder.cancel();

    const clearHtmlIds = [
      'columns-stage', 'comments-list', 'archive-results', 'entry-preview-pane',
      'vault-recovery-code-display', 'conflict-local-diff', 'conflict-remote-diff',
      'history-timeline-list', 'history-diff-viewer', 'history-snapshot-viewer',
      'drafts-list', 'arc-book-stage', 'dossier-stage', 'word-trend-chart', 'word-trend-matches',
    ];
    for (const id of clearHtmlIds) {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '';
    }

    const clearValueIds = [
      'entry-title-input', 'entry-mood-input', 'entry-tags-input', 'entry-body-input',
      'comment-body-input', 'vault-current-password', 'vault-new-password',
      'vault-confirm-password', 'vault-decoy-password', 'vault-decoy-confirm',
      'entry-doublelock-passphrase', 'entry-doublelock-hint', 'gh-token-input',
      'conflict-merged-title', 'conflict-merged-mood', 'conflict-merged-tags', 'conflict-merged-body',
    ];
    for (const id of clearValueIds) {
      const el = document.getElementById(id);
      if (el) el.value = '';
    }

    const modalIds = [
      'composer-modal', 'github-modal', 'vault-modal', 'conflict-modal',
      'history-modal', 'drafts-modal', 'share-modal', 'cmdk-modal', 'confirm-modal',
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

    this.setActiveKeyring(null);
    this.state.recentRecoveryCode = null;
    this.state.activeConflict = null;
    this.state.activeHistory = null;
    this.state.activeCloudDraftDate = null;
    this.state.isDecoySession = false;
    this.state.decoyPolicy = null;
    this.state.doubleLockUnlocked.clear();
    this.state.decryptedEntryCache.clear();
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
        reasonBadge.textContent = 'PANIC LOCK ACTIVATED (CTRL+SHIFT+L) · KEYS & MEDIA WIPED';
        reasonBadge.hidden = false;
      } else if (reason === 'inactivity') {
        reasonBadge.textContent = `AUTO-LOCKED AFTER ${this.getEffectiveAutoLockMinutes()}M OF INACTIVITY`;
        reasonBadge.hidden = false;
      } else {
        reasonBadge.textContent = 'LOCKED · SESSION KEY & DECRYPTED MEDIA WIPED';
        reasonBadge.hidden = false;
      }
    }

    const lockScreen = document.getElementById('lock-screen');
    if (lockScreen) lockScreen.hidden = false;
    this.syncPasskeyLockButton();
    const passInput = document.getElementById('lock-password-input');
    if (passInput) {
      passInput.value = '';
      passInput.focus();
    }
    this.updateModeBadge();
  }

  syncPasskeyLockButton() {
    const btn = document.getElementById('lock-passkey-btn');
    if (btn) btn.hidden = !(isWebAuthnSupported() && hasPasskeySlots(this.state.vaultMeta));
  }

  async init() {
    const savedTheme = getSavedThemePreset(this.state.zeroFootprint);
    applyThemePreset(savedTheme, false, this.state.zeroFootprint);
    const themeSel = document.getElementById('theme-preset-select');
    if (themeSel) themeSel.value = savedTheme;

    this.populateDateSelectors();
    this.initAlignmentStudios();
    this.bindEvents();
    this.registerServiceWorker();
    this.updateOfflineQueuePill();

    if (!this.state.zeroFootprint) {
      try {
        await this.mediaStore.open();
      } catch {
        // IndexedDB fallback handled gracefully
      }
    }

    await this.loadVaultAndIndex();

    const shareParams = parseShareHash(window.location.hash);
    if (shareParams) {
      await this.openSharedEntryViewer(shareParams.shareId, shareParams.keyB64Url);
      this.updateModeBadge();
      return;
    }

    this.applyHashRoute();
    if (this.state.unlocked) {
      await this.renderActiveView();
      this.refreshCloudDraftBadge().catch(() => {});
      this.flushOfflineQueueIfReady(false).catch(() => {});
    }
    this.updateModeBadge();
  }

  populateDateSelectors() {
    const monthSel = document.getElementById('month-select');
    if (monthSel && monthSel.options.length === 0) {
      monthSel.innerHTML = MONTHS.map(
        (name, i) => `<option value="${pad2(i + 1)}">${name}</option>`
      ).join('');
    }
    this.syncDaySelectorOptions(11, 24);
  }

  syncDaySelectorOptions(month, selectedDay) {
    const daySel = document.getElementById('day-select');
    if (!daySel) return;
    const maxD = DAYS_IN_MONTH[month - 1] || 31;
    const clamped = Math.min(maxD, Math.max(1, Number(selectedDay) || 1));
    daySel.innerHTML = Array.from({ length: maxD }, (_, i) => {
      const d = i + 1;
      return `<option value="${pad2(d)}">${d}</option>`;
    }).join('');
    daySel.value = pad2(clamped);
  }

  initAlignmentStudios() {
    this.entryStudio = new AlignmentStudio(document.getElementById('entry-alignment-host'), {
      onChange: (layout) => {
        if (this.state.entryDraftGallery.length > 0) {
          Object.assign(this.state.entryDraftGallery[0], layout);
        }
      },
    });

    this.commentStudio = new AlignmentStudio(document.getElementById('comment-alignment-host'), {
      onChange: (layout) => {
        if (this.state.commentDraftPhoto) {
          Object.assign(this.state.commentDraftPhoto, layout);
        }
      },
    });
  }

  showToast(message, type = 'info') {
    const stack = document.getElementById('toast-container');
    if (!stack) return;
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = message;
    stack.appendChild(el);
    window.setTimeout(() => {
      el.remove();
    }, 4200);
  }

  openConfirm({ title = 'Confirm Action', message = '', confirmLabel = 'Confirm' }) {
    return new Promise((resolve) => {
      this.state.confirmResolver = resolve;
      document.getElementById('confirm-modal-title').textContent = title;
      document.getElementById('confirm-modal-message').textContent = message;
      document.getElementById('confirm-ok-btn').textContent = confirmLabel;
      document.getElementById('confirm-modal').hidden = false;
    });
  }

  closeConfirm(result) {
    const modal = document.getElementById('confirm-modal');
    if (modal) modal.hidden = true;
    if (typeof this.state.confirmResolver === 'function') {
      const fn = this.state.confirmResolver;
      this.state.confirmResolver = null;
      fn(Boolean(result));
    }
  }

  updateModeBadge() {
    const badge = document.getElementById('mode-badge');
    const lockNowBtn = document.getElementById('lock-now-btn');
    if (badge) {
      const target = this.gh.getDataTarget();
      if (navigator.onLine === false) {
        badge.textContent = 'OFFLINE';
        badge.classList.remove('is-live');
      } else if (this.gh.hasToken()) {
        badge.textContent = target.isSplitVault ? 'SPLIT VAULT · LIVE' : 'GITHUB LIVE';
        badge.classList.add('is-live');
      } else if (this.gh.isConfigured()) {
        badge.textContent = target.isSplitVault ? 'SPLIT VAULT · READ' : 'GITHUB READ';
        badge.classList.remove('is-live');
      } else {
        badge.textContent = 'SANDBOX';
        badge.classList.remove('is-live');
      }
    }

    if (lockNowBtn) {
      lockNowBtn.hidden = !this.hasActiveSessionKey() && !this.hasConfiguredVault();
    }
    const cloakBadge = document.getElementById('cloak-mode-badge');
    if (cloakBadge) {
      cloakBadge.hidden = !Boolean(this.state.vaultMeta?.metadataCloaking);
    }
  }

  applyHashRoute() {
    const raw = String(window.location.hash || '').replace(/^#/, '');
    if (!raw || raw === 'today') {
      this.state.activeDay = getTodayDayKey();
      return;
    }
    if (raw === 'compose') {
      this.state.activeDay = getTodayDayKey();
      window.setTimeout(() => this.openComposer({ presetDate: getTodayIsoDate() }), 60);
      return;
    }
    if (raw === 'heatmap') {
      this.switchView('heatmap');
      return;
    }
    if (raw === 'archive') {
      this.switchView('archive');
      return;
    }
    if (raw.startsWith('compare?')) {
      const params = new URLSearchParams(raw.slice('compare?'.length));
      const a = params.get('a');
      const b = params.get('b');
      if (a && b) {
        this.state.compare2Active = true;
        this.state.compareDateA = a;
        this.state.compareDateB = b;
      }
      return;
    }
    if (/^\d{2}-\d{2}$/.test(raw)) {
      const { month, day } = parseDayKey(raw);
      this.state.activeDay = formatDayKey(month, day);
    }
  }

  syncHashRoute() {
    if (this.state.compare2Active) {
      window.history.replaceState(
        null,
        '',
        `#compare?a=${encodeURIComponent(this.state.compareDateA)}&b=${encodeURIComponent(
          this.state.compareDateB
        )}`
      );
    } else {
      window.history.replaceState(null, '', `#${this.state.activeDay}`);
    }
  }

  async loadVaultAndIndex() {
    let vaultMeta = null;
    if (this.gh.hasToken() || this.gh.isConfigured()) {
      vaultMeta = await this.gh.readJson('vault.json', null);
    }
    if (!vaultMeta) {
      const localVaultRaw = this.storageGet('perpetual_diary_vault_local_v1');
      if (localVaultRaw) {
        try {
          vaultMeta = JSON.parse(localVaultRaw);
        } catch {
          vaultMeta = null;
        }
      }
    }

    this.state.vaultMeta = vaultMeta;
    if (vaultMeta?.genericCommitMessages || vaultMeta?.metadataCloaking) {
      this.gh.updateConfig({ genericCommitMessages: true });
    }
    if (Number.isFinite(Number(vaultMeta?.autoLockMinutes))) {
      this.state.autoLockMinutes = Number(vaultMeta.autoLockMinutes);
      this.storageSet(AUTOLOCK_STORAGE_KEY, String(this.state.autoLockMinutes));
    }

    if (vaultMeta && vaultMeta.enabled && !this.hasActiveSessionKey()) {
      this.state.unlocked = false;
      const lockScreen = document.getElementById('lock-screen');
      if (lockScreen) lockScreen.hidden = false;
      this.syncPasskeyLockButton();
      if (vaultMeta.metadataCloaking) {
        this.state.indexData = { version: 1, updatedAt: '', days: {} };
        return;
      }
    } else {
      this.state.unlocked = true;
      const lockScreen = document.getElementById('lock-screen');
      if (lockScreen) lockScreen.hidden = true;
    }

    await this.loadManifestIndex();
  }

  async persistVaultMeta(nextVaultMeta, commitMessage = 'diary: update vault metadata') {
    this.state.vaultMeta = nextVaultMeta;
    this.storageSet('perpetual_diary_vault_local_v1', JSON.stringify(nextVaultMeta));
    if (this.gh.hasToken()) {
      await this.gh.putJson('vault.json', nextVaultMeta, commitMessage);
    }
  }

  async loadManifestIndex() {
    if (this.gh.hasToken() || this.gh.isConfigured()) {
      if (this.isMetadataCloakingActive()) {
        try {
          const encMeta = await this.gh.getFileMeta('index.enc');
          if (encMeta.exists && encMeta.content) {
            const decIndex = await decryptManifestIndex(
              encMeta.content,
              this.state.keyring || this.state.cryptoKey
            );
            if (decIndex && decIndex.days) {
              this.state.indexData = decIndex;
              return;
            }
          }
        } catch {
          // fall back to index.json if not yet migrated
        }
      }

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
      if (this.isMetadataCloakingActive()) {
        try {
          const shardSubpath = await computeDayShardSubpath(
            dayStr,
            this.state.keyring || this.state.cryptoKey
          );
          const shardMeta = await this.gh.getFileMeta(shardSubpath);
          if (shardMeta.exists && shardMeta.content) {
            if (shardMeta.sha) this.state.dayShas[dayStr] = shardMeta.sha;
            const unsealed = await unsealDayDocument(
              dayStr,
              shardMeta.content,
              this.state.keyring || this.state.cryptoKey
            );
            if (unsealed && typeof unsealed === 'object') {
              const normalized = {
                day: dayStr,
                entries: unsealed.entries || {},
                comments: Array.isArray(unsealed.comments) ? unsealed.comments : [],
              };
              this.state.dayCache[dayStr] = normalized;
              return normalized;
            }
          }
        } catch (err) {
          this.showToast(`Cloaked shard read warning (${dayStr}): ${err.message}`, 'warn');
        }
      }

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

    if (this.state.zeroFootprint) {
      if (!this.state.sandboxRamDays) {
        this.state.sandboxRamDays = JSON.parse(JSON.stringify(SANDBOX_SEED_DAYS));
      }
      const ramDoc = this.state.sandboxRamDays[dayStr] || { day: dayStr, entries: {}, comments: [] };
      this.state.dayCache[dayStr] = ramDoc;
      return ramDoc;
    }

    const rawDay = this.storageGet(`perpetual_diary_day_${dayStr}`);
    if (rawDay) {
      try {
        const parsed = JSON.parse(rawDay);
        this.state.dayCache[dayStr] = parsed;
        return parsed;
      } catch {
        // fall back
      }
    }

    if (SANDBOX_SEED_DAYS[dayStr]) {
      const seeded = JSON.parse(JSON.stringify(SANDBOX_SEED_DAYS[dayStr]));
      this.state.dayCache[dayStr] = seeded;
      this.storageSet(`perpetual_diary_day_${dayStr}`, JSON.stringify(seeded));
      return seeded;
    }

    const emptyLocal = { day: dayStr, entries: {}, comments: [] };
    this.state.dayCache[dayStr] = emptyLocal;
    return emptyLocal;
  }

  async persistSandboxDay(dayStr, dayDoc) {
    this.state.dayCache[dayStr] = dayDoc;
    const nextIdx = recalculateIndexForDay(this.state.indexData, dayStr, dayDoc);
    this.state.indexData = nextIdx;

    if (this.state.zeroFootprint) {
      if (!this.state.sandboxRamDays) {
        this.state.sandboxRamDays = JSON.parse(JSON.stringify(SANDBOX_SEED_DAYS));
      }
      this.state.sandboxRamDays[dayStr] = dayDoc;
      return;
    }

    this.storageSet(`perpetual_diary_day_${dayStr}`, JSON.stringify(dayDoc));
    this.storageSet('perpetual_diary_sandbox_index_v1', JSON.stringify(nextIdx));
  }

  async persistDayDocument(dayStr, nextDoc, commitMessage) {
    const normalized = {
      day: dayStr,
      entries: nextDoc.entries || {},
      comments: Array.isArray(nextDoc.comments) ? nextDoc.comments : [],
    };

    if (this.gh.hasToken()) {
      const res = await this.gh.updateDayAndIndex(
        dayStr,
        normalized,
        commitMessage,
        this.buildCloakTxAdapter()
      );
      this.state.dayCache[dayStr] = normalized;
      if (res.daySha) this.state.dayShas[dayStr] = res.daySha;
      this.state.indexData = res.index;
      return { doc: normalized, commitSha: res.commitSha };
    }

    await this.persistSandboxDay(dayStr, normalized);
    recordSandboxRevision(dayStr, normalized, commitMessage, this.state.zeroFootprint);
    return { doc: normalized, commitSha: '' };
  }

  async decryptFieldDetailed(value, encryptedFlag, aad = '') {
    if (!value) return { status: 'ok', text: '', version: 0 };
    if (!encryptedFlag && !isEncryptedPayload(value)) {
      return { status: 'ok', text: String(value), version: 0 };
    }
    const ver = getPayloadVersion(value);
    if (!this.hasActiveSessionKey()) {
      return { status: 'locked', text: null, version: ver };
    }
    try {
      const plain = await decryptText(value, this.state.keyring || this.state.cryptoKey, aad);
      return { status: 'ok', text: plain, version: ver };
    } catch (err) {
      return {
        status: err?.isTamperSuspected || err?.code === 'AAD_TAMPER_ERROR' ? 'tampered' : 'locked',
        text: null,
        version: ver,
        error: err.message,
      };
    }
  }

  async decryptFieldIfNeeded(value, encryptedFlag, aad = '') {
    const res = await this.decryptFieldDetailed(value, encryptedFlag, aad);
    return res.status === 'ok' ? res.text : null;
  }

  switchView(viewName) {
    document.querySelectorAll('.nav-tab').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.view === viewName);
    });
    document.querySelectorAll('.view-section').forEach((sec) => {
      sec.classList.toggle('is-active', sec.id === `view-${viewName}`);
    });
    this.renderActiveView();
  }

  async renderActiveView() {
    if (!this.state.unlocked) return;
    const activeTab = document.querySelector('.nav-tab.is-active')?.dataset.view || 'reader';
    if (activeTab === 'heatmap') {
      this.renderHeatmap();
    } else if (activeTab === 'archive') {
      await this.renderArchive();
    } else if (activeTab === 'analytics') {
      await this.renderAnalyticsAndArcs();
    } else {
      await this.renderReader();
    }
  }

  renderWindowRibbon() {
    const panel = document.getElementById('window-ribbon-panel');
    const titleEl = document.getElementById('window-ribbon-title');
    const metaEl = document.getElementById('window-ribbon-meta');
    const cardsEl = document.getElementById('window-ribbon-cards');
    if (!panel || !cardsEl) return;

    if (this.state.windowScope === 'day' || this.state.compare2Active) {
      panel.hidden = true;
      return;
    }

    panel.hidden = false;
    let dayKeys = [];
    if (this.state.windowScope === 'week') {
      dayKeys = getCalendarDaysWindow(this.state.activeDay, 3);
      titleEl.textContent = `ON THIS WEEK ACROSS YEARS (±3 DAYS AROUND ${formatReadableDayKey(
        this.state.activeDay
      ).toUpperCase()})`;
    } else {
      const season = getSeasonForDay(this.state.activeDay);
      dayKeys = getSeasonDayKeys(season.id);
      titleEl.textContent = `${season.glyph} ${season.label.toUpperCase()} ACROSS YEARS`;
    }

    const activeWindowDays = collectIndexedWindowEntries(this.state.indexData, dayKeys);
    metaEl.textContent = `${activeWindowDays.length} recorded date(s)`;

    if (activeWindowDays.length === 0) {
      cardsEl.innerHTML =
        '<span class="mono-meta">No entries recorded in this calendar window yet.</span>';
      return;
    }

    cardsEl.innerHTML = activeWindowDays
      .map(
        (d) => `
        <button type="button" class="window-day-pill${
          d.dayStr === this.state.activeDay ? ' is-current' : ''
        }" data-win-day="${escapeHtml(d.dayStr)}">
          <strong>${escapeHtml(d.readableDay)}</strong>
          <span class="mono-meta">${escapeHtml(d.years.join(', '))}</span>
        </button>
      `
      )
      .join('');

    cardsEl.querySelectorAll('.window-day-pill').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.state.activeDay = btn.dataset.winDay;
        this.renderReader();
      });
    });
  }

  async renderReader() {
    if (!this.state.unlocked) return;
    const { month, day } = parseDayKey(this.state.activeDay);
    const monthSel = document.getElementById('month-select');
    if (monthSel) monthSel.value = pad2(month);
    this.syncDaySelectorOptions(month, day);

    document.getElementById('active-date-title').textContent = formatReadableDayKey(
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

    this.renderWindowRibbon();

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
      const list = getYearEntriesList(doc.entries?.[yrStr], yrStr, dayKey);
      const entriesForCol =
        list.length > 0
          ? list
          : [
              {
                id: `empty-${item.iso}`,
                year: Number(yrStr) || 2026,
                diaryDate: item.iso,
                title: `${item.label} (${item.iso})`,
                body: '_No entry recorded on this exact date._',
                tags: [],
                mood: '',
                images: [],
                image: null,
                encrypted: false,
              },
            ];
      const card = await this.buildYearColumnCard(entriesForCol, dayKey, yrStr);
      if (card) stage.appendChild(card);
    }
  }

  async renderDayColumns(stage, dayStr) {
    const doc = await this.getDayDocument(dayStr);
    const entriesMap = doc.entries || {};
    let years = Object.keys(entriesMap)
      .map((y) => Number(y))
      .filter((n) => Number.isFinite(n) && getYearEntriesList(entriesMap[String(n)], n, dayStr).length > 0);

    years.sort((a, b) => (this.state.sortOrder === 'asc' ? a - b : b - a));
    if (this.state.pinnedYear && years.includes(Number(this.state.pinnedYear))) {
      const pinNum = Number(this.state.pinnedYear);
      years = [pinNum, ...years.filter((y) => y !== pinNum)];
    }

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
    let visibleYearCount = 0;

    for (const yr of years) {
      const yrKey = String(yr);
      const yearEntries = getYearEntriesList(entriesMap[yrKey], yr, dayStr);
      const card = await this.buildYearColumnCard(yearEntries, dayStr, yrKey);
      if (!card) continue;
      visibleYearCount += 1;
      if (
        this.state.mobileMode === 'tabs' &&
        Number(this.state.mobileSelectedYear) !== Number(yr)
      ) {
        card.classList.add('mobile-tab-hidden');
      }
      stage.appendChild(card);
    }

    document.getElementById('recorded-years-count').textContent =
      `${visibleYearCount} ${visibleYearCount === 1 ? 'YEAR' : 'YEARS'}`;

    const addCard = document.createElement('article');
    addCard.className = 'year-column add-year-card';
    const defaultNewYear = new Date().getFullYear();
    addCard.innerHTML = `
      <div class="add-year-inner">
        <div class="mono-label">+ ADD RETROACTIVE YEAR</div>
        <p class="section-subtext">Transcribe or backdate an entry for ${escapeHtml(
          formatReadableDayKey(dayStr)
        )}.</p>
        <div class="add-year-controls">
          <input type="number" class="input-text input-year" min="1900" max="2100" value="${defaultNewYear}" aria-label="Target Year" />
          <button type="button" class="btn btn-primary btn-sm add-year-go-btn">Open Composer</button>
        </div>
      </div>
    `;
    addCard.querySelector('.add-year-go-btn').addEventListener('click', () => {
      const yrVal = Number(addCard.querySelector('.input-year').value) || defaultNewYear;
      const { month, day } = parseDayKey(dayStr);
      this.openComposer({ presetDate: `${yrVal}-${pad2(month)}-${pad2(day)}` });
    });
    stage.appendChild(addCard);
  }

  async buildYearColumnCard(yearEntries, dayStr, yearKey) {
    const col = document.createElement('article');
    const yearNum = Number(yearKey);
    const isPinned = Number(this.state.pinnedYear) === yearNum;
    col.className = `year-column${isPinned ? ' is-pinned' : ''}`;
    const expectedDate = `${yearKey}-${dayStr}`;
    col.dataset.year = String(yearKey);
    col.dataset.diaryDate = expectedDate;

    const renderedItems = [];
    for (let idx = 0; idx < yearEntries.length; idx += 1) {
      const itemEl = await this.buildStackedEntryItem(
        yearEntries[idx],
        dayStr,
        yearKey,
        idx,
        yearEntries.length
      );
      if (itemEl) renderedItems.push(itemEl);
    }

    if (renderedItems.length === 0) {
      return null;
    }

    const multiBadge =
      renderedItems.length > 1
        ? `<span class="year-entry-count-pill">${renderedItems.length} ENTRIES</span>`
        : '';

    col.innerHTML = `
      <header class="year-col-header">
        <div class="year-col-title-row">
          <span class="year-heading">${escapeHtml(String(yearKey))}</span>
          ${multiBadge}
        </div>
        <div class="year-col-actions">
          <button type="button" class="btn btn-ghost btn-sm col-history-btn" title="Git Revision Time Machine">⏱ History</button>
          <button type="button" class="btn btn-ghost btn-sm col-pin-btn ${isPinned ? 'is-pinned' : ''}">${
      isPinned ? 'Pinned' : 'Pin'
    }</button>
        </div>
      </header>
      <div class="year-entries-stack${renderedItems.length > 1 ? ' is-multi' : ''}"></div>
      <div class="year-col-add-entry-bar">
        <button type="button" class="btn btn-ghost btn-sm col-add-another-btn">+ Add Another ${escapeHtml(
          String(yearKey)
        )} Entry</button>
      </div>
    `;

    const stackEl = col.querySelector('.year-entries-stack');
    for (const itemEl of renderedItems) {
      stackEl.appendChild(itemEl);
    }

    col.querySelector('.col-pin-btn')?.addEventListener('click', () => {
      this.state.pinnedYear =
        Number(this.state.pinnedYear) === yearNum ? null : yearNum;
      this.renderReader();
    });

    col.querySelector('.col-history-btn')?.addEventListener('click', () => {
      const firstCached = Array.from(this.state.decryptedEntryCache.values()).find(
        (e) => e.dayStr === dayStr && Number(e.year) === yearNum
      );
      this.openHistoryModal(dayStr, yearKey, firstCached || {
        diaryDate: expectedDate,
        title: '',
        body: '',
        mood: '',
        tags: [],
      });
    });

    col.querySelector('.col-add-another-btn')?.addEventListener('click', () => {
      this.openComposer({ presetDate: expectedDate });
    });

    return col;
  }

  async buildStackedEntryItem(entry, dayStr, yearKey, indexInYear, totalInYear) {
    const item = document.createElement('div');
    item.className = 'stacked-entry-item';
    const expectedDate = `${yearKey}-${dayStr}`;
    const resolvedDate = entry.diaryDate || expectedDate;
    const entryId = entry.id || `ent-${yearKey}-${indexInYear + 1}`;
    item.dataset.entryId = entryId;
    item.dataset.year = String(yearKey);
    item.dataset.diaryDate = resolvedDate;

    const backdatedDays = diffCalendarDays(entry.diaryDate, entry.writtenAt);
    const backdateBadge =
      backdatedDays > 0 ? `<span class="badge-backdated">BACKDATED +${backdatedDays}d</span>` : '';

    const bodyAad = buildEntryAad(expectedDate, yearKey, 'body');
    const titleAad = buildEntryAad(expectedDate, yearKey, 'title');

    const bodyResult = await this.decryptFieldDetailed(entry.body, Boolean(entry.encrypted), bodyAad);
    const titleResult = await this.decryptFieldDetailed(
      entry.title || '',
      Boolean(entry.encrypted),
      titleAad
    );

    if (this.state.isDecoySession) {
      const isPlainEntry = !entry.encrypted && !isEncryptedPayload(entry.body);
      if (isPlainEntry && this.state.decoyPolicy && !this.state.decoyPolicy.includePlaintext) {
        return null;
      }
      if (!isPlainEntry && bodyResult.status !== 'ok') {
        return null;
      }
    }

    const isTampered = bodyResult.status === 'tampered' || titleResult.status === 'tampered';
    const isLockedEntry = !isTampered && bodyResult.status === 'locked';
    let decryptedBody = bodyResult.text;
    let decryptedTitle = titleResult.text;

    const dlSlotKey = `${dayStr}:${yearKey}:${entryId}`;
    const isDoubleLocked =
      !isTampered &&
      !isLockedEntry &&
      (isDoubleLockedPayload(decryptedBody) || Boolean(entry.doubleLocked));
    const dlRamCache = isDoubleLocked ? this.state.doubleLockUnlocked.get(dlSlotKey) : null;
    const isDoubleLockSealed = isDoubleLocked && !dlRamCache;

    if (isDoubleLocked && dlRamCache) {
      decryptedBody = dlRamCache.body;
      decryptedTitle = dlRamCache.title;
    }

    const capsuleStatus = getTimeCapsuleStatus(entry);
    const isCapsuleSealed =
      !isTampered && !isLockedEntry && !isDoubleLockSealed && capsuleStatus.isSealed;

    if (!isTampered && !isLockedEntry && !isDoubleLockSealed) {
      this.state.decryptedEntryCache.set(`${resolvedDate}::${entryId}`, {
        id: entryId,
        diaryDate: resolvedDate,
        dayStr,
        year: Number(entry.year || yearKey),
        title: decryptedTitle || '',
        body: decryptedBody || '',
        mood: entry.mood || '',
        tags: Array.isArray(entry.tags) ? entry.tags : [],
        location: entry.location || '',
        weather: entry.weather || '',
        artifacts: entry.artifacts || null,
        metrics: entry.metrics || null,
        preserveWhitespace: Boolean(entry.preserveWhitespace),
        writtenAt: entry.writtenAt || '',
      });
    }

    let bodyHtml = '';
    let plainWords = 0;

    if (isTampered) {
      bodyHtml = `
        <div class="tamper-alert-card" role="alert">
          <div class="mono-label">⚠ CRYPTOGRAPHIC INTEGRITY ALERT · AAD MISMATCH</div>
          <p>Decryption rejected because AES-GCM AAD does not match <code>${escapeHtml(
            expectedDate
          )}</code>.</p>
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
    } else if (isDoubleLockSealed) {
      const hintLine = entry.doubleLockHint
        ? `<div class="mono-meta">Hint: ${escapeHtml(entry.doubleLockHint)}</div>`
        : '';
      bodyHtml = `
        <div class="doublelock-sealed-card">
          <div class="mono-label">⚿ DOUBLE-LOCKED ENTRY · 2ND PASSPHRASE REQUIRED</div>
          <p class="section-subtext">This entry remains sealed even while your diary is unlocked.</p>
          ${hintLine}
          <form class="dl-unlock-form" autocomplete="off">
            <input type="password" class="input-text input-sm dl-pass-input" placeholder="Enter 2nd passphrase" required />
            <button type="submit" class="btn btn-primary btn-sm">Unseal</button>
          </form>
          <div class="form-error dl-error" role="alert" hidden></div>
        </div>
      `;
    } else if (isCapsuleSealed) {
      bodyHtml = `
        <div class="capsule-sealed-card">
          <div class="mono-label">⏳ TIME CAPSULE SEALED UNTIL ${escapeHtml(
            capsuleStatus.sealedUntil
          )}</div>
          <p class="section-subtext">Opens automatically in <strong>${
            capsuleStatus.daysRemaining
          } day(s)</strong>.</p>
        </div>
      `;
    } else {
      bodyHtml = renderMarkdown(decryptedBody, {
        preserveWhitespace: Boolean(entry.preserveWhitespace),
        scopeId: `${dayStr}-${yearKey}-${indexInYear}`,
      });
      plainWords = countWords(stripMarkdown(decryptedBody));
    }

    let mediaHtml = '';
    const resolvedLightboxItems = [];

    if (!isLockedEntry && !isTampered && !isDoubleLockSealed && !isCapsuleSealed) {
      const galleryImages = normalizeEntryImages(entry);
      if (galleryImages.length > 0) {
        const primary = galleryImages[0];
        const primaryAsset = await this.resolveMediaAssetSafe(primary.src);

        if (primaryAsset.status === 'locked') {
          mediaHtml += `
            <div class="encrypted-media-card">
              <div class="mono-label">🔒 ENCRYPTED PHOTO VAULT (.ENC)</div>
              <p class="section-subtext">Unlock your Vault to decrypt this image in RAM.</p>
            </div>
          `;
        } else if (primaryAsset.status === 'tampered') {
          mediaHtml += `
            <div class="tamper-alert-card" role="alert">
              <div class="mono-label">⚠ PHOTO INTEGRITY ALERT · AAD MISMATCH</div>
            </div>
          `;
        } else if (primaryAsset.status === 'ok' && primaryAsset.url) {
          resolvedLightboxItems.push({
            url: primaryAsset.url,
            caption: primary.caption || '',
            diaryDate: resolvedDate,
            encrypted: primaryAsset.encrypted,
            kind: primary.kind,
          });

          const align = primary.align || 'full';
          const widthStyle = align === 'full' ? 'width:100%;' : `width:${primary.width || 52}%;`;
          const heightPx = primary.height || 240;
          const posX = primary.posX ?? 50;
          const posY = primary.posY ?? 50;

          mediaHtml += `
            <figure class="entry-figure align-${escapeHtml(align)}" style="${widthStyle}">
              <div class="entry-figure-frame" style="height:${heightPx}px;">
                <img
                  src="${escapeHtml(primaryAsset.url)}"
                  alt="${escapeHtml(primary.caption || `Photo from ${resolvedDate}`)}"
                  data-lb-open="0"
                  style="object-position:${posX}% ${posY}%;"
                />
                ${primaryAsset.encrypted ? '<span class="media-enc-badge">🔒 .ENC</span>' : ''}
                ${primary.originalRef ? '<span class="media-orig-badge">ORIG OFFLINE</span>' : ''}
                <button type="button" class="btn btn-ghost btn-sm inline-realign-btn">⇄ Align</button>
              </div>
              ${primary.caption ? `<figcaption class="figure-caption">${escapeHtml(primary.caption)}</figcaption>` : ''}
            </figure>
          `;
        }

        if (galleryImages.length > 1) {
          const thumbBtns = [];
          for (let gIdx = 1; gIdx < galleryImages.length; gIdx += 1) {
            const gItem = galleryImages[gIdx];
            const gAsset = await this.resolveMediaAssetSafe(gItem.src);
            if (gAsset.status === 'ok' && gAsset.url) {
              const lbIdx = resolvedLightboxItems.length;
              resolvedLightboxItems.push({
                url: gAsset.url,
                caption: gItem.caption || '',
                diaryDate: resolvedDate,
                encrypted: gAsset.encrypted,
                kind: gItem.kind,
              });
              thumbBtns.push(
                `<button type="button" class="gallery-thumb-btn" data-lb-open="${lbIdx}" title="Open photo ${
                  lbIdx + 1
                }"><img src="${escapeHtml(gAsset.url)}" alt="${escapeHtml(
                  gItem.caption || ''
                )}" /></button>`
              );
            }
          }
          if (thumbBtns.length > 0) {
            mediaHtml += `<div class="entry-gallery-strip">${thumbBtns.join('')}</div>`;
          }
        }
      }

      if (entry.audio && entry.audio.src) {
        const audioAsset = await this.resolveMediaAssetSafe(entry.audio.src);
        if (audioAsset.status === 'ok' && audioAsset.url) {
          mediaHtml += `
            <div class="voice-note-card">
              <span class="mono-label">🎙 VOICE NOTE (${formatDurationSec(
                entry.audio.durationSec || 0
              )})${audioAsset.encrypted ? ' · 🔒 .ENC' : ''}</span>
              <audio controls preload="metadata" src="${escapeHtml(audioAsset.url)}"></audio>
            </div>
          `;
        } else if (audioAsset.status === 'locked') {
          mediaHtml += `<div class="encrypted-media-card"><span class="mono-label">🔒 ENCRYPTED VOICE NOTE (.ENC)</span></div>`;
        }
      }
    }

    const chips = [];
    if (entry.mood) chips.push(`<span class="mood-chip">mood: ${escapeHtml(entry.mood)}</span>`);
    if (entry.location) chips.push(`<span class="stamp-chip">◎ ${escapeHtml(entry.location)}</span>`);
    if (entry.weather) chips.push(`<span class="stamp-chip">${escapeHtml(entry.weather)}</span>`);
    if (capsuleStatus.isNewlyUnlocked) {
      chips.push(`<span class="capsule-badge">⏳ UNSEALED ${escapeHtml(capsuleStatus.sealedUntil)}</span>`);
    }
    if (entry.metrics && typeof entry.metrics === 'object') {
      for (const [mKey, mVal] of Object.entries(entry.metrics)) {
        if (Number(mVal) > 0) {
          chips.push(`<span class="metric-chip">${escapeHtml(mKey)}: ${Number(mVal)}/5</span>`);
        }
      }
    }
    if (Array.isArray(entry.tags)) {
      for (const t of entry.tags) {
        const isArc = String(t || '').toLowerCase().startsWith('arc:');
        chips.push(
          `<span class="tag-chip${isArc ? ' is-arc' : ''}"${
            isArc ? ` data-arc-slug="${escapeHtml(t.slice(4).trim())}" title="Open Story Arc Book View"` : ''
          }>#${escapeHtml(t)}</span>`
        );
      }
    }
    const metaChipsHtml = chips.length ? `<div class="entry-meta-chips">${chips.join('')}</div>` : '';

    let artifactsHtml = '';
    if (!isLockedEntry && !isTampered && !isDoubleLockSealed && !isCapsuleSealed && entry.artifacts) {
      const items = ARTIFACT_FIELDS.filter((f) => entry.artifacts[f.key]).map(
        (f) =>
          `<span class="artifact-item">${f.icon} <strong>${escapeHtml(
            f.label
          )}:</strong> ${escapeHtml(entry.artifacts[f.key])}</span>`
      );
      if (items.length > 0) {
        artifactsHtml = `<div class="artifacts-strip">${items.join('')}</div>`;
      }
    }

    let backlinksHtml = '';
    if (!isLockedEntry && !isTampered && !isDoubleLockSealed && !isCapsuleSealed) {
      const backlinks = computeBacklinksForDate(
        dayStr,
        yearKey,
        Array.from(this.state.decryptedEntryCache.values()),
        entryId
      );
      if (backlinks.length > 0) {
        backlinksHtml = `
          <div class="backlinks-box">
            <div class="mono-label">↔ REFERENCED BY (${backlinks.length})</div>
            <div class="backlinks-list">
              ${backlinks
                .map(
                  (bl) => `
                  <button type="button" class="backlink-item" data-jump-day="${escapeHtml(
                    bl.sourceDayStr
                  )}">
                    <span class="mono-meta">${escapeHtml(bl.sourceDate)} · ${escapeHtml(
                    bl.sourceTitle
                  )}</span>
                    <span class="backlink-snippet">${escapeHtml(bl.snippet)}</span>
                  </button>
                `
                )
                .join('')}
            </div>
          </div>
        `;
      }
    }

    const timeLabel = entry.writtenAt
      ? new Date(entry.writtenAt).toLocaleTimeString(undefined, {
          hour: '2-digit',
          minute: '2-digit',
        })
      : '';
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
    const dlBadge = isDoubleLocked ? ' · <span class="dl-status-tag">⚿ DOUBLE-LOCK</span>' : '';
    const disabledAttr =
      isTampered || isLockedEntry || isDoubleLockSealed || isCapsuleSealed ? 'disabled' : '';

    const stackCounterPill =
      totalInYear > 1
        ? `<span class="stacked-entry-index">#${indexInYear + 1} of ${totalInYear}${
            timeLabel ? ` · ${escapeHtml(timeLabel)}` : ''
          }</span>`
        : '';

    item.innerHTML = `
      <div class="stacked-entry-top">
        <div class="stacked-entry-date mono-meta">
          ${stackCounterPill}
          <span>${escapeHtml(resolvedDate)}${encBadge}${dlBadge}</span>
          ${backdateBadge}
        </div>
        <div class="stacked-entry-actions">
          ${
            isDoubleLocked && dlRamCache
              ? '<button type="button" class="btn btn-ghost btn-xs col-reseal-btn">⚿ Re-Seal</button>'
              : ''
          }
          <button type="button" class="btn btn-ghost btn-xs col-share-btn" ${disabledAttr}>↗ Share</button>
          <button type="button" class="btn btn-ghost btn-xs col-quote-btn" ${disabledAttr}>❝ Quote</button>
          <button type="button" class="btn btn-ghost btn-xs col-edit-btn" ${
            isTampered || isDoubleLockSealed ? 'disabled' : ''
          }>Edit</button>
          <button type="button" class="btn btn-ghost btn-xs col-delete-btn">Delete</button>
        </div>
      </div>
      ${
        !isLockedEntry && !isTampered && !isDoubleLockSealed && !isCapsuleSealed && decryptedTitle
          ? `<h3 class="entry-title">${escapeHtml(decryptedTitle)}</h3>`
          : ''
      }
      ${metaChipsHtml}
      ${artifactsHtml}
      <div class="entry-prose-wrap">
        ${mediaHtml}
        <div class="prose-body">${bodyHtml}</div>
      </div>
      ${backlinksHtml}
      <footer class="year-col-footer mono-meta">
        <span>${
          isTampered
            ? 'Integrity Failed'
            : isCapsuleSealed
              ? `Sealed until ${capsuleStatus.sealedUntil}`
              : isDoubleLockSealed
                ? 'Double-Locked'
                : isLockedEntry
                  ? 'Encrypted'
                  : `${plainWords} words`
        }</span>
        <span>${escapeHtml(loggedLabel)}</span>
      </footer>
    `;

    item.querySelectorAll('[data-lb-open]').forEach((el) => {
      el.addEventListener('click', () => {
        openMediaLightbox(resolvedLightboxItems, Number(el.dataset.lbOpen) || 0);
      });
    });

    item.querySelectorAll('.tag-chip.is-arc').forEach((chipEl) => {
      chipEl.addEventListener('click', () => {
        this.state.selectedArcSlug = chipEl.dataset.arcSlug || '';
        this.switchView('analytics');
      });
    });

    item.querySelectorAll('.backlink-item').forEach((blBtn) => {
      blBtn.addEventListener('click', () => {
        const targetDay = blBtn.dataset.jumpDay;
        if (targetDay) {
          this.state.activeDay = targetDay;
          this.state.compare2Active = false;
          this.renderReader();
        }
      });
    });

    const dlForm = item.querySelector('.dl-unlock-form');
    if (dlForm) {
      dlForm.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const passInput = dlForm.querySelector('.dl-pass-input');
        const errEl = item.querySelector('.dl-error');
        errEl.hidden = true;
        try {
          const secondPass = passInput.value;
          const plainBody = await decryptDoubleLockedText(
            bodyResult.text,
            secondPass,
            buildDoubleLockAad(expectedDate, yearKey, 'body')
          );
          const plainTitle =
            titleResult.text && isDoubleLockedPayload(titleResult.text)
              ? await decryptDoubleLockedText(
                  titleResult.text,
                  secondPass,
                  buildDoubleLockAad(expectedDate, yearKey, 'title')
                )
              : titleResult.text || '';
          this.state.doubleLockUnlocked.set(dlSlotKey, {
            body: plainBody,
            title: plainTitle,
            passphrase: secondPass,
          });
          passInput.value = '';
          this.showToast(`Unsealed Double-Locked entry (${resolvedDate}) in RAM.`, 'success');
          await this.renderReader();
        } catch (err) {
          errEl.textContent = err.message || 'Incorrect Double-Lock passphrase.';
          errEl.hidden = false;
        }
      });
    }

    item.querySelector('.col-reseal-btn')?.addEventListener('click', () => {
      this.state.doubleLockUnlocked.delete(dlSlotKey);
      this.showToast(`Re-sealed Double-Locked entry (${resolvedDate}).`, 'info');
      this.renderReader();
    });

    item.querySelector('.unlock-inline-btn')?.addEventListener('click', () => {
      document.getElementById('lock-screen').hidden = false;
      document.getElementById('lock-password-input').focus();
    });

    item.querySelector('.col-quote-btn')?.addEventListener('click', () => {
      const selText = window.getSelection()?.toString().trim();
      this.attachQuoteToComment({
        text: selText || extractDefaultQuote(decryptedBody || ''),
        year: Number(yearKey),
        diaryDate: resolvedDate,
      });
    });

    item.querySelector('.col-share-btn')?.addEventListener('click', () => {
      this.openShareComposerModal({
        diaryDate: resolvedDate,
        year: Number(yearKey),
        title: decryptedTitle || '',
        body: decryptedBody || '',
        mood: entry.mood || '',
        tags: Array.isArray(entry.tags) ? entry.tags : [],
      });
    });

    item.querySelector('.col-edit-btn')?.addEventListener('click', () => {
      this.openComposer({
        editEntry: {
          ...entry,
          id: entryId,
          body: decryptedBody ?? entry.body,
          title: decryptedTitle ?? entry.title,
          _unlockedDoubleLockPassphrase: dlRamCache?.passphrase || '',
        },
        dayStr,
        yearKey,
      });
    });

    item.querySelector('.col-delete-btn')?.addEventListener('click', () => {
      this.handleDeleteEntry(dayStr, yearKey, { ...entry, id: entryId });
    });

    const realignBtn = item.querySelector('.inline-realign-btn');
    const primaryImg = normalizeEntryImages(entry)[0];
    if (realignBtn && primaryImg) {
      realignBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (this.state.inlineAlignCleanup) this.state.inlineAlignCleanup();
        const figureEl = item.querySelector('.entry-figure');
        this.state.inlineAlignCleanup = attachInlineAlignController(
          figureEl,
          primaryImg,
          async (updatedLayout) => {
            const latestDoc = await this.getDayDocument(dayStr, true);
            const list = getYearEntriesList(latestDoc.entries?.[yearKey], yearKey, dayStr);
            const targetEntry = list.find((e) => e.id === entryId) || list[0];
            if (targetEntry) {
              const imgs = normalizeEntryImages(targetEntry);
              if (imgs[0]) Object.assign(imgs[0], updatedLayout);
              targetEntry.images = imgs;
              targetEntry.image = imgs[0] || null;
              targetEntry.updatedAt = new Date().toISOString();
              latestDoc.entries[yearKey] = list.length === 1 ? list[0] : list;
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

    return item;
  }

  hideContextShortcutMenu() {
    const menu = document.getElementById('context-shortcut-menu');
    if (menu) {
      menu.hidden = true;
      menu.innerHTML = '';
    }
  }

  showContextShortcutMenu(clientX, clientY, targetEl) {
    if (!this.state.unlocked) return;
    const menu = document.getElementById('context-shortcut-menu');
    if (!menu) return;

    const selectedText = window.getSelection()?.toString().trim() || '';
    const stackedCard = targetEl?.closest?.('.stacked-entry-item');
    const yearCol = targetEl?.closest?.('.year-column');
    const hmCell = targetEl?.closest?.('.hm-cell');

    const items = [];
    let headerLabel = `SHORTCUTS · ${formatReadableDayKey(this.state.activeDay)}`;

    if (selectedText.length > 0) {
      headerLabel = `SELECTION (${selectedText.length} CHARS)`;
      if (yearCol) {
        items.push({
          label: '❝ Quote Selection in Margin Note',
          run: () =>
            this.attachQuoteToComment({
              text: selectedText,
              year: Number(yearCol.dataset.year),
              diaryDate: stackedCard?.dataset.diaryDate || yearCol.dataset.diaryDate,
            }),
        });
      }
      items.push({
        label: '⌕ Track Phrase in Word Trend',
        run: () => {
          this.state.wordTrendQuery = selectedText.slice(0, 48);
          this.switchView('analytics');
        },
      });
      items.push({
        label: '⎘ Copy Highlighted Text',
        shortcut: 'Ctrl+C',
        run: () => {
          navigator.clipboard?.writeText(selectedText).catch(() => {});
          this.showToast('Selection copied to clipboard.', 'success');
        },
      });
      items.push({ sep: true });
    }

    if (hmCell && hmCell.dataset.day) {
      const hmDay = hmCell.dataset.day;
      headerLabel = `CALENDAR · ${formatReadableDayKey(hmDay)} (${hmDay})`;
      items.push({
        label: `Open ${formatReadableDayKey(hmDay)} Side-by-Side`,
        run: () => {
          this.state.activeDay = hmDay;
          this.state.compare2Active = false;
          this.switchView('reader');
        },
      });
      items.push({
        label: `+ Write Entry on ${formatReadableDayKey(hmDay)}`,
        run: () => {
          const { month, day } = parseDayKey(hmDay);
          this.openComposer({
            presetDate: `${new Date().getFullYear()}-${pad2(month)}-${pad2(day)}`,
          });
        },
      });
      items.push({ sep: true });
    }

    if (yearCol && yearCol.dataset.year) {
      const yr = yearCol.dataset.year;
      const dayStr = this.state.activeDay;
      if (!selectedText) {
        headerLabel = `${yr} · ${formatReadableDayKey(dayStr)}`;
      }
      items.push({
        label: `+ Add Another ${yr} Entry`,
        run: () => this.openComposer({ presetDate: `${yr}-${dayStr}` }),
      });

      if (stackedCard && stackedCard.dataset.entryId) {
        const entryId = stackedCard.dataset.entryId;
        items.push({
          label: `✎ Edit This ${yr} Entry`,
          run: async () => {
            const doc = await this.getDayDocument(dayStr, false);
            const list = getYearEntriesList(doc.entries?.[yr], yr, dayStr);
            const raw = list.find((e) => e.id === entryId);
            if (!raw) return;
            const cached = this.state.decryptedEntryCache.get(
              `${raw.diaryDate || `${yr}-${dayStr}`}::${entryId}`
            );
            this.openComposer({
              editEntry: {
                ...raw,
                id: entryId,
                body: cached?.body ?? raw.body,
                title: cached?.title ?? raw.title,
              },
              dayStr,
              yearKey: yr,
            });
          },
        });
      }

      items.push({
        label: Number(this.state.pinnedYear) === Number(yr) ? `Unpin ${yr} Column` : `Pin ${yr} Column First`,
        run: () => {
          this.state.pinnedYear = Number(this.state.pinnedYear) === Number(yr) ? null : Number(yr);
          this.renderReader();
        },
      });
      items.push({ sep: true });
    }

    items.push(
      {
        label: '+ Write New Entry Today',
        run: () => this.openComposer({ presetDate: getTodayIsoDate() }),
      },
      {
        label: 'Jump to Today Side-by-Side',
        run: () => {
          this.state.activeDay = getTodayDayKey();
          this.state.compare2Active = false;
          this.switchView('reader');
        },
      },
      {
        label: 'Open Command Palette',
        shortcut: 'Ctrl+K',
        run: () => this.openCommandPalette(),
      },
      {
        label: 'Insights, Word Trends & Story Arcs',
        run: () => this.switchView('analytics'),
      },
      {
        label: 'Print Book / 8-Page Mini-Zine',
        run: () => this.switchView('archive'),
      },
      { sep: true },
      {
        label: '⚿ Panic Lock Diary Now',
        shortcut: 'Ctrl+Shift+L',
        danger: true,
        run: () => this.lockDiaryNow('panic'),
      }
    );

    menu.innerHTML =
      `<div class="ctx-menu-header">${escapeHtml(headerLabel)}</div>` +
      items
        .map((it, idx) =>
          it.sep
            ? '<div class="ctx-menu-sep"></div>'
            : `<button type="button" class="ctx-menu-item${it.danger ? ' is-danger' : ''}" data-ctx-idx="${idx}">
                <span>${escapeHtml(it.label)}</span>
                ${it.shortcut ? `<span class="ctx-menu-kbd">${escapeHtml(it.shortcut)}</span>` : ''}
              </button>`
        )
        .join('');

    menu.hidden = false;

    const rect = menu.getBoundingClientRect();
    const maxX = Math.max(8, window.innerWidth - rect.width - 10);
    const maxY = Math.max(8, window.innerHeight - rect.height - 10);
    menu.style.left = `${Math.min(clientX, maxX)}px`;
    menu.style.top = `${Math.min(clientY, maxY)}px`;

    menu.querySelectorAll('.ctx-menu-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = items[Number(btn.dataset.ctxIdx)];
        this.hideContextShortcutMenu();
        if (action && typeof action.run === 'function') {
          action.run();
        }
      });
    });
  }

  attachQuoteToComment(quoteObj) {
    this.state.pendingQuote = quoteObj;
    document.getElementById('comment-quote-source').textContent =
      `QUOTING ${quoteObj.year} · ${quoteObj.diaryDate}`;
    document.getElementById('comment-quote-preview').textContent = quoteObj.text;
    document.getElementById('comment-quote-attachment').hidden = false;
    const pill = document.getElementById('selection-quote-pill');
    if (pill) pill.hidden = true;
    document.getElementById('comments-section')?.scrollIntoView({ behavior: 'smooth' });
    window.setTimeout(() => document.getElementById('comment-body-input')?.focus(), 250);
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
      listEl.innerHTML = `<div class="empty-comments mono-meta">No margin notes on ${formatReadableDayKey(
        dayStr
      )} yet.</div>`;
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
          <button type="button" class="quoted-citation-card" data-jump-year="${escapeHtml(
            String(cmt.quote.year || '')
          )}">
            <div class="mono-label">QUOTING ${escapeHtml(String(cmt.quote.year || ''))} · ${escapeHtml(
          String(cmt.quote.diaryDate || '')
        )}</div>
            <div class="quoted-citation-text">“${escapeHtml(cmt.quote.text)}”</div>
          </button>
        `;
      }

      let photoHtml = '';
      if (!isLocked && !isTampered && cmt.image && cmt.image.src) {
        const asset = await this.resolveMediaAssetSafe(cmt.image.src);
        if (asset.status === 'ok' && asset.url) {
          photoHtml = `
            <figure class="comment-figure">
              <div class="comment-figure-frame">
                <img src="${escapeHtml(asset.url)}" alt="${escapeHtml(
            cmt.image.caption || 'Comment photo'
          )}" style="object-position:${cmt.image.posX ?? 50}% ${cmt.image.posY ?? 50}%;max-height:${
            cmt.image.height ?? 200
          }px;" />
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
        ? `<div class="tamper-alert-card" role="alert"><div class="mono-label">⚠ AAD INTEGRITY MISMATCH</div></div>`
        : isLocked
          ? '<em>Encrypted note — unlock Vault to view.</em>'
          : renderMarkdown(plainBody, { scopeId: `cmt-${cmt.id}` });

      card.innerHTML = `
        <div class="comment-card-top">
          <div>
            <span class="comment-author">${escapeHtml(cmt.author || 'Self')}</span>
            <span class="mono-meta">${escapeHtml(timestamp)}${res.version === 3 ? ' · v3 AAD' : ''}</span>
          </div>
          <div>
            <button type="button" class="btn btn-ghost btn-sm cmt-edit-btn" ${isTampered ? 'disabled' : ''}>Edit</button>
            <button type="button" class="btn btn-ghost btn-sm cmt-delete-btn">Delete</button>
          </div>
        </div>
        ${quoteCardHtml}
        <div class="prose-body">${bodyMarkup}</div>
        ${photoHtml}
      `;

      card.querySelector('.quoted-citation-card')?.addEventListener('click', (ev) => {
        const targetCol = document.querySelector(
          `.year-column[data-year="${ev.currentTarget.dataset.jumpYear}"]`
        );
        if (targetCol) {
          targetCol.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
          targetCol.classList.remove('flash-highlight');
          void targetCol.offsetWidth;
          targetCol.classList.add('flash-highlight');
        }
      });

      card.querySelector('.cmt-edit-btn').addEventListener('click', () => {
        if (!isTampered) this.startEditingComment(cmt, plainBody ?? cmt.body);
      });
      card.querySelector('.cmt-delete-btn').addEventListener('click', () => {
        this.handleDeleteComment(dayStr, cmt);
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

    if (cmt.quote?.text) {
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
    const statsEl = document.getElementById('comment-photo-stats');
    if (statsEl) statsEl.hidden = true;
    document.getElementById('comment-submit-btn').textContent = 'Post Margin Note';
    this.clearCommentQuote();
    this.commentStudio.clear();
  }

  clearCommentQuote() {
    this.state.pendingQuote = null;
    document.getElementById('comment-quote-attachment').hidden = true;
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
      body = await encryptText(
        body,
        this.state.keyring || this.state.cryptoKey,
        buildCommentAad(dayStr, targetCommentId, 'body')
      );
    }

    const caption = document.getElementById('comment-photo-caption').value.trim();
    const photoUrl = document.getElementById('comment-photo-url').value.trim();
    let imagePayload = this.state.commentDraftPhoto ? { ...this.state.commentDraftPhoto } : null;
    const mediaUploads = [];

    if (!imagePayload && photoUrl && /^https:\/\//i.test(photoUrl)) {
      imagePayload = { src: photoUrl, caption, align: 'full', posX: 50, posY: 50, width: 100, height: 220 };
    } else if (imagePayload) {
      imagePayload.caption = caption;
      if (imagePayload._pendingBuffer) {
        const encryptPhoto = Boolean(
          document.getElementById('comment-photo-encrypt-checkbox')?.checked && this.hasActiveSessionKey()
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
    const existingComment = (existingDoc.comments || []).find((c) => c.id === this.state.editingCommentId);
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
        const tx = {
          dayMutations: [{ dayStr, mode: 'comment', commentMutation: { op, comment: commentObj } }],
          mediaUploads,
          commitMessage: `diary: ${op} comment on ${dayStr}`,
          cloak: this.buildCloakTxAdapter(),
        };
        try {
          const res = await this.gh.commitAtomicDayMutations(tx);
          this.state.dayCache[dayStr] = res.docs[dayStr];
          if (res.dayShas?.[dayStr]) this.state.dayShas[dayStr] = res.dayShas[dayStr];
          this.state.indexData = res.index;
          this.showToast(
            `${this.state.editingCommentId ? 'Margin note updated' : 'Margin note posted'} atomically.`,
            'success'
          );
        } catch (err) {
          if (isNetworkOfflineError(err)) {
            this.offlineQueue.enqueue(
              GitHubClient.serializeTransactionForQueue(tx),
              this.state.zeroFootprint
            );
            this.updateOfflineQueuePill();
            this.showToast('Offline: margin note queued & will sync automatically when online.', 'warn');
          } else {
            throw err;
          }
        }
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
        this.showToast('Margin note saved.', 'success');
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
          dayMutations: [{ dayStr, mode: 'comment', commentMutation: { op: 'delete', id: commentObj.id } }],
          mediaDeletes,
          commitMessage: `diary: delete comment on ${dayStr}`,
          cloak: this.buildCloakTxAdapter(),
        });
        this.state.dayCache[dayStr] = res.docs[dayStr];
        this.state.indexData = res.index;
        this.showToast('Margin note deleted atomically.', 'success');
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

  populateComposerTemplates() {
    const sel = document.getElementById('entry-template-select');
    if (!sel) return;
    const customs = loadCustomTemplates(this.state.zeroFootprint);
    const all = [...customs, ...BUILT_IN_TEMPLATES];
    sel.innerHTML =
      '<option value="">Insert Template…</option>' +
      all
        .map(
          (t) =>
            `<option value="${escapeHtml(t.id)}">${escapeHtml(
              t.custom ? `★ ${t.name}` : t.name
            )}</option>`
        )
        .join('');
  }

  renderComposerMetricsSliders(existingMetrics = null) {
    const grid = document.getElementById('entry-metrics-grid');
    if (!grid) return;
    const defs = loadMetricDefinitions(this.state.zeroFootprint);
    grid.innerHTML = defs
      .map((m) => {
        const val = Number(existingMetrics?.[m.id] || 0);
        return `
          <label class="metric-slider-item">
            <span class="mono-meta">${escapeHtml(m.label)}: <strong data-metric-readout="${escapeHtml(
          m.id
        )}">${val > 0 ? `${val}/${m.max}` : '—'}</strong></span>
            <input type="range" min="0" max="${m.max}" value="${val}" data-metric-id="${escapeHtml(
          m.id
        )}" />
          </label>
        `;
      })
      .join('');

    grid.querySelectorAll('input[type="range"]').forEach((rng) => {
      rng.addEventListener('input', () => {
        const id = rng.dataset.metricId;
        const v = Number(rng.value) || 0;
        const out = grid.querySelector(`[data-metric-readout="${id}"]`);
        if (out) out.textContent = v > 0 ? `${v}/${rng.max}` : '—';
      });
    });
  }

  renderDraftGalleryStrip() {
    const listEl = document.getElementById('entry-gallery-draft-list');
    const removeBtn = document.getElementById('entry-photo-remove-btn');
    if (!listEl) return;

    const items = this.state.entryDraftGallery;
    if (removeBtn) removeBtn.hidden = items.length === 0;

    if (items.length === 0) {
      listEl.hidden = true;
      listEl.innerHTML = '';
      this.entryStudio.clear();
      return;
    }

    listEl.hidden = false;
    listEl.innerHTML = items
      .map(
        (it, idx) => `
        <div class="gallery-thumb-btn${idx === 0 ? ' is-primary' : ''}" title="${
          idx === 0 ? 'Primary cover photo' : `Gallery photo ${idx + 1} (click to make primary)`
        }">
          <img src="${escapeHtml(it._previewUrl || it.src || '')}" alt="" data-promote-idx="${idx}" />
          <button type="button" class="btn btn-danger btn-sm" data-del-img-idx="${idx}" style="position:absolute;top:2px;right:2px;padding:1px 5px;font-size:10px;">✕</button>
        </div>
      `
      )
      .join('');

    listEl.querySelectorAll('[data-promote-idx]').forEach((img) => {
      img.addEventListener('click', () => {
        const idx = Number(img.dataset.promoteIdx) || 0;
        if (idx > 0 && idx < this.state.entryDraftGallery.length) {
          const [picked] = this.state.entryDraftGallery.splice(idx, 1);
          this.state.entryDraftGallery.unshift(picked);
          this.syncPrimaryDraftPhotoStudio();
          this.renderDraftGalleryStrip();
        }
      });
    });

    listEl.querySelectorAll('[data-del-img-idx]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const idx = Number(btn.dataset.delImgIdx);
        this.state.entryDraftGallery.splice(idx, 1);
        this.syncPrimaryDraftPhotoStudio();
        this.renderDraftGalleryStrip();
      });
    });
  }

  async syncPrimaryDraftPhotoStudio() {
    const primary = this.state.entryDraftGallery[0];
    if (!primary) {
      this.entryStudio.clear();
      return;
    }
    const url = primary._previewUrl || (await this.resolveMediaUrlSafe(primary.src));
    primary._previewUrl = url;
    this.entryStudio.setMedia(url, primary, primary._statsLabel || '');
  }

  resetVoiceDraftUi() {
    if (this.voiceRecorder?.isRecording()) this.voiceRecorder.cancel();
    if (this.state.entryDraftVoice?._previewUrl?.startsWith('blob:')) {
      try {
        URL.revokeObjectURL(this.state.entryDraftVoice._previewUrl);
      } catch {
        // ignore
      }
    }
    this.state.entryDraftVoice = null;
    const recBtn = document.getElementById('voice-record-btn');
    const stopBtn = document.getElementById('voice-stop-btn');
    const timerEl = document.getElementById('voice-timer');
    const meterEl = document.getElementById('voice-meter-fill');
    const audioEl = document.getElementById('voice-draft-preview');
    const remBtn = document.getElementById('voice-remove-btn');
    if (recBtn) recBtn.hidden = false;
    if (stopBtn) stopBtn.hidden = true;
    if (timerEl) timerEl.textContent = '00:00';
    if (meterEl) meterEl.style.width = '0%';
    if (audioEl) {
      audioEl.pause();
      audioEl.removeAttribute('src');
      audioEl.hidden = true;
    }
    if (remBtn) remBtn.hidden = true;
  }

  toggleComposerZenMode(forceVal) {
    this.state.zenMode = forceVal !== undefined ? Boolean(forceVal) : !this.state.zenMode;
    const modal = document.getElementById('composer-modal');
    const btn = document.getElementById('composer-zen-btn');
    if (modal) modal.classList.toggle('is-zen-mode', this.state.zenMode);
    if (btn) btn.textContent = this.state.zenMode ? '⤢ Exit Zen' : '⛶ Zen Mode';
  }

  async openComposer({ presetDate = '', editEntry = null, dayStr = '', yearKey = '' } = {}) {
    this.populateComposerTemplates();
    this.toggleComposerZenMode(false);
    this.resetVoiceDraftUi();

    const presetSel = document.getElementById('entry-webp-preset');
    if (presetSel) presetSel.value = getSavedWebpPreset(this.state.zeroFootprint);

    document.getElementById('entry-prompt-banner').hidden = true;
    this.state.activePromptText = '';

    const sketchPanel = document.getElementById('entry-sketch-panel');
    if (sketchPanel) sketchPanel.hidden = true;

    const dlCb = document.getElementById('entry-doublelock-checkbox');
    const dlFields = document.getElementById('entry-doublelock-fields');
    const dlPassInput = document.getElementById('entry-doublelock-passphrase');
    const dlHintInput = document.getElementById('entry-doublelock-hint');

    if (editEntry) {
      const resolvedDate = editEntry.diaryDate || `${yearKey}-${dayStr}`;
      const targetId = editEntry.id || `ent-${Date.now()}`;
      this.state.editingEntryKey = { dayStr, yearKey: String(yearKey), entryId: targetId };
      this.state.editingBaseEntry = {
        id: targetId,
        diaryDate: resolvedDate,
        title: editEntry.title || '',
        body: editEntry.body || '',
        mood: editEntry.mood || '',
        tags: Array.isArray(editEntry.tags) ? [...editEntry.tags] : [],
        writtenAt: editEntry.writtenAt || null,
        updatedAt: editEntry.updatedAt || null,
        expectedSha: this.state.dayShas[dayStr] || null,
      };

      document.getElementById('composer-modal-title').textContent = `Edit ${resolvedDate}`;
      document.getElementById('entry-date-input').value = resolvedDate;
      document.getElementById('entry-title-input').value = editEntry.title || '';
      document.getElementById('entry-mood-input').value = editEntry.mood || '';
      document.getElementById('entry-tags-input').value = Array.isArray(editEntry.tags)
        ? editEntry.tags.join(', ')
        : '';
      document.getElementById('entry-body-input').value = editEntry.body || '';
      document.getElementById('entry-verse-checkbox').checked = Boolean(
        editEntry.preserveWhitespace
      );
      document.getElementById('entry-encrypt-checkbox').checked = Boolean(editEntry.encrypted);
      document.getElementById('entry-delete-btn').hidden = false;

      document.getElementById('entry-location-input').value = editEntry.location || '';
      document.getElementById('entry-weather-input').value = editEntry.weather || '';
      document.getElementById('entry-sealed-until-input').value = editEntry.sealedUntil || '';
      for (const f of ARTIFACT_FIELDS) {
        const el = document.getElementById(`artifact-${f.key}`);
        if (el) el.value = editEntry.artifacts?.[f.key] || '';
      }
      this.renderComposerMetricsSliders(editEntry.metrics || null);

      const wasDoubleLocked = Boolean(editEntry.doubleLocked);
      dlCb.checked = wasDoubleLocked;
      dlFields.hidden = !wasDoubleLocked;
      dlPassInput.value = editEntry._unlockedDoubleLockPassphrase || '';
      dlHintInput.value = editEntry.doubleLockHint || '';

      const existingImgs = normalizeEntryImages(editEntry);
      this.state.entryDraftGallery = existingImgs.map((img) => ({ ...img }));
      document.getElementById('entry-photo-caption').value = existingImgs[0]?.caption || '';
      await this.syncPrimaryDraftPhotoStudio();
      this.renderDraftGalleryStrip();

      if (editEntry.audio && editEntry.audio.src) {
        this.state.entryDraftVoice = { ...editEntry.audio };
        const audioUrl = await this.resolveMediaUrlSafe(editEntry.audio.src);
        if (audioUrl) {
          const audioEl = document.getElementById('voice-draft-preview');
          audioEl.src = audioUrl;
          audioEl.hidden = false;
          document.getElementById('voice-remove-btn').hidden = false;
          document.getElementById('voice-timer').textContent = formatDurationSec(
            editEntry.audio.durationSec || 0
          );
        }
      }
    } else {
      const targetDate = presetDate || getTodayIsoDate();
      this.state.editingEntryKey = null;
      this.state.editingBaseEntry = null;
      this.state.entryDraftGallery = [];

      document.getElementById('composer-modal-title').textContent = `New Entry · ${targetDate}`;
      document.getElementById('entry-date-input').value = targetDate;
      document.getElementById('entry-title-input').value = '';
      document.getElementById('entry-mood-input').value = '';
      document.getElementById('entry-tags-input').value = '';
      document.getElementById('entry-body-input').value = '';
      document.getElementById('entry-verse-checkbox').checked = false;
      document.getElementById('entry-encrypt-checkbox').checked = this.hasActiveSessionKey();
      document.getElementById('entry-delete-btn').hidden = true;

      document.getElementById('entry-location-input').value = '';
      document.getElementById('entry-weather-input').value = '';
      document.getElementById('entry-sealed-until-input').value = '';
      for (const f of ARTIFACT_FIELDS) {
        const el = document.getElementById(`artifact-${f.key}`);
        if (el) el.value = '';
      }
      this.renderComposerMetricsSliders(null);

      dlCb.checked = false;
      dlFields.hidden = true;
      dlPassInput.value = '';
      dlHintInput.value = '';

      document.getElementById('entry-photo-url').value = '';
      document.getElementById('entry-photo-caption').value = '';
      this.renderDraftGalleryStrip();
      this.checkLocalDraftForDate(targetDate);
    }

    this.setEditorMode('write');
    this.updateComposerCounts();
    document.getElementById('composer-modal').hidden = false;
    document.getElementById('entry-body-input').focus();
  }

  closeComposer() {
    this.toggleComposerZenMode(false);
    if (this.voiceRecorder?.isRecording()) this.voiceRecorder.cancel();
    document.getElementById('composer-modal').hidden = true;
    if (this.draftSaveTimer) {
      window.clearTimeout(this.draftSaveTimer);
      this.draftSaveTimer = null;
    }
  }

  setEditorMode(mode) {
    this.state.editorMode = mode;
    const ws = document.getElementById('editor-workspace');
    const preview = document.getElementById('entry-preview-pane');
    ws.className = `editor-workspace mode-${mode}`;
    preview.hidden = mode === 'write';
    document.querySelectorAll('#editor-mode-group .seg-btn').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.editorMode === mode);
    });
    if (mode !== 'write') {
      preview.innerHTML = renderMarkdown(document.getElementById('entry-body-input').value, {
        preserveWhitespace: Boolean(document.getElementById('entry-verse-checkbox')?.checked),
        scopeId: 'composer-preview',
      });
    }
  }

  updateComposerCounts() {
    const raw = document.getElementById('entry-body-input').value;
    document.getElementById('entry-word-count').textContent =
      `${countWords(raw)} words · ${countChars(raw)} chars`;
    if (this.state.editorMode !== 'write') {
      document.getElementById('entry-preview-pane').innerHTML = renderMarkdown(raw, {
        preserveWhitespace: Boolean(document.getElementById('entry-verse-checkbox')?.checked),
        scopeId: 'composer-preview',
      });
    }
  }

  scheduleDraftAutosave() {
    if (this.draftSaveTimer) window.clearTimeout(this.draftSaveTimer);
    if (this.state.zeroFootprint) {
      document.getElementById('entry-draft-status').textContent =
        'Zero-Footprint Mode: local draft autosave disabled';
      return;
    }
    this.draftSaveTimer = window.setTimeout(() => {
      const dateStr = document.getElementById('entry-date-input').value;
      if (!dateStr) return;
      const draftPayload = {
        diaryDate: dateStr,
        title: document.getElementById('entry-title-input').value,
        mood: document.getElementById('entry-mood-input').value,
        tags: document.getElementById('entry-tags-input').value,
        body: document.getElementById('entry-body-input').value,
        savedAt: new Date().toISOString(),
      };
      if (draftPayload.body.trim() || draftPayload.title.trim()) {
        this.storageSet(`perpetual_diary_draft_${dateStr}`, JSON.stringify(draftPayload));
        document.getElementById('entry-draft-status').textContent = 'Draft saved locally';
      }
    }, 650);
  }

  checkLocalDraftForDate(dateStr) {
    const banner = document.getElementById('draft-recovery-banner');
    if (this.state.zeroFootprint) {
      banner.hidden = true;
      return;
    }
    const raw = this.storageGet(`perpetual_diary_draft_${dateStr}`);
    if (!raw) {
      banner.hidden = true;
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      banner.hidden = !(parsed && (parsed.body || parsed.title));
    } catch {
      banner.hidden = true;
    }
  }

  applyMarkdownSnippet(action) {
    const ta = document.getElementById('entry-body-input');
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = ta.value.slice(start, end);
    let replacement = selected;

    if (action === 'bold') replacement = `**${selected || 'bold text'}**`;
    else if (action === 'italic') replacement = `*${selected || 'italic text'}*`;
    else if (action === 'h2') replacement = `\n## ${selected || 'Section Heading'}\n`;
    else if (action === 'quote') replacement = `\n> ${selected || 'Quoted passage'}\n`;
    else if (action === 'list') replacement = `\n- ${selected || 'List item'}\n`;
    else if (action === 'wikilink') replacement = `[[${selected || getTodayIsoDate()}]]`;
    else if (action === 'callout')
      replacement = `\n> [!reflection] Title\n> ${selected || 'Reflection note'}\n`;
    else if (action === 'sidenote') replacement = `^[${selected || 'Margin sidenote'}]`;
    else if (action === 'footnote') {
      replacement = `${selected || 'Statement'}[^1]\n\n[^1]: Footnote citation.`;
    }

    ta.setRangeText(replacement, start, end, 'end');
    ta.focus();
    this.updateComposerCounts();
    this.scheduleDraftAutosave();
  }

  collectComposerArtifactsAndMetrics() {
    const rawArt = {};
    for (const f of ARTIFACT_FIELDS) {
      rawArt[f.key] = document.getElementById(`artifact-${f.key}`)?.value || '';
    }
    const artifacts = normalizeArtifacts(rawArt);

    const rawMet = {};
    document.querySelectorAll('#entry-metrics-grid input[type="range"]').forEach((rng) => {
      rawMet[rng.dataset.metricId] = Number(rng.value) || 0;
    });
    const metrics = normalizeEntryMetrics(rawMet);

    return { artifacts, metrics };
  }

  async handleEntryFormSubmit(ev) {
    ev.preventDefault();
    const dateVal = document.getElementById('entry-date-input').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateVal)) {
      this.showToast('Please choose a valid diary date.', 'error');
      return;
    }

    const [yearStr, mm, dd] = dateVal.split('-');
    const dayStr = `${mm}-${dd}`;
    const rawTitle = document.getElementById('entry-title-input').value.trim();
    const rawBody = document.getElementById('entry-body-input').value.trim();
    if (!rawBody) {
      this.showToast('Entry prose cannot be empty.', 'error');
      return;
    }

    const mood = document.getElementById('entry-mood-input').value.trim();
    const tags = document
      .getElementById('entry-tags-input')
      .value.split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const location = document.getElementById('entry-location-input').value.trim();
    const weather = document.getElementById('entry-weather-input').value.trim();
    const sealedUntil = document.getElementById('entry-sealed-until-input').value.trim();
    const preserveWhitespace = Boolean(document.getElementById('entry-verse-checkbox')?.checked);
    const { artifacts, metrics } = this.collectComposerArtifactsAndMetrics();

    const shouldEncrypt = document.getElementById('entry-encrypt-checkbox').checked;
    const useDoubleLock = Boolean(document.getElementById('entry-doublelock-checkbox')?.checked);
    const doubleLockPass = document.getElementById('entry-doublelock-passphrase')?.value || '';
    const doubleLockHint = document.getElementById('entry-doublelock-hint')?.value.trim() || '';

    if (useDoubleLock && doubleLockPass.length < 4) {
      this.showToast('Double-Lock passphrase must be at least 4 characters.', 'warn');
      return;
    }

    let finalTitle = rawTitle;
    let finalBody = rawBody;
    const plainWordCount = countWords(stripMarkdown(rawBody));

    if (useDoubleLock) {
      finalBody = await encryptDoubleLockedText(
        finalBody,
        doubleLockPass,
        buildDoubleLockAad(dateVal, yearStr, 'body')
      );
      if (finalTitle) {
        finalTitle = await encryptDoubleLockedText(
          finalTitle,
          doubleLockPass,
          buildDoubleLockAad(dateVal, yearStr, 'title')
        );
      }
    }

    if (shouldEncrypt) {
      if (!this.hasActiveSessionKey()) {
        this.showToast('Unlock the Vault before saving encrypted entries.', 'warn');
        return;
      }
      finalBody = await encryptText(
        finalBody,
        this.state.keyring || this.state.cryptoKey,
        buildEntryAad(dateVal, yearStr, 'body')
      );
      if (finalTitle) {
        finalTitle = await encryptText(
          finalTitle,
          this.state.keyring || this.state.cryptoKey,
          buildEntryAad(dateVal, yearStr, 'title')
        );
      }
    }

    const primaryCaption = document.getElementById('entry-photo-caption').value.trim();
    const photoUrlInput = document.getElementById('entry-photo-url').value.trim();
    const encryptMedia = Boolean(
      document.getElementById('entry-photo-encrypt-checkbox')?.checked && this.hasActiveSessionKey()
    );
    const mediaUploads = [];
    const shardedMediaUploads = [];
    const finalGallery = [];

    if (this.state.entryDraftGallery.length === 0 && photoUrlInput && /^https:\/\//i.test(photoUrlInput)) {
      finalGallery.push({
        id: `img-${Date.now().toString(36)}`,
        src: photoUrlInput,
        caption: primaryCaption,
        align: 'full',
        posX: 50,
        posY: 50,
        width: 100,
        height: 240,
        encrypted: false,
        kind: 'photo',
      });
    } else {
      for (let i = 0; i < this.state.entryDraftGallery.length; i += 1) {
        const item = { ...this.state.entryDraftGallery[i] };
        if (i === 0) item.caption = primaryCaption;

        if (item._pendingBuffer) {
          const prepared = await prepareMediaPayloadForStorage({
            buffer: item._pendingBuffer,
            mime: item._mime || 'image/webp',
            ext: item._ext || 'webp',
            datePrefix: dateVal,
            encrypt: encryptMedia,
            keyring: this.state.keyring || this.state.cryptoKey,
            namePrefix: item.kind === 'sketch' ? 'sketch' : '',
          });
          item.encrypted = prepared.encrypted;

          if (this.gh.hasToken()) {
            const mediaTarget = this.gh.getMediaTarget(Number(yearStr));
            if (mediaTarget.isSharded) {
              shardedMediaUploads.push({
                year: Number(yearStr),
                subpath: prepared.mediaSubpath,
                buffer: prepared.uploadBuffer,
              });
              item.src = buildShardPointer(mediaTarget.repo, prepared.mediaSubpath);
            } else {
              mediaUploads.push({
                subpath: prepared.mediaSubpath,
                buffer: prepared.uploadBuffer,
              });
              item.src = `${this.gh.getDataTarget().basePath}/${prepared.mediaSubpath}`;
            }
          } else {
            item.src = await this.storeLocalMediaBuffer(
              prepared.mediaSubpath,
              prepared.uploadBuffer,
              prepared.uploadMime,
              prepared.encrypted
            );
          }
        }

        delete item._pendingBuffer;
        delete item._ext;
        delete item._mime;
        delete item._previewUrl;
        delete item._statsLabel;
        finalGallery.push(item);
      }
    }

    let finalAudio = null;
    if (this.state.entryDraftVoice) {
      const vDraft = { ...this.state.entryDraftVoice };
      if (vDraft._pendingBuffer) {
        const preparedAudio = await prepareAudioPayloadForStorage({
          buffer: vDraft._pendingBuffer,
          mime: vDraft._mime || 'audio/webm',
          ext: vDraft._ext || 'webm',
          datePrefix: dateVal,
          encrypt: encryptMedia,
          keyring: this.state.keyring || this.state.cryptoKey,
        });
        let audioSrc;
        if (this.gh.hasToken()) {
          mediaUploads.push({
            subpath: preparedAudio.mediaSubpath,
            buffer: preparedAudio.uploadBuffer,
          });
          audioSrc = `${this.gh.getDataTarget().basePath}/${preparedAudio.mediaSubpath}`;
        } else {
          audioSrc = await this.storeLocalMediaBuffer(
            preparedAudio.mediaSubpath,
            preparedAudio.uploadBuffer,
            preparedAudio.uploadMime,
            preparedAudio.encrypted
          );
        }
        finalAudio = {
          src: audioSrc,
          durationSec: vDraft.durationSec || 0,
          mime: vDraft._mime || 'audio/webm',
          encrypted: preparedAudio.encrypted,
        };
      } else if (vDraft.src) {
        finalAudio = {
          src: vDraft.src,
          durationSec: vDraft.durationSec || 0,
          mime: vDraft.mime || 'audio/webm',
          encrypted: Boolean(vDraft.encrypted),
        };
      }
    }

    const nowIso = new Date().toISOString();
    const prevKey = this.state.editingEntryKey;
    const targetEntryId =
      prevKey?.entryId || `ent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    const entryRecord = {
      id: targetEntryId,
      year: Number(yearStr),
      diaryDate: dateVal,
      title: finalTitle,
      body: finalBody,
      tags,
      mood,
      location: location || '',
      weather: weather || '',
      artifacts: artifacts || null,
      metrics: metrics || null,
      sealedUntil: sealedUntil || '',
      preserveWhitespace,
      wordCount: plainWordCount,
      images: finalGallery,
      image: finalGallery[0] || null,
      audio: finalAudio,
      writtenAt: this.state.editingBaseEntry?.writtenAt || nowIso,
      updatedAt: nowIso,
      encrypted: shouldEncrypt,
      doubleLocked: useDoubleLock,
      doubleLockHint: useDoubleLock ? doubleLockHint : '',
    };

    const isMovingSlot =
      prevKey && (prevKey.dayStr !== dayStr || String(prevKey.yearKey) !== String(yearStr));
    const isSameSlotEdit = prevKey && !isMovingSlot;

    try {
      for (const shUp of shardedMediaUploads) {
        await this.gh.uploadMediaToShard(
          shUp.year,
          shUp.subpath,
          shUp.buffer,
          `diary: upload sharded media ${shUp.subpath}`
        );
      }

      if (this.gh.hasToken()) {
        const dayMutations = [];
        if (isMovingSlot) {
          dayMutations.push({
            dayStr: prevKey.dayStr,
            mode: 'entry-delete',
            yearKey: String(prevKey.yearKey),
            entryId: prevKey.entryId,
          });
        }
        dayMutations.push({
          dayStr,
          mode: 'entry-save',
          yearKey: yearStr,
          entryId: targetEntryId,
          entryRecord,
          expectedUpdatedAt: isSameSlotEdit ? this.state.editingBaseEntry?.updatedAt || null : null,
          expectedSha: isSameSlotEdit ? this.state.editingBaseEntry?.expectedSha || null : null,
        });

        const tx = {
          dayMutations,
          mediaUploads,
          commitMessage: `diary: ${prevKey ? 'update' : 'create'} ${dateVal}`,
          cloak: this.buildCloakTxAdapter(),
        };

        try {
          const res = await this.gh.commitAtomicDayMutations(tx);
          for (const [dKey, updatedDoc] of Object.entries(res.docs)) {
            this.state.dayCache[dKey] = updatedDoc;
          }
          if (res.dayShas) Object.assign(this.state.dayShas, res.dayShas);
          this.state.indexData = res.index;
          const shortSha = res.commitSha ? ` (#${res.commitSha.slice(0, 7)})` : '';
          this.showToast(`Saved ${dateVal} in 1 atomic Git commit${shortSha}.`, 'success');
        } catch (err) {
          if (err instanceof SyncConflictError || err?.code === 'SYNC_CONFLICT') {
            await this.openConflictResolver({
              dayStr,
              yearKey: yearStr,
              entryId: targetEntryId,
              localPlain: { title: rawTitle, mood, tags, body: rawBody },
              localEntryRecord: entryRecord,
              mediaUploads,
              isMovingSlot,
              prevKey,
              conflictErr: err,
            });
            return;
          }
          if (isNetworkOfflineError(err)) {
            this.offlineQueue.enqueue(
              GitHubClient.serializeTransactionForQueue(tx),
              this.state.zeroFootprint
            );
            this.updateOfflineQueuePill();
            this.showToast(
              `Offline: ${dateVal} queued & will sync automatically when back online.`,
              'warn'
            );
          } else {
            throw err;
          }
        }
      } else {
        if (isMovingSlot) {
          const oldDoc = await this.getDayDocument(prevKey.dayStr, true);
          const oldList = getYearEntriesList(
            oldDoc.entries[prevKey.yearKey],
            prevKey.yearKey,
            prevKey.dayStr
          ).filter((e) => e.id !== prevKey.entryId);
          if (oldList.length === 0) delete oldDoc.entries[prevKey.yearKey];
          else oldDoc.entries[prevKey.yearKey] = oldList.length === 1 ? oldList[0] : oldList;
          await this.persistSandboxDay(prevKey.dayStr, oldDoc);
        }

        const targetDoc = await this.getDayDocument(dayStr, true);
        const list = getYearEntriesList(targetDoc.entries[yearStr], yearStr, dayStr);
        const existingIdx = list.findIndex((e) => e.id === targetEntryId);
        if (existingIdx >= 0) {
          list[existingIdx] = entryRecord;
        } else {
          list.push(entryRecord);
        }
        targetDoc.entries[yearStr] = list.length === 1 ? list[0] : list;

        await this.persistSandboxDay(dayStr, targetDoc);
        recordSandboxRevision(
          dayStr,
          targetDoc,
          `sandbox: ${prevKey ? 'update' : 'create'} ${dateVal}`,
          this.state.zeroFootprint
        );
        this.showToast(`Saved ${dateVal} to local sandbox.`, 'success');
      }

      const dlKey = `${dayStr}:${yearStr}:${targetEntryId}`;
      if (useDoubleLock) {
        this.state.doubleLockUnlocked.set(dlKey, {
          body: rawBody,
          title: rawTitle,
          passphrase: doubleLockPass,
        });
      } else {
        this.state.doubleLockUnlocked.delete(dlKey);
      }

      this.storageRemove(`perpetual_diary_draft_${dateVal}`);
      if (this.state.activeCloudDraftDate === dateVal) {
        deleteCloudDraft(this.gh, dateVal, { zeroFootprint: this.state.zeroFootprint })
          .then(() => this.refreshCloudDraftBadge())
          .catch(() => {});
        this.state.activeCloudDraftDate = null;
      }

      this.state.activeDay = dayStr;
      this.state.compare2Active = false;
      this.closeComposer();
      await this.renderActiveView();
    } catch (err) {
      this.showToast(err.message || 'Failed to save entry.', 'error');
    }
  }

  async handleDeleteEntry(dayStr, yearKey, entry) {
    const confirmed = await this.openConfirm({
      title: `Delete ${entry.diaryDate || `${yearKey}-${dayStr}`} Entry`,
      message: 'This will remove this entry from the year column and update the manifest index.',
      confirmLabel: 'Delete Entry',
    });
    if (!confirmed) return;

    const targetId = entry.id || '';

    try {
      const imgs = normalizeEntryImages(entry);
      if (this.gh.hasToken()) {
        const mediaDeletes = [];
        const basePrefix = `${this.gh.getDataTarget().basePath}/`;
        for (const img of imgs) {
          if (isShardPointer(img.src)) {
            const sh = parseShardPointer(
              img.src,
              this.gh.getDataTarget().owner,
              this.gh.config.mediaShardBranch || 'main'
            );
            if (sh) {
              await this.gh
                .deleteShardedMedia(
                  sh.owner,
                  sh.repo,
                  sh.branch,
                  sh.subpath,
                  `diary: delete sharded media ${sh.subpath}`
                )
                .catch(() => {});
            }
          } else if (img.src?.startsWith(basePrefix)) {
            mediaDeletes.push(img.src.slice(basePrefix.length));
          }
        }
        if (entry.audio?.src?.startsWith(basePrefix)) {
          mediaDeletes.push(entry.audio.src.slice(basePrefix.length));
        }

        const res = await this.gh.commitAtomicDayMutations({
          dayMutations: [
            { dayStr, mode: 'entry-delete', yearKey: String(yearKey), entryId: targetId },
          ],
          mediaDeletes,
          commitMessage: `diary: delete ${yearKey}-${dayStr}`,
          cloak: this.buildCloakTxAdapter(),
        });
        this.state.dayCache[dayStr] = res.docs[dayStr];
        if (res.dayShas?.[dayStr]) this.state.dayShas[dayStr] = res.dayShas[dayStr];
        this.state.indexData = res.index;
        this.showToast(`Deleted ${yearKey}-${dayStr} entry atomically.`, 'success');
      } else {
        const doc = await this.getDayDocument(dayStr, true);
        const list = getYearEntriesList(doc.entries[String(yearKey)], yearKey, dayStr);
        const remaining = targetId ? list.filter((e) => e.id !== targetId) : [];
        if (remaining.length === 0) {
          delete doc.entries[String(yearKey)];
        } else {
          doc.entries[String(yearKey)] = remaining.length === 1 ? remaining[0] : remaining;
        }
        await this.persistSandboxDay(dayStr, doc);
        this.showToast(`Deleted ${yearKey}-${dayStr} entry.`, 'success');
      }

      this.state.decryptedEntryCache.delete(`${entry.diaryDate || `${yearKey}-${dayStr}`}::${targetId}`);
      this.closeComposer();
      await this.renderActiveView();
    } catch (err) {
      this.showToast(err.message || 'Failed to delete entry.', 'error');
    }
  }

  /* ==========================================================================
     3-WAY CONFLICT RESOLVER
     ========================================================================== */

  async openConflictResolver({
    dayStr,
    yearKey,
    entryId,
    localPlain,
    localEntryRecord,
    mediaUploads,
    isMovingSlot,
    prevKey,
    conflictErr,
  }) {
    const remoteEntry = conflictErr.remoteEntry || {};
    const expectedDate = `${yearKey}-${dayStr}`;

    let remoteTitle = remoteEntry.title || '';
    let remoteBody = remoteEntry.body || '';
    if (remoteEntry.encrypted || isEncryptedPayload(remoteBody)) {
      remoteBody =
        (await this.decryptFieldIfNeeded(
          remoteEntry.body,
          true,
          buildEntryAad(expectedDate, yearKey, 'body')
        )) || '[Encrypted remote body]';
      remoteTitle = remoteEntry.title
        ? (await this.decryptFieldIfNeeded(
            remoteEntry.title,
            true,
            buildEntryAad(expectedDate, yearKey, 'title')
          )) || ''
        : '';
    }

    const basePlain = this.state.editingBaseEntry || { title: '', body: '', mood: '', tags: [] };
    const mergedTags = mergeTags(localPlain.tags, remoteEntry.tags || []);
    const autoMerge = buildThreeWayMerge(basePlain.body || '', localPlain.body, remoteBody);

    this.state.activeConflict = {
      dayStr,
      yearKey,
      entryId,
      localPlain,
      remotePlain: {
        title: remoteTitle,
        mood: remoteEntry.mood || '',
        tags: Array.isArray(remoteEntry.tags) ? remoteEntry.tags : [],
        body: remoteBody,
        updatedAt: remoteEntry.updatedAt || '',
      },
      basePlain,
      localEntryRecord,
      mediaUploads,
      isMovingSlot,
      prevKey,
      remoteSha: conflictErr.remoteSha || null,
    };

    document.getElementById('conflict-summary-banner').textContent =
      `Another device updated ${expectedDate} on GitHub (${
        remoteEntry.updatedAt ? new Date(remoteEntry.updatedAt).toLocaleString() : 'recently'
      }). Review differences below and commit a clean merge.`;

    document.getElementById('conflict-local-meta').textContent =
      `${countWords(localPlain.body)} words`;
    document.getElementById('conflict-remote-meta').textContent =
      `${countWords(remoteBody)} words`;

    document.getElementById('conflict-local-diff').innerHTML = renderDiffHtml(
      basePlain.body || '',
      localPlain.body
    );
    document.getElementById('conflict-remote-diff').innerHTML = renderDiffHtml(
      basePlain.body || '',
      remoteBody
    );

    document.getElementById('conflict-merged-title').value =
      localPlain.title || remoteTitle || '';
    document.getElementById('conflict-merged-mood').value =
      localPlain.mood || remoteEntry.mood || '';
    document.getElementById('conflict-merged-tags').value = mergedTags.join(', ');
    document.getElementById('conflict-merged-body').value = autoMerge.mergedText;

    document.getElementById('conflict-modal').hidden = false;
  }

  async handleConflictMergeSubmit(ev) {
    ev.preventDefault();
    const ctx = this.state.activeConflict;
    if (!ctx) return;

    const mergedBody = document.getElementById('conflict-merged-body').value.trim();
    if (!mergedBody) {
      this.showToast('Merged entry prose cannot be empty.', 'warn');
      return;
    }
    if (
      mergedBody.includes('<<<<<<<') ||
      mergedBody.includes('=======') ||
      mergedBody.includes('>>>>>>>')
    ) {
      this.showToast('Remove all <<<<<<< / ======= / >>>>>>> conflict markers first.', 'warn');
      return;
    }

    const mergedTitle = document.getElementById('conflict-merged-title').value.trim();
    const mergedMood = document.getElementById('conflict-merged-mood').value.trim();
    const mergedTags = document
      .getElementById('conflict-merged-tags')
      .value.split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    const expectedDate = `${ctx.yearKey}-${ctx.dayStr}`;
    const shouldEncrypt = Boolean(ctx.localEntryRecord.encrypted);
    let finalTitle = mergedTitle;
    let finalBody = mergedBody;

    if (shouldEncrypt) {
      finalBody = await encryptText(
        mergedBody,
        this.state.keyring || this.state.cryptoKey,
        buildEntryAad(expectedDate, ctx.yearKey, 'body')
      );
      if (mergedTitle) {
        finalTitle = await encryptText(
          mergedTitle,
          this.state.keyring || this.state.cryptoKey,
          buildEntryAad(expectedDate, ctx.yearKey, 'title')
        );
      }
    }

    const resolvedRecord = {
      ...ctx.localEntryRecord,
      title: finalTitle,
      body: finalBody,
      mood: mergedMood,
      tags: mergedTags,
      wordCount: countWords(stripMarkdown(mergedBody)),
      updatedAt: new Date().toISOString(),
    };

    try {
      const dayMutations = [];
      if (ctx.isMovingSlot && ctx.prevKey) {
        dayMutations.push({
          dayStr: ctx.prevKey.dayStr,
          mode: 'entry-delete',
          yearKey: String(ctx.prevKey.yearKey),
          entryId: ctx.prevKey.entryId,
        });
      }
      dayMutations.push({
        dayStr: ctx.dayStr,
        mode: 'entry-save',
        yearKey: String(ctx.yearKey),
        entryId: ctx.entryId,
        entryRecord: resolvedRecord,
        expectedSha: null,
        expectedUpdatedAt: null,
      });

      const res = await this.gh.commitAtomicDayMutations({
        dayMutations,
        mediaUploads: ctx.mediaUploads || [],
        commitMessage: `diary: resolve merge conflict ${expectedDate}`,
        cloak: this.buildCloakTxAdapter(),
      });

      for (const [dKey, updatedDoc] of Object.entries(res.docs)) {
        this.state.dayCache[dKey] = updatedDoc;
      }
      if (res.dayShas) Object.assign(this.state.dayShas, res.dayShas);
      this.state.indexData = res.index;

      this.state.activeConflict = null;
      document.getElementById('conflict-modal').hidden = true;
      this.storageRemove(`perpetual_diary_draft_${expectedDate}`);
      this.closeComposer();
      await this.renderActiveView();
      this.showToast(`Conflict resolved and committed for ${expectedDate}.`, 'success');
    } catch (err) {
      this.showToast(err.message || 'Failed to commit merged entry.', 'error');
    }
  }

  /* ==========================================================================
     GIT REVISION TIME MACHINE & CROSS-DEVICE `drafts` BRANCH
     ========================================================================== */

  async openHistoryModal(dayStr, yearKey, currentPlainEntry) {
    const modal = document.getElementById('history-modal');
    const timelineEl = document.getElementById('history-timeline-list');
    const diffViewer = document.getElementById('history-diff-viewer');
    const snapViewer = document.getElementById('history-snapshot-viewer');
    const restoreBtn = document.getElementById('history-restore-btn');
    const banner = document.getElementById('history-status-banner');

    document.getElementById('history-modal-title').textContent =
      `Revision History · ${yearKey}-${dayStr}`;
    timelineEl.innerHTML = '<div class="mono-meta" style="padding:0.8rem;">Loading commits…</div>';
    diffViewer.innerHTML = '';
    snapViewer.innerHTML = '';
    restoreBtn.disabled = true;
    banner.hidden = true;
    modal.hidden = false;

    try {
      const revisions = await fetchDayCommitHistory(this.gh, dayStr, {
        cloakAdapter: this.buildCloakTxAdapter(),
        limit: 25,
      });

      document.getElementById('history-count-label').textContent = String(revisions.length);
      this.state.activeHistory = {
        dayStr,
        yearKey: String(yearKey),
        currentPlainEntry,
        revisions,
        selectedRevision: null,
        selectedEntry: null,
      };

      if (revisions.length === 0) {
        timelineEl.innerHTML =
          '<div class="mono-meta" style="padding:0.8rem;">No prior revisions recorded yet.</div>';
        return;
      }

      timelineEl.innerHTML = revisions
        .map(
          (rev, idx) => `
          <button type="button" class="history-commit-item" data-rev-idx="${idx}">
            <div class="history-commit-top">
              <span class="mono-label">${escapeHtml(rev.shortSha)}</span>
              <span class="mono-meta">${escapeHtml(
                new Date(rev.date).toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                })
              )}</span>
            </div>
            <div class="history-commit-msg">${escapeHtml(rev.message)}</div>
          </button>
        `
        )
        .join('');

      timelineEl.querySelectorAll('.history-commit-item').forEach((btn) => {
        btn.addEventListener('click', () => {
          timelineEl.querySelectorAll('.history-commit-item').forEach((b) => b.classList.remove('is-active'));
          btn.classList.add('is-active');
          this.selectHistoryRevision(Number(btn.dataset.revIdx));
        });
      });

      timelineEl.querySelector('.history-commit-item')?.click();
    } catch (err) {
      banner.className = 'status-callout is-err';
      banner.textContent = err.message || 'Could not load revision history.';
      banner.hidden = false;
    }
  }

  async selectHistoryRevision(idx) {
    const ctx = this.state.activeHistory;
    if (!ctx || !ctx.revisions[idx]) return;
    const rev = ctx.revisions[idx];
    const diffViewer = document.getElementById('history-diff-viewer');
    const snapViewer = document.getElementById('history-snapshot-viewer');
    const metaEl = document.getElementById('history-entry-meta');
    const restoreBtn = document.getElementById('history-restore-btn');

    document.getElementById('history-selected-sha').textContent = `COMMIT ${rev.shortSha}`;
    document.getElementById('history-selected-meta').textContent =
      ` · ${new Date(rev.date).toLocaleString()}`;
    diffViewer.innerHTML = '<div class="mono-meta" style="padding:0.75rem;">Decrypting snapshot…</div>';
    restoreBtn.disabled = true;

    try {
      const res = await fetchEntryAtRevision(this.gh, ctx.dayStr, ctx.yearKey, rev, {
        keyring: this.state.keyring || this.state.cryptoKey,
        cloakAdapter: this.buildCloakTxAdapter(),
      });

      if (!res.found || !res.entry) {
        diffViewer.innerHTML =
          '<div class="mono-meta" style="padding:0.75rem;">Entry did not exist at this revision.</div>';
        snapViewer.innerHTML = '';
        metaEl.hidden = true;
        return;
      }

      const rawSlot = res.entry;
      const chosenEntry = Array.isArray(rawSlot) ? rawSlot[0] : rawSlot;
      ctx.selectedRevision = rev;
      ctx.selectedEntry = chosenEntry;

      metaEl.hidden = false;
      metaEl.textContent = `${chosenEntry.title || '(No heading)'} · ${countWords(
        chosenEntry.body || ''
      )} words`;

      diffViewer.innerHTML = renderDiffHtml(
        chosenEntry.body || '',
        ctx.currentPlainEntry?.body || ''
      );
      snapViewer.innerHTML = renderMarkdown(chosenEntry.body || '', {
        preserveWhitespace: Boolean(chosenEntry.preserveWhitespace),
        scopeId: `hist-${rev.shortSha}`,
      });

      this.setHistoryViewMode(this.state.historyViewMode);
      restoreBtn.disabled = Boolean(res.locked || res.decryptionError);
    } catch (err) {
      diffViewer.innerHTML = `<div class="form-error">${escapeHtml(err.message)}</div>`;
    }
  }

  setHistoryViewMode(mode) {
    this.state.historyViewMode = mode;
    const diffViewer = document.getElementById('history-diff-viewer');
    const snapViewer = document.getElementById('history-snapshot-viewer');
    diffViewer.hidden = mode !== 'diff';
    snapViewer.hidden = mode !== 'snapshot';
    document.querySelectorAll('#history-view-toggle .seg-btn').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.historyMode === mode);
    });
  }

  async refreshCloudDraftBadge() {
    const pill = document.getElementById('cloud-drafts-count');
    if (!pill) return;
    try {
      const list = await listCloudDrafts(this.gh, { zeroFootprint: this.state.zeroFootprint });
      pill.textContent = String(list.length);
      pill.hidden = list.length === 0;
    } catch {
      pill.hidden = true;
    }
  }

  async handleSaveToCloudDraft() {
    const dateVal = document.getElementById('entry-date-input').value;
    const title = document.getElementById('entry-title-input').value.trim();
    const mood = document.getElementById('entry-mood-input').value.trim();
    const tags = document
      .getElementById('entry-tags-input')
      .value.split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const body = document.getElementById('entry-body-input').value;
    const encryptOnPublish = document.getElementById('entry-encrypt-checkbox').checked;

    if (!body.trim() && !title.trim()) {
      this.showToast('Write some text before saving to the drafts branch.', 'warn');
      return;
    }

    try {
      const res = await saveCloudDraft(
        this.gh,
        { diaryDate: dateVal, title, mood, tags, body, encryptOnPublish },
        {
          keyring: this.state.keyring || this.state.cryptoKey,
          encrypt: this.hasActiveSessionKey(),
          zeroFootprint: this.state.zeroFootprint,
        }
      );
      this.state.activeCloudDraftDate = dateVal;
      await this.refreshCloudDraftBadge();
      this.showToast(`Synced draft for ${dateVal} to "${res.branch}" branch.`, 'success');
    } catch (err) {
      this.showToast(err.message || 'Failed to sync draft.', 'error');
    }
  }

  async openDraftsModal() {
    const modal = document.getElementById('drafts-modal');
    const listEl = document.getElementById('drafts-list');
    const errEl = document.getElementById('drafts-error');
    errEl.hidden = true;
    listEl.innerHTML = '<div class="mono-meta">Loading drafts…</div>';
    modal.hidden = false;

    try {
      const drafts = await listCloudDrafts(this.gh, { zeroFootprint: this.state.zeroFootprint });
      if (drafts.length === 0) {
        listEl.innerHTML =
          '<div class="empty-comments mono-meta">No unfinished drafts on the drafts branch.</div>';
        return;
      }

      listEl.innerHTML = drafts
        .map(
          (d) => `
          <div class="draft-row-card">
            <div>
              <strong>${escapeHtml(d.diaryDate)}</strong>
              <span class="mono-meta"> · ${escapeHtml(d.source)}</span>
            </div>
            <div class="draft-row-actions">
              <button type="button" class="btn btn-primary btn-sm draft-open-btn" data-draft-date="${escapeHtml(
                d.diaryDate
              )}">Resume</button>
              <button type="button" class="btn btn-danger btn-sm draft-del-btn" data-draft-date="${escapeHtml(
                d.diaryDate
              )}">Delete</button>
            </div>
          </div>
        `
        )
        .join('');

      listEl.querySelectorAll('.draft-open-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const targetDate = btn.dataset.draftDate;
          try {
            const loaded = await loadCloudDraft(this.gh, targetDate, {
              keyring: this.state.keyring || this.state.cryptoKey,
              zeroFootprint: this.state.zeroFootprint,
            });
            modal.hidden = true;
            this.state.activeCloudDraftDate = targetDate;
            await this.openComposer({ presetDate: targetDate });
            document.getElementById('entry-title-input').value = loaded.title || '';
            document.getElementById('entry-mood-input').value = loaded.mood || '';
            document.getElementById('entry-tags-input').value = Array.isArray(loaded.tags)
              ? loaded.tags.join(', ')
              : '';
            document.getElementById('entry-body-input').value = loaded.body || '';
            this.updateComposerCounts();
          } catch (err) {
            errEl.textContent = err.message;
            errEl.hidden = false;
          }
        });
      });

      listEl.querySelectorAll('.draft-del-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const targetDate = btn.dataset.draftDate;
          try {
            await deleteCloudDraft(this.gh, targetDate, {
              zeroFootprint: this.state.zeroFootprint,
            });
            await this.refreshCloudDraftBadge();
            await this.openDraftsModal();
          } catch (err) {
            errEl.textContent = err.message;
            errEl.hidden = false;
          }
        });
      });
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  }

  /* ==========================================================================
     366-DAY HEATMAP, ARCHIVE, WORD TREND EXPLORER & STORY ARCS
     ========================================================================== */

  renderHeatmap() {
    const grid = document.getElementById('heatmap-grid');
    const readout = document.getElementById('heatmap-hover-readout');
    if (!grid) return;

    const daysMap = this.state.indexData?.days || {};
    grid.innerHTML = '';

    for (let m = 1; m <= 12; m += 1) {
      const card = document.createElement('div');
      card.className = 'hm-month-card';
      const maxD = DAYS_IN_MONTH[m - 1];
      let cellsHtml = '';

      for (let d = 1; d <= maxD; d += 1) {
        const dayStr = formatDayKey(m, d);
        const info = daysMap[dayStr];
        const { level, valueLabel } = getHeatmapLevelForMode(info, this.state.heatmapMode);
        const tip = `${formatReadableDayKey(dayStr)} (${dayStr}) — ${valueLabel}`;
        cellsHtml += `<button type="button" class="hm-cell hm-lvl-${level}" data-day="${dayStr}" data-tip="${escapeHtml(
          tip
        )}" title="${escapeHtml(tip)}" aria-label="${escapeHtml(tip)}"></button>`;
      }

      card.innerHTML = `
        <div class="hm-month-title">${MONTHS[m - 1]}</div>
        <div class="hm-month-cells">${cellsHtml}</div>
      `;
      grid.appendChild(card);
    }

    grid.querySelectorAll('.hm-cell').forEach((cell) => {
      cell.addEventListener('mouseenter', () => {
        if (readout) readout.textContent = cell.dataset.tip || '';
      });
      cell.addEventListener('focus', () => {
        if (readout) readout.textContent = cell.dataset.tip || '';
      });
      cell.addEventListener('click', () => {
        this.state.activeDay = cell.dataset.day;
        this.state.compare2Active = false;
        this.switchView('reader');
      });
    });
  }

  async loadAllIndexedDaysIntoCache(statusEl = null) {
    const dayKeys = Object.keys(this.state.indexData?.days || {}).sort();
    for (let i = 0; i < dayKeys.length; i += 1) {
      const dayStr = dayKeys[i];
      if (statusEl) {
        statusEl.textContent = `Loading & decrypting ${i + 1}/${dayKeys.length} (${dayStr})…`;
      }
      const doc = await this.getDayDocument(dayStr, false);
      for (const [yrKey, slot] of Object.entries(doc.entries || {})) {
        const list = getYearEntriesList(slot, yrKey, dayStr);
        for (const entry of list) {
          const expectedDate = `${yrKey}-${dayStr}`;
          const resolvedDate = entry.diaryDate || expectedDate;
          const entryId = entry.id || `ent-${yrKey}-1`;
          const bodyRes = await this.decryptFieldDetailed(
            entry.body,
            Boolean(entry.encrypted),
            buildEntryAad(expectedDate, yrKey, 'body')
          );
          const titleRes = await this.decryptFieldDetailed(
            entry.title || '',
            Boolean(entry.encrypted),
            buildEntryAad(expectedDate, yrKey, 'title')
          );
          if (bodyRes.status === 'ok' && !isDoubleLockedPayload(bodyRes.text)) {
            this.state.decryptedEntryCache.set(`${resolvedDate}::${entryId}`, {
              id: entryId,
              diaryDate: resolvedDate,
              dayStr,
              year: Number(yrKey),
              title: titleRes.text || '',
              body: bodyRes.text || '',
              mood: entry.mood || '',
              tags: Array.isArray(entry.tags) ? entry.tags : [],
              location: entry.location || '',
              weather: entry.weather || '',
              artifacts: entry.artifacts || null,
              metrics: entry.metrics || null,
              preserveWhitespace: Boolean(entry.preserveWhitespace),
              writtenAt: entry.writtenAt || '',
            });
          }
        }
      }
    }
  }

  async renderArchive() {
    const daysMap = this.state.indexData?.days || {};
    const yearSet = new Set();
    const tagCounts = new Map();

    for (const info of Object.values(daysMap)) {
      (info.years || []).forEach((y) => yearSet.add(Number(y)));
      (info.tags || []).forEach((t) => {
        tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
      });
    }

    const yearSel = document.getElementById('archive-year-select');
    const prevYearVal = yearSel.value;
    yearSel.innerHTML =
      '<option value="">All Years</option>' +
      Array.from(yearSet)
        .sort((a, b) => b - a)
        .map((y) => `<option value="${y}">${y}</option>`)
        .join('');
    yearSel.value = prevYearVal;

    const cloudEl = document.getElementById('archive-tag-cloud');
    cloudEl.innerHTML = Array.from(tagCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(
        ([tag, cnt]) =>
          `<button type="button" class="tag-cloud-btn${
            this.state.archiveTag === tag ? ' is-active' : ''
          }" data-tag="${escapeHtml(tag)}">#${escapeHtml(tag)} (${cnt})</button>`
      )
      .join('');

    cloudEl.querySelectorAll('.tag-cloud-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const t = btn.dataset.tag;
        this.state.archiveTag = this.state.archiveTag === t ? '' : t;
        this.renderArchive();
      });
    });

    const query = this.state.archiveSearch.trim().toLowerCase();
    const filterYear = this.state.archiveYear;
    const filterTag = this.state.archiveTag;
    const resultsEl = document.getElementById('archive-results');

    const cards = [];
    for (const [dayStr, info] of Object.entries(daysMap).sort((a, b) => a[0].localeCompare(b[0]))) {
      const years = (info.years || []).filter((y) => !filterYear || String(y) === filterYear);
      if (years.length === 0) continue;
      if (filterTag && !(info.tags || []).includes(filterTag)) continue;

      for (const yr of years) {
        const matchingCached = Array.from(this.state.decryptedEntryCache.values()).filter(
          (e) => e.dayStr === dayStr && Number(e.year) === Number(yr)
        );

        if (matchingCached.length > 0) {
          for (const cached of matchingCached) {
            const hay = `${cached.diaryDate} ${cached.title} ${cached.mood} ${(
              cached.tags || []
            ).join(' ')} ${cached.body}`.toLowerCase();
            if (query && !hay.includes(query)) continue;
            const plain = stripMarkdown(cached.body || '');
            const snippet = plain ? `${plain.slice(0, 140)}…` : 'Encrypted or unloaded prose';
            cards.push({
              dayStr,
              year: yr,
              title: cached.title || `${formatReadableDayKey(dayStr)} · ${yr}`,
              snippet,
              tags: cached.tags || [],
            });
          }
        } else {
          const hay = `${dayStr} ${yr} ${(info.tags || []).join(' ')} ${
            info.moods?.[yr] || ''
          }`.toLowerCase();
          if (query && !hay.includes(query)) continue;
          cards.push({
            dayStr,
            year: yr,
            title: `${formatReadableDayKey(dayStr)} · ${yr}`,
            snippet: 'Click "Load All Days" to search full decrypted prose.',
            tags: info.tags || [],
          });
        }
      }
    }

    if (cards.length === 0) {
      resultsEl.innerHTML =
        '<div class="empty-comments mono-meta">No entries match the current filter.</div>';
      return;
    }

    resultsEl.innerHTML = cards
      .map(
        (c) => `
        <article class="archive-card" data-day="${escapeHtml(c.dayStr)}">
          <div class="mono-meta">${escapeHtml(String(c.year))}-${escapeHtml(c.dayStr)}</div>
          <strong>${escapeHtml(c.title)}</strong>
          <p class="section-subtext">${escapeHtml(c.snippet)}</p>
        </article>
      `
      )
      .join('');

    resultsEl.querySelectorAll('.archive-card').forEach((card) => {
      card.addEventListener('click', () => {
        this.state.activeDay = card.dataset.day;
        this.state.compare2Active = false;
        this.switchView('reader');
      });
    });
  }

  async renderAnalyticsAndArcs() {
    const plainEntries = Array.from(this.state.decryptedEntryCache.values());
    const stats = computeDiaryAnalytics(this.state.indexData, plainEntries);

    const kpiGrid = document.getElementById('analytics-kpi-grid');
    if (kpiGrid) {
      kpiGrid.innerHTML = `
        <div class="kpi-card"><div class="mono-label">TOTAL ENTRIES</div><div class="kpi-value">${stats.totalEntries}</div></div>
        <div class="kpi-card"><div class="mono-label">TOTAL WORDS</div><div class="kpi-value">${stats.totalWords.toLocaleString()}</div></div>
        <div class="kpi-card"><div class="mono-label">366-DAY COVERAGE</div><div class="kpi-value">${stats.calendarCoveragePct}%</div></div>
        <div class="kpi-card"><div class="mono-label">AVG WORDS / ENTRY</div><div class="kpi-value">${stats.avgWordsPerEntry}</div></div>
        <div class="kpi-card"><div class="mono-label">LONGEST DAY RUN</div><div class="kpi-value">${stats.longestStreak}d</div></div>
      `;
    }

    const yearsChart = document.getElementById('analytics-years-chart');
    if (yearsChart) {
      const maxYearWords = Math.max(1, ...stats.yearsBreakdown.map((y) => y.words));
      yearsChart.innerHTML =
        stats.yearsBreakdown.length === 0
          ? '<span class="mono-meta">No entries recorded yet.</span>'
          : stats.yearsBreakdown
              .map(
                (y) => `
              <div class="bar-chart-row">
                <span>${y.year} (${y.entries})</span>
                <div class="bar-chart-track"><div class="bar-chart-fill" style="width:${Math.round(
                  (y.words / maxYearWords) * 100
                )}%"></div></div>
                <span>${y.words.toLocaleString()}w</span>
              </div>
            `
              )
              .join('');
    }

    const moodsChart = document.getElementById('analytics-moods-chart');
    if (moodsChart) {
      const maxMood = Math.max(1, ...stats.topMoods.map((m) => m.count));
      moodsChart.innerHTML =
        stats.topMoods.length === 0
          ? '<span class="mono-meta">Add moods to entries to visualize patterns.</span>'
          : stats.topMoods
              .map(
                (m) => `
              <div class="bar-chart-row">
                <span>${escapeHtml(m.mood)}</span>
                <div class="bar-chart-track"><div class="bar-chart-fill" style="width:${Math.round(
                  (m.count / maxMood) * 100
                )}%"></div></div>
                <span>${m.count}</span>
              </div>
            `
              )
              .join('');
    }

    this.renderWordTrendExplorer(plainEntries);

    const dossierSel = document.getElementById('dossier-year-select');
    if (dossierSel) {
      const years = stats.yearsBreakdown.map((y) => y.year).sort((a, b) => b - a);
      const list = years.length > 0 ? years : [new Date().getFullYear()];
      if (!list.includes(Number(this.state.selectedDossierYear))) {
        this.state.selectedDossierYear = list[0];
      }
      dossierSel.innerHTML = list
        .map((y) => `<option value="${y}">${y}</option>`)
        .join('');
      dossierSel.value = String(this.state.selectedDossierYear);

      const dossier = generateYearInReviewDossier(
        this.state.selectedDossierYear,
        this.state.indexData,
        plainEntries
      );
      const dossierStage = document.getElementById('dossier-stage');
      if (dossierStage) {
        dossierStage.innerHTML = `
          <p><strong>${dossier.year} Summary:</strong> ${dossier.entryCount} entries · ${dossier.totalWords.toLocaleString()} words · Most active month: <strong>${dossier.busiestMonth}</strong> (${dossier.busiestMonthWords.toLocaleString()} words).</p>
        `;
      }
    }

    const arcs = extractStoryArcs(this.state.indexData);
    const arcSel = document.getElementById('arc-select');
    const arcPrintBtn = document.getElementById('arc-print-book-btn');
    const arcStage = document.getElementById('arc-book-stage');

    if (arcSel) {
      arcSel.innerHTML =
        '<option value="">Select a Story Arc (arc:...)</option>' +
        arcs
          .map(
            (a) =>
              `<option value="${escapeHtml(a.slug)}">${escapeHtml(a.label)} (${
                a.entryCount
              } days)</option>`
          )
          .join('');
      if (this.state.selectedArcSlug) {
        arcSel.value = this.state.selectedArcSlug;
      }

      if (arcSel.value && arcStage) {
        const book = buildStoryArcBook(arcSel.value, plainEntries);
        if (arcPrintBtn) arcPrintBtn.disabled = book.chapters.length === 0;

        if (book.chapters.length === 0) {
          arcStage.innerHTML =
            '<p class="section-subtext">Click <strong>Decrypt All Days for Full Insights</strong> above to load all chapters of this Story Arc.</p>';
        } else {
          arcStage.innerHTML = `
            <div class="mono-label">STORY ARC · ${escapeHtml(book.dateSpan)} · ${book.totalWords.toLocaleString()} WORDS</div>
            <h3 class="section-heading" style="margin-bottom:1rem;">${escapeHtml(book.title)}</h3>
            ${book.chapters
              .map(
                (ch) => `
                <article class="arc-chapter">
                  <div class="mono-meta">${escapeHtml(ch.diaryDate)}${
                  ch.mood ? ` · mood: ${escapeHtml(ch.mood)}` : ''
                }</div>
                  ${ch.title ? `<h4>${escapeHtml(ch.title)}</h4>` : ''}
                  <div class="prose-body">${renderMarkdown(ch.body, {
                    preserveWhitespace: Boolean(ch.preserveWhitespace),
                    scopeId: `arc-${ch.id || ch.diaryDate}`,
                  })}</div>
                </article>
              `
              )
              .join('')}
          `;
        }
      } else if (arcPrintBtn) {
        arcPrintBtn.disabled = true;
      }
    }
  }

  renderWordTrendExplorer(plainEntries = null) {
    const entries = plainEntries || Array.from(this.state.decryptedEntryCache.values());
    const inputEl = document.getElementById('word-trend-input');
    const chipsEl = document.getElementById('word-trend-chips');
    const chartEl = document.getElementById('word-trend-chart');
    const matchesEl = document.getElementById('word-trend-matches');
    const summaryEl = document.getElementById('word-trend-summary-meta');
    if (!chipsEl || !chartEl || !matchesEl) return;

    if (inputEl && inputEl.value !== this.state.wordTrendQuery) {
      inputEl.value = this.state.wordTrendQuery;
    }

    const trend = computeWordTrend(this.state.wordTrendQuery, entries);

    chipsEl.innerHTML =
      trend.topWords.length === 0
        ? '<span class="mono-meta">Load or unlock entries to surface recurring words.</span>'
        : trend.topWords
            .map(
              (w) =>
                `<button type="button" class="word-trend-chip${
                  this.state.wordTrendQuery.toLowerCase() === w.word ? ' is-active' : ''
                }" data-trend-word="${escapeHtml(w.word)}">${escapeHtml(w.word)} (${
                  w.count
                })</button>`
            )
            .join('');

    chipsEl.querySelectorAll('.word-trend-chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.state.wordTrendQuery = btn.dataset.trendWord || '';
        this.renderWordTrendExplorer(entries);
      });
    });

    if (!trend.query) {
      if (summaryEl) {
        summaryEl.textContent = `${entries.length} decrypted entr${
          entries.length === 1 ? 'y' : 'ies'
        } indexed in RAM`;
      }
      chartEl.innerHTML =
        '<span class="mono-meta">Enter any word or phrase above (or click a recurring word chip) to plot its trajectory across years.</span>';
      matchesEl.innerHTML = '';
      return;
    }

    if (summaryEl) {
      summaryEl.textContent = `"${trend.query}": ${trend.totalOccurrences} mention(s) across ${
        trend.matchingEntriesCount
      } entr${trend.matchingEntriesCount === 1 ? 'y' : 'ies'}${
        trend.peakYear ? ` · Peak: ${trend.peakYear}` : ''
      }`;
    }

    const maxHits = Math.max(1, ...trend.byYear.map((y) => y.occurrences));
    chartEl.innerHTML =
      trend.byYear.length === 0
        ? '<span class="mono-meta">No years loaded yet.</span>'
        : trend.byYear
            .map(
              (y) => `
              <div class="bar-chart-row">
                <span>${y.year} (${y.entryHits}/${y.totalEntries})</span>
                <div class="bar-chart-track"><div class="bar-chart-fill" style="width:${Math.round(
                  (y.occurrences / maxHits) * 100
                )}%"></div></div>
                <span>${y.occurrences}×</span>
              </div>
            `
            )
            .join('');

    if (trend.matches.length === 0) {
      matchesEl.innerHTML = `<span class="mono-meta">No mentions of "${escapeHtml(
        trend.query
      )}" in currently loaded entries. Click "Decrypt All Days for Full Insights" to scan your entire archive.</span>`;
      return;
    }

    matchesEl.innerHTML = trend.matches
      .map(
        (m) => `
        <button type="button" class="word-trend-match-item" data-jump-day="${escapeHtml(m.dayStr)}">
          <div class="mono-meta">${escapeHtml(m.diaryDate)} · ${escapeHtml(m.title)} (${
          m.occurrences
        }×)</div>
          <div class="section-subtext">${escapeHtml(m.excerpt)}</div>
        </button>
      `
      )
      .join('');

    matchesEl.querySelectorAll('.word-trend-match-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.state.activeDay = btn.dataset.jumpDay;
        this.state.compare2Active = false;
        this.switchView('reader');
      });
    });
  }

  /* ==========================================================================
     COMMAND PALETTE (`Ctrl+K`)
     ========================================================================== */

  buildCommandList() {
    const cmds = [
      {
        id: 'cmd-write',
        title: '+ Write New Entry Today',
        subtitle: getTodayIsoDate(),
        keywords: 'new compose write today',
        run: () => this.openComposer({ presetDate: getTodayIsoDate() }),
      },
      {
        id: 'cmd-today',
        title: 'Jump to Today Side-by-Side',
        subtitle: formatReadableDayKey(getTodayDayKey()),
        keywords: 'today reader home',
        run: () => {
          this.state.activeDay = getTodayDayKey();
          this.state.compare2Active = false;
          this.switchView('reader');
        },
      },
      {
        id: 'cmd-heatmap',
        title: 'View 366-Day Perpetual Heatmap',
        subtitle: 'Multi-metric calendar grid',
        keywords: '366 heatmap calendar',
        run: () => this.switchView('heatmap'),
      },
      {
        id: 'cmd-archive',
        title: 'Open Archive, Search & Exports',
        subtitle: 'Search, Print Book, Mini-Zine, Import',
        keywords: 'archive search export import',
        run: () => this.switchView('archive'),
      },
      {
        id: 'cmd-analytics',
        title: 'Open Insights, Word Trends & Story Arcs',
        subtitle: 'Word velocity, vocabulary trends, Year-in-Review Dossier',
        keywords: 'analytics insights word trend arcs dossier book',
        run: () => this.switchView('analytics'),
      },
      {
        id: 'cmd-print-book',
        title: 'Print-to-Book (Paginated PDF Edition)',
        subtitle: 'Generates clean print layout with table of contents',
        keywords: 'print pdf book export',
        run: () =>
          this.triggerPrintEdition(
            openPrintBookWindow,
            {
              title: 'Perpetual Side-by-Side Diary',
              subtitle: 'Compiled Print Edition',
              entries: Array.from(this.state.decryptedEntryCache.values()),
            },
            'Print Book'
          ),
      },
      {
        id: 'cmd-mini-zine',
        title: 'Print 8-Page Foldable Mini-Zine',
        subtitle: '1-sheet pocket booklet imposition',
        keywords: 'zine pocket print fold',
        run: () =>
          this.triggerPrintEdition(
            openMiniZineWindow,
            {
              title: 'Perpetual Pocket Zine',
              entries: Array.from(this.state.decryptedEntryCache.values()),
            },
            '8-Page Mini-Zine'
          ),
      },
      {
        id: 'cmd-vault',
        title: 'Open Vault, Passkeys, Cloaking & Recovery Kit',
        subtitle: 'Encryption & security settings',
        keywords: 'vault password argon2 passkey recovery cloak',
        run: () => this.openVaultModal(),
      },
      {
        id: 'cmd-github',
        title: 'Open GitHub Sync & Split-Repo Settings',
        subtitle: 'Repository, PAT & Zero-Footprint Mode',
        keywords: 'github sync pat settings split repo',
        run: () => this.openGitHubModal(),
      },
      {
        id: 'cmd-lock',
        title: 'Panic Lock Diary Now',
        subtitle: 'Wipe keys & decrypted media from RAM',
        keywords: 'lock panic security',
        run: () => this.lockDiaryNow('panic'),
      },
    ];

    for (const dayStr of Object.keys(this.state.indexData?.days || {}).sort()) {
      const info = this.state.indexData.days[dayStr];
      cmds.push({
        id: `day-${dayStr}`,
        title: `Jump to ${formatReadableDayKey(dayStr)} (${dayStr})`,
        subtitle: `Years: ${(info.years || []).join(', ')}`,
        keywords: `${dayStr} ${formatReadableDayKey(dayStr)} ${(info.tags || []).join(' ')}`,
        run: () => {
          this.state.activeDay = dayStr;
          this.state.compare2Active = false;
          this.switchView('reader');
        },
      });
    }

    return cmds;
  }

  openCommandPalette() {
    const modal = document.getElementById('cmdk-modal');
    const input = document.getElementById('cmdk-input');
    if (!modal || !input) return;
    input.value = '';
    this.state.cmdkSelectedIndex = 0;
    this.renderCommandPaletteResults('');
    modal.hidden = false;
    input.focus();
  }

  renderCommandPaletteResults(query) {
    const listEl = document.getElementById('cmdk-list');
    if (!listEl) return;
    const all = this.buildCommandList();
    const filtered = filterCommands(all, query).slice(0, 14);
    this.state.cmdkItems = filtered;
    this.state.cmdkSelectedIndex = Math.min(
      Math.max(0, this.state.cmdkSelectedIndex),
      Math.max(0, filtered.length - 1)
    );

    if (filtered.length === 0) {
      listEl.innerHTML =
        '<div class="mono-meta" style="padding:0.85rem;">No matching commands or dates.</div>';
      return;
    }

    listEl.innerHTML = filtered
      .map(
        (cmd, idx) => `
        <button type="button" class="cmdk-item${
          idx === this.state.cmdkSelectedIndex ? ' is-selected' : ''
        }" data-cmd-idx="${idx}">
          <div>
            <div class="cmdk-item-title">${escapeHtml(cmd.title)}</div>
            <div class="cmdk-item-sub">${escapeHtml(cmd.subtitle || '')}</div>
          </div>
        </button>
      `
      )
      .join('');

    listEl.querySelectorAll('.cmdk-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        const chosen = filtered[Number(btn.dataset.cmdIdx)];
        document.getElementById('cmdk-modal').hidden = true;
        if (chosen) chosen.run();
      });
    });
  }

  /* ==========================================================================
     ZERO-KNOWLEDGE SHARE LINKS
     ========================================================================== */

  openShareComposerModal(entrySnapshot) {
    this.state.pendingShareEntry = entrySnapshot;
    document.getElementById('share-entry-summary').textContent =
      `Sharing ${entrySnapshot.diaryDate}${
        entrySnapshot.title ? ` — "${entrySnapshot.title}"` : ''
      }. Encrypted client-side with a fresh 256-bit key stored strictly in the URL #fragment.`;
    document.getElementById('share-result-box').hidden = true;
    document.getElementById('share-error').hidden = true;
    document.getElementById('share-modal').hidden = false;
  }

  async openSharedEntryViewer(shareId, keyB64Url) {
    const overlay = document.getElementById('shared-viewer-overlay');
    const titleEl = document.getElementById('shared-viewer-title');
    const metaEl = document.getElementById('shared-viewer-meta');
    const tagsEl = document.getElementById('shared-viewer-tags');
    const bodyEl = document.getElementById('shared-viewer-body');
    const errEl = document.getElementById('shared-viewer-error');

    overlay.hidden = false;
    errEl.hidden = true;

    try {
      const payload = await fetchAndDecryptShareLink(shareId, keyB64Url, this.gh);
      titleEl.textContent = payload.title || `Shared Entry · ${payload.diaryDate}`;
      metaEl.textContent = `${payload.diaryDate}${payload.mood ? ` · mood: ${payload.mood}` : ''}`;
      tagsEl.innerHTML = (payload.tags || [])
        .map((t) => `<span class="tag-chip">#${escapeHtml(t)}</span>`)
        .join('');
      bodyEl.innerHTML = renderMarkdown(payload.body || '', { scopeId: `shared-${shareId}` });
    } catch (err) {
      titleEl.textContent = 'Shared Entry Unavailable';
      errEl.textContent = err.message || 'Could not decrypt shared entry.';
      errEl.hidden = false;
    }
  }

  /* ==========================================================================
     VAULT & GITHUB MODALS
     ========================================================================== */

  openVaultModal() {
    const vm = this.state.vaultMeta;
    const banner = document.getElementById('vault-status-banner');
    const archPanel = document.getElementById('vault-arch-panel');
    const recPanel = document.getElementById('vault-recovery-panel');
    const upgBanner = document.getElementById('vault-upgrade-banner');
    const migBanner = document.getElementById('vault-migrate-banner');
    const mediaMigBanner = document.getElementById('vault-media-migrate-banner');
    const cloakPanel = document.getElementById('vault-cloak-panel');
    const passkeyPanel = document.getElementById('vault-passkey-panel');
    const decoyPanel = document.getElementById('vault-decoy-panel');
    const argon2Panel = document.getElementById('vault-argon2-panel');
    const sharesPanel = document.getElementById('vault-shares-panel');
    const curPassGroup = document.getElementById('vault-current-pass-group');

    document.getElementById('vault-error').hidden = true;
    document.getElementById('vault-current-password').value = '';
    document.getElementById('vault-new-password').value = '';
    document.getElementById('vault-confirm-password').value = '';
    document.getElementById('vault-lock-enabled-checkbox').checked = Boolean(vm?.enabled);
    document.getElementById('vault-autolock-select').value = String(
      this.getEffectiveAutoLockMinutes()
    );
    document.getElementById('vault-encrypt-pat-checkbox').checked = Boolean(vm?.encryptedPat);

    const hasVault = this.hasConfiguredVault();
    const isV2 = Number(vm?.version) === 2;
    const isUnlocked = this.hasActiveSessionKey();

    curPassGroup.hidden = !hasVault;
    document.getElementById('vault-disable-btn').hidden = !hasVault;

    if (!hasVault) {
      banner.className = 'status-callout';
      banner.textContent =
        'No master password configured yet. Set one below to initialize a v2 Envelope + v3 AAD Vault.';
    } else if (isUnlocked) {
      banner.className = 'status-callout is-ok';
      banner.textContent = `Vault unlocked (${isV2 ? 'v2 Envelope' : 'v1 Legacy'} · DEK ${
        this.state.keyring?.dekFingerprint || 'active'
      }).`;
    } else {
      banner.className = 'status-callout is-err';
      banner.textContent = 'Vault is currently locked.';
    }

    archPanel.hidden = !isV2;
    recPanel.hidden = !(isV2 && isUnlocked);
    upgBanner.hidden = !(hasVault && !isV2);
    migBanner.hidden = !(isV2 && isUnlocked);
    mediaMigBanner.hidden = !(isV2 && isUnlocked);
    cloakPanel.hidden = !(isV2 && isUnlocked);
    passkeyPanel.hidden = !(isV2 && isUnlocked && isWebAuthnSupported());
    decoyPanel.hidden = !(isV2 && isUnlocked);
    argon2Panel.hidden = !(isV2 && isUnlocked);

    if (isV2) {
      document.getElementById('vault-fingerprint-label').textContent =
        `DEK: ${vm.dekFingerprint || '—'}`;
      const slots = Array.isArray(vm.keySlots) ? vm.keySlots : [];
      document.getElementById('vault-slots-list').innerHTML = slots
        .map(
          (s) =>
            `<div class="vault-slot-card"><span><strong>${escapeHtml(
              s.label || s.type
            )}</strong> · <span class="mono-meta">${escapeHtml(
              s.kdf || s.format || s.type
            )}</span></span><span class="mono-meta">${escapeHtml(s.id)}</span></div>`
        )
        .join('');

      const hasRec = slots.some((s) => s.type === 'recovery');
      document.getElementById('vault-recovery-slot-status').textContent = hasRec
        ? 'Active slot enrolled'
        : 'Not generated';

      const pwSlot = slots.find((s) => s.type === 'password');
      document.getElementById('vault-kdf-status-pill').textContent =
        pwSlot?.kdf || 'PBKDF2-SHA256';

      document.getElementById('vault-cloak-enabled-checkbox').checked = Boolean(
        vm.metadataCloaking
      );
      document.getElementById('vault-generic-commits-checkbox').checked = Boolean(
        vm.genericCommitMessages
      );
      document.getElementById('vault-cloak-status-pill').textContent = vm.metadataCloaking
        ? 'ACTIVE'
        : 'OFF';

      const pkSlots = slots.filter((s) => s.type === 'passkey');
      document.getElementById('vault-passkey-status').textContent =
        pkSlots.length > 0 ? `${pkSlots.length} enrolled` : 'Not enrolled';
      document.getElementById('vault-passkey-list').innerHTML = pkSlots
        .map(
          (pk) =>
            `<div class="vault-slot-card"><span>⚷ ${escapeHtml(
              pk.label
            )}</span><button type="button" class="btn btn-danger btn-sm pk-remove-btn" data-pk-id="${escapeHtml(
              pk.id
            )}">Revoke</button></div>`
        )
        .join('');
      document.querySelectorAll('.pk-remove-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const next = removePasskeySlot(this.state.vaultMeta, btn.dataset.pkId);
          await this.persistVaultMeta(next, 'diary: revoke passkey slot');
          this.openVaultModal();
        });
      });

      const hasDecoy = Boolean(vm.altProfile);
      document.getElementById('vault-decoy-status').textContent = hasDecoy
        ? 'Configured'
        : 'Not configured';
      document.getElementById('vault-remove-decoy-btn').hidden = !hasDecoy;
    }

    const shareRecords = loadShareRecords(this.state.zeroFootprint ? null : window.localStorage);
    sharesPanel.hidden = shareRecords.length === 0;
    if (shareRecords.length > 0) {
      document.getElementById('vault-shares-count').textContent = `${shareRecords.length} active`;
      document.getElementById('vault-shares-list').innerHTML = shareRecords
        .map(
          (sr) =>
            `<div class="vault-slot-card"><span>${escapeHtml(sr.diaryDate)} · ${escapeHtml(
              sr.titlePreview
            )}</span><button type="button" class="btn btn-danger btn-sm share-revoke-btn" data-share-id="${escapeHtml(
              sr.shareId
            )}">Revoke</button></div>`
        )
        .join('');
      document.querySelectorAll('.share-revoke-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
          await revokeShareLink(btn.dataset.shareId, this.gh, {
            zeroFootprint: this.state.zeroFootprint,
          });
          this.showToast('Share link permanently revoked.', 'success');
          this.openVaultModal();
        });
      });
    }

    document.getElementById('vault-modal').hidden = false;
  }

  async openGitHubModal() {
    const cfg = this.gh.config;
    document.getElementById('gh-owner-input').value = cfg.owner || '';
    document.getElementById('gh-repo-input').value = cfg.repo || '';
    document.getElementById('gh-branch-input').value = cfg.branch || 'main';
    document.getElementById('gh-datapath-input').value = cfg.dataPath || 'data';
    document.getElementById('gh-use-private-vault').checked = Boolean(cfg.usePrivateVault);
    document.getElementById('gh-vault-owner-input').value = cfg.vaultOwner || '';
    document.getElementById('gh-vault-repo-input').value =
      cfg.vaultRepo || 'perpetual-diary-vault';
    document.getElementById('gh-vault-branch-input').value = cfg.vaultBranch || 'main';
    document.getElementById('gh-vault-path-input').value = cfg.vaultPath || 'data';
    document.getElementById('gh-use-media-sharding').checked = Boolean(cfg.useMediaSharding);
    document.getElementById('gh-media-shard-pattern').value =
      cfg.mediaShardPattern || 'diary-media-{year}';
    document.getElementById('gh-media-shard-branch').value = cfg.mediaShardBranch || 'main';
    document.getElementById('gh-token-input').value = cfg.token || '';
    document.getElementById('gh-token-expiry-input').value = cfg.tokenExpiresAt || '';
    document.getElementById('gh-read-api-checkbox').checked = Boolean(cfg.readFromApiWhenAuthed);
    document.getElementById('gh-zero-footprint-checkbox').checked = this.state.zeroFootprint;

    document.getElementById('split-vault-fields').hidden = !cfg.usePrivateVault;
    document.getElementById('media-shard-fields').hidden = !cfg.useMediaSharding;
    document.getElementById('gh-media-shard-preview').textContent =
      `Active shard: ${resolveShardRepoName(
        cfg.mediaShardPattern || 'diary-media-{year}',
        new Date().getFullYear()
      )}`;
    document.getElementById('gh-test-result').hidden = true;
    document.getElementById('github-modal').hidden = false;

    try {
      const health = await this.gh.getRepoHealth();
      document.getElementById('health-mode-pill').textContent = health.mode.toUpperCase();
      document.getElementById('health-repo-label').textContent = health.vaultRepoName;
      document.getElementById('health-size-label').textContent =
        `${formatBytesCompact(health.totalSizeKb * 1024)} / 1,024 MB (${health.usagePercent}%)`;
      document.getElementById('health-pat-status').textContent = this.gh.hasToken()
        ? 'PAT: Configured'
        : 'PAT: Not set';
      const fill = document.getElementById('quota-bar-fill');
      fill.style.width = `${Math.min(100, health.usagePercent)}%`;
      fill.classList.toggle('is-warn', health.usagePercent >= 75);
    } catch {
      // non-fatal
    }
  }

  /* ==========================================================================
     EVENT BINDINGS
     ========================================================================== */

  bindEvents() {
    window.addEventListener('online', () => {
      this.updateModeBadge();
      this.flushOfflineQueueIfReady(false);
    });
    window.addEventListener('offline', () => this.updateModeBadge());
    window.addEventListener('beforeunload', () => this.revokeRamMediaUrls());

    ['pointerdown', 'keydown', 'scroll'].forEach((evtName) => {
      window.addEventListener(evtName, () => this.recordUserActivity(true), { passive: true });
    });

    document.addEventListener('contextmenu', (ev) => {
      const tag = ev.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || ev.target?.isContentEditable) {
        return;
      }
      if (!this.state.unlocked) return;
      ev.preventDefault();
      this.showContextShortcutMenu(ev.clientX, ev.clientY, ev.target);
    });

    document.addEventListener('click', (ev) => {
      const menu = document.getElementById('context-shortcut-menu');
      if (menu && !menu.hidden && !menu.contains(ev.target)) {
        this.hideContextShortcutMenu();
      }
    });

    window.addEventListener('keydown', (ev) => {
      const mod = ev.ctrlKey || ev.metaKey;
      if (mod && ev.key.toLowerCase() === 'k') {
        ev.preventDefault();
        this.openCommandPalette();
        return;
      }
      if (mod && ev.shiftKey && ev.key.toLowerCase() === 'l') {
        ev.preventDefault();
        this.lockDiaryNow('panic');
        return;
      }
      if (mod && ev.shiftKey && ev.key.toLowerCase() === 'g') {
        ev.preventDefault();
        this.openGitHubModal();
        return;
      }
      if (ev.key === 'Escape') {
        this.hideContextShortcutMenu();
        const cmdk = document.getElementById('cmdk-modal');
        if (cmdk && !cmdk.hidden) {
          cmdk.hidden = true;
          return;
        }
        if (this.state.zenMode) {
          this.toggleComposerZenMode(false);
        }
      }
    });

    // Lock Screen
    document.getElementById('lock-form')?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const errEl = document.getElementById('lock-error');
      errEl.hidden = true;
      const secret = document.getElementById('lock-password-input').value;
      const zf = Boolean(document.getElementById('lock-zero-footprint-checkbox')?.checked);
      this.setZeroFootprintMode(zf, false);

      const res = await unlockVaultOrDecoy(secret, this.state.vaultMeta);
      if (!res.ok) {
        errEl.textContent = res.error || 'Incorrect password.';
        errEl.hidden = false;
        return;
      }

      this.setActiveKeyring(res.keyring);
      this.state.isDecoySession = Boolean(res.isDecoy);
      this.state.decoyPolicy = res.decoyPolicy || null;
      this.state.unlocked = true;
      if (res.pat) {
        this.gh.updateConfig({ token: res.pat });
        this.saveGitHubConfigLocally();
      }
      document.getElementById('lock-password-input').value = '';
      document.getElementById('lock-screen').hidden = true;
      await this.loadManifestIndex();
      this.updateModeBadge();
      await this.renderActiveView();
    });

    document.getElementById('lock-passkey-btn')?.addEventListener('click', async () => {
      const errEl = document.getElementById('lock-error');
      errEl.hidden = true;
      const res = await unlockVaultWithPasskey(this.state.vaultMeta);
      if (!res.ok) {
        errEl.textContent = res.error || 'Passkey unlock failed.';
        errEl.hidden = false;
        return;
      }
      this.setActiveKeyring(res.keyring);
      this.state.unlocked = true;
      if (res.pat) {
        this.gh.updateConfig({ token: res.pat });
        this.saveGitHubConfigLocally();
      }
      document.getElementById('lock-screen').hidden = true;
      await this.loadManifestIndex();
      this.updateModeBadge();
      await this.renderActiveView();
    });

    document.getElementById('lock-open-settings-btn')?.addEventListener('click', () => {
      this.openGitHubModal();
    });

    // Header Controls
    document.querySelectorAll('.nav-tab').forEach((btn) => {
      btn.addEventListener('click', () => this.switchView(btn.dataset.view));
    });
    document.getElementById('brand-home-link')?.addEventListener('click', (ev) => {
      ev.preventDefault();
      this.state.activeDay = getTodayDayKey();
      this.state.compare2Active = false;
      this.switchView('reader');
    });
    document.getElementById('open-cmdk-btn')?.addEventListener('click', () => this.openCommandPalette());
    document.getElementById('open-drafts-btn')?.addEventListener('click', () => this.openDraftsModal());
    document.getElementById('open-composer-btn')?.addEventListener('click', () =>
      this.openComposer({ presetDate: getTodayIsoDate() })
    );
    document.getElementById('vault-btn')?.addEventListener('click', () => this.openVaultModal());
    document.getElementById('lock-now-btn')?.addEventListener('click', () => this.lockDiaryNow('manual'));
    document.getElementById('github-settings-btn')?.addEventListener('click', () =>
      this.openGitHubModal()
    );
    document.getElementById('offline-queue-pill')?.addEventListener('click', () =>
      this.flushOfflineQueueIfReady(true)
    );
    document.getElementById('theme-preset-select')?.addEventListener('change', (ev) => {
      applyThemePreset(ev.target.value, true, this.state.zeroFootprint);
    });

    // Reader Date & Layout Controls
    document.getElementById('month-select')?.addEventListener('change', (ev) => {
      const m = Number(ev.target.value);
      const { day } = parseDayKey(this.state.activeDay);
      this.state.activeDay = formatDayKey(m, day);
      this.renderReader();
    });
    document.getElementById('day-select')?.addEventListener('change', (ev) => {
      const { month } = parseDayKey(this.state.activeDay);
      this.state.activeDay = formatDayKey(month, Number(ev.target.value));
      this.renderReader();
    });
    document.getElementById('prev-day-btn')?.addEventListener('click', () => {
      const all = getAll366DayKeys();
      const idx = all.indexOf(this.state.activeDay);
      this.state.activeDay = all[(idx - 1 + all.length) % all.length];
      this.renderReader();
    });
    document.getElementById('next-day-btn')?.addEventListener('click', () => {
      const all = getAll366DayKeys();
      const idx = all.indexOf(this.state.activeDay);
      this.state.activeDay = all[(idx + 1) % all.length];
      this.renderReader();
    });
    document.getElementById('today-btn')?.addEventListener('click', () => {
      this.state.activeDay = getTodayDayKey();
      this.state.compare2Active = false;
      this.renderReader();
    });
    document.getElementById('next-recorded-btn')?.addEventListener('click', () => {
      const keys = Object.keys(this.state.indexData?.days || {}).sort();
      if (keys.length === 0) return;
      const next = keys.find((k) => k > this.state.activeDay) || keys[0];
      this.state.activeDay = next;
      this.state.compare2Active = false;
      this.renderReader();
    });
    document.getElementById('random-day-btn')?.addEventListener('click', () => {
      const keys = Object.keys(this.state.indexData?.days || {});
      if (keys.length === 0) return;
      this.state.activeDay = keys[Math.floor(Math.random() * keys.length)];
      this.state.compare2Active = false;
      this.renderReader();
    });
    document.getElementById('jump-comments-btn')?.addEventListener('click', () => {
      document.getElementById('comments-section')?.scrollIntoView({ behavior: 'smooth' });
    });

    document.querySelectorAll('#col-width-group .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.state.colMode = btn.dataset.colMode;
        document.querySelectorAll('#col-width-group .seg-btn').forEach((b) =>
          b.classList.toggle('is-active', b === btn)
        );
        this.renderReader();
      });
    });

    document.getElementById('sort-order-btn')?.addEventListener('click', (ev) => {
      this.state.sortOrder = this.state.sortOrder === 'asc' ? 'desc' : 'asc';
      ev.currentTarget.textContent =
        this.state.sortOrder === 'asc' ? 'Oldest → Newest' : 'Newest → Oldest';
      this.renderReader();
    });

    document.querySelectorAll('#window-scope-group .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.state.windowScope = btn.dataset.windowScope;
        document.querySelectorAll('#window-scope-group .seg-btn').forEach((b) =>
          b.classList.toggle('is-active', b === btn)
        );
        this.renderReader();
      });
    });

    document.getElementById('toggle-compare2-btn')?.addEventListener('click', () => {
      this.state.compare2Active = !this.state.compare2Active;
      this.renderReader();
    });
    document.getElementById('compare-swap-btn')?.addEventListener('click', () => {
      const a = document.getElementById('compare-date-a');
      const b = document.getElementById('compare-date-b');
      [a.value, b.value] = [b.value, a.value];
    });
    document.getElementById('compare-run-btn')?.addEventListener('click', () => {
      this.state.compareDateA = document.getElementById('compare-date-a').value;
      this.state.compareDateB = document.getElementById('compare-date-b').value;
      this.renderReader();
    });
    document.getElementById('compare-exit-btn')?.addEventListener('click', () => {
      this.state.compare2Active = false;
      this.renderReader();
    });

    document.getElementById('copy-permalink-btn')?.addEventListener('click', () => {
      this.syncHashRoute();
      navigator.clipboard?.writeText(window.location.href).catch(() => {});
      this.showToast('Permalink copied to clipboard.', 'success');
    });

    document.querySelectorAll('#mobile-view-toggle .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.state.mobileMode = btn.dataset.mobileMode;
        document.querySelectorAll('#mobile-view-toggle .seg-btn').forEach((b) =>
          b.classList.toggle('is-active', b === btn)
        );
        this.renderReader();
      });
    });

    // Wiki-Link & Sidenote clicks inside Reader
    document.getElementById('columns-stage')?.addEventListener('click', (ev) => {
      const wiki = ev.target.closest('.wiki-link');
      if (wiki) {
        ev.preventDefault();
        const dayTarget = wiki.dataset.wikiDay;
        if (dayTarget) {
          this.state.activeDay = dayTarget;
          this.state.compare2Active = false;
          this.renderReader();
        }
        return;
      }
      const snBtn = ev.target.closest('.md-sidenote-ref');
      if (snBtn) {
        const wrap = snBtn.closest('.md-sidenote-wrap');
        const open = wrap.classList.toggle('is-open');
        snBtn.setAttribute('aria-expanded', String(open));
      }
    });

    // Floating Highlight-to-Quote Pill
    document.addEventListener('selectionchange', () => {
      const pill = document.getElementById('selection-quote-pill');
      if (!pill) return;
      const sel = window.getSelection();
      const text = sel?.toString().trim() || '';
      if (!text || sel.rangeCount === 0) {
        pill.hidden = true;
        return;
      }
      const anchorEl =
        sel.anchorNode?.nodeType === 1 ? sel.anchorNode : sel.anchorNode?.parentElement;
      const col = anchorEl?.closest?.('.year-column');
      const card = anchorEl?.closest?.('.stacked-entry-item');
      if (!col || !col.dataset.year) {
        pill.hidden = true;
        return;
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      pill.style.top = `${Math.max(12, window.scrollY + rect.top - 38)}px`;
      pill.style.left = `${Math.max(12, window.scrollX + rect.left)}px`;
      pill.dataset.quoteText = text;
      pill.dataset.quoteYear = col.dataset.year;
      pill.dataset.quoteDate = card?.dataset.diaryDate || col.dataset.diaryDate;
      pill.hidden = false;
    });

    document.getElementById('selection-quote-pill')?.addEventListener('click', (ev) => {
      const btn = ev.currentTarget;
      this.attachQuoteToComment({
        text: btn.dataset.quoteText || '',
        year: Number(btn.dataset.quoteYear),
        diaryDate: btn.dataset.quoteDate || '',
      });
    });

    // Margin Comments Form & Photo
    document.getElementById('comment-form')?.addEventListener('submit', (ev) =>
      this.handleCommentSubmit(ev)
    );
    document.getElementById('comment-cancel-edit-btn')?.addEventListener('click', () =>
      this.resetCommentComposer()
    );
    document.getElementById('comment-clear-quote-btn')?.addEventListener('click', () =>
      this.clearCommentQuote()
    );
    document.getElementById('comment-photo-file')?.addEventListener('change', async (ev) => {
      const file = ev.target.files?.[0];
      if (!file) return;
      try {
        const processed = await processImageFile(file, {
          preset: getSavedWebpPreset(this.state.zeroFootprint),
        });
        this.state.commentDraftPhoto = {
          src: '',
          caption: document.getElementById('comment-photo-caption').value.trim(),
          align: 'full',
          posX: 50,
          posY: 50,
          width: 100,
          height: 200,
          _pendingBuffer: processed.arrayBuffer,
          _ext: processed.ext,
          _mime: processed.mime,
        };
        document.getElementById('comment-photo-remove-btn').hidden = false;
        this.commentStudio.setMedia(processed.dataUrl, this.state.commentDraftPhoto);
      } catch (err) {
        this.showToast(err.message, 'error');
      }
      ev.target.value = '';
    });
    document.getElementById('comment-photo-remove-btn')?.addEventListener('click', () => {
      this.state.commentDraftPhoto = null;
      document.getElementById('comment-photo-remove-btn').hidden = true;
      this.commentStudio.clear();
    });

    // Composer Controls
    document.getElementById('composer-zen-btn')?.addEventListener('click', () =>
      this.toggleComposerZenMode()
    );
    document.getElementById('composer-close-btn')?.addEventListener('click', () =>
      this.closeComposer()
    );
    document.getElementById('entry-cancel-btn')?.addEventListener('click', () =>
      this.closeComposer()
    );
    document.getElementById('entry-form')?.addEventListener('submit', (ev) =>
      this.handleEntryFormSubmit(ev)
    );
    document.getElementById('entry-save-cloud-draft-btn')?.addEventListener('click', () =>
      this.handleSaveToCloudDraft()
    );
    document.getElementById('entry-delete-btn')?.addEventListener('click', () => {
      if (this.state.editingEntryKey && this.state.editingBaseEntry) {
        this.handleDeleteEntry(
          this.state.editingEntryKey.dayStr,
          this.state.editingEntryKey.yearKey,
          this.state.editingBaseEntry
        );
      }
    });

    document.getElementById('entry-body-input')?.addEventListener('input', () => {
      this.updateComposerCounts();
      this.scheduleDraftAutosave();
    });
    document.getElementById('entry-verse-checkbox')?.addEventListener('change', () =>
      this.updateComposerCounts()
    );

    document.querySelectorAll('#editor-mode-group .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => this.setEditorMode(btn.dataset.editorMode));
    });
    document.querySelectorAll('.md-btn').forEach((btn) => {
      btn.addEventListener('click', () => this.applyMarkdownSnippet(btn.dataset.md));
    });

    document.getElementById('entry-template-select')?.addEventListener('change', (ev) => {
      const id = ev.target.value;
      if (!id) return;
      const all = [...loadCustomTemplates(this.state.zeroFootprint), ...BUILT_IN_TEMPLATES];
      const tpl = all.find((t) => t.id === id);
      if (tpl) {
        const ta = document.getElementById('entry-body-input');
        ta.value = ta.value ? `${ta.value}\n\n${tpl.body}` : tpl.body;
        if (tpl.mood && !document.getElementById('entry-mood-input').value) {
          document.getElementById('entry-mood-input').value = tpl.mood;
        }
        if (tpl.tags && !document.getElementById('entry-tags-input').value) {
          document.getElementById('entry-tags-input').value = tpl.tags;
        }
        if (tpl.preserveWhitespace) {
          document.getElementById('entry-verse-checkbox').checked = true;
        }
        this.updateComposerCounts();
      }
      ev.target.value = '';
    });

    document.getElementById('entry-save-template-btn')?.addEventListener('click', () => {
      const body = document.getElementById('entry-body-input').value.trim();
      if (!body) {
        this.showToast('Write template prose first.', 'warn');
        return;
      }
      const title =
        document.getElementById('entry-title-input').value.trim() ||
        `Template ${new Date().toLocaleDateString()}`;
      saveCustomTemplate(
        {
          name: title,
          mood: document.getElementById('entry-mood-input').value.trim(),
          tags: document.getElementById('entry-tags-input').value.trim(),
          preserveWhitespace: Boolean(document.getElementById('entry-verse-checkbox')?.checked),
          body,
        },
        this.state.zeroFootprint
      );
      this.populateComposerTemplates();
      this.showToast(`Saved "${title}" to your templates.`, 'success');
    });

    document.getElementById('entry-draw-prompt-btn')?.addEventListener('click', () => {
      const cat = document.getElementById('entry-prompt-category').value;
      const drawn = drawRandomPrompt(cat, this.state.activePromptText);
      if (!drawn) return;
      this.state.activePromptText = drawn.text;
      document.getElementById('entry-prompt-text').textContent = drawn.text;
      document.getElementById('entry-prompt-banner').hidden = false;
    });
    document.getElementById('entry-insert-prompt-btn')?.addEventListener('click', () => {
      if (!this.state.activePromptText) return;
      const ta = document.getElementById('entry-body-input');
      const block = `> **Prompt:** ${this.state.activePromptText}\n\n`;
      ta.value = `${block}${ta.value}`;
      this.updateComposerCounts();
      ta.focus();
    });

    document.getElementById('entry-stamp-weather-btn')?.addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      try {
        const res = await fetchCurrentLocationAndWeather();
        document.getElementById('entry-location-input').value = res.place;
        document.getElementById('entry-weather-input').value = res.weather;
        this.showToast(`Stamped ${res.stampText}.`, 'success');
      } catch (err) {
        this.showToast(err.message, 'warn');
      } finally {
        btn.disabled = false;
      }
    });

    document.getElementById('entry-doublelock-checkbox')?.addEventListener('change', (ev) => {
      document.getElementById('entry-doublelock-fields').hidden = !ev.target.checked;
    });

    document.getElementById('draft-restore-btn')?.addEventListener('click', () => {
      const dateStr = document.getElementById('entry-date-input').value;
      const raw = this.storageGet(`perpetual_diary_draft_${dateStr}`);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      document.getElementById('entry-title-input').value = parsed.title || '';
      document.getElementById('entry-mood-input').value = parsed.mood || '';
      document.getElementById('entry-tags-input').value = parsed.tags || '';
      document.getElementById('entry-body-input').value = parsed.body || '';
      document.getElementById('draft-recovery-banner').hidden = true;
      this.updateComposerCounts();
    });
    document.getElementById('draft-discard-btn')?.addEventListener('click', () => {
      const dateStr = document.getElementById('entry-date-input').value;
      this.storageRemove(`perpetual_diary_draft_${dateStr}`);
      document.getElementById('draft-recovery-banner').hidden = true;
    });

    // Multi-Photo Upload, Sketch Pad & Voice Note Recorder
    document.getElementById('entry-webp-preset')?.addEventListener('change', (ev) => {
      saveWebpPreset(ev.target.value, this.state.zeroFootprint);
    });

    document.getElementById('entry-photo-file')?.addEventListener('change', async (ev) => {
      const files = Array.from(ev.target.files || []);
      if (files.length === 0) return;
      const preset = document.getElementById('entry-webp-preset')?.value || 'balanced';
      const archiveOrig = Boolean(
        document.getElementById('entry-archive-original-checkbox')?.checked
      );
      const dateVal = document.getElementById('entry-date-input').value || getTodayIsoDate();

      for (const file of files) {
        try {
          let originalRef = null;
          if (archiveOrig) {
            const hash = await computeFileShortHash(file);
            const archiveFilename = downloadOriginalForColdArchive(file, dateVal, hash);
            originalRef = { sha256Short: hash, archiveFilename };
          }
          const processed = await processImageFile(file, { preset });
          this.state.entryDraftGallery.push({
            id: `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
            src: '',
            caption: '',
            align: 'full',
            posX: 50,
            posY: 50,
            width: 100,
            height: 240,
            kind: 'photo',
            originalRef,
            _pendingBuffer: processed.arrayBuffer,
            _ext: processed.ext,
            _mime: processed.mime,
            _previewUrl: processed.dataUrl,
            _statsLabel: `${processed.formatLabel} · ${formatBytesCompact(processed.size)}`,
          });
        } catch (err) {
          this.showToast(err.message, 'error');
        }
      }
      await this.syncPrimaryDraftPhotoStudio();
      this.renderDraftGalleryStrip();
      ev.target.value = '';
    });

    document.getElementById('entry-photo-remove-btn')?.addEventListener('click', () => {
      this.state.entryDraftGallery = [];
      this.renderDraftGalleryStrip();
    });

    document.getElementById('entry-sketch-toggle-btn')?.addEventListener('click', () => {
      const panel = document.getElementById('entry-sketch-panel');
      panel.hidden = !panel.hidden;
      if (!panel.hidden && !this.sketchPad) {
        this.sketchPad = new InkSketchPad(document.getElementById('entry-sketch-host'));
        this.sketchPad.mount();
      }
    });
    document.getElementById('entry-sketch-close-btn')?.addEventListener('click', () => {
      document.getElementById('entry-sketch-panel').hidden = true;
    });
    document.getElementById('entry-sketch-attach-btn')?.addEventListener('click', async () => {
      try {
        if (!this.sketchPad) return;
        const exported = await this.sketchPad.exportWebp();
        this.state.entryDraftGallery.push({
          id: `sk-${Date.now().toString(36)}`,
          src: '',
          caption: 'Ink Sketch',
          align: 'center',
          posX: 50,
          posY: 50,
          width: 75,
          height: 240,
          kind: 'sketch',
          _pendingBuffer: exported.arrayBuffer,
          _ext: exported.ext,
          _mime: exported.mime,
          _previewUrl: exported.dataUrl,
          _statsLabel: `Sketch · ${formatBytesCompact(exported.size)}`,
        });
        this.sketchPad.clear();
        document.getElementById('entry-sketch-panel').hidden = true;
        await this.syncPrimaryDraftPhotoStudio();
        this.renderDraftGalleryStrip();
        this.showToast('Ink sketch attached to entry.', 'success');
      } catch (err) {
        this.showToast(err.message, 'warn');
      }
    });

    document.getElementById('voice-record-btn')?.addEventListener('click', async () => {
      if (!isAudioRecordingSupported()) {
        this.showToast('Microphone recording is unavailable in this browser.', 'warn');
        return;
      }
      try {
        this.voiceRecorder = new VoiceNoteRecorder({
          onTick: (sec) => {
            document.getElementById('voice-timer').textContent = formatDurationSec(sec);
          },
          onLevel: (rms) => {
            document.getElementById('voice-meter-fill').style.width = `${Math.round(rms * 100)}%`;
          },
        });
        await this.voiceRecorder.start();
        document.getElementById('voice-record-btn').hidden = true;
        document.getElementById('voice-stop-btn').hidden = false;
      } catch (err) {
        this.showToast(err.message || 'Microphone permission denied.', 'error');
      }
    });

    document.getElementById('voice-stop-btn')?.addEventListener('click', async () => {
      if (!this.voiceRecorder) return;
      const recorded = await this.voiceRecorder.stop();
      document.getElementById('voice-record-btn').hidden = false;
      document.getElementById('voice-stop-btn').hidden = true;
      document.getElementById('voice-meter-fill').style.width = '0%';
      if (recorded) {
        this.state.entryDraftVoice = {
          _pendingBuffer: recorded.arrayBuffer,
          _ext: recorded.ext,
          _mime: recorded.mime,
          _previewUrl: recorded.previewUrl,
          durationSec: recorded.durationSec,
        };
        const audioEl = document.getElementById('voice-draft-preview');
        audioEl.src = recorded.previewUrl;
        audioEl.hidden = false;
        document.getElementById('voice-remove-btn').hidden = false;
      }
    });

    document.getElementById('voice-remove-btn')?.addEventListener('click', () => {
      this.resetVoiceDraftUi();
    });

    // Heatmap, Archive, Word Trend, Dossier, Story Arcs & Print Buttons
    document.getElementById('heatmap-mode-select')?.addEventListener('change', (ev) => {
      this.state.heatmapMode = ev.target.value;
      this.renderHeatmap();
    });

    document.getElementById('load-all-days-btn')?.addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      await this.loadAllIndexedDaysIntoCache(btn);
      btn.textContent = 'All Days Loaded';
      btn.disabled = false;
      await this.renderArchive();
    });

    document.getElementById('analytics-load-all-btn')?.addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      await this.loadAllIndexedDaysIntoCache(btn);
      btn.textContent = 'All Days Decrypted';
      btn.disabled = false;
      await this.renderAnalyticsAndArcs();
    });

    document.getElementById('word-trend-input')?.addEventListener('input', (ev) => {
      this.state.wordTrendQuery = ev.target.value;
      this.renderWordTrendExplorer();
    });
    document.getElementById('word-trend-clear-btn')?.addEventListener('click', () => {
      this.state.wordTrendQuery = '';
      this.renderWordTrendExplorer();
    });

    document.getElementById('archive-search-input')?.addEventListener('input', (ev) => {
      this.state.archiveSearch = ev.target.value;
      this.renderArchive();
    });
    document.getElementById('archive-year-select')?.addEventListener('change', (ev) => {
      this.state.archiveYear = ev.target.value;
      this.renderArchive();
    });

    document.getElementById('print-book-btn')?.addEventListener('click', () => {
      this.triggerPrintEdition(
        openPrintBookWindow,
        {
          title: 'Perpetual Side-by-Side Diary',
          subtitle: 'Archive Print Edition',
          entries: Array.from(this.state.decryptedEntryCache.values()),
        },
        'Print Book'
      );
    });

    document.getElementById('print-zine-btn')?.addEventListener('click', () => {
      this.triggerPrintEdition(
        openMiniZineWindow,
        {
          title: 'Perpetual Pocket Zine',
          entries: Array.from(this.state.decryptedEntryCache.values()),
        },
        '8-Page Mini-Zine'
      );
    });

    document.getElementById('export-json-btn')?.addEventListener('click', () => {
      const payload = {
        exportedAt: new Date().toISOString(),
        index: this.state.indexData,
        days: this.state.dayCache,
      };
      const a = document.createElement('a');
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
      );
      a.href = url;
      a.download = `perpetual-diary-export-${getTodayIsoDate()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    });

    document.getElementById('export-md-btn')?.addEventListener('click', () => {
      const entries = Array.from(this.state.decryptedEntryCache.values()).sort((a, b) =>
        a.diaryDate.localeCompare(b.diaryDate)
      );
      const md = entries
        .map((e) => `# ${e.diaryDate}${e.title ? ` — ${e.title}` : ''}\n\n${e.body}\n`)
        .join('\n---\n\n');
      const a = document.createElement('a');
      const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
      a.href = url;
      a.download = `perpetual-diary-${getTodayIsoDate()}.md`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    });

    document.getElementById('import-diary-file')?.addEventListener('change', async (ev) => {
      const file = ev.target.files?.[0];
      if (!file) return;
      try {
        const parsed = parseImportedDiaryFile(file.name, await file.text());
        if (parsed.entries.length === 0) {
          this.showToast('No valid dated entries found in imported file.', 'warn');
          return;
        }
        for (const imp of parsed.entries) {
          const doc = await this.getDayDocument(imp.dayStr, true);
          const yrKey = String(imp.year);
          const list = getYearEntriesList(doc.entries[yrKey], yrKey, imp.dayStr);
          list.push({
            id: `imp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            year: imp.year,
            diaryDate: imp.diaryDate,
            title: imp.title,
            body: imp.body,
            mood: imp.mood,
            tags: imp.tags,
            location: imp.location || '',
            weather: imp.weather || '',
            artifacts: imp.artifacts || null,
            metrics: imp.metrics || null,
            preserveWhitespace: Boolean(imp.preserveWhitespace),
            wordCount: countWords(stripMarkdown(imp.body)),
            images: [],
            image: null,
            writtenAt: imp.writtenAt,
            updatedAt: new Date().toISOString(),
            encrypted: false,
          });
          doc.entries[yrKey] = list.length === 1 ? list[0] : list;
          await this.persistDayDocument(imp.dayStr, doc, `import: ${imp.diaryDate}`);
        }
        this.showToast(
          `Imported ${parsed.entries.length} entries (${parsed.format}).`,
          'success'
        );
        await this.renderActiveView();
      } catch (err) {
        this.showToast(err.message || 'Import failed.', 'error');
      }
      ev.target.value = '';
    });

    document.getElementById('dossier-year-select')?.addEventListener('change', (ev) => {
      this.state.selectedDossierYear = Number(ev.target.value);
      this.renderAnalyticsAndArcs();
    });
    document.getElementById('dossier-download-md-btn')?.addEventListener('click', () => {
      const dossier = generateYearInReviewDossier(
        this.state.selectedDossierYear,
        this.state.indexData,
        Array.from(this.state.decryptedEntryCache.values())
      );
      const md = renderYearDossierMarkdown(dossier);
      const a = document.createElement('a');
      const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
      a.href = url;
      a.download = `${dossier.year}-year-in-review.md`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    document.getElementById('dossier-print-book-btn')?.addEventListener('click', () => {
      const yr = Number(this.state.selectedDossierYear);
      const entries = Array.from(this.state.decryptedEntryCache.values()).filter(
        (e) => Number(e.year) === yr
      );
      this.triggerPrintEdition(
        openPrintBookWindow,
        { title: `${yr} — Perpetual Year Book`, entries },
        `${yr} Year Book`
      );
    });

    document.getElementById('arc-select')?.addEventListener('change', (ev) => {
      this.state.selectedArcSlug = ev.target.value;
      this.renderAnalyticsAndArcs();
    });
    document.getElementById('arc-print-book-btn')?.addEventListener('click', () => {
      if (!this.state.selectedArcSlug) return;
      const book = buildStoryArcBook(
        this.state.selectedArcSlug,
        Array.from(this.state.decryptedEntryCache.values())
      );
      this.triggerPrintEdition(
        openPrintBookWindow,
        { title: `Story Arc: ${book.title}`, subtitle: book.dateSpan, entries: book.chapters },
        `Story Arc: ${book.title}`
      );
    });

    // Conflict Resolver, Time Machine, Drafts & Share Modals
    document.getElementById('conflict-close-btn')?.addEventListener('click', () => {
      document.getElementById('conflict-modal').hidden = true;
    });
    document.getElementById('conflict-cancel-btn')?.addEventListener('click', () => {
      document.getElementById('conflict-modal').hidden = true;
    });
    document.getElementById('conflict-pick-local-btn')?.addEventListener('click', () => {
      if (!this.state.activeConflict) return;
      document.getElementById('conflict-merged-body').value =
        this.state.activeConflict.localPlain.body;
    });
    document.getElementById('conflict-pick-remote-btn')?.addEventListener('click', () => {
      if (!this.state.activeConflict) return;
      document.getElementById('conflict-merged-body').value =
        this.state.activeConflict.remotePlain.body;
    });
    document.getElementById('conflict-pick-merge-btn')?.addEventListener('click', () => {
      if (!this.state.activeConflict) return;
      const m = buildThreeWayMerge(
        this.state.activeConflict.basePlain.body,
        this.state.activeConflict.localPlain.body,
        this.state.activeConflict.remotePlain.body
      );
      document.getElementById('conflict-merged-body').value = m.mergedText;
    });
    document.getElementById('conflict-form')?.addEventListener('submit', (ev) =>
      this.handleConflictMergeSubmit(ev)
    );

    document.getElementById('history-close-btn')?.addEventListener('click', () => {
      document.getElementById('history-modal').hidden = true;
    });
    document.getElementById('history-cancel-btn')?.addEventListener('click', () => {
      document.getElementById('history-modal').hidden = true;
    });
    document.querySelectorAll('#history-view-toggle .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => this.setHistoryViewMode(btn.dataset.historyMode));
    });
    document.getElementById('history-restore-btn')?.addEventListener('click', async () => {
      const ctx = this.state.activeHistory;
      if (!ctx?.selectedEntry) return;
      document.getElementById('history-modal').hidden = true;
      await this.openComposer({
        editEntry: ctx.selectedEntry,
        dayStr: ctx.dayStr,
        yearKey: ctx.yearKey,
      });
      this.showToast('Historical revision loaded into Composer — review & save to restore.', 'info');
    });

    document.getElementById('drafts-close-btn')?.addEventListener('click', () => {
      document.getElementById('drafts-modal').hidden = true;
    });
    document.getElementById('drafts-done-btn')?.addEventListener('click', () => {
      document.getElementById('drafts-modal').hidden = true;
    });
    document.getElementById('drafts-refresh-btn')?.addEventListener('click', () =>
      this.openDraftsModal()
    );
    document.getElementById('drafts-new-btn')?.addEventListener('click', () => {
      document.getElementById('drafts-modal').hidden = true;
      this.openComposer({ presetDate: getTodayIsoDate() });
    });

    document.getElementById('share-close-btn')?.addEventListener('click', () => {
      document.getElementById('share-modal').hidden = true;
    });
    document.getElementById('share-cancel-btn')?.addEventListener('click', () => {
      document.getElementById('share-modal').hidden = true;
    });
    document.getElementById('share-form')?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (!this.state.pendingShareEntry) return;
      const errEl = document.getElementById('share-error');
      errEl.hidden = true;
      try {
        const res = await createRevocableShareLink({
          entrySnapshot: this.state.pendingShareEntry,
          expiresInHours: Number(document.getElementById('share-expiry-select').value),
          ghClient: this.gh,
          zeroFootprint: this.state.zeroFootprint,
          usePublicAppRepo: Boolean(
            document.getElementById('share-public-repo-checkbox')?.checked
          ),
        });
        document.getElementById('share-result-url').value = res.shareUrl;
        document.getElementById('share-result-box').hidden = false;
      } catch (err) {
        errEl.textContent = err.message;
        errEl.hidden = false;
      }
    });
    document.getElementById('share-copy-url-btn')?.addEventListener('click', () => {
      const url = document.getElementById('share-result-url').value;
      navigator.clipboard?.writeText(url).catch(() => {});
      this.showToast('Zero-knowledge share link copied.', 'success');
    });
    document.getElementById('share-open-preview-btn')?.addEventListener('click', () => {
      const url = document.getElementById('share-result-url').value;
      const hash = url.slice(url.indexOf('#'));
      const parsed = parseShareHash(hash);
      if (parsed) {
        document.getElementById('share-modal').hidden = true;
        this.openSharedEntryViewer(parsed.shareId, parsed.keyB64Url);
      }
    });

    document.getElementById('shared-viewer-exit-btn')?.addEventListener('click', () => {
      document.getElementById('shared-viewer-overlay').hidden = true;
      window.history.replaceState(null, '', '#today');
      this.applyHashRoute();
      this.renderActiveView();
    });

    // GitHub Sync Settings Modal
    document.getElementById('github-close-btn')?.addEventListener('click', () => {
      document.getElementById('github-modal').hidden = true;
    });
    document.getElementById('gh-use-private-vault')?.addEventListener('change', (ev) => {
      document.getElementById('split-vault-fields').hidden = !ev.target.checked;
    });
    document.getElementById('gh-use-media-sharding')?.addEventListener('change', (ev) => {
      document.getElementById('media-shard-fields').hidden = !ev.target.checked;
    });
    document.getElementById('gh-media-shard-pattern')?.addEventListener('input', (ev) => {
      document.getElementById('gh-media-shard-preview').textContent =
        `Active shard: ${resolveShardRepoName(ev.target.value, new Date().getFullYear())}`;
    });
    document.getElementById('gh-test-shard-btn')?.addEventListener('click', async () => {
      const box = document.getElementById('gh-test-result');
      box.hidden = false;
      box.className = 'status-callout';
      box.textContent = 'Testing current year media shard…';
      try {
        const res = await this.gh.testMediaShard(new Date().getFullYear());
        box.className = 'status-callout is-ok';
        box.textContent = `Connected to shard ${res.fullName} (push: ${res.canPush}).`;
      } catch (err) {
        box.className = 'status-callout is-err';
        box.textContent = err.message;
      }
    });

    const readGitHubFormConfig = () => ({
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
      useMediaSharding: Boolean(document.getElementById('gh-use-media-sharding').checked),
      mediaShardPattern:
        document.getElementById('gh-media-shard-pattern').value.trim() || 'diary-media-{year}',
      mediaShardBranch:
        document.getElementById('gh-media-shard-branch').value.trim() || 'main',
      token: document.getElementById('gh-token-input').value.trim(),
      tokenExpiresAt: document.getElementById('gh-token-expiry-input').value.trim(),
      readFromApiWhenAuthed: Boolean(document.getElementById('gh-read-api-checkbox').checked),
    });

    document.getElementById('gh-test-btn')?.addEventListener('click', async () => {
      const box = document.getElementById('gh-test-result');
      box.hidden = false;
      box.className = 'status-callout';
      box.textContent = 'Testing GitHub connection…';
      this.gh.updateConfig(readGitHubFormConfig());
      try {
        const res = await this.gh.testConnection();
        box.className = 'status-callout is-ok';
        box.textContent = `Connected to ${res.fullName} (${
          res.isPrivate ? 'Private' : 'Public'
        } · Write access: ${res.canPush ? 'Verified' : 'Read-only'}).`;
      } catch (err) {
        box.className = 'status-callout is-err';
        box.textContent = err.message;
      }
    });

    document.getElementById('github-form')?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const zf = Boolean(document.getElementById('gh-zero-footprint-checkbox').checked);
      this.setZeroFootprintMode(zf, false);
      this.gh.updateConfig(readGitHubFormConfig());
      this.saveGitHubConfigLocally();
      document.getElementById('github-modal').hidden = true;
      this.state.dayCache = {};
      await this.loadVaultAndIndex();
      this.updateModeBadge();
      if (this.state.unlocked) await this.renderActiveView();
      this.showToast('GitHub sync settings saved.', 'success');
    });

    document.getElementById('gh-clear-token-btn')?.addEventListener('click', () => {
      document.getElementById('gh-token-input').value = '';
      this.gh.updateConfig({ token: '' });
      this.saveGitHubConfigLocally();
      this.updateModeBadge();
      this.showToast('GitHub PAT cleared.', 'info');
    });

    document.getElementById('gh-wipe-local-btn')?.addEventListener('click', async () => {
      const ok = await this.openConfirm({
        title: 'Wipe All Local Browser Traces',
        message:
          'Clears localStorage, sessionStorage, Service Worker caches, and IndexedDB media from this browser. Remote GitHub data is untouched.',
        confirmLabel: 'Wipe Browser Traces',
      });
      if (!ok) return;
      await this.wipeAllLocalBrowserTraces();
      this.showToast('All local browser traces wiped.', 'success');
    });

    // Vault & Encryption Modal
    document.getElementById('vault-close-btn')?.addEventListener('click', () => {
      document.getElementById('vault-modal').hidden = true;
    });
    document.getElementById('vault-cancel-btn')?.addEventListener('click', () => {
      document.getElementById('vault-modal').hidden = true;
    });

    document.getElementById('vault-form')?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const errEl = document.getElementById('vault-error');
      errEl.hidden = true;

      const enabled = Boolean(document.getElementById('vault-lock-enabled-checkbox').checked);
      const autoLockMinutes = Number(document.getElementById('vault-autolock-select').value) || 0;
      const curPass = document.getElementById('vault-current-password').value;
      const newPass = document.getElementById('vault-new-password').value;
      const confirmPass = document.getElementById('vault-confirm-password').value;
      const encryptPat = Boolean(document.getElementById('vault-encrypt-pat-checkbox').checked);

      if (newPass && newPass !== confirmPass) {
        errEl.textContent = 'New password and confirmation do not match.';
        errEl.hidden = false;
        return;
      }

      try {
        if (!this.hasConfiguredVault()) {
          if (!newPass || newPass.length < 4) {
            throw new Error('Master password must be at least 4 characters.');
          }
          const created = await createEnvelopeVault(newPass, {
            enabled,
            autoLockMinutes,
            patToken: encryptPat ? this.gh.config.token : null,
          });
          this.setActiveKeyring(created.keyring);
          this.state.unlocked = true;
          await this.persistVaultMeta(created.vaultMeta, 'diary: initialize v2 envelope vault');
        } else if (newPass) {
          const rotated = curPass
            ? await rotateVaultPassword(this.state.vaultMeta, curPass, newPass, {
                enabled,
                autoLockMinutes,
                encryptPat,
                patToken: this.gh.config.token,
              })
            : await rotateVaultPasswordWithKeyring(
                this.state.vaultMeta,
                this.state.keyring,
                newPass,
                {
                  enabled,
                  autoLockMinutes,
                  encryptPat,
                  patToken: this.gh.config.token,
                }
              );
          this.setActiveKeyring(rotated.keyring);
          await this.persistVaultMeta(rotated.vaultMeta, 'diary: rotate master password');
        } else {
          const nextMeta = {
            ...this.state.vaultMeta,
            enabled,
            autoLockMinutes,
            encryptedPat:
              encryptPat && this.gh.config.token && this.hasActiveSessionKey()
                ? await encryptPatToken(
                    this.gh.config.token,
                    this.state.keyring || this.state.cryptoKey
                  )
                : encryptPat
                  ? this.state.vaultMeta.encryptedPat || null
                  : null,
            updatedAt: new Date().toISOString(),
          };
          await this.persistVaultMeta(nextMeta, 'diary: update vault policy');
        }

        this.state.autoLockMinutes = autoLockMinutes;
        this.storageSet(AUTOLOCK_STORAGE_KEY, String(autoLockMinutes));
        this.startAutoLockMonitor();
        this.updateModeBadge();
        document.getElementById('vault-modal').hidden = true;
        this.showToast('Vault settings saved.', 'success');
      } catch (err) {
        errEl.textContent = err.message || 'Vault save failed.';
        errEl.hidden = false;
      }
    });

    document.getElementById('vault-disable-btn')?.addEventListener('click', async () => {
      if (!this.state.vaultMeta) return;
      const nextMeta = {
        ...this.state.vaultMeta,
        enabled: false,
        updatedAt: new Date().toISOString(),
      };
      await this.persistVaultMeta(nextMeta, 'diary: disable lock screen');
      document.getElementById('vault-modal').hidden = true;
      this.showToast('Lock screen disabled.', 'info');
    });

    document.getElementById('vault-upgrade-btn')?.addEventListener('click', async () => {
      const curPass = document.getElementById('vault-current-password').value;
      const errEl = document.getElementById('vault-error');
      errEl.hidden = true;
      try {
        const res = await upgradeLegacyVaultToEnvelope(this.state.vaultMeta, curPass, {
          patToken: this.gh.config.token,
        });
        this.setActiveKeyring(res.keyring);
        await this.persistVaultMeta(res.vaultMeta, 'diary: upgrade to v2 envelope vault');
        this.openVaultModal();
        this.showToast('Upgraded to v2 Envelope Encryption.', 'success');
      } catch (err) {
        errEl.textContent = err.message;
        errEl.hidden = false;
      }
    });

    document.getElementById('vault-upgrade-argon2-btn')?.addEventListener('click', async () => {
      const curPass = document.getElementById('vault-current-password').value;
      const presetKey = document.getElementById('vault-argon2-preset').value;
      const preset = ARGON2ID_PRESETS[presetKey] || ARGON2ID_PRESETS.balanced;
      const statusEl = document.getElementById('vault-argon2-status');
      statusEl.hidden = false;
      statusEl.textContent = 'Deriving Argon2id slot in background Web Worker…';
      try {
        const res = await upgradePasswordSlotKdf(this.state.vaultMeta, curPass, {
          kdf: 'Argon2id',
          memoryKiB: preset.memoryKiB,
          timeCost: preset.timeCost,
        });
        this.setActiveKeyring(res.keyring);
        await this.persistVaultMeta(res.vaultMeta, 'diary: upgrade password slot to Argon2id');
        statusEl.textContent = `Upgraded to ${preset.label}.`;
        this.openVaultModal();
        this.showToast('Password slot upgraded to Argon2id.', 'success');
      } catch (err) {
        statusEl.textContent = err.message;
      }
    });

    document.getElementById('vault-gen-recovery-btn')?.addEventListener('click', async () => {
      try {
        const res = await attachPaperRecoverySlot(this.state.vaultMeta, this.state.keyring);
        this.state.recentRecoveryCode = res.recoveryCode;
        await this.persistVaultMeta(res.vaultMeta, 'diary: enroll 256-bit paper recovery slot');
        document.getElementById('vault-recovery-code-display').textContent = res.recoveryCode;
        document.getElementById('vault-recovery-code-box').hidden = false;
        document.getElementById('vault-print-card-btn').disabled = false;
        this.showToast('256-bit Paper Recovery Key generated — print or store it safely.', 'success');
      } catch (err) {
        this.showToast(err.message, 'error');
      }
    });

    document.getElementById('vault-print-card-btn')?.addEventListener('click', () => {
      if (!this.state.recentRecoveryCode) return;
      openPrintableRecoveryCard({
        recoveryCode: this.state.recentRecoveryCode,
        dekFingerprint: this.state.vaultMeta?.dekFingerprint || '',
        vaultMeta: this.state.vaultMeta,
        repoConfig: this.gh.config,
      });
    });

    document.getElementById('vault-download-decryptor-btn')?.addEventListener('click', () => {
      const html = buildOfflineDecryptorHtml({
        vaultMeta: this.state.vaultMeta,
        repoConfig: this.gh.config,
      });
      const a = document.createElement('a');
      const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
      a.href = url;
      a.download = `perpetual-offline-decryptor-${getTodayIsoDate()}.html`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1500);
    });

    document.getElementById('vault-migrate-media-btn')?.addEventListener('click', async () => {
      const statusEl = document.getElementById('vault-media-migrate-status');
      statusEl.hidden = false;
      try {
        const res = await migratePlaintextMediaToEncryptedVault({
          app: this,
          onProgress: (msg) => {
            statusEl.textContent = msg;
          },
        });
        statusEl.textContent = `Encrypted ${res.encryptedCount} photo(s) across ${res.updatedDays} day(s).`;
        this.showToast(`Encrypted ${res.encryptedCount} photo(s) into .enc vault.`, 'success');
      } catch (err) {
        statusEl.textContent = err.message;
      }
    });

    document.getElementById('vault-migrate-cloak-btn')?.addEventListener('click', async () => {
      const statusEl = document.getElementById('vault-cloak-migrate-status');
      statusEl.hidden = false;
      try {
        const res = await migrateRepositoryToCloakedMode({
          app: this,
          onProgress: (msg) => {
            statusEl.textContent = msg;
          },
        });
        statusEl.textContent = `Cloaked ${res.migratedDays} day(s) into HMAC shards + index.enc.`;
        this.updateModeBadge();
        this.openVaultModal();
        this.showToast('Repository migrated to Metadata Cloaking.', 'success');
      } catch (err) {
        statusEl.textContent = err.message;
      }
    });

    document.getElementById('vault-register-passkey-btn')?.addEventListener('click', async () => {
      try {
        const label =
          document.getElementById('vault-passkey-label-input').value.trim() ||
          'Biometric Passkey';
        const res = await registerPasskeySlot(this.state.vaultMeta, this.state.keyring, {
          label,
        });
        await this.persistVaultMeta(res.vaultMeta, 'diary: enroll biometric passkey slot');
        this.openVaultModal();
        this.showToast(`Enrolled passkey "${label}".`, 'success');
      } catch (err) {
        this.showToast(err.message, 'error');
      }
    });

    document.getElementById('vault-save-decoy-btn')?.addEventListener('click', async () => {
      const p1 = document.getElementById('vault-decoy-password').value;
      const p2 = document.getElementById('vault-decoy-confirm').value;
      if (p1 !== p2) {
        this.showToast('Decoy passwords do not match.', 'warn');
        return;
      }
      try {
        const includePlaintext = Boolean(
          document.getElementById('vault-decoy-include-plain').checked
        );
        const res = await configureDecoyVault(this.state.vaultMeta, p1, { includePlaintext });
        await this.persistVaultMeta(res.vaultMeta, 'diary: update vault profile');
        document.getElementById('vault-decoy-password').value = '';
        document.getElementById('vault-decoy-confirm').value = '';
        this.openVaultModal();
        this.showToast('Decoy vault profile saved.', 'success');
      } catch (err) {
        this.showToast(err.message, 'error');
      }
    });

    document.getElementById('vault-remove-decoy-btn')?.addEventListener('click', async () => {
      const next = removeDecoyVault(this.state.vaultMeta);
      await this.persistVaultMeta(next, 'diary: remove secondary vault profile');
      this.openVaultModal();
      this.showToast('Decoy profile removed.', 'info');
    });

    // Command Palette Input & Keyboard Navigation
    document.getElementById('cmdk-input')?.addEventListener('input', (ev) => {
      this.state.cmdkSelectedIndex = 0;
      this.renderCommandPaletteResults(ev.target.value);
    });
    document.getElementById('cmdk-input')?.addEventListener('keydown', (ev) => {
      const items = this.state.cmdkItems || [];
      if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        this.state.cmdkSelectedIndex = (this.state.cmdkSelectedIndex + 1) % Math.max(1, items.length);
        this.renderCommandPaletteResults(ev.target.value);
      } else if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        this.state.cmdkSelectedIndex =
          (this.state.cmdkSelectedIndex - 1 + Math.max(1, items.length)) %
          Math.max(1, items.length);
        this.renderCommandPaletteResults(ev.target.value);
      } else if (ev.key === 'Enter' && items[this.state.cmdkSelectedIndex]) {
        ev.preventDefault();
        document.getElementById('cmdk-modal').hidden = true;
        items[this.state.cmdkSelectedIndex].run();
      }
    });
    document.getElementById('cmdk-modal')?.addEventListener('click', (ev) => {
      if (ev.target.id === 'cmdk-modal') ev.target.hidden = true;
    });

    // Confirmation Dialog
    document.getElementById('confirm-close-btn')?.addEventListener('click', () =>
      this.closeConfirm(false)
    );
    document.getElementById('confirm-cancel-btn')?.addEventListener('click', () =>
      this.closeConfirm(false)
    );
    document.getElementById('confirm-ok-btn')?.addEventListener('click', () =>
      this.closeConfirm(true)
    );
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const app = new PerpetualDiaryApp();
  window.perpetualDiary = app;
  app.init().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('PerpetualDiary initialization error:', err);
  });
});
