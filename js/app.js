/**
 * Perpetual Side-by-Side Web Diary — Main Application Controller
 * Coordinates Vault cryptography, Side-by-Side Reader, Custom Compare 2,
 * Per-Day Comments & Passage Quoting, Flexible Entry Composer (Create/Edit/Move/Delete),
 * Hold-and-Drag Photo Alignment, 366-Day Heatmap, Archive/Search, Ownership Exports,
 * and Live GitHub <-> Neocities synchronization with Local Sandbox fallback.
 */

import {
  DEFAULT_ITERATIONS,
  isEncryptedPayload,
  encryptText,
  decryptText,
  createVaultConfig,
  verifyVaultPassword,
  encryptPat,
  decryptPat,
} from './crypto.js';

import {
  escapeHtml,
  sanitizeUrl,
  renderMarkdown,
  stripMarkdown,
  countWords,
  countChars,
  extractDefaultQuote,
} from './markdown.js';

import {
  emptyDayData,
  recalculateIndexForDay,
  GitHubClient,
} from './github.js';

import {
  DEFAULT_IMAGE_META,
  LocalMediaStore,
  processImageFile,
  buildMediaFilename,
  resolveMediaSrc,
  normalizeImageMeta,
  AlignmentStudio,
  attachInlineAlignController,
} from './media.js';

/* ==========================================================================
   CONSTANTS & STORAGE KEYS
   ========================================================================== */
const LS_THEME_KEY = 'perpetual_theme_v1';
const LS_GH_CONFIG_KEY = 'perpetual_gh_config_v1';
const LS_GH_PAT_ENC_KEY = 'perpetual_gh_pat_enc_v1';
const LS_SANDBOX_KEY = 'perpetual_sandbox_v1';
const LS_PREFS_KEY = 'perpetual_ui_prefs_v1';
const LS_DRAFT_PREFIX = 'perpetual_draft_v1:';
const SS_PASSPHRASE_KEY = 'perpetual_session_pass_v1';

const MONTHS = Object.freeze([
  { num: 1, name: 'January', short: 'JAN', days: 31 },
  { num: 2, name: 'February', short: 'FEB', days: 29 }, // Perpetual calendar includes Feb 29
  { num: 3, name: 'March', short: 'MAR', days: 31 },
  { num: 4, name: 'April', short: 'APR', days: 30 },
  { num: 5, name: 'May', short: 'MAY', days: 31 },
  { num: 6, name: 'June', short: 'JUN', days: 30 },
  { num: 7, name: 'July', short: 'JUL', days: 31 },
  { num: 8, name: 'August', short: 'AUG', days: 31 },
  { num: 9, name: 'September', short: 'SEP', days: 30 },
  { num: 10, name: 'October', short: 'OCT', days: 31 },
  { num: 11, name: 'November', short: 'NOV', days: 30 },
  { num: 12, name: 'December', short: 'DEC', days: 31 },
]);

/* ==========================================================================
   PRE-SEEDED SANDBOX DATA (Graceful out-of-the-box experience)
   ========================================================================== */
function createBuiltInSeed() {
  const sampleDay = {
    day: '11-24',
    entries: {
      '2024': {
        year: 2024,
        diaryDate: '2024-11-24',
        title: 'First frost & a quiet ledger',
        body:
          'Started keeping a perpetual diary today instead of letting notebooks vanish into boxes.\n\n' +
          '> The value of a daily record is rarely visible in the same week you write it; it reveals itself three Novembers later.\n\n' +
          'Walked around the block after rain. Made pour-over coffee and wrote down three small things I want to stay true to:\n\n' +
          '- Keep notes honest rather than theatrical\n' +
          '- Measure progress in seasons, not hours\n' +
          '- Return to this exact page next year',
        tags: ['reflection', 'beginnings', 'autumn'],
        mood: 'grounded',
        image: null,
        writtenAt: '2024-11-24T21:10:00Z',
        updatedAt: '2024-11-24T21:10:00Z',
        encrypted: false,
      },
      '2025': {
        year: 2025,
        diaryDate: '2025-11-24',
        title: 'Reading myself from a year ago',
        body:
          'Seeing 2024 sitting right beside today feels surreal. Almost everything I worried about last November resolved quietly without drama.\n\n' +
          'Finished reorganizing my desk and backed up all my photo folders. Note to 2026 me: **protect your mornings** before opening messages.',
        tags: ['reflection', 'routine'],
        mood: 'clear',
        image: null,
        writtenAt: '2025-11-26T22:15:00Z',
        updatedAt: '2025-11-26T22:20:00Z',
        encrypted: false,
      },
      '2026': {
        year: 2026,
        diaryDate: '2026-11-24',
        title: 'Three columns side by side',
        body:
          'This site is now running as a static perpetual archive—zero third-party databases, plain JSON files, and client-side AES-256-GCM encryption whenever I want entries sealed.\n\n' +
          'Try **highlighting any sentence** in this column to quote it into a margin comment below, or click **Write Entry** to add a new year or attach a drag-aligned photograph.',
        tags: ['reflection', 'craft', 'archive'],
        mood: 'focused',
        image: null,
        writtenAt: '2026-11-24T16:40:00Z',
        updatedAt: '2026-11-24T16:40:00Z',
        encrypted: false,
      },
    },
    comments: [
      {
        id: 'cmt-1732460500',
        author: 'Self',
        body: 'Still holds true two years later. Looking across all three columns makes the long arc obvious in a single glance.',
        createdAt: '2026-11-24T17:05:00Z',
        updatedAt: '2026-11-24T17:05:00Z',
        encrypted: false,
        quote: {
          text: 'The value of a daily record is rarely visible in the same week you write it; it reveals itself three Novembers later.',
          year: 2024,
          diaryDate: '2024-11-24',
        },
        image: null,
      },
    ],
  };

  const index = recalculateIndexForDay({ version: 1, updatedAt: new Date().toISOString(), days: {} }, '11-24', sampleDay);
  return {
    index,
    days: { '11-24': sampleDay },
    vault: {
      version: 1,
      enabled: false,
      kdf: 'PBKDF2-SHA256',
      iterations: DEFAULT_ITERATIONS,
      salt: null,
      canaryCipher: null,
      encryptedPat: null,
      updatedAt: null,
    },
  };
}

/* ==========================================================================
   DATE UTILITIES
   ========================================================================== */
function pad2(n) {
  return String(n).padStart(2, '0');
}

function getTodayYmd() {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

function getTodayMmDd() {
  const now = new Date();
  return `${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

function isValidMmDd(mmdd) {
  const match = /^(\d{2})-(\d{2})$/.exec(String(mmdd || ''));
  if (!match) return false;
  const m = Number(match[1]);
  const d = Number(match[2]);
  const mInfo = MONTHS[m - 1];
  return Boolean(mInfo && d >= 1 && d <= mInfo.days);
}

function isValidYmd(ymd) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!match) return false;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function splitYmd(ymd) {
  const [y, m, d] = String(ymd).split('-');
  return { year: Number(y), yearStr: y, mmdd: `${m}-${d}` };
}

function formatHumanMmDd(mmdd) {
  const [mStr, dStr] = String(mmdd).split('-');
  const mInfo = MONTHS[Number(mStr) - 1];
  if (!mInfo) return mmdd;
  return `${mInfo.name} ${Number(dStr)}`;
}

function stepMmDd(mmdd, delta) {
  const [mStr, dStr] = String(mmdd).split('-');
  let m = Number(mStr);
  let d = Number(dStr) + delta;

  if (d > MONTHS[m - 1].days) {
    d = 1;
    m = m === 12 ? 1 : m + 1;
  } else if (d < 1) {
    m = m === 1 ? 12 : m - 1;
    d = MONTHS[m - 1].days;
  }
  return `${pad2(m)}-${pad2(d)}`;
}

function computeBackdateDiffDays(diaryDate, writtenAtIso) {
  if (!isValidYmd(diaryDate) || !writtenAtIso) return 0;
  const writtenDt = new Date(writtenAtIso);
  if (Number.isNaN(writtenDt.getTime())) return 0;

  const [y, m, d] = diaryDate.split('-').map(Number);
  const diaryUtc = Date.UTC(y, m - 1, d);
  const writtenUtc = Date.UTC(
    writtenDt.getFullYear(),
    writtenDt.getMonth(),
    writtenDt.getDate()
  );

  return Math.round((writtenUtc - diaryUtc) / 86400000);
}

function formatBackdateBadge(diffDays) {
  if (!diffDays) return '';
  if (diffDays > 0) return `BACKDATED +${diffDays}d`;
  return `FUTURE ${diffDays}d`;
}

function formatShortTimestamp(iso) {
  if (!iso) return '';
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/* ==========================================================================
   APPLICATION STATE & CORE INSTANCES
   ========================================================================== */
const github = new GitHubClient();
const localMedia = new LocalMediaStore();

const state = {
  view: 'reader', // 'reader' | 'heatmap' | 'archive'
  activeMmDd: getTodayMmDd(),
  sizeMode: 'fit', // 'fit' | 'compact' | 'standard' | 'wide'
  sortOrder: 'asc', // 'asc' | 'desc'
  pinnedYear: null,
  mobileLayout: 'swipe', // 'swipe' | 'tabs'
  mobileActiveYear: null,

  // Compare 2 arbitrary dates mode
  compareMode: false,
  compareDateA: '',
  compareDateB: '',
  compareFilterYears: null, // Optional ?compare=2024,2026 filter on single day

  // Data caches
  index: { version: 1, updatedAt: null, days: {} },
  dayCache: new Map(), // mmdd -> dayData
  vault: {
    version: 1,
    enabled: false,
    kdf: 'PBKDF2-SHA256',
    iterations: DEFAULT_ITERATIONS,
    salt: null,
    canaryCipher: null,
    encryptedPat: null,
    updatedAt: null,
  },

  // Security / Session state (kept strictly in volatile memory unless user checks session option)
  passphrase: '',
  vaultUnlocked: false,

  // Composer state
  composer: {
    isOpen: false,
    mode: 'create', // 'create' | 'edit'
    originalDate: null, // YYYY-MM-DD when editing
    originalWrittenAt: null,
    originalImageSrc: null,
    editorMode: 'write', // 'write' | 'split' | 'preview'
    pendingUpload: null, // { blob, arrayBuffer, ext, previewUrl }
    imageMeta: null,
    draftTimer: null,
    studio: null,
  },

  // Comment composer state
  commentComposer: {
    editingId: null,
    originalCreatedAt: null,
    originalImageSrc: null,
    quote: null, // { text, year, diaryDate }
    pendingUpload: null,
    imageMeta: null,
    studio: null,
  },

  // Highlight-to-quote selection snapshot
  selectionQuote: null, // { text, year, diaryDate }

  // Archive filters
  archive: {
    query: '',
    year: 'all',
    tag: '',
    loadedAll: false,
  },

  // Active inline alignment controllers (destroyed on re-render)
  inlineAlignControllers: [],

  // Active confirm resolver
  confirmResolver: null,
};

/* ==========================================================================
   DOM REFERENCES (Locked to Part 1 HTML Contract)
   ========================================================================== */
const $ = (id) => document.getElementById(id);

const dom = {
  // Lock screen
  lockScreen: $('lock-screen'),
  lockForm: $('lock-form'),
  lockPasswordInput: $('lock-password-input'),
  lockRememberSession: $('lock-remember-session'),
  lockSubmitBtn: $('lock-submit-btn'),
  lockError: $('lock-error'),
  lockSubtitle: $('lock-subtitle'),

  // Header
  brandHomeBtn: $('brand-home-btn'),
  modeBadge: $('mode-badge'),
  navReaderBtn: $('nav-reader-btn'),
  navHeatmapBtn: $('nav-heatmap-btn'),
  navArchiveBtn: $('nav-archive-btn'),
  btnNewEntry: $('btn-new-entry'),
  btnVaultSettings: $('btn-vault-settings'),
  btnLockNow: $('btn-lock-now'),
  btnGithubSettings: $('btn-github-settings'),
  btnThemeToggle: $('btn-theme-toggle'),

  // Views
  viewReader: $('view-reader'),
  viewHeatmap: $('view-heatmap'),
  viewArchive: $('view-archive'),

  // Reader toolbar
  selectMonth: $('select-month'),
  selectDay: $('select-day'),
  btnPrevDay: $('btn-prev-day'),
  btnNextDay: $('btn-next-day'),
  readerDateHeading: $('reader-date-heading'),
  readerYearCount: $('reader-year-count'),
  btnToday: $('btn-today'),
  btnNextRecorded: $('btn-next-recorded'),
  btnRandomDay: $('btn-random-day'),
  btnJumpComments: $('btn-jump-comments'),
  commentsCountBadge: $('comments-count-badge'),
  sizingControl: $('sizing-control'),
  btnSortOrder: $('btn-sort-order'),
  btnCompareMode: $('btn-compare-mode'),
  btnMobileLayout: $('btn-mobile-layout'),
  btnCopyPermalink: $('btn-copy-permalink'),
  compareBar: $('compare-bar'),
  compareDateA: $('compare-date-a'),
  btnCompareSwap: $('btn-compare-swap'),
  compareDateB: $('compare-date-b'),
  btnCompareApply: $('btn-compare-apply'),
  btnCompareExit: $('btn-compare-exit'),
  mobileYearTabs: $('mobile-year-tabs'),
  columnsTrack: $('columns-track'),

  // Comments & Quoting
  commentsSection: $('comments-section'),
  commentsHeading: $('comments-heading'),
  commentsList: $('comments-list'),
  commentForm: $('comment-form'),
  commentEditingBanner: $('comment-editing-banner'),
  commentEditingLabel: $('comment-editing-label'),
  btnCancelCommentEdit: $('btn-cancel-comment-edit'),
  commentQuotePreview: $('comment-quote-preview'),
  commentQuoteMeta: $('comment-quote-meta'),
  commentQuoteText: $('comment-quote-text'),
  btnRemoveCommentQuote: $('btn-remove-comment-quote'),
  commentAuthorInput: $('comment-author-input'),
  commentBodyInput: $('comment-body-input'),
  commentEncryptWrap: $('comment-encrypt-wrap'),
  commentEncryptCheckbox: $('comment-encrypt-checkbox'),
  commentPhotoToggleBtn: $('comment-photo-toggle-btn'),
  commentPhotoPanel: $('comment-photo-panel'),
  commentPhotoFile: $('comment-photo-file'),
  commentPhotoUrl: $('comment-photo-url'),
  commentPhotoUrlApply: $('comment-photo-url-apply'),
  commentPhotoRemoveBtn: $('comment-photo-remove-btn'),
  commentAlignmentStudio: $('comment-alignment-studio'),
  commentSubmitBtn: $('comment-submit-btn'),
  quotePopover: $('quote-popover'),
  btnQuoteSelection: $('btn-quote-selection'),

  // Heatmap
  heatmapStats: $('heatmap-stats'),
  heatmapYearFilter: $('heatmap-year-filter'),
  heatmapGrid: $('heatmap-grid'),
  heatmapTooltip: $('heatmap-tooltip'),

  // Archive
  archiveSearchInput: $('archive-search-input'),
  archiveYearFilter: $('archive-year-filter'),
  archiveTagCloud: $('archive-tag-cloud'),
  btnLoadAllDays: $('btn-load-all-days'),
  archiveLoadStatus: $('archive-load-status'),
  btnExportJson: $('btn-export-json'),
  btnExportMd: $('btn-export-md'),
  archiveResults: $('archive-results'),

  // Entry Composer Modal
  modalComposer: $('modal-composer'),
  composerTitleHeading: $('composer-title-heading'),
  btnCloseComposer: $('btn-close-composer'),
  composerDraftBanner: $('composer-draft-banner'),
  btnRestoreDraft: $('btn-restore-draft'),
  btnDiscardDraft: $('btn-discard-draft'),
  composerForm: $('composer-form'),
  composerDate: $('composer-date'),
  composerBackdateIndicator: $('composer-backdate-indicator'),
  composerTitle: $('composer-title'),
  composerMood: $('composer-mood'),
  composerTags: $('composer-tags'),
  composerEncryptWrap: $('composer-encrypt-wrap'),
  composerEncryptCheckbox: $('composer-encrypt-checkbox'),
  composerMdToolbar: $('composer-md-toolbar'),
  composerViewTabs: $('composer-view-tabs'),
  composerEditorGrid: $('composer-editor-grid'),
  composerBody: $('composer-body'),
  composerPreview: $('composer-preview'),
  composerCounts: $('composer-counts'),
  composerPhotoFile: $('composer-photo-file'),
  composerPhotoUrl: $('composer-photo-url'),
  composerPhotoUrlApply: $('composer-photo-url-apply'),
  composerPhotoRemoveBtn: $('composer-photo-remove-btn'),
  composerAlignmentStudio: $('composer-alignment-studio'),
  btnComposerDelete: $('btn-composer-delete'),
  btnComposerCancel: $('btn-composer-cancel'),
  btnComposerSave: $('btn-composer-save'),

  // GitHub Settings Modal
  modalGithub: $('modal-github'),
  btnCloseGithub: $('btn-close-github'),
  githubForm: $('github-form'),
  ghOwner: $('gh-owner'),
  ghRepo: $('gh-repo'),
  ghBranch: $('gh-branch'),
  ghDataPath: $('gh-data-path'),
  ghToken: $('gh-token'),
  ghReadApi: $('gh-read-api'),
  ghEncryptPatLocal: $('gh-encrypt-pat-local'),
  ghTestResult: $('gh-test-result'),
  btnGhTest: $('btn-gh-test'),
  btnGhClear: $('btn-gh-clear'),
  btnGhSave: $('btn-gh-save'),

  // Vault Modal
  modalVault: $('modal-vault'),
  btnCloseVault: $('btn-close-vault'),
  vaultStatusBox: $('vault-status-box'),
  vaultForm: $('vault-form'),
  vaultEnabledCheckbox: $('vault-enabled-checkbox'),
  vaultCurrentPasswordGroup: $('vault-current-password-group'),
  vaultCurrentPassword: $('vault-current-password'),
  vaultNewPassword: $('vault-new-password'),
  vaultConfirmPassword: $('vault-confirm-password'),
  vaultStorePatInVault: $('vault-store-pat-in-vault'),
  vaultFormError: $('vault-form-error'),
  btnVaultDisable: $('btn-vault-disable'),
  btnVaultSave: $('btn-vault-save'),

  // Confirm Dialog & Toasts
  modalConfirm: $('modal-confirm'),
  confirmTitle: $('confirm-title'),
  confirmMessage: $('confirm-message'),
  confirmExtraWrap: $('confirm-extra-wrap'),
  confirmExtraCheckbox: $('confirm-extra-checkbox'),
  confirmExtraLabel: $('confirm-extra-label'),
  btnConfirmCancel: $('btn-confirm-cancel'),
  btnConfirmOk: $('btn-confirm-ok'),
  toastContainer: $('toast-container'),
};

/* ==========================================================================
   TOAST NOTIFICATIONS & CUSTOM CONFIRM MODAL (Zero alert/confirm)
   ========================================================================== */
function showToast(message, type = 'info', durationMs = 3800) {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.setAttribute('role', 'status');

  const textSpan = document.createElement('span');
  textSpan.textContent = String(message || '');

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'btn btn-ghost btn-xs';
  closeBtn.textContent = '✕';
  closeBtn.setAttribute('aria-label', 'Dismiss notification');

  const dismiss = () => {
    if (toast.parentNode) toast.remove();
  };
  closeBtn.addEventListener('click', dismiss);

  toast.appendChild(textSpan);
  toast.appendChild(closeBtn);
  dom.toastContainer.appendChild(toast);

  if (durationMs > 0) {
    setTimeout(dismiss, durationMs);
  }
}

/**
 * Displays the custom in-app confirmation modal.
 * @param {{
 *   title?: string,
 *   message: string,
 *   confirmText?: string,
 *   danger?: boolean,
 *   extraCheckboxLabel?: string,
 *   extraCheckboxDefault?: boolean
 * }} opts
 * @returns {Promise<{ confirmed: boolean, extraChecked: boolean }>}
 */
function showConfirm(opts) {
  return new Promise((resolve) => {
    dom.confirmTitle.textContent = opts.title || 'Confirm Action';
    dom.confirmMessage.textContent = opts.message || '';
    dom.btnConfirmOk.textContent = opts.confirmText || 'Confirm';
    dom.btnConfirmOk.className = opts.danger !== false ? 'btn btn-danger' : 'btn btn-primary';

    if (opts.extraCheckboxLabel) {
      dom.confirmExtraWrap.hidden = false;
      dom.confirmExtraLabel.textContent = opts.extraCheckboxLabel;
      dom.confirmExtraCheckbox.checked = Boolean(opts.extraCheckboxDefault);
    } else {
      dom.confirmExtraWrap.hidden = true;
      dom.confirmExtraCheckbox.checked = false;
    }

    state.confirmResolver = resolve;
    dom.modalConfirm.hidden = false;
    dom.btnConfirmCancel.focus();
  });
}

function closeConfirm(confirmed) {
  dom.modalConfirm.hidden = true;
  if (state.confirmResolver) {
    const resolve = state.confirmResolver;
    state.confirmResolver = null;
    resolve({
      confirmed: Boolean(confirmed),
      extraChecked: Boolean(dom.confirmExtraCheckbox.checked),
    });
  }
}

/* ==========================================================================
   LOCAL SANDBOX & PERSISTENCE LAYER
   ========================================================================== */
function loadSandboxStore() {
  try {
    const raw = localStorage.getItem(LS_SANDBOX_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.days) {
        return parsed;
      }
    }
  } catch {
    // Corrupted localStorage fallback
  }
  return null;
}

function saveSandboxStore(storeObj) {
  try {
    localStorage.setItem(LS_SANDBOX_KEY, JSON.stringify(storeObj));
  } catch (err) {
    showToast(`Local sandbox storage warning: ${err.message}`, 'error');
  }
}

function ensureSandboxStoreInitialized() {
  let store = loadSandboxStore();
  if (!store) {
    store = createBuiltInSeed();
    saveSandboxStore(store);
  }
  return store;
}

function loadUiPrefs() {
  try {
    const raw = localStorage.getItem(LS_PREFS_KEY);
    if (!raw) return;
    const p = JSON.parse(raw);
    if (['fit', 'compact', 'standard', 'wide'].includes(p.sizeMode)) state.sizeMode = p.sizeMode;
    if (['asc', 'desc'].includes(p.sortOrder)) state.sortOrder = p.sortOrder;
    if (['swipe', 'tabs'].includes(p.mobileLayout)) state.mobileLayout = p.mobileLayout;
  } catch {
    // Ignore invalid prefs
  }
}

function saveUiPrefs() {
  try {
    localStorage.setItem(
      LS_PREFS_KEY,
      JSON.stringify({
        sizeMode: state.sizeMode,
        sortOrder: state.sortOrder,
        mobileLayout: state.mobileLayout,
      })
    );
  } catch {
    // Ignore storage failures
  }
}

function loadGithubConfigFromStorage() {
  try {
    const raw = localStorage.getItem(LS_GH_CONFIG_KEY);
    if (!raw) return;
    const cfg = JSON.parse(raw);
    github.updateConfig({
      owner: cfg.owner || '',
      repo: cfg.repo || '',
      branch: cfg.branch || 'main',
      dataPath: cfg.dataPath || 'data',
      readFromApi: cfg.readFromApi !== false,
      // Plaintext token is only stored if user did NOT choose encrypted PAT mode
      token: cfg.token || '',
    });
  } catch {
    // Ignore invalid config
  }
}

function persistGithubConfig(options = {}) {
  const storePlainToken = Boolean(options.storePlainToken);
  const payload = {
    owner: github.owner,
    repo: github.repo,
    branch: github.branch,
    dataPath: github.dataPath,
    readFromApi: github.readFromApi,
    token: storePlainToken ? github.token : '',
    encryptPatLocal: Boolean(options.encryptPatLocal),
  };
  localStorage.setItem(LS_GH_CONFIG_KEY, JSON.stringify(payload));
}

function isLiveMode() {
  return github.canWrite();
}

function updateModeBadge() {
  if (isLiveMode()) {
    dom.modeBadge.textContent = 'LIVE · GITHUB';
    dom.modeBadge.className = 'mode-badge mode-live';
    dom.modeBadge.title = `Connected to ${github.owner}/${github.repo} (${github.branch})`;
  } else {
    dom.modeBadge.textContent = 'SANDBOX';
    dom.modeBadge.className = 'mode-badge mode-sandbox';
    dom.modeBadge.title = 'Local Sandbox Mode (localStorage + IndexedDB). Press Ctrl+Shift+G to connect GitHub.';
  }
}

/* ==========================================================================
   UNIFIED DATA REPOSITORY (GitHub Live <-> Static Neocities <-> Local Sandbox)
   ========================================================================== */
async function loadVaultMetadata() {
  if (isLiveMode()) {
    try {
      const res = await github.readJson('vault.json');
      if (res.exists && res.data) {
        state.vault = { ...state.vault, ...res.data };
        return state.vault;
      }
    } catch (err) {
      showToast(`Could not fetch vault.json from GitHub: ${err.message}`, 'error');
    }
  } else {
    // Check static hosted vault.json first, then sandbox override
    try {
      const staticRes = await github.fetchStaticJson('vault.json');
      if (staticRes.exists && staticRes.data) {
        state.vault = { ...state.vault, ...staticRes.data };
      }
    } catch {
      // Static vault may not exist during local testing
    }
    const sandbox = loadSandboxStore();
    if (sandbox && sandbox.vault && sandbox.vault.updatedAt) {
      state.vault = { ...state.vault, ...sandbox.vault };
    }
  }
  return state.vault;
}

async function loadIndexData() {
  if (isLiveMode()) {
    const res = await github.readJson('index.json');
    if (res.exists && res.data && res.data.days) {
      state.index = res.data;
    } else {
      state.index = { version: 1, updatedAt: new Date().toISOString(), days: {} };
    }
    return state.index;
  }

  // Sandbox / Static mode: prefer existing local sandbox overrides if initialized,
  // otherwise seed from static Neocities index.json or built-in demo seed.
  let sandbox = loadSandboxStore();
  if (sandbox && sandbox.index && sandbox.index.days) {
    state.index = sandbox.index;
    return state.index;
  }

  try {
    const staticRes = await github.fetchStaticJson('index.json');
    if (staticRes.exists && staticRes.data && staticRes.data.days) {
      state.index = staticRes.data;
      return state.index;
    }
  } catch {
    // Fallback to built-in seed below
  }

  sandbox = ensureSandboxStoreInitialized();
  state.index = sandbox.index;
  return state.index;
}

async function loadDayData(mmdd, forceRefresh = false) {
  if (!forceRefresh && state.dayCache.has(mmdd)) {
    return state.dayCache.get(mmdd);
  }

  let dayObj = emptyDayData(mmdd);

  if (isLiveMode()) {
    try {
      const res = await github.readJson(`days/${mmdd}.json`);
      if (res.exists && res.data) {
        dayObj = {
          day: mmdd,
          entries: res.data.entries && typeof res.data.entries === 'object' ? res.data.entries : {},
          comments: Array.isArray(res.data.comments) ? res.data.comments : [],
        };
      }
    } catch (err) {
      showToast(`Failed loading ${mmdd}: ${err.message}`, 'error');
    }
  } else {
    const sandbox = loadSandboxStore();
    if (sandbox && sandbox.days && Object.prototype.hasOwnProperty.call(sandbox.days, mmdd)) {
      const d = sandbox.days[mmdd];
      dayObj = {
        day: mmdd,
        entries: d.entries || {},
        comments: Array.isArray(d.comments) ? d.comments : [],
      };
    } else {
      let loadedStatic = false;
      try {
        const staticRes = await github.fetchStaticJson(`days/${mmdd}.json`);
        if (staticRes.exists && staticRes.data) {
          dayObj = {
            day: mmdd,
            entries: staticRes.data.entries || {},
            comments: Array.isArray(staticRes.data.comments) ? staticRes.data.comments : [],
          };
          loadedStatic = true;
        }
      } catch {
        // Static day file does not exist yet
      }

      if (!loadedStatic && !sandbox) {
        const seeded = ensureSandboxStoreInitialized();
        if (seeded.days[mmdd]) {
          dayObj = seeded.days[mmdd];
        }
      }
    }
  }

  state.dayCache.set(mmdd, dayObj);
  return dayObj;
}

/**
 * Commits a day file + index.json update either to GitHub (Live) or Local Sandbox.
 * Guarantees Neocities-safe overwrites so deletions always reflect cleanly even under cleanup: false.
 */
async function saveDayAndIndex(mmdd, mutatorFn, commitMessage) {
  if (isLiveMode()) {
    const dayResult = await github.updateJsonWithRetry(
      `days/${mmdd}.json`,
      async (remoteDay) => {
        const base =
          remoteDay && typeof remoteDay === 'object'
            ? {
                day: mmdd,
                entries: remoteDay.entries && typeof remoteDay.entries === 'object' ? { ...remoteDay.entries } : {},
                comments: Array.isArray(remoteDay.comments) ? [...remoteDay.comments] : [],
              }
            : emptyDayData(mmdd);
        return mutatorFn(base);
      },
      commitMessage
    );

    const updatedDay = dayResult.data;
    state.dayCache.set(mmdd, updatedDay);

    const idxResult = await github.updateJsonWithRetry(
      'index.json',
      (remoteIdx) => recalculateIndexForDay(remoteIdx, mmdd, updatedDay),
      `diary: update index (${mmdd})`
    );
    state.index = idxResult.data;
    return updatedDay;
  }

  // Local Sandbox persistence
  const sandbox = loadSandboxStore() || {
    index: state.index,
    days: {},
    vault: state.vault,
  };
  const currentDay = await loadDayData(mmdd);
  const cloned = JSON.parse(JSON.stringify(currentDay));
  const updatedDay = await mutatorFn(cloned);

  sandbox.days[mmdd] = updatedDay;
  sandbox.index = recalculateIndexForDay(sandbox.index || state.index, mmdd, updatedDay);
  saveSandboxStore(sandbox);

  state.dayCache.set(mmdd, updatedDay);
  state.index = sandbox.index;
  return updatedDay;
}

/**
 * Uploads an image (GitHub /data/media/ in Live Mode, IndexedDB in Sandbox Mode)
 * and caches the local blob in IndexedDB for instant zero-lag display.
 */
async function persistUploadedPhoto(diaryDate, pendingUpload) {
  const relPath = buildMediaFilename(diaryDate, pendingUpload.ext);

  if (isLiveMode()) {
    await github.putBinary(
      relPath,
      pendingUpload.arrayBuffer,
      `diary: upload media ${relPath}`
    );
    // Also cache locally in IndexedDB so preview is instantaneous
    try {
      await localMedia.saveBlob(relPath, pendingUpload.blob);
    } catch {
      // Non-critical cache failure
    }
    return relPath;
  }

  const idbKey = `idb://${relPath}`;
  await localMedia.saveBlob(idbKey, pendingUpload.blob);
  return idbKey;
}

/**
 * Optionally deletes an orphaned /data/media/ image file from GitHub or IndexedDB.
 */
async function removeMediaAsset(src) {
  if (!src || typeof src !== 'string') return;
  if (src.startsWith('idb://')) {
    await localMedia.deleteBlob(src).catch(() => {});
    return;
  }
  if (src.startsWith('data/media/')) {
    await localMedia.deleteBlob(src).catch(() => {});
    if (isLiveMode()) {
      await github.deleteFile(src, `diary: delete orphaned media ${src}`).catch(() => {});
    }
  }
}

/* ==========================================================================
   VAULT PASSWORD GATE & CRYPTOGRAPHIC HELPERS
   ========================================================================== */
function hasVaultConfigured() {
  return Boolean(state.vault && state.vault.canaryCipher);
}

function getVaultIterations() {
  return Number(state.vault?.iterations) || DEFAULT_ITERATIONS;
}

function updateSecurityHeaderControls() {
  const canEncrypt = Boolean(state.passphrase);
  dom.btnLockNow.hidden = !(hasVaultConfigured() || canEncrypt);
  dom.composerEncryptWrap.hidden = !canEncrypt;
  dom.commentEncryptWrap.hidden = !canEncrypt;
}

async function tryAutoDecryptStoredPat(password) {
  if (github.token) return false;
  const iterations = getVaultIterations();

  // 1. Check encrypted PAT in localStorage
  try {
    const encLocal = localStorage.getItem(LS_GH_PAT_ENC_KEY);
    if (encLocal && isEncryptedPayload(encLocal)) {
      const decryptedPat = await decryptPat(encLocal, password, iterations);
      if (decryptedPat) {
        github.updateConfig({ token: decryptedPat });
        updateModeBadge();
        return true;
      }
    }
  } catch {
    // Ignore mismatch
  }

  // 2. Check optional encrypted PAT inside /data/vault.json
  try {
    if (state.vault && isEncryptedPayload(state.vault.encryptedPat)) {
      const decryptedPat = await decryptPat(state.vault.encryptedPat, password, iterations);
      if (decryptedPat) {
        github.updateConfig({ token: decryptedPat });
        updateModeBadge();
        return true;
      }
    }
  } catch {
    // Ignore mismatch
  }

  return false;
}

async function unlockWithPassword(password, rememberInSession = true) {
  const valid = await verifyVaultPassword(password, state.vault);
  if (!valid) {
    return false;
  }

  state.passphrase = password;
  state.vaultUnlocked = true;

  if (rememberInSession) {
    try {
      sessionStorage.setItem(SS_PASSPHRASE_KEY, password);
    } catch {
      // Ignore private browsing sessionStorage restrictions
    }
  }

  const patUnlocked = await tryAutoDecryptStoredPat(password);
  dom.lockScreen.hidden = true;
  dom.lockError.hidden = true;
  dom.lockPasswordInput.value = '';
  updateSecurityHeaderControls();

  if (patUnlocked) {
    // Re-fetch live data from GitHub API now that PAT is unlocked
    state.dayCache.clear();
    await loadIndexData();
    showToast('Diary & GitHub Write Mode unlocked.', 'success');
  } else {
    showToast('Diary unlocked for this session.', 'success');
  }

  return true;
}

function lockDiaryNow() {
  state.passphrase = '';
  state.vaultUnlocked = false;
  try {
    sessionStorage.removeItem(SS_PASSPHRASE_KEY);
  } catch {
    // Ignore
  }

  // If PAT was stored encrypted, wipe volatile in-memory token as well
  try {
    const hasEncLocal = Boolean(localStorage.getItem(LS_GH_PAT_ENC_KEY));
    const hasEncVault = Boolean(state.vault && isEncryptedPayload(state.vault.encryptedPat));
    if (hasEncLocal || hasEncVault) {
      github.updateConfig({ token: '' });
      updateModeBadge();
    }
  } catch {
    // Ignore
  }

  closeAllModals();
  updateSecurityHeaderControls();

  if (state.vault.enabled && hasVaultConfigured()) {
    dom.columnsTrack.innerHTML = '';
    dom.commentsList.innerHTML = '';
    dom.lockScreen.hidden = false;
    dom.lockPasswordInput.value = '';
    dom.lockError.hidden = true;
    dom.lockPasswordInput.focus();
  } else {
    renderActiveView();
    showToast('Session key wiped. Encrypted entries are now sealed.', 'info');
  }
}

async function decryptFieldSafe(value) {
  if (!isEncryptedPayload(value)) {
    return { ok: true, sealed: false, text: String(value ?? '') };
  }
  if (!state.passphrase) {
    return { ok: false, sealed: true, text: '' };
  }
  try {
    const plain = await decryptText(value, state.passphrase, getVaultIterations());
    return { ok: true, sealed: false, text: plain };
  } catch {
    return { ok: false, sealed: true, text: '' };
  }
}

/* ==========================================================================
   URL HASH ROUTING & DEEP LINKS
   Supports:
   - #11-24
   - #11-24?compare=2024,2026
   - #compare?a=2025-03-10&b=2026-11-24
   - #heatmap
   - #archive
   ========================================================================== */
function parseHashRoute() {
  const rawHash = window.location.hash.replace(/^#/, '').trim();
  if (!rawHash) {
    state.view = 'reader';
    state.compareMode = false;
    state.compareFilterYears = null;
    // Default to today, or 11-24 if today has no entries and 11-24 is seeded
    const today = getTodayMmDd();
    const indexedDays = Object.keys(state.index.days || {});
    if (indexedDays.length > 0 && !state.index.days[today] && state.index.days['11-24']) {
      state.activeMmDd = '11-24';
    } else {
      state.activeMmDd = today;
    }
    return;
  }

  const [pathPart, queryPart] = rawHash.split('?');
  const params = new URLSearchParams(queryPart || '');

  if (pathPart === 'heatmap') {
    state.view = 'heatmap';
    return;
  }

  if (pathPart === 'archive') {
    state.view = 'archive';
    return;
  }

  if (pathPart === 'compare') {
    state.view = 'reader';
    const a = params.get('a');
    const b = params.get('b');
    state.compareMode = true;
    state.compareDateA = isValidYmd(a) ? a : `${new Date().getFullYear() - 1}-${state.activeMmDd}`;
    state.compareDateB = isValidYmd(b) ? b : getTodayYmd();
    return;
  }

  if (isValidMmDd(pathPart)) {
    state.view = 'reader';
    state.compareMode = false;
    state.activeMmDd = pathPart;
    const compareYearsParam = params.get('compare');
    if (compareYearsParam) {
      const parsedYears = compareYearsParam
        .split(',')
        .map((y) => Number(y.trim()))
        .filter((n) => Number.isInteger(n));
      state.compareFilterYears = parsedYears.length > 0 ? parsedYears : null;
    } else {
      state.compareFilterYears = null;
    }
  }
}

function syncHashToUrl(replace = false) {
  let targetHash = `#${state.activeMmDd}`;
  if (state.view === 'heatmap') {
    targetHash = '#heatmap';
  } else if (state.view === 'archive') {
    targetHash = '#archive';
  } else if (state.compareMode && isValidYmd(state.compareDateA) && isValidYmd(state.compareDateB)) {
    targetHash = `#compare?a=${state.compareDateA}&b=${state.compareDateB}`;
  } else if (state.compareFilterYears && state.compareFilterYears.length > 0) {
    targetHash = `#${state.activeMmDd}?compare=${state.compareFilterYears.join(',')}`;
  }

  if (window.location.hash !== targetHash) {
    if (replace) {
      history.replaceState(null, '', targetHash);
    } else {
      history.pushState(null, '', targetHash);
    }
  }
}

function switchView(nextView) {
  state.view = nextView;
  dom.viewReader.hidden = nextView !== 'reader';
  dom.viewHeatmap.hidden = nextView !== 'heatmap';
  dom.viewArchive.hidden = nextView !== 'archive';

  dom.navReaderBtn.classList.toggle('is-active', nextView === 'reader');
  dom.navHeatmapBtn.classList.toggle('is-active', nextView === 'heatmap');
  dom.navArchiveBtn.classList.toggle('is-active', nextView === 'archive');

  hideQuotePopover();
  syncHashToUrl();
  renderActiveView();
}

async function renderActiveView() {
  if (state.vault.enabled && hasVaultConfigured() && !state.vaultUnlocked) {
    return;
  }
  if (state.view === 'reader') {
    await renderReaderView();
  } else if (state.view === 'heatmap') {
    renderHeatmapView();
  } else if (state.view === 'archive') {
    await renderArchiveView();
  }
}

/* ==========================================================================
   DATE SELECTOR CONTROLS
   ========================================================================== */
function populateMonthSelect() {
  dom.selectMonth.innerHTML = '';
  for (const m of MONTHS) {
    const opt = document.createElement('option');
    opt.value = pad2(m.num);
    opt.textContent = `${pad2(m.num)} · ${m.short}`;
    dom.selectMonth.appendChild(opt);
  }
}

function populateDaySelect(monthStr, selectedDayStr) {
  const mIdx = Math.max(0, Math.min(11, Number(monthStr) - 1));
  const maxDays = MONTHS[mIdx].days;
  const clampedDay = Math.min(maxDays, Math.max(1, Number(selectedDayStr) || 1));

  dom.selectDay.innerHTML = '';
  for (let d = 1; d <= maxDays; d += 1) {
    const opt = document.createElement('option');
    opt.value = pad2(d);
    opt.textContent = pad2(d);
    dom.selectDay.appendChild(opt);
  }
  dom.selectDay.value = pad2(clampedDay);
}

function syncReaderHeaderControls(dayData) {
  const [mStr, dStr] = state.activeMmDd.split('-');
  dom.selectMonth.value = mStr;
  populateDaySelect(mStr, dStr);

  dom.readerDateHeading.textContent = state.compareMode
    ? `${state.compareDateA} vs. ${state.compareDateB}`
    : formatHumanMmDd(state.activeMmDd);

  const yearsCount = dayData ? Object.keys(dayData.entries || {}).length : 0;
  dom.readerYearCount.textContent = state.compareMode
    ? 'COMPARE 2'
    : `${yearsCount} ${yearsCount === 1 ? 'YEAR' : 'YEARS'}`;

  const commentCount = dayData && Array.isArray(dayData.comments) ? dayData.comments.length : 0;
  dom.commentsCountBadge.textContent = String(commentCount);

  // Sizing segmented control
  dom.columnsTrack.classList.remove('size-fit', 'size-compact', 'size-standard', 'size-wide');
  dom.columnsTrack.classList.add(`size-${state.sizeMode}`);
  for (const btn of dom.sizingControl.querySelectorAll('.seg-btn')) {
    btn.classList.toggle('is-active', btn.dataset.size === state.sizeMode);
  }

  dom.btnSortOrder.textContent =
    state.sortOrder === 'asc' ? 'Oldest → Newest' : 'Newest → Oldest';
  dom.btnCompareMode.classList.toggle('is-active', state.compareMode);
  dom.compareBar.hidden = !state.compareMode;
  dom.commentsSection.hidden = state.compareMode;

  if (state.compareMode) {
    dom.compareDateA.value = state.compareDateA;
    dom.compareDateB.value = state.compareDateB;
  }

  dom.btnMobileLayout.textContent =
    state.mobileLayout === 'tabs' ? 'View: Tabs' : 'View: Swipe';
  dom.columnsTrack.classList.toggle('mobile-tabbed', state.mobileLayout === 'tabs');
}

/* ==========================================================================
   RENDERING PHOTO FIGURES (WITH ON-PAGE HOLD-AND-DRAG RE-ALIGNMENT)
   ========================================================================== */
function destroyInlineAlignControllers() {
  while (state.inlineAlignControllers.length > 0) {
    const ctrl = state.inlineAlignControllers.pop();
    try {
      ctrl.destroy();
    } catch {
      // Ignore cleanup errors
    }
  }
}

async function buildDiaryFigureElement(imageMeta, onSaveUpdatedMeta) {
  const meta = normalizeImageMeta(imageMeta);
  if (!meta) return null;

  const resolvedUrl = await resolveMediaSrc(meta.src, {
    localStore: localMedia,
    githubClient: github,
  });
  if (!resolvedUrl) return null;

  const figure = document.createElement('figure');
  figure.className = `diary-figure align-${meta.align}`;
  figure.style.width = meta.align === 'full' ? '100%' : `${meta.width}%`;

  const viewport = document.createElement('div');
  viewport.className = 'diary-figure-viewport';
  viewport.style.height = `${meta.height}px`;

  const img = document.createElement('img');
  img.src = resolvedUrl;
  img.alt = meta.caption || 'Diary photograph';
  img.loading = 'lazy';
  img.style.objectPosition = `${meta.posX}% ${meta.posY}%`;

  const alignBtn = document.createElement('button');
  alignBtn.type = 'button';
  alignBtn.className = 'figure-align-trigger';
  alignBtn.textContent = '⇄ Drag Align';
  alignBtn.title = 'Hold-and-drag to pan focal point or change layout alignment directly on the page';

  alignBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const ctrl = attachInlineAlignController(figure, meta, {
      onSave: async (updatedMeta) => {
        await onSaveUpdatedMeta(updatedMeta);
      },
    });
    state.inlineAlignControllers.push(ctrl);
  });

  viewport.appendChild(img);
  viewport.appendChild(alignBtn);
  figure.appendChild(viewport);

  if (meta.caption) {
    const cap = document.createElement('figcaption');
    cap.textContent = meta.caption;
    figure.appendChild(cap);
  }

  return figure;
}

/* ==========================================================================
   SIDE-BY-SIDE READER VIEW & COMPARE 2 MODE
   ========================================================================== */
async function renderReaderView() {
  destroyInlineAlignControllers();
  hideQuotePopover();

  if (state.compareMode) {
    await renderCustomCompareView();
    return;
  }

  const mmdd = state.activeMmDd;
  const dayData = await loadDayData(mmdd);
  syncReaderHeaderControls(dayData);

  dom.columnsTrack.innerHTML = '';
  dom.mobileYearTabs.innerHTML = '';

  let years = Object.keys(dayData.entries || {})
    .map((y) => Number(y))
    .filter((n) => Number.isInteger(n))
    .sort((a, b) => (state.sortOrder === 'asc' ? a - b : b - a));

  if (state.compareFilterYears && state.compareFilterYears.length > 0) {
    const filtered = years.filter((y) => state.compareFilterYears.includes(y));
    if (filtered.length > 0) years = filtered;
  }

  // Keep pinned year valid
  if (state.pinnedYear !== null && !years.includes(state.pinnedYear)) {
    state.pinnedYear = null;
  }

  // Ensure pinned year sits first so sticky-left works seamlessly
  if (state.pinnedYear !== null) {
    years = [state.pinnedYear, ...years.filter((y) => y !== state.pinnedYear)];
  }

  // Mobile active year default
  if (years.length > 0 && !years.includes(state.mobileActiveYear)) {
    state.mobileActiveYear = years[years.length - 1];
  }

  const showMobileTabs = state.mobileLayout === 'tabs' && years.length > 0;
  dom.mobileYearTabs.hidden = !showMobileTabs;

  for (const yearNum of years) {
    const entry = dayData.entries[String(yearNum)];
    if (!entry) continue;

    const colEl = await buildYearColumnElement(entry, mmdd, { isCompare: false });
    if (state.mobileLayout === 'tabs' && yearNum === state.mobileActiveYear) {
      colEl.classList.add('is-mobile-active');
    }
    dom.columnsTrack.appendChild(colEl);

    if (showMobileTabs) {
      const tabBtn = document.createElement('button');
      tabBtn.type = 'button';
      tabBtn.className = `mobile-year-tab${yearNum === state.mobileActiveYear ? ' is-active' : ''}`;
      tabBtn.textContent = String(yearNum);
      tabBtn.setAttribute('role', 'tab');
      tabBtn.setAttribute('aria-selected', String(yearNum === state.mobileActiveYear));
      tabBtn.addEventListener('click', () => {
        state.mobileActiveYear = yearNum;
        renderReaderView();
      });
      dom.mobileYearTabs.appendChild(tabBtn);
    }
  }

  // Always append the Retroactive "+ Add Year" Column
  const addCol = buildAddYearColumnElement(mmdd, years);
  if (state.mobileLayout === 'tabs' && years.length === 0) {
    addCol.classList.add('is-mobile-active');
  }
  dom.columnsTrack.appendChild(addCol);

  if (showMobileTabs) {
    const addTab = document.createElement('button');
    addTab.type = 'button';
    addTab.className = `mobile-year-tab${state.mobileActiveYear === 'add' ? ' is-active' : ''}`;
    addTab.textContent = '+ Add Year';
    addTab.addEventListener('click', () => {
      state.mobileActiveYear = 'add';
      for (const el of dom.columnsTrack.children) {
        el.classList.toggle('is-mobile-active', el.classList.contains('add-year-column'));
      }
      for (const btn of dom.mobileYearTabs.children) {
        btn.classList.toggle('is-active', btn === addTab);
      }
    });
    dom.mobileYearTabs.appendChild(addTab);
  }

  await renderCommentsSection(mmdd, dayData);
}

async function renderCustomCompareView() {
  syncReaderHeaderControls(null);
  dom.mobileYearTabs.hidden = true;
  dom.columnsTrack.innerHTML = '';

  const slots = [
    { label: 'DATE A', ymd: state.compareDateA },
    { label: 'DATE B', ymd: state.compareDateB },
  ];

  for (const slot of slots) {
    if (!isValidYmd(slot.ymd)) {
      const empty = buildEmptyCompareColumn(slot.label, 'Pick a valid date above');
      dom.columnsTrack.appendChild(empty);
      continue;
    }

    const { yearStr, mmdd } = splitYmd(slot.ymd);
    const dayData = await loadDayData(mmdd);
    const entry = dayData.entries[yearStr];

    if (entry) {
      const col = await buildYearColumnElement(entry, mmdd, { isCompare: true });
      dom.columnsTrack.appendChild(col);
    } else {
      const empty = buildEmptyCompareColumn(slot.ymd, 'No entry recorded for this date yet.', () => {
        openEntryComposer({ mode: 'create', date: slot.ymd });
      });
      dom.columnsTrack.appendChild(empty);
    }
  }
}

function buildEmptyCompareColumn(title, subtitle, onWriteClick) {
  const col = document.createElement('article');
  col.className = 'year-column empty-slot-card';
  const h3 = document.createElement('h3');
  h3.className = 'column-year';
  h3.textContent = title;
  const p = document.createElement('p');
  p.className = 'muted-note';
  p.textContent = subtitle;
  col.appendChild(h3);
  col.appendChild(p);

  if (typeof onWriteClick === 'function') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-primary btn-sm';
    btn.textContent = `+ Write ${title}`;
    btn.addEventListener('click', onWriteClick);
    col.appendChild(btn);
  }
  return col;
}

async function buildYearColumnElement(entry, mmdd, options = {}) {
  const yearNum = Number(entry.year);
  const isPinned = !options.isCompare && state.pinnedYear === yearNum;

  const col = document.createElement('article');
  col.className = `year-column${isPinned ? ' is-pinned' : ''}`;
  col.dataset.year = String(yearNum);
  col.dataset.diaryDate = entry.diaryDate;

  // Header
  const header = document.createElement('header');
  header.className = 'column-header';

  const yearGroup = document.createElement('div');
  yearGroup.className = 'column-year-group';

  const yearLine = document.createElement('div');
  yearLine.className = 'column-year-line';

  const yearEl = document.createElement('span');
  yearEl.className = 'column-year';
  yearEl.textContent = String(yearNum);
  yearLine.appendChild(yearEl);

  const diffDays = computeBackdateDiffDays(entry.diaryDate, entry.writtenAt);
  if (diffDays !== 0) {
    const badge = document.createElement('span');
    badge.className = 'backdate-badge';
    badge.textContent = formatBackdateBadge(diffDays);
    badge.title = `Logged on ${formatShortTimestamp(entry.writtenAt)}`;
    yearLine.appendChild(badge);
  }

  if (entry.encrypted || isEncryptedPayload(entry.body)) {
    const lockPill = document.createElement('span');
    lockPill.className = 'mono-pill mono-pill-amber';
    lockPill.textContent = 'AES-256';
    lockPill.title = 'Encrypted client-side with AES-256-GCM';
    yearLine.appendChild(lockPill);
  }

  const dateSub = document.createElement('span');
  dateSub.className = 'column-date-sub';
  dateSub.textContent = entry.diaryDate;

  yearGroup.appendChild(yearLine);
  yearGroup.appendChild(dateSub);

  // Per-Column Actions: Quote, Pin, Edit, Delete
  const actions = document.createElement('div');
  actions.className = 'column-actions';

  const decTitle = await decryptFieldSafe(entry.title || '');
  const decBody = await decryptFieldSafe(entry.body || '');
  const isSealed = decBody.sealed || decTitle.sealed;

  if (!options.isCompare && !isSealed) {
    const quoteBtn = document.createElement('button');
    quoteBtn.type = 'button';
    quoteBtn.className = 'col-action-btn';
    quoteBtn.textContent = '❝ Quote';
    quoteBtn.title = 'Quote selected text (or opening passage) into a margin comment';
    quoteBtn.addEventListener('click', () => {
      const selected = getSelectedTextWithinColumn(col);
      const quoteText = selected || extractDefaultQuote(decBody.text, 190) || decTitle.text || entry.diaryDate;
      attachQuoteToCommentComposer({
        text: quoteText,
        year: yearNum,
        diaryDate: entry.diaryDate,
      });
    });
    actions.appendChild(quoteBtn);
  }

  if (!options.isCompare) {
    const pinBtn = document.createElement('button');
    pinBtn.type = 'button';
    pinBtn.className = `col-action-btn${isPinned ? ' is-pinned' : ''}`;
    pinBtn.textContent = isPinned ? 'Pinned' : 'Pin';
    pinBtn.title = isPinned ? 'Unpin column' : 'Pin this year sticky to the left edge';
    pinBtn.addEventListener('click', () => {
      state.pinnedYear = isPinned ? null : yearNum;
      renderReaderView();
    });
    actions.appendChild(pinBtn);
  }

  if (!isSealed) {
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'col-action-btn';
    editBtn.textContent = 'Edit';
    editBtn.title = `Edit ${entry.diaryDate}`;
    editBtn.addEventListener('click', () => {
      openEntryComposer({
        mode: 'edit',
        entry,
        decryptedTitle: decTitle.text,
        decryptedBody: decBody.text,
      });
    });
    actions.appendChild(editBtn);
  }

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'col-action-btn is-danger';
  delBtn.textContent = 'Delete';
  delBtn.title = `Delete ${entry.diaryDate}`;
  delBtn.addEventListener('click', () => {
    handleDeleteEntry(entry);
  });
  actions.appendChild(delBtn);

  header.appendChild(yearGroup);
  header.appendChild(actions);
  col.appendChild(header);

  // Body
  const bodyWrap = document.createElement('div');
  bodyWrap.className = 'column-body';

  if (isSealed) {
    bodyWrap.appendChild(buildSealedCardElement());
  } else {
    if (decTitle.text.trim()) {
      const titleEl = document.createElement('h2');
      titleEl.className = 'entry-title';
      titleEl.textContent = decTitle.text;
      bodyWrap.appendChild(titleEl);
    }

    // Mood & Tags
    const hasMood = Boolean(entry.mood && entry.mood.trim());
    const tags = Array.isArray(entry.tags) ? entry.tags.filter(Boolean) : [];
    if (hasMood || tags.length > 0) {
      const metaBar = document.createElement('div');
      metaBar.className = 'entry-meta-bar';

      if (hasMood) {
        const moodChip = document.createElement('span');
        moodChip.className = 'mood-chip';
        moodChip.textContent = `mood: ${entry.mood}`;
        metaBar.appendChild(moodChip);
      }

      for (const tag of tags) {
        const tagBtn = document.createElement('button');
        tagBtn.type = 'button';
        tagBtn.className = 'tag-chip';
        tagBtn.textContent = `#${tag}`;
        tagBtn.addEventListener('click', () => {
          state.archive.tag = tag;
          switchView('archive');
        });
        metaBar.appendChild(tagBtn);
      }

      bodyWrap.appendChild(metaBar);
    }

    // Prose container (photo sits inside prose so Left/Right wrap flows cleanly around it)
    const proseEl = document.createElement('div');
    proseEl.className = 'prose-content';
    proseEl.dataset.entryYear = String(yearNum);
    proseEl.dataset.diaryDate = entry.diaryDate;

    if (entry.image && entry.image.src) {
      const figEl = await buildDiaryFigureElement(entry.image, async (updatedMeta) => {
        await saveEntryPhotoAlignment(mmdd, String(yearNum), updatedMeta);
      });
      if (figEl) {
        proseEl.appendChild(figEl);
      }
    }

    const mdFrag = document.createElement('div');
    mdFrag.innerHTML = renderMarkdown(decBody.text);
    while (mdFrag.firstChild) {
      proseEl.appendChild(mdFrag.firstChild);
    }

    bodyWrap.appendChild(proseEl);
  }

  col.appendChild(bodyWrap);

  // Footer
  const footer = document.createElement('footer');
  footer.className = 'column-footer';

  const wc = isSealed ? (state.index.days[mmdd]?.wordCounts?.[String(yearNum)] || 0) : countWords(decBody.text);
  const leftMeta = document.createElement('span');
  leftMeta.textContent = isSealed ? 'SEALED ENTRY' : `${wc} words`;

  const rightMeta = document.createElement('span');
  rightMeta.textContent = entry.writtenAt ? `Logged ${formatShortTimestamp(entry.writtenAt)}` : '';

  footer.appendChild(leftMeta);
  footer.appendChild(rightMeta);
  col.appendChild(footer);

  return col;
}

function buildSealedCardElement() {
  const card = document.createElement('div');
  card.className = 'sealed-card';
  card.innerHTML = `
    <div class="sealed-card-icon" aria-hidden="true">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
        <rect x="4" y="11" width="16" height="10" rx="2"></rect>
        <path d="M8 11V7a4 4 0 0 1 8 0v4"></path>
      </svg>
    </div>
    <p class="sealed-card-title">Encrypted Entry — Enter Password to Unlock</p>
    <p class="sealed-card-text">This entry is encrypted client-side with AES-256-GCM.</p>
  `;

  const form = document.createElement('form');
  form.className = 'add-year-form';
  form.autocomplete = 'off';

  const input = document.createElement('input');
  input.type = 'password';
  input.className = 'input input-sm';
  input.placeholder = 'Master password…';
  input.required = true;

  const btn = document.createElement('button');
  btn.type = 'submit';
  btn.className = 'btn btn-primary btn-sm';
  btn.textContent = 'Unlock Session';

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const candidate = input.value;
    if (!candidate) return;
    btn.disabled = true;
    btn.textContent = 'Deriving key…';
    try {
      if (hasVaultConfigured()) {
        const ok = await unlockWithPassword(candidate, true);
        if (!ok) {
          showToast('Incorrect password.', 'error');
          btn.disabled = false;
          btn.textContent = 'Unlock Session';
          return;
        }
      } else {
        state.passphrase = candidate;
        state.vaultUnlocked = true;
        updateSecurityHeaderControls();
      }
      await renderActiveView();
    } catch (err) {
      showToast(err.message || 'Could not unlock.', 'error');
      btn.disabled = false;
      btn.textContent = 'Unlock Session';
    }
  });

  form.appendChild(input);
  form.appendChild(btn);
  card.appendChild(form);
  return card;
}

function buildAddYearColumnElement(mmdd, existingYears) {
  const card = document.createElement('aside');
  card.className = 'add-year-column';

  const kicker = document.createElement('p');
  kicker.className = 'mono-kicker';
  kicker.textContent = 'RETROACTIVE ENTRY';

  const heading = document.createElement('h3');
  heading.textContent = `Add a year for ${formatHumanMmDd(mmdd)}`;

  const hint = document.createElement('p');
  hint.className = 'muted-note';
  hint.textContent = 'Transcribe a past notebook or start this year.';

  const form = document.createElement('form');
  form.className = 'add-year-form';

  const currentYear = new Date().getFullYear();
  let suggestedYear = currentYear;
  while (existingYears.includes(suggestedYear) && suggestedYear > 1950) {
    suggestedYear -= 1;
  }

  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'input input-mono input-sm';
  input.min = '1900';
  input.max = '2150';
  input.value = String(suggestedYear);
  input.setAttribute('aria-label', 'Target Year');

  const btn = document.createElement('button');
  btn.type = 'submit';
  btn.className = 'btn btn-primary btn-sm';
  btn.textContent = '+ Add Year';

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const y = Number(input.value);
    if (!Number.isInteger(y) || y < 1900 || y > 2150) {
      showToast('Enter a valid 4-digit year.', 'error');
      return;
    }
    const targetYmd = `${y}-${mmdd}`;
    if (!isValidYmd(targetYmd)) {
      showToast(`${targetYmd} is not a valid calendar date (leap year check).`, 'error');
      return;
    }
    openEntryComposer({ mode: 'create', date: targetYmd });
  });

  form.appendChild(input);
  form.appendChild(btn);
  card.appendChild(kicker);
  card.appendChild(heading);
  card.appendChild(hint);
  card.appendChild(form);
  return card;
}

async function saveEntryPhotoAlignment(mmdd, yearStr, updatedMeta) {
  try {
    await saveDayAndIndex(
      mmdd,
      (day) => {
        if (!day.entries[yearStr]) return day;
        day.entries[yearStr] = {
          ...day.entries[yearStr],
          image: normalizeImageMeta(updatedMeta),
          updatedAt: new Date().toISOString(),
        };
        return day;
      },
      `diary: align photo on ${yearStr}-${mmdd}`
    );
    showToast(
      isLiveMode()
        ? 'Photo alignment committed to GitHub.'
        : 'Photo alignment saved locally (Sandbox).',
      'success'
    );
    await renderReaderView();
  } catch (err) {
    showToast(`Failed to save photo alignment: ${err.message}`, 'error');
    throw err;
  }
}

/* ==========================================================================
   PER-DAY COMMENTS & HIGHLIGHT-TO-QUOTE SYSTEM
   ========================================================================== */
function getSelectedTextWithinColumn(columnEl) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return '';
  const text = sel.toString().trim().replace(/\s+/g, ' ');
  if (!text) return '';
  const anchorNode = sel.anchorNode;
  if (anchorNode && columnEl.contains(anchorNode)) {
    return text.slice(0, 420);
  }
  return '';
}

function hideQuotePopover() {
  dom.quotePopover.hidden = true;
  state.selectionQuote = null;
}

function handleDocumentSelectionChange() {
  if (state.view !== 'reader' || state.compareMode) {
    hideQuotePopover();
    return;
  }

  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    hideQuotePopover();
    return;
  }

  const text = sel.toString().trim().replace(/\s+/g, ' ');
  if (text.length < 3) {
    hideQuotePopover();
    return;
  }

  const range = sel.getRangeAt(0);
  const common = range.commonAncestorContainer;
  const hostEl = common.nodeType === Node.ELEMENT_NODE ? common : common.parentElement;
  const proseEl = hostEl ? hostEl.closest('.prose-content[data-entry-year]') : null;

  if (!proseEl) {
    hideQuotePopover();
    return;
  }

  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    hideQuotePopover();
    return;
  }

  state.selectionQuote = {
    text: text.slice(0, 420),
    year: Number(proseEl.dataset.entryYear),
    diaryDate: proseEl.dataset.diaryDate,
  };

  const x = Math.min(window.innerWidth - 95, Math.max(95, rect.left + rect.width / 2));
  const y = Math.max(66, rect.top - 10);

  dom.quotePopover.style.left = `${x}px`;
  dom.quotePopover.style.top = `${y}px`;
  dom.quotePopover.hidden = false;
}

function attachQuoteToCommentComposer(quoteObj) {
  state.commentComposer.quote = quoteObj
    ? {
        text: String(quoteObj.text || '').trim(),
        year: Number(quoteObj.year),
        diaryDate: String(quoteObj.diaryDate || ''),
      }
    : null;

  renderCommentQuotePreview();
  hideQuotePopover();

  if (state.commentComposer.quote) {
    dom.commentForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
    dom.commentBodyInput.focus();
  }
}

function renderCommentQuotePreview() {
  const q = state.commentComposer.quote;
  if (!q || !q.text) {
    dom.commentQuotePreview.hidden = true;
    return;
  }
  dom.commentQuoteMeta.textContent = `QUOTING ${q.year} · ${q.diaryDate}`;
  dom.commentQuoteText.textContent = `“${q.text}”`;
  dom.commentQuotePreview.hidden = false;
}

function jumpToQuotedYearColumn(yearNum) {
  const targetCol = dom.columnsTrack.querySelector(`.year-column[data-year="${yearNum}"]`);
  if (!targetCol) {
    showToast(`Column for ${yearNum} is not currently visible.`, 'info');
    return;
  }

  if (state.mobileLayout === 'tabs') {
    state.mobileActiveYear = Number(yearNum);
    renderReaderView().then(() => {
      const col = dom.columnsTrack.querySelector(`.year-column[data-year="${yearNum}"]`);
      if (col) flashColumn(col);
    });
    return;
  }

  targetCol.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'center' });
  flashColumn(targetCol);
}

function flashColumn(colEl) {
  colEl.classList.remove('is-quote-flash');
  void colEl.offsetWidth; // Force reflow to restart animation
  colEl.classList.add('is-quote-flash');
}

async function renderCommentsSection(mmdd, dayData) {
  dom.commentsHeading.textContent = `Notes & Reflections on ${formatHumanMmDd(mmdd)}`;
  dom.commentsList.innerHTML = '';

  const comments = Array.isArray(dayData.comments) ? dayData.comments : [];
  dom.commentsCountBadge.textContent = String(comments.length);

  if (comments.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted-note';
    empty.textContent = 'No margin notes for this calendar date yet. Highlight any prose above to quote it, or leave a reflection below.';
    dom.commentsList.appendChild(empty);
    return;
  }

  for (const cmt of comments) {
    const card = document.createElement('article');
    card.className = 'comment-card';
    card.dataset.commentId = cmt.id;

    const head = document.createElement('div');
    head.className = 'comment-card-header';

    const metaLeft = document.createElement('div');
    metaLeft.className = 'comment-meta-left';

    const author = document.createElement('span');
    author.className = 'comment-author';
    author.textContent = cmt.author || 'Self';

    const time = document.createElement('span');
    time.className = 'comment-time';
    const editedSuffix =
      cmt.updatedAt && cmt.createdAt && cmt.updatedAt !== cmt.createdAt ? ' · edited' : '';
    time.textContent = `${formatShortTimestamp(cmt.createdAt)}${editedSuffix}`;

    metaLeft.appendChild(author);
    metaLeft.appendChild(time);

    if (cmt.encrypted || isEncryptedPayload(cmt.body)) {
      const encPill = document.createElement('span');
      encPill.className = 'mono-pill mono-pill-amber';
      encPill.textContent = 'AES-256';
      metaLeft.appendChild(encPill);
    }

    const decBody = await decryptFieldSafe(cmt.body || '');
    const decQuoteText = cmt.quote?.text ? await decryptFieldSafe(cmt.quote.text) : { ok: true, sealed: false, text: '' };
    const isSealed = decBody.sealed || decQuoteText.sealed;

    const actions = document.createElement('div');
    actions.className = 'comment-card-actions';

    if (!isSealed) {
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'col-action-btn';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => {
        startEditingComment(cmt, decBody.text, decQuoteText.text);
      });
      actions.appendChild(editBtn);
    }

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'col-action-btn is-danger';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', () => {
      handleDeleteComment(mmdd, cmt);
    });
    actions.appendChild(delBtn);

    head.appendChild(metaLeft);
    head.appendChild(actions);
    card.appendChild(head);

    if (isSealed) {
      const sealedMsg = document.createElement('p');
      sealedMsg.className = 'muted-note';
      sealedMsg.textContent = '🔒 Encrypted margin note — unlock your diary password to read.';
      card.appendChild(sealedMsg);
    } else {
      // Quoted Passage Card
      if (cmt.quote && decQuoteText.text) {
        const quoteCard = document.createElement('div');
        quoteCard.className = 'quote-card quote-card-clickable';
        quoteCard.title = `Jump to ${cmt.quote.year} column`;
        quoteCard.innerHTML = `
          <div class="quote-card-header">
            <span class="quote-meta">QUOTING ${escapeHtml(cmt.quote.year)} · ${escapeHtml(cmt.quote.diaryDate)}</span>
            <span class="mono-text muted-text">↑ Jump</span>
          </div>
          <blockquote class="quote-excerpt">“${escapeHtml(decQuoteText.text)}”</blockquote>
        `;
        quoteCard.addEventListener('click', () => {
          jumpToQuotedYearColumn(cmt.quote.year);
        });
        card.appendChild(quoteCard);
      }

      const bodyDiv = document.createElement('div');
      bodyDiv.className = 'prose-content';

      if (cmt.image && cmt.image.src) {
        const fig = await buildDiaryFigureElement(cmt.image, async (updatedMeta) => {
          await saveCommentPhotoAlignment(mmdd, cmt.id, updatedMeta);
        });
        if (fig) bodyDiv.appendChild(fig);
      }

      const mdWrap = document.createElement('div');
      mdWrap.innerHTML = renderMarkdown(decBody.text);
      while (mdWrap.firstChild) {
        bodyDiv.appendChild(mdWrap.firstChild);
      }
      card.appendChild(bodyDiv);
    }

    dom.commentsList.appendChild(card);
  }
}

async function saveCommentPhotoAlignment(mmdd, commentId, updatedMeta) {
  try {
    await saveDayAndIndex(
      mmdd,
      (day) => {
        day.comments = day.comments.map((c) =>
          c.id === commentId
            ? { ...c, image: normalizeImageMeta(updatedMeta), updatedAt: new Date().toISOString() }
            : c
        );
        return day;
      },
      `diary: align comment photo on ${mmdd}`
    );
    showToast('Comment photo alignment saved.', 'success');
    await renderReaderView();
  } catch (err) {
    showToast(`Could not update comment photo: ${err.message}`, 'error');
    throw err;
  }
}

function resetCommentComposer() {
  state.commentComposer.editingId = null;
  state.commentComposer.originalCreatedAt = null;
  state.commentComposer.originalImageSrc = null;
  state.commentComposer.quote = null;
  state.commentComposer.imageMeta = null;

  if (state.commentComposer.pendingUpload?.previewUrl) {
    URL.revokeObjectURL(state.commentComposer.pendingUpload.previewUrl);
  }
  state.commentComposer.pendingUpload = null;

  dom.commentEditingBanner.hidden = true;
  dom.commentAuthorInput.value = 'Self';
  dom.commentBodyInput.value = '';
  dom.commentEncryptCheckbox.checked = Boolean(state.passphrase && state.vault.enabled);
  dom.commentPhotoPanel.hidden = true;
  dom.commentPhotoUrl.value = '';
  dom.commentPhotoFile.value = '';
  dom.commentPhotoRemoveBtn.hidden = true;
  dom.commentSubmitBtn.textContent = 'Post Comment';

  if (state.commentComposer.studio) {
    state.commentComposer.studio.clear();
  }
  renderCommentQuotePreview();
}

async function startEditingComment(cmt, decryptedBody, decryptedQuoteText) {
  resetCommentComposer();
  state.commentComposer.editingId = cmt.id;
  state.commentComposer.originalCreatedAt = cmt.createdAt;
  state.commentComposer.originalImageSrc = cmt.image?.src || null;

  dom.commentEditingBanner.hidden = false;
  dom.commentEditingLabel.textContent = `Editing comment from ${formatShortTimestamp(cmt.createdAt)}`;
  dom.commentAuthorInput.value = cmt.author || 'Self';
  dom.commentBodyInput.value = decryptedBody || '';
  dom.commentEncryptCheckbox.checked = Boolean(cmt.encrypted || isEncryptedPayload(cmt.body));
  dom.commentSubmitBtn.textContent = 'Save Comment Changes';

  if (cmt.quote && decryptedQuoteText) {
    state.commentComposer.quote = {
      text: decryptedQuoteText,
      year: cmt.quote.year,
      diaryDate: cmt.quote.diaryDate,
    };
    renderCommentQuotePreview();
  }

  if (cmt.image && cmt.image.src) {
    const normalized = normalizeImageMeta(cmt.image);
    state.commentComposer.imageMeta = normalized;
    const previewUrl = await resolveMediaSrc(normalized.src, {
      localStore: localMedia,
      githubClient: github,
    });
    dom.commentPhotoPanel.hidden = false;
    dom.commentPhotoRemoveBtn.hidden = false;
    state.commentComposer.studio.setImage(normalized, previewUrl);
  }

  dom.commentForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
  dom.commentBodyInput.focus();
}

async function handleCommentSubmit(e) {
  e.preventDefault();
  const mmdd = state.activeMmDd;
  const rawBody = dom.commentBodyInput.value.trim();
  const author = dom.commentAuthorInput.value.trim() || 'Self';
  const hasPhoto = Boolean(state.commentComposer.imageMeta || state.commentComposer.pendingUpload);

  if (!rawBody && !hasPhoto) {
    showToast('Write a comment or attach a photo first.', 'error');
    return;
  }

  const shouldEncrypt = Boolean(state.passphrase && dom.commentEncryptCheckbox.checked);
  const nowIso = new Date().toISOString();
  const isEditing = Boolean(state.commentComposer.editingId);

  dom.commentSubmitBtn.disabled = true;
  dom.commentSubmitBtn.textContent = isEditing ? 'Saving…' : 'Posting…';

  try {
    let finalImage = state.commentComposer.studio.getMeta();
    const oldSrc = state.commentComposer.originalImageSrc;

    if (state.commentComposer.pendingUpload) {
      const uploadedSrc = await persistUploadedPhoto(getTodayYmd(), state.commentComposer.pendingUpload);
      finalImage = normalizeImageMeta({
        ...(finalImage || DEFAULT_IMAGE_META),
        src: uploadedSrc,
      });
    }

    const bodyPayload = shouldEncrypt
      ? await encryptText(rawBody, state.passphrase, getVaultIterations())
      : rawBody;

    let quotePayload = null;
    if (state.commentComposer.quote && state.commentComposer.quote.text) {
      quotePayload = {
        text: shouldEncrypt
          ? await encryptText(state.commentComposer.quote.text, state.passphrase, getVaultIterations())
          : state.commentComposer.quote.text,
        year: state.commentComposer.quote.year,
        diaryDate: state.commentComposer.quote.diaryDate,
      };
    }

    const commentRecord = {
      id: isEditing ? state.commentComposer.editingId : `cmt-${Date.now()}`,
      author,
      body: bodyPayload,
      createdAt: isEditing ? state.commentComposer.originalCreatedAt || nowIso : nowIso,
      updatedAt: nowIso,
      encrypted: shouldEncrypt,
      quote: quotePayload,
      image: finalImage,
    };

    await saveDayAndIndex(
      mmdd,
      (day) => {
        if (isEditing) {
          day.comments = day.comments.map((c) => (c.id === commentRecord.id ? commentRecord : c));
        } else {
          day.comments.push(commentRecord);
        }
        return day;
      },
      isEditing ? `diary: edit comment on ${mmdd}` : `diary: add comment on ${mmdd}`
    );

    // Clean up replaced or removed comment image asset if it was repo/idb hosted
    if (isEditing && oldSrc && (!finalImage || finalImage.src !== oldSrc)) {
      await removeMediaAsset(oldSrc);
    }

    resetCommentComposer();
    await renderReaderView();
    showToast(
      isLiveMode()
        ? isEditing
          ? 'Comment updated & committed to GitHub.'
          : 'Comment posted & committed to GitHub.'
        : isEditing
          ? 'Comment updated in Local Sandbox.'
          : 'Comment posted in Local Sandbox.',
      'success'
    );
  } catch (err) {
    showToast(`Failed to save comment: ${err.message}`, 'error');
  } finally {
    dom.commentSubmitBtn.disabled = false;
    dom.commentSubmitBtn.textContent = state.commentComposer.editingId
      ? 'Save Comment Changes'
      : 'Post Comment';
  }
}

async function handleDeleteComment(mmdd, cmt) {
  const hasOwnedMedia = Boolean(
    cmt.image?.src && (cmt.image.src.startsWith('data/media/') || cmt.image.src.startsWith('idb://'))
  );

  const res = await showConfirm({
    title: 'Delete Comment',
    message: 'Are you sure you want to permanently remove this margin comment?',
    confirmText: 'Delete Comment',
    danger: true,
    extraCheckboxLabel: hasOwnedMedia
      ? 'Also delete the attached photo file from storage'
      : '',
    extraCheckboxDefault: true,
  });

  if (!res.confirmed) return;

  try {
    await saveDayAndIndex(
      mmdd,
      (day) => {
        day.comments = day.comments.filter((c) => c.id !== cmt.id);
        return day;
      },
      `diary: delete comment on ${mmdd}`
    );

    if (hasOwnedMedia && res.extraChecked) {
      await removeMediaAsset(cmt.image.src);
    }

    if (state.commentComposer.editingId === cmt.id) {
      resetCommentComposer();
    }

    await renderReaderView();
    showToast(
      isLiveMode() ? 'Comment deleted & committed to GitHub.' : 'Comment deleted locally.',
      'success'
    );
  } catch (err) {
    showToast(`Failed to delete comment: ${err.message}`, 'error');
  }
}

/* ==========================================================================
   FLEXIBLE ENTRY COMPOSER (CREATE, EDIT, DATE-MOVE, DELETE, DRAFTS, STUDIO)
   ========================================================================== */
function getDraftStorageKey() {
  const scope =
    state.composer.mode === 'edit' && state.composer.originalDate
      ? `edit:${state.composer.originalDate}`
      : `new:${dom.composerDate.value || 'default'}`;
  return `${LS_DRAFT_PREFIX}${scope}`;
}

function scheduleDraftSave() {
  if (!state.composer.isOpen) return;
  clearTimeout(state.composer.draftTimer);
  state.composer.draftTimer = setTimeout(() => {
    try {
      const payload = {
        diaryDate: dom.composerDate.value,
        title: dom.composerTitle.value,
        mood: dom.composerMood.value,
        tags: dom.composerTags.value,
        body: dom.composerBody.value,
        savedAt: Date.now(),
      };
      localStorage.setItem(getDraftStorageKey(), JSON.stringify(payload));
    } catch {
      // Ignore draft write errors
    }
  }, 2000);
}

function clearComposerDraft() {
  clearTimeout(state.composer.draftTimer);
  try {
    localStorage.removeItem(getDraftStorageKey());
  } catch {
    // Ignore
  }
  dom.composerDraftBanner.hidden = true;
}

function checkForRecoveredDraft() {
  try {
    const raw = localStorage.getItem(getDraftStorageKey());
    if (!raw) {
      dom.composerDraftBanner.hidden = true;
      return;
    }
    const draft = JSON.parse(raw);
    if (draft && (draft.body || draft.title) && draft.body !== dom.composerBody.value) {
      dom.composerDraftBanner.hidden = false;
    } else {
      dom.composerDraftBanner.hidden = true;
    }
  } catch {
    dom.composerDraftBanner.hidden = true;
  }
}

function updateComposerBackdateBadge() {
  const ymd = dom.composerDate.value;
  const referenceIso =
    state.composer.mode === 'edit' && state.composer.originalWrittenAt
      ? state.composer.originalWrittenAt
      : new Date().toISOString();
  const diff = computeBackdateDiffDays(ymd, referenceIso);
  if (diff !== 0) {
    dom.composerBackdateIndicator.textContent = formatBackdateBadge(diff);
    dom.composerBackdateIndicator.hidden = false;
  } else {
    dom.composerBackdateIndicator.hidden = true;
  }
}

function updateComposerCountsAndPreview() {
  const text = dom.composerBody.value;
  dom.composerCounts.textContent = `${countWords(text)} words · ${countChars(text)} chars`;
  if (state.composer.editorMode !== 'write') {
    dom.composerPreview.innerHTML = renderMarkdown(text) || '<p class="muted-note">Nothing to preview yet…</p>';
  }
}

function setComposerEditorMode(mode) {
  state.composer.editorMode = mode;
  dom.composerEditorGrid.classList.remove('mode-write', 'mode-split', 'mode-preview');
  dom.composerEditorGrid.classList.add(`mode-${mode}`);
  for (const btn of dom.composerViewTabs.querySelectorAll('.seg-btn')) {
    btn.classList.toggle('is-active', btn.dataset.editorMode === mode);
  }
  updateComposerCountsAndPreview();
}

function applyMarkdownToolbarAction(action) {
  const ta = dom.composerBody;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const selected = ta.value.slice(start, end);
  let replacement = selected;
  let cursorOffset = 0;

  switch (action) {
    case 'bold':
      replacement = `**${selected || 'bold text'}**`;
      cursorOffset = selected ? replacement.length : 2;
      break;
    case 'italic':
      replacement = `*${selected || 'italic text'}*`;
      cursorOffset = selected ? replacement.length : 1;
      break;
    case 'h2':
      replacement = `\n## ${selected || 'Heading'}\n`;
      cursorOffset = replacement.length - 1;
      break;
    case 'quote':
      replacement = `\n> ${selected || 'Quoted passage'}\n`;
      cursorOffset = replacement.length - 1;
      break;
    case 'list':
      replacement = selected
        ? selected
            .split('\n')
            .map((l) => `- ${l}`)
            .join('\n')
        : '\n- List item\n';
      cursorOffset = replacement.length;
      break;
    case 'code':
      replacement = selected.includes('\n')
        ? `\n\`\`\`\n${selected}\n\`\`\`\n`
        : `\`${selected || 'code'}\``;
      cursorOffset = replacement.length;
      break;
    default:
      return;
  }

  ta.setRangeText(replacement, start, end, 'end');
  if (!selected && (action === 'bold' || action === 'italic')) {
    ta.setSelectionRange(start + cursorOffset, start + replacement.length - cursorOffset);
  }
  ta.focus();
  updateComposerCountsAndPreview();
  scheduleDraftSave();
}

async function openEntryComposer(options = {}) {
  const mode = options.mode === 'edit' ? 'edit' : 'create';
  state.composer.isOpen = true;
  state.composer.mode = mode;

  if (state.composer.pendingUpload?.previewUrl) {
    URL.revokeObjectURL(state.composer.pendingUpload.previewUrl);
  }
  state.composer.pendingUpload = null;
  state.composer.imageMeta = null;
  state.composer.studio.clear();
  dom.composerPhotoFile.value = '';
  dom.composerPhotoUrl.value = '';
  dom.composerPhotoRemoveBtn.hidden = true;

  if (mode === 'edit' && options.entry) {
    const entry = options.entry;
    state.composer.originalDate = entry.diaryDate;
    state.composer.originalWrittenAt = entry.writtenAt || new Date().toISOString();
    state.composer.originalImageSrc = entry.image?.src || null;

    dom.composerTitleHeading.textContent = `Edit Entry · ${entry.diaryDate}`;
    dom.composerDate.value = entry.diaryDate;
    dom.composerTitle.value = options.decryptedTitle ?? entry.title ?? '';
    dom.composerMood.value = entry.mood || '';
    dom.composerTags.value = Array.isArray(entry.tags) ? entry.tags.join(', ') : '';
    dom.composerBody.value = options.decryptedBody ?? entry.body ?? '';
    dom.composerEncryptCheckbox.checked = Boolean(entry.encrypted || isEncryptedPayload(entry.body));
    dom.btnComposerDelete.hidden = false;
    dom.btnComposerSave.textContent = 'Save Changes';

    if (entry.image && entry.image.src) {
      const normalized = normalizeImageMeta(entry.image);
      state.composer.imageMeta = normalized;
      const previewUrl = await resolveMediaSrc(normalized.src, {
        localStore: localMedia,
        githubClient: github,
      });
      dom.composerPhotoRemoveBtn.hidden = false;
      state.composer.studio.setImage(normalized, previewUrl);
    }
  } else {
    state.composer.originalDate = null;
    state.composer.originalWrittenAt = null;
    state.composer.originalImageSrc = null;

    const defaultDate =
      options.date && isValidYmd(options.date)
        ? options.date
        : state.view === 'reader' && !state.compareMode
          ? `${new Date().getFullYear()}-${state.activeMmDd}`
          : getTodayYmd();

    dom.composerTitleHeading.textContent = 'New Diary Entry';
    dom.composerDate.value = isValidYmd(defaultDate) ? defaultDate : getTodayYmd();
    dom.composerTitle.value = '';
    dom.composerMood.value = '';
    dom.composerTags.value = '';
    dom.composerBody.value = '';
    dom.composerEncryptCheckbox.checked = Boolean(state.passphrase);
    dom.btnComposerDelete.hidden = true;
    dom.btnComposerSave.textContent = 'Save Entry';
  }

  updateSecurityHeaderControls();
  setComposerEditorMode('write');
  updateComposerBackdateBadge();
  updateComposerCountsAndPreview();
  checkForRecoveredDraft();

  dom.modalComposer.hidden = false;
  dom.composerBody.focus();
}

function closeEntryComposer() {
  clearTimeout(state.composer.draftTimer);
  state.composer.isOpen = false;
  dom.modalComposer.hidden = true;
}

async function handleEntryComposerSubmit(e) {
  e.preventDefault();
  const diaryDate = dom.composerDate.value;
  if (!isValidYmd(diaryDate)) {
    showToast('Please select a valid calendar date (YYYY-MM-DD).', 'error');
    return;
  }

  const rawTitle = dom.composerTitle.value.trim();
  const rawBody = dom.composerBody.value.trim();
  if (!rawBody) {
    showToast('Entry prose cannot be empty.', 'error');
    return;
  }

  const mood = dom.composerMood.value.trim();
  const tags = Array.from(
    new Set(
      dom.composerTags.value
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean)
    )
  );

  const shouldEncrypt = Boolean(state.passphrase && dom.composerEncryptCheckbox.checked);
  const { year, yearStr, mmdd } = splitYmd(diaryDate);
  const nowIso = new Date().toISOString();
  const isEditing = state.composer.mode === 'edit' && Boolean(state.composer.originalDate);
  const movedDate = isEditing && state.composer.originalDate !== diaryDate;

  // Guard against accidental overwrite if moving/creating on a year that already exists
  if (!isEditing || movedDate) {
    const destDay = await loadDayData(mmdd);
    if (destDay.entries[yearStr]) {
      const overwrite = await showConfirm({
        title: 'Overwrite Existing Entry?',
        message: `An entry already exists for ${diaryDate}. Saving will replace it.`,
        confirmText: 'Overwrite Entry',
        danger: true,
      });
      if (!overwrite.confirmed) return;
    }
  }

  dom.btnComposerSave.disabled = true;
  dom.btnComposerSave.textContent = 'Saving…';

  try {
    let finalImage = state.composer.studio.getMeta();
    const oldImageSrc = state.composer.originalImageSrc;

    if (state.composer.pendingUpload) {
      const uploadedSrc = await persistUploadedPhoto(diaryDate, state.composer.pendingUpload);
      finalImage = normalizeImageMeta({
        ...(finalImage || DEFAULT_IMAGE_META),
        src: uploadedSrc,
      });
    }

    const titlePayload =
      shouldEncrypt && rawTitle
        ? await encryptText(rawTitle, state.passphrase, getVaultIterations())
        : rawTitle;
    const bodyPayload = shouldEncrypt
      ? await encryptText(rawBody, state.passphrase, getVaultIterations())
      : rawBody;

    const entryRecord = {
      year,
      diaryDate,
      title: titlePayload,
      body: bodyPayload,
      tags,
      mood,
      image: finalImage,
      writtenAt: isEditing ? state.composer.originalWrittenAt || nowIso : nowIso,
      updatedAt: nowIso,
      encrypted: shouldEncrypt,
      wordCount: countWords(rawBody),
    };

    // Handle Date Move cleanly: remove old slot before/alongside writing new slot
    if (movedDate) {
      const oldSplit = splitYmd(state.composer.originalDate);
      if (oldSplit.mmdd === mmdd) {
        // Moved across years on the same MM-DD
        await saveDayAndIndex(
          mmdd,
          (day) => {
            delete day.entries[oldSplit.yearStr];
            day.entries[yearStr] = entryRecord;
            return day;
          },
          `diary: move ${state.composer.originalDate} -> ${diaryDate}`
        );
      } else {
        // Moved across different MM-DD files
        await saveDayAndIndex(
          oldSplit.mmdd,
          (day) => {
            delete day.entries[oldSplit.yearStr];
            return day;
          },
          `diary: move out ${state.composer.originalDate}`
        );
        await saveDayAndIndex(
          mmdd,
          (day) => {
            day.entries[yearStr] = entryRecord;
            return day;
          },
          `diary: move in ${diaryDate}`
        );
      }
    } else {
      await saveDayAndIndex(
        mmdd,
        (day) => {
          day.entries[yearStr] = entryRecord;
          return day;
        },
        isEditing ? `diary: update ${diaryDate}` : `diary: create ${diaryDate}`
      );
    }

    // Remove orphaned photo if image was replaced or deleted while editing
    if (isEditing && oldImageSrc && (!finalImage || finalImage.src !== oldImageSrc)) {
      await removeMediaAsset(oldImageSrc);
    }

    clearComposerDraft();
    closeEntryComposer();

    // Navigate directly to the saved calendar day
    state.activeMmDd = mmdd;
    state.compareMode = false;
    state.compareFilterYears = null;
    state.view = 'reader';
    dom.viewReader.hidden = false;
    dom.viewHeatmap.hidden = true;
    dom.viewArchive.hidden = true;
    dom.navReaderBtn.classList.add('is-active');
    dom.navHeatmapBtn.classList.remove('is-active');
    dom.navArchiveBtn.classList.remove('is-active');
    syncHashToUrl();

    await renderReaderView();
    showToast(
      isLiveMode()
        ? `Saved ${diaryDate} & committed to GitHub. Auto-deploy triggered.`
        : `Saved ${diaryDate} in Local Sandbox Mode.`,
      'success'
    );
  } catch (err) {
    showToast(`Could not save entry: ${err.message}`, 'error');
  } finally {
    dom.btnComposerSave.disabled = false;
    dom.btnComposerSave.textContent = isEditing ? 'Save Changes' : 'Save Entry';
  }
}

async function handleDeleteEntry(entry) {
  const { yearStr, mmdd } = splitYmd(entry.diaryDate);
  const hasOwnedMedia = Boolean(
    entry.image?.src && (entry.image.src.startsWith('data/media/') || entry.image.src.startsWith('idb://'))
  );

  const res = await showConfirm({
    title: `Delete ${entry.diaryDate}?`,
    message: `This will permanently delete the ${yearStr} diary entry for ${formatHumanMmDd(
      mmdd
    )}. Your comments on this day will remain intact.`,
    confirmText: 'Delete Entry',
    danger: true,
    extraCheckboxLabel: hasOwnedMedia
      ? 'Also delete the attached photo file from storage'
      : '',
    extraCheckboxDefault: true,
  });

  if (!res.confirmed) return;

  try {
    await saveDayAndIndex(
      mmdd,
      (day) => {
        delete day.entries[yearStr];
        return day;
      },
      `diary: delete ${entry.diaryDate}`
    );

    if (hasOwnedMedia && res.extraChecked) {
      await removeMediaAsset(entry.image.src);
    }

    if (state.composer.isOpen) {
      clearComposerDraft();
      closeEntryComposer();
    }

    await renderActiveView();
    showToast(
      isLiveMode()
        ? `Deleted ${entry.diaryDate} & committed Neocities-safe update to GitHub.`
        : `Deleted ${entry.diaryDate} from Local Sandbox.`,
      'success'
    );
  } catch (err) {
    showToast(`Failed to delete entry: ${err.message}`, 'error');
  }
}

/* ==========================================================================
   PHOTO UPLOAD & URL HELPERS FOR BOTH STUDIOS
   ========================================================================== */
async function handleStudioFileInput(file, targetState, removeBtn) {
  if (!file) return;
  try {
    const processed = await processImageFile(file);
    if (targetState.pendingUpload?.previewUrl) {
      URL.revokeObjectURL(targetState.pendingUpload.previewUrl);
    }
    const previewUrl = URL.createObjectURL(processed.blob);
    targetState.pendingUpload = { ...processed, previewUrl };

    const existing = targetState.studio.getMeta() || DEFAULT_IMAGE_META;
    const nextMeta = normalizeImageMeta({
      ...existing,
      src: previewUrl,
    });
    targetState.imageMeta = nextMeta;
    targetState.studio.setImage(nextMeta, previewUrl);
    removeBtn.hidden = false;
    showToast(`Image ready (${Math.round(processed.size / 1024)} KB). Hold & drag to align.`, 'info');
  } catch (err) {
    showToast(err.message || 'Image could not be loaded.', 'error');
  }
}

function handleStudioUrlApply(urlInput, targetState, removeBtn) {
  const safe = sanitizeUrl(urlInput.value);
  if (!safe || !/^https?:\/\//i.test(safe)) {
    showToast('Please paste a valid https:// image URL.', 'error');
    return;
  }

  if (targetState.pendingUpload?.previewUrl) {
    URL.revokeObjectURL(targetState.pendingUpload.previewUrl);
  }
  targetState.pendingUpload = null;

  const existing = targetState.studio.getMeta() || DEFAULT_IMAGE_META;
  const nextMeta = normalizeImageMeta({
    ...existing,
    src: safe,
  });
  targetState.imageMeta = nextMeta;
  targetState.studio.setImage(nextMeta, safe);
  removeBtn.hidden = false;
  urlInput.value = '';
}

function handleStudioRemovePhoto(targetState, fileInput, urlInput, removeBtn) {
  if (targetState.pendingUpload?.previewUrl) {
    URL.revokeObjectURL(targetState.pendingUpload.previewUrl);
  }
  targetState.pendingUpload = null;
  targetState.imageMeta = null;
  targetState.studio.clear();
  fileInput.value = '';
  urlInput.value = '';
  removeBtn.hidden = true;
}

/* ==========================================================================
   366-DAY PERPETUAL HEATMAP VIEW
   ========================================================================== */
function getAllIndexedYears() {
  const yearSet = new Set();
  for (const info of Object.values(state.index.days || {})) {
    if (Array.isArray(info.years)) {
      for (const y of info.years) yearSet.add(Number(y));
    }
  }
  return Array.from(yearSet).sort((a, b) => b - a);
}

function renderHeatmapView() {
  const daysMap = state.index.days || {};
  const allYears = getAllIndexedYears();
  const prevSelection = dom.heatmapYearFilter.value || 'all';

  // Populate year highlight dropdown
  dom.heatmapYearFilter.innerHTML = '<option value="all">All Recorded Years</option>';
  for (const y of allYears) {
    const opt = document.createElement('option');
    opt.value = String(y);
    opt.textContent = String(y);
    dom.heatmapYearFilter.appendChild(opt);
  }
  dom.heatmapYearFilter.value = allYears.includes(Number(prevSelection)) ? prevSelection : 'all';

  const selectedYear = dom.heatmapYearFilter.value;
  const todayMmDd = getTodayMmDd();

  // Compute summary stats
  let totalEntries = 0;
  let recordedDaysCount = 0;
  let totalWords = 0;
  let totalComments = 0;

  for (const info of Object.values(daysMap)) {
    const yrs = Array.isArray(info.years) ? info.years : [];
    if (yrs.length > 0) recordedDaysCount += 1;
    totalEntries += yrs.length;
    totalComments += Number(info.commentCount) || 0;
    if (info.wordCounts && typeof info.wordCounts === 'object') {
      for (const wc of Object.values(info.wordCounts)) {
        totalWords += Number(wc) || 0;
      }
    }
  }

  const spanText =
    allYears.length > 1
      ? `${allYears[allYears.length - 1]}–${allYears[0]}`
      : allYears.length === 1
        ? String(allYears[0])
        : '—';

  dom.heatmapStats.innerHTML = `
    <div class="stat-tile"><div class="stat-value">${totalEntries}</div><div class="stat-label">Total Entries</div></div>
    <div class="stat-tile"><div class="stat-value">${recordedDaysCount} / 366</div><div class="stat-label">Calendar Days Logged</div></div>
    <div class="stat-tile"><div class="stat-value">${escapeHtml(spanText)}</div><div class="stat-label">Year Span</div></div>
    <div class="stat-tile"><div class="stat-value">${totalWords.toLocaleString()}</div><div class="stat-label">Indexed Words</div></div>
    <div class="stat-tile"><div class="stat-value">${totalComments}</div><div class="stat-label">Margin Notes</div></div>
  `;

  // Render 12x31 matrix
  dom.heatmapGrid.innerHTML = '';

  // Corner + Day 1..31 headers
  const corner = document.createElement('div');
  corner.className = 'heat-col-header';
  dom.heatmapGrid.appendChild(corner);

  for (let d = 1; d <= 31; d += 1) {
    const hdr = document.createElement('div');
    hdr.className = 'heat-col-header';
    hdr.textContent = String(d);
    dom.heatmapGrid.appendChild(hdr);
  }

  for (const m of MONTHS) {
    const mLabel = document.createElement('div');
    mLabel.className = 'heat-month-label';
    mLabel.textContent = m.short;
    dom.heatmapGrid.appendChild(mLabel);

    for (let d = 1; d <= 31; d += 1) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'heat-cell';

      if (d > m.days) {
        cell.classList.add('is-invalid');
        cell.disabled = true;
        cell.tabIndex = -1;
        dom.heatmapGrid.appendChild(cell);
        continue;
      }

      const mmdd = `${pad2(m.num)}-${pad2(d)}`;
      const info = daysMap[mmdd];
      const yrs = info && Array.isArray(info.years) ? info.years : [];

      let level = 0;
      if (selectedYear !== 'all') {
        level = yrs.includes(Number(selectedYear)) ? 4 : 0;
      } else if (yrs.length >= 4) {
        level = 4;
      } else {
        level = yrs.length; // 0, 1, 2, 3
      }

      cell.classList.add(`level-${level}`);
      if (mmdd === todayMmDd) cell.classList.add('is-today');
      cell.setAttribute('aria-label', `${formatHumanMmDd(mmdd)}: ${yrs.length} recorded years`);

      cell.addEventListener('mouseenter', (e) => {
        const yText = yrs.length > 0 ? yrs.join(', ') : 'No entries yet';
        dom.heatmapTooltip.textContent = `${formatHumanMmDd(mmdd)} (${mmdd}) · ${yText}`;
        dom.heatmapTooltip.hidden = false;
        positionTooltip(e.clientX, e.clientY);
      });
      cell.addEventListener('mousemove', (e) => {
        positionTooltip(e.clientX, e.clientY);
      });
      cell.addEventListener('mouseleave', () => {
        dom.heatmapTooltip.hidden = true;
      });
      cell.addEventListener('click', () => {
        dom.heatmapTooltip.hidden = true;
        state.activeMmDd = mmdd;
        state.compareMode = false;
        state.compareFilterYears = null;
        switchView('reader');
      });

      dom.heatmapGrid.appendChild(cell);
    }
  }
}

function positionTooltip(clientX, clientY) {
  const x = Math.min(window.innerWidth - 220, clientX + 14);
  const y = Math.max(12, clientY - 38);
  dom.heatmapTooltip.style.left = `${x}px`;
  dom.heatmapTooltip.style.top = `${y}px`;
}

/* ==========================================================================
   ARCHIVE, SEARCH, TAG CLOUD & ONE-CLICK OWNERSHIP EXPORTS
   ========================================================================== */
async function loadAllIndexedDays() {
  const mmdds = Object.keys(state.index.days || {}).sort();
  dom.btnLoadAllDays.disabled = true;
  dom.btnLoadAllDays.textContent = `Loading 0 / ${mmdds.length}…`;

  try {
    let loaded = 0;
    for (const mmdd of mmdds) {
      await loadDayData(mmdd);
      loaded += 1;
      dom.btnLoadAllDays.textContent = `Loading ${loaded} / ${mmdds.length}…`;
    }
    state.archive.loadedAll = true;
    showToast(`Loaded all ${mmdds.length} indexed calendar days for full-text search.`, 'success');
    await renderArchiveView();
  } catch (err) {
    showToast(`Error loading archive: ${err.message}`, 'error');
  } finally {
    dom.btnLoadAllDays.disabled = false;
    dom.btnLoadAllDays.textContent = 'Load All Indexed Days';
  }
}

async function renderArchiveView() {
  const daysMap = state.index.days || {};
  const indexedMmdds = Object.keys(daysMap).sort();
  const allYears = getAllIndexedYears();

  // Year filter select
  dom.archiveYearFilter.innerHTML = '<option value="all">All Years</option>';
  for (const y of allYears) {
    const opt = document.createElement('option');
    opt.value = String(y);
    opt.textContent = String(y);
    dom.archiveYearFilter.appendChild(opt);
  }
  dom.archiveYearFilter.value = state.archive.year;
  dom.archiveSearchInput.value = state.archive.query;

  // Tag cloud from index
  const tagCounts = new Map();
  for (const info of Object.values(daysMap)) {
    for (const t of info.tags || []) {
      tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
    }
  }
  const sortedTags = Array.from(tagCounts.entries()).sort((a, b) => b[1] - a[1]);

  dom.archiveTagCloud.innerHTML = '';
  if (sortedTags.length > 0) {
    const clearTag = document.createElement('button');
    clearTag.type = 'button';
    clearTag.className = `tag-chip${!state.archive.tag ? ' is-active' : ''}`;
    clearTag.textContent = 'All Tags';
    clearTag.addEventListener('click', () => {
      state.archive.tag = '';
      renderArchiveView();
    });
    dom.archiveTagCloud.appendChild(clearTag);

    for (const [tag, count] of sortedTags) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `tag-chip${state.archive.tag === tag ? ' is-active' : ''}`;
      btn.textContent = `#${tag} (${count})`;
      btn.addEventListener('click', () => {
        state.archive.tag = state.archive.tag === tag ? '' : tag;
        renderArchiveView();
      });
      dom.archiveTagCloud.appendChild(btn);
    }
  }

  // Count how many indexed days are loaded in memory
  const loadedCount = indexedMmdds.filter((d) => state.dayCache.has(d)).length;
  dom.archiveLoadStatus.textContent = `${loadedCount} of ${indexedMmdds.length} indexed days loaded in memory for full-text search.`;

  // Gather matching items
  const query = state.archive.query.trim().toLowerCase();
  const filterYear = state.archive.year;
  const filterTag = state.archive.tag;
  const cards = [];

  for (const mmdd of indexedMmdds) {
    const dayInfo = daysMap[mmdd];
    const cachedDay = state.dayCache.get(mmdd);

    if (cachedDay) {
      for (const entry of Object.values(cachedDay.entries || {})) {
        if (filterYear !== 'all' && String(entry.year) !== filterYear) continue;
        if (filterTag && !(entry.tags || []).includes(filterTag)) continue;

        const decTitle = await decryptFieldSafe(entry.title || '');
        const decBody = await decryptFieldSafe(entry.body || '');
        const plainBody = decBody.sealed ? '[Encrypted Entry]' : stripMarkdown(decBody.text);
        const plainTitle = decTitle.sealed ? '[Encrypted]' : decTitle.text;

        if (query) {
          const hay = `${entry.diaryDate} ${plainTitle} ${entry.mood || ''} ${(entry.tags || []).join(
            ' '
          )} ${plainBody}`.toLowerCase();
          if (!hay.includes(query)) continue;
        }

        cards.push({
          mmdd,
          year: entry.year,
          diaryDate: entry.diaryDate,
          title: plainTitle || formatHumanMmDd(mmdd),
          snippet: plainBody.slice(0, 220),
          tags: entry.tags || [],
          sealed: decBody.sealed,
        });
      }
    } else {
      // Lightweight index-only card before Load All is pressed
      for (const y of dayInfo.years || []) {
        if (filterYear !== 'all' && String(y) !== filterYear) continue;
        if (filterTag && !(dayInfo.tags || []).includes(filterTag)) continue;
        const diaryDate = `${y}-${mmdd}`;
        if (query) {
          const hay = `${diaryDate} ${formatHumanMmDd(mmdd)} ${(dayInfo.tags || []).join(' ')}`.toLowerCase();
          if (!hay.includes(query)) continue;
        }
        cards.push({
          mmdd,
          year: y,
          diaryDate,
          title: formatHumanMmDd(mmdd),
          snippet: 'Click to open day, or click "Load All Indexed Days" to search full prose.',
          tags: dayInfo.tags || [],
          sealed: false,
        });
      }
    }
  }

  cards.sort((a, b) => b.diaryDate.localeCompare(a.diaryDate));
  dom.archiveResults.innerHTML = '';

  if (cards.length === 0) {
    dom.archiveResults.innerHTML =
      '<p class="muted-note">No entries matched your current filter or search query.</p>';
    return;
  }

  for (const item of cards) {
    const card = document.createElement('article');
    card.className = 'archive-card';
    card.innerHTML = `
      <div class="archive-card-head">
        <span class="mono-pill">${escapeHtml(item.diaryDate)}</span>
        ${item.sealed ? '<span class="mono-pill mono-pill-amber">SEALED</span>' : ''}
      </div>
      <h3 class="archive-card-title">${escapeHtml(item.title)}</h3>
      <p class="archive-card-snippet">${escapeHtml(item.snippet)}</p>
    `;
    card.addEventListener('click', () => {
      state.activeMmDd = item.mmdd;
      state.compareMode = false;
      state.compareFilterYears = null;
      switchView('reader');
    });
    dom.archiveResults.appendChild(card);
  }
}

function triggerFileDownload(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function gatherFullDecryptedArchive() {
  const mmdds = Object.keys(state.index.days || {}).sort();
  const daysOut = {};

  for (const mmdd of mmdds) {
    const dayData = await loadDayData(mmdd);
    const entriesOut = {};

    for (const [yKey, entry] of Object.entries(dayData.entries || {})) {
      const decTitle = await decryptFieldSafe(entry.title || '');
      const decBody = await decryptFieldSafe(entry.body || '');
      entriesOut[yKey] = {
        ...entry,
        title: decTitle.sealed ? entry.title : decTitle.text,
        body: decBody.sealed ? entry.body : decBody.text,
      };
    }

    const commentsOut = [];
    for (const cmt of dayData.comments || []) {
      const decBody = await decryptFieldSafe(cmt.body || '');
      const decQuote = cmt.quote?.text
        ? await decryptFieldSafe(cmt.quote.text)
        : { sealed: false, text: '' };
      commentsOut.push({
        ...cmt,
        body: decBody.sealed ? cmt.body : decBody.text,
        quote: cmt.quote
          ? { ...cmt.quote, text: decQuote.sealed ? cmt.quote.text : decQuote.text }
          : null,
      });
    }

    daysOut[mmdd] = { day: mmdd, entries: entriesOut, comments: commentsOut };
  }

  return {
    exportedAt: new Date().toISOString(),
    source: isLiveMode() ? `${github.owner}/${github.repo}` : 'local-sandbox',
    index: state.index,
    days: daysOut,
  };
}

async function handleExportJson() {
  try {
    showToast('Preparing complete .JSON archive…', 'info', 2000);
    const archive = await gatherFullDecryptedArchive();
    triggerFileDownload(
      `perpetual-diary-${getTodayYmd()}.json`,
      `${JSON.stringify(archive, null, 2)}\n`,
      'application/json'
    );
    showToast('Downloaded full .JSON diary archive.', 'success');
  } catch (err) {
    showToast(`Export failed: ${err.message}`, 'error');
  }
}

async function handleExportMarkdown() {
  try {
    showToast('Compiling Markdown book…', 'info', 2000);
    const archive = await gatherFullDecryptedArchive();
    const lines = [
      '# Perpetual Side-by-Side Web Diary',
      '',
      `_Exported on ${new Date().toLocaleString()}_`,
      '',
      '---',
      '',
    ];

    for (const mmdd of Object.keys(archive.days).sort()) {
      const day = archive.days[mmdd];
      lines.push(`## ${formatHumanMmDd(mmdd)} (${mmdd})`, '');

      const years = Object.keys(day.entries).sort((a, b) => Number(a) - Number(b));
      for (const y of years) {
        const e = day.entries[y];
        lines.push(`### ${e.diaryDate}${e.title ? ` — ${e.title}` : ''}`);
        const metaParts = [];
        if (e.mood) metaParts.push(`Mood: ${e.mood}`);
        if (e.tags?.length) metaParts.push(`Tags: ${e.tags.map((t) => `#${t}`).join(', ')}`);
        if (metaParts.length) lines.push(`_${metaParts.join(' · ')}_`);
        lines.push('', e.body || '', '');
      }

      if (day.comments.length > 0) {
        lines.push('#### Margin Notes', '');
        for (const c of day.comments) {
          if (c.quote?.text) {
            lines.push(`> "${c.quote.text}" — *(${c.quote.diaryDate})*`, '');
          }
          lines.push(`- **${c.author || 'Self'}** (${formatShortTimestamp(c.createdAt)}): ${c.body}`, '');
        }
      }

      lines.push('---', '');
    }

    triggerFileDownload(
      `perpetual-diary-book-${getTodayYmd()}.md`,
      lines.join('\n'),
      'text/markdown;charset=utf-8'
    );
    showToast('Downloaded formatted .MD diary book.', 'success');
  } catch (err) {
    showToast(`Export failed: ${err.message}`, 'error');
  }
}

/* ==========================================================================
   GITHUB SETTINGS MODAL & VAULT PASSWORD MODAL
   ========================================================================== */
function openGithubModal() {
  dom.ghOwner.value = github.owner;
  dom.ghRepo.value = github.repo;
  dom.ghBranch.value = github.branch || 'main';
  dom.ghDataPath.value = github.dataPath || 'data';
  dom.ghToken.value = github.token || '';
  dom.ghReadApi.checked = github.readFromApi;
  dom.ghEncryptPatLocal.checked = Boolean(localStorage.getItem(LS_GH_PAT_ENC_KEY));
  dom.ghTestResult.hidden = true;
  dom.modalGithub.hidden = false;
  dom.ghOwner.focus();
}

function openVaultModal() {
  dom.vaultFormError.hidden = true;
  dom.vaultCurrentPassword.value = '';
  dom.vaultNewPassword.value = '';
  dom.vaultConfirmPassword.value = '';

  const configured = hasVaultConfigured();
  dom.vaultEnabledCheckbox.checked = configured ? Boolean(state.vault.enabled) : true;
  dom.vaultCurrentPasswordGroup.hidden = !configured;
  dom.btnVaultDisable.hidden = !configured;
  dom.vaultStorePatInVault.checked = Boolean(state.vault && isEncryptedPayload(state.vault.encryptedPat));

  if (configured) {
    dom.vaultStatusBox.className = 'status-box is-ok';
    dom.vaultStatusBox.textContent = state.vault.enabled
      ? `VAULT ACTIVE · Full Lock Screen ON · PBKDF2-SHA256 (${getVaultIterations().toLocaleString()} iterations)`
      : `VAULT READY · Full Lock Screen OFF (Per-Entry Encryption Available)`;
  } else {
    dom.vaultStatusBox.className = 'status-box';
    dom.vaultStatusBox.textContent =
      'NO MASTER PASSWORD SET · Set a password below to enable Full Lock Screen & AES-256-GCM encryption.';
  }

  dom.modalVault.hidden = false;
  (configured ? dom.vaultCurrentPassword : dom.vaultNewPassword).focus();
}

function closeAllModals() {
  closeEntryComposer();
  dom.modalGithub.hidden = true;
  dom.modalVault.hidden = true;
  if (!dom.modalConfirm.hidden) {
    closeConfirm(false);
  }
}

async function persistVaultConfig(nextVaultObj, commitMsg) {
  state.vault = nextVaultObj;
  if (isLiveMode()) {
    await github.putJson('vault.json', nextVaultObj, commitMsg);
  } else {
    const sandbox = loadSandboxStore() || createBuiltInSeed();
    sandbox.vault = nextVaultObj;
    saveSandboxStore(sandbox);
  }
}

/* ==========================================================================
   EVENT BINDINGS & KEYBOARD SHORTCUTS
   ========================================================================== */
function bindEvents() {
  // Theme toggle
  dom.btnThemeToggle.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem(LS_THEME_KEY, next);
  });

  // Lock screen submit
  dom.lockForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const candidate = dom.lockPasswordInput.value;
    if (!candidate) return;

    dom.lockSubmitBtn.disabled = true;
    dom.lockSubmitBtn.textContent = 'Verifying…';
    dom.lockError.hidden = true;

    try {
      const ok = await unlockWithPassword(candidate, dom.lockRememberSession.checked);
      if (!ok) {
        dom.lockError.textContent = 'Incorrect password. Please try again.';
        dom.lockError.hidden = false;
        dom.lockPasswordInput.select();
        return;
      }
      await renderActiveView();
    } catch (err) {
      dom.lockError.textContent = err.message || 'Unlock failed.';
      dom.lockError.hidden = false;
    } finally {
      dom.lockSubmitBtn.disabled = false;
      dom.lockSubmitBtn.textContent = 'Unlock Diary';
    }
  });

  // Header navigation
  dom.brandHomeBtn.addEventListener('click', () => {
    state.activeMmDd = getTodayMmDd();
    state.compareMode = false;
    state.compareFilterYears = null;
    switchView('reader');
  });
  dom.navReaderBtn.addEventListener('click', () => switchView('reader'));
  dom.navHeatmapBtn.addEventListener('click', () => switchView('heatmap'));
  dom.navArchiveBtn.addEventListener('click', () => switchView('archive'));

  dom.btnNewEntry.addEventListener('click', () => openEntryComposer({ mode: 'create' }));
  dom.btnLockNow.addEventListener('click', lockDiaryNow);
  dom.btnVaultSettings.addEventListener('click', openVaultModal);
  dom.btnGithubSettings.addEventListener('click', openGithubModal);

  // Reader Date Navigation
  dom.selectMonth.addEventListener('change', () => {
    populateDaySelect(dom.selectMonth.value, dom.selectDay.value);
    state.activeMmDd = `${dom.selectMonth.value}-${dom.selectDay.value}`;
    state.compareMode = false;
    state.compareFilterYears = null;
    syncHashToUrl();
    renderReaderView();
  });

  dom.selectDay.addEventListener('change', () => {
    state.activeMmDd = `${dom.selectMonth.value}-${dom.selectDay.value}`;
    state.compareMode = false;
    state.compareFilterYears = null;
    syncHashToUrl();
    renderReaderView();
  });

  dom.btnPrevDay.addEventListener('click', () => {
    state.activeMmDd = stepMmDd(state.activeMmDd, -1);
    state.compareMode = false;
    state.compareFilterYears = null;
    syncHashToUrl();
    renderReaderView();
  });

  dom.btnNextDay.addEventListener('click', () => {
    state.activeMmDd = stepMmDd(state.activeMmDd, 1);
    state.compareMode = false;
    state.compareFilterYears = null;
    syncHashToUrl();
    renderReaderView();
  });

  dom.btnToday.addEventListener('click', () => {
    state.activeMmDd = getTodayMmDd();
    state.compareMode = false;
    state.compareFilterYears = null;
    syncHashToUrl();
    renderReaderView();
  });

  dom.btnNextRecorded.addEventListener('click', () => {
    const days = Object.keys(state.index.days || {})
      .filter((k) => (state.index.days[k]?.years || []).length > 0)
      .sort();
    if (days.length === 0) {
      showToast('No recorded days in index yet.', 'info');
      return;
    }
    const next = days.find((d) => d > state.activeMmDd) || days[0];
    state.activeMmDd = next;
    state.compareMode = false;
    state.compareFilterYears = null;
    syncHashToUrl();
    renderReaderView();
  });

  dom.btnRandomDay.addEventListener('click', () => {
    const days = Object.keys(state.index.days || {}).filter(
      (k) => (state.index.days[k]?.years || []).length > 0
    );
    if (days.length === 0) {
      showToast('No recorded days in index yet.', 'info');
      return;
    }
    const pool = days.length > 1 ? days.filter((d) => d !== state.activeMmDd) : days;
    state.activeMmDd = pool[Math.floor(Math.random() * pool.length)];
    state.compareMode = false;
    state.compareFilterYears = null;
    syncHashToUrl();
    renderReaderView();
  });

  dom.btnJumpComments.addEventListener('click', () => {
    dom.commentsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // Sizing segmented control
  dom.sizingControl.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn[data-size]');
    if (!btn) return;
    state.sizeMode = btn.dataset.size;
    saveUiPrefs();
    syncReaderHeaderControls(state.dayCache.get(state.activeMmDd));
  });

  // Chronological sort toggle
  dom.btnSortOrder.addEventListener('click', () => {
    state.sortOrder = state.sortOrder === 'asc' ? 'desc' : 'asc';
    saveUiPrefs();
    renderReaderView();
  });

  // Mobile layout toggle (Swipe vs Year Tabs)
  dom.btnMobileLayout.addEventListener('click', () => {
    state.mobileLayout = state.mobileLayout === 'swipe' ? 'tabs' : 'swipe';
    saveUiPrefs();
    renderReaderView();
  });

  // Custom Compare 2 Controls
  dom.btnCompareMode.addEventListener('click', () => {
    state.compareMode = !state.compareMode;
    if (state.compareMode) {
      if (!isValidYmd(state.compareDateA)) {
        state.compareDateA = `${new Date().getFullYear() - 1}-${state.activeMmDd}`;
      }
      if (!isValidYmd(state.compareDateB)) {
        state.compareDateB = getTodayYmd();
      }
    }
    syncHashToUrl();
    renderReaderView();
  });

  dom.btnCompareSwap.addEventListener('click', () => {
    const tmp = dom.compareDateA.value;
    dom.compareDateA.value = dom.compareDateB.value;
    dom.compareDateB.value = tmp;
    state.compareDateA = dom.compareDateA.value;
    state.compareDateB = dom.compareDateB.value;
    syncHashToUrl();
    renderReaderView();
  });

  dom.btnCompareApply.addEventListener('click', () => {
    if (!isValidYmd(dom.compareDateA.value) || !isValidYmd(dom.compareDateB.value)) {
      showToast('Pick two valid YYYY-MM-DD dates to compare.', 'error');
      return;
    }
    state.compareDateA = dom.compareDateA.value;
    state.compareDateB = dom.compareDateB.value;
    syncHashToUrl();
    renderReaderView();
  });

  dom.btnCompareExit.addEventListener('click', () => {
    state.compareMode = false;
    syncHashToUrl();
    renderReaderView();
  });

  dom.btnCopyPermalink.addEventListener('click', async () => {
    syncHashToUrl(true);
    try {
      await navigator.clipboard.writeText(window.location.href);
      showToast('Permalink copied to clipboard.', 'success');
    } catch {
      showToast(`Link: ${window.location.hash}`, 'info');
    }
  });

  // Floating Highlight-to-Quote popover
  document.addEventListener('mouseup', () => setTimeout(handleDocumentSelectionChange, 15));
  document.addEventListener('keyup', () => setTimeout(handleDocumentSelectionChange, 15));
  dom.btnQuoteSelection.addEventListener('click', () => {
    if (state.selectionQuote) {
      attachQuoteToCommentComposer(state.selectionQuote);
      window.getSelection()?.removeAllRanges();
    }
  });

  // Comment Composer
  dom.commentForm.addEventListener('submit', handleCommentSubmit);
  dom.btnCancelCommentEdit.addEventListener('click', resetCommentComposer);
  dom.btnRemoveCommentQuote.addEventListener('click', () => attachQuoteToCommentComposer(null));
  dom.commentPhotoToggleBtn.addEventListener('click', () => {
    dom.commentPhotoPanel.hidden = !dom.commentPhotoPanel.hidden;
  });
  dom.commentPhotoFile.addEventListener('change', () => {
    handleStudioFileInput(
      dom.commentPhotoFile.files?.[0],
      state.commentComposer,
      dom.commentPhotoRemoveBtn
    );
  });
  dom.commentPhotoUrlApply.addEventListener('click', () => {
    handleStudioUrlApply(
      dom.commentPhotoUrl,
      state.commentComposer,
      dom.commentPhotoRemoveBtn
    );
  });
  dom.commentPhotoRemoveBtn.addEventListener('click', () => {
    handleStudioRemovePhoto(
      state.commentComposer,
      dom.commentPhotoFile,
      dom.commentPhotoUrl,
      dom.commentPhotoRemoveBtn
    );
  });

  // Heatmap & Archive events
  dom.heatmapYearFilter.addEventListener('change', renderHeatmapView);
  dom.archiveSearchInput.addEventListener('input', () => {
    state.archive.query = dom.archiveSearchInput.value;
    renderArchiveView();
  });
  dom.archiveYearFilter.addEventListener('change', () => {
    state.archive.year = dom.archiveYearFilter.value;
    renderArchiveView();
  });
  dom.btnLoadAllDays.addEventListener('click', loadAllIndexedDays);
  dom.btnExportJson.addEventListener('click', handleExportJson);
  dom.btnExportMd.addEventListener('click', handleExportMarkdown);

  // Entry Composer Modal
  dom.btnCloseComposer.addEventListener('click', closeEntryComposer);
  dom.btnComposerCancel.addEventListener('click', closeEntryComposer);
  dom.composerForm.addEventListener('submit', handleEntryComposerSubmit);
  dom.composerDate.addEventListener('change', updateComposerBackdateBadge);
  dom.composerBody.addEventListener('input', () => {
    updateComposerCountsAndPreview();
    scheduleDraftSave();
  });
  dom.composerTitle.addEventListener('input', scheduleDraftSave);
  dom.composerMood.addEventListener('input', scheduleDraftSave);
  dom.composerTags.addEventListener('input', scheduleDraftSave);

  dom.composerMdToolbar.addEventListener('click', (e) => {
    const btn = e.target.closest('.md-btn[data-md]');
    if (btn) applyMarkdownToolbarAction(btn.dataset.md);
  });

  dom.composerViewTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn[data-editor-mode]');
    if (btn) setComposerEditorMode(btn.dataset.editorMode);
  });

  dom.btnRestoreDraft.addEventListener('click', () => {
    try {
      const raw = localStorage.getItem(getDraftStorageKey());
      if (!raw) return;
      const d = JSON.parse(raw);
      if (d.diaryDate && isValidYmd(d.diaryDate)) dom.composerDate.value = d.diaryDate;
      dom.composerTitle.value = d.title || '';
      dom.composerMood.value = d.mood || '';
      dom.composerTags.value = d.tags || '';
      dom.composerBody.value = d.body || '';
      updateComposerBackdateBadge();
      updateComposerCountsAndPreview();
      dom.composerDraftBanner.hidden = true;
      showToast('Recovered unsaved draft.', 'info');
    } catch {
      dom.composerDraftBanner.hidden = true;
    }
  });
  dom.btnDiscardDraft.addEventListener('click', clearComposerDraft);

  dom.composerPhotoFile.addEventListener('change', () => {
    handleStudioFileInput(
      dom.composerPhotoFile.files?.[0],
      state.composer,
      dom.composerPhotoRemoveBtn
    );
  });
  dom.composerPhotoUrlApply.addEventListener('click', () => {
    handleStudioUrlApply(
      dom.composerPhotoUrl,
      state.composer,
      dom.composerPhotoRemoveBtn
    );
  });
  dom.composerPhotoRemoveBtn.addEventListener('click', () => {
    handleStudioRemovePhoto(
      state.composer,
      dom.composerPhotoFile,
      dom.composerPhotoUrl,
      dom.composerPhotoRemoveBtn
    );
  });

  dom.btnComposerDelete.addEventListener('click', async () => {
    if (!state.composer.originalDate) return;
    const { yearStr, mmdd } = splitYmd(state.composer.originalDate);
    const day = await loadDayData(mmdd);
    const entry = day.entries[yearStr];
    if (entry) {
      await handleDeleteEntry(entry);
    }
  });

  // GitHub Settings Modal
  dom.btnCloseGithub.addEventListener('click', () => {
    dom.modalGithub.hidden = true;
  });

  dom.btnGhTest.addEventListener('click', async () => {
    const temp = new GitHubClient({
      owner: dom.ghOwner.value,
      repo: dom.ghRepo.value,
      branch: dom.ghBranch.value,
      dataPath: dom.ghDataPath.value,
      token: dom.ghToken.value,
    });
    dom.btnGhTest.disabled = true;
    dom.btnGhTest.textContent = 'Testing…';
    dom.ghTestResult.hidden = false;
    dom.ghTestResult.className = 'status-box';
    dom.ghTestResult.textContent = 'Contacting GitHub REST API…';
    try {
      const res = await temp.testConnection();
      dom.ghTestResult.className = `status-box ${res.ok ? 'is-ok' : 'is-err'}`;
      dom.ghTestResult.textContent = res.message;
    } catch (err) {
      dom.ghTestResult.className = 'status-box is-err';
      dom.ghTestResult.textContent = err.message || 'Connection test failed.';
    } finally {
      dom.btnGhTest.disabled = false;
      dom.btnGhTest.textContent = 'Test Connection';
    }
  });

  dom.btnGhClear.addEventListener('click', () => {
    github.updateConfig({ token: '' });
    dom.ghToken.value = '';
    localStorage.removeItem(LS_GH_PAT_ENC_KEY);
    persistGithubConfig({ storePlainToken: false, encryptPatLocal: false });
    updateModeBadge();
    dom.ghTestResult.hidden = false;
    dom.ghTestResult.className = 'status-box';
    dom.ghTestResult.textContent = 'Token cleared from browser. Switched to Local Sandbox / Read Mode.';
    showToast('GitHub token cleared.', 'info');
  });

  dom.githubForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const encryptLocal = dom.ghEncryptPatLocal.checked;
    const rawToken = dom.ghToken.value.trim();

    if (encryptLocal && rawToken && !state.passphrase) {
      dom.ghTestResult.hidden = false;
      dom.ghTestResult.className = 'status-box is-err';
      dom.ghTestResult.textContent =
        'Set or unlock your Diary Vault password first before encrypting your PAT in localStorage.';
      return;
    }

    github.updateConfig({
      owner: dom.ghOwner.value,
      repo: dom.ghRepo.value,
      branch: dom.ghBranch.value,
      dataPath: dom.ghDataPath.value,
      token: rawToken,
      readFromApi: dom.ghReadApi.checked,
    });

    if (encryptLocal && rawToken && state.passphrase) {
      const encBlob = await encryptPat(rawToken, state.passphrase, getVaultIterations());
      localStorage.setItem(LS_GH_PAT_ENC_KEY, encBlob);
      persistGithubConfig({ storePlainToken: false, encryptPatLocal: true });
    } else {
      localStorage.removeItem(LS_GH_PAT_ENC_KEY);
      persistGithubConfig({ storePlainToken: true, encryptPatLocal: false });
    }

    updateModeBadge();
    dom.modalGithub.hidden = true;
    state.dayCache.clear();
    await loadVaultMetadata();
    await loadIndexData();
    await renderActiveView();
    showToast(
      isLiveMode()
        ? `Connected to ${github.owner}/${github.repo} in Live Mode.`
        : 'Saved settings (Local Sandbox Mode active).',
      'success'
    );
  });

  // Vault Password Modal
  dom.btnCloseVault.addEventListener('click', () => {
    dom.modalVault.hidden = true;
  });

  dom.btnVaultDisable.addEventListener('click', async () => {
    const res = await showConfirm({
      title: 'Disable Full Lock Screen?',
      message:
        'Visitors will be able to open the site without a password gate. Already-encrypted entries will remain sealed as AES-256-GCM ciphertext until unlocked.',
      confirmText: 'Disable Lock Gate',
      danger: true,
    });
    if (!res.confirmed) return;

    try {
      const updated = { ...state.vault, enabled: false, updatedAt: new Date().toISOString() };
      await persistVaultConfig(updated, 'diary: disable vault lock gate');
      dom.modalVault.hidden = true;
      showToast('Full Lock Screen disabled.', 'info');
    } catch (err) {
      showToast(`Failed to update vault.json: ${err.message}`, 'error');
    }
  });

  dom.vaultForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    dom.vaultFormError.hidden = true;

    const configured = hasVaultConfigured();
    const currentPass = dom.vaultCurrentPassword.value;
    const newPass = dom.vaultNewPassword.value;
    const confirmPass = dom.vaultConfirmPassword.value;
    const lockEnabled = dom.vaultEnabledCheckbox.checked;
    const storePatInVault = dom.vaultStorePatInVault.checked;

    dom.btnVaultSave.disabled = true;
    dom.btnVaultSave.textContent = 'Deriving Key…';

    try {
      if (configured) {
        const okCurrent = await verifyVaultPassword(currentPass, state.vault);
        if (!okCurrent) {
          throw new Error('Current master password is incorrect.');
        }
      }

      const activePassword = newPass || (configured ? currentPass : '');
      if (activePassword.length < 8) {
        throw new Error('Master password must be at least 8 characters long.');
      }
      if (newPass && newPass !== confirmPass) {
        throw new Error('New password and confirmation do not match.');
      }

      let encryptedPat = null;
      if (storePatInVault) {
        if (!github.token) {
          throw new Error('Connect a GitHub PAT in Settings first to store an encrypted copy inside vault.json.');
        }
        encryptedPat = await encryptPat(github.token, activePassword, DEFAULT_ITERATIONS);
      }

      const nextVault = await createVaultConfig(activePassword, {
        enabled: lockEnabled,
        iterations: DEFAULT_ITERATIONS,
        encryptedPat,
      });

      await persistVaultConfig(nextVault, 'diary: update vault password configuration');

      state.passphrase = activePassword;
      state.vaultUnlocked = true;
      try {
        sessionStorage.setItem(SS_PASSPHRASE_KEY, activePassword);
      } catch {
        // Ignore
      }

      // If local encrypted PAT was previously used, re-encrypt it with the new password
      if (localStorage.getItem(LS_GH_PAT_ENC_KEY) && github.token) {
        const reEnc = await encryptPat(github.token, activePassword, DEFAULT_ITERATIONS);
        localStorage.setItem(LS_GH_PAT_ENC_KEY, reEnc);
      }

      updateSecurityHeaderControls();
      dom.modalVault.hidden = true;
      showToast(
        isLiveMode()
          ? 'Vault password saved & committed to data/vault.json.'
          : 'Vault password saved in Local Sandbox.',
        'success'
      );
    } catch (err) {
      dom.vaultFormError.textContent = err.message || 'Could not update vault.';
      dom.vaultFormError.hidden = false;
    } finally {
      dom.btnVaultSave.disabled = false;
      dom.btnVaultSave.textContent = 'Save Vault Password';
    }
  });

  // Custom Confirm Dialog
  dom.btnConfirmCancel.addEventListener('click', () => closeConfirm(false));
  dom.btnConfirmOk.addEventListener('click', () => closeConfirm(true));

  // Hashchange listener
  window.addEventListener('hashchange', () => {
    parseHashRoute();
    dom.viewReader.hidden = state.view !== 'reader';
    dom.viewHeatmap.hidden = state.view !== 'heatmap';
    dom.viewArchive.hidden = state.view !== 'archive';
    dom.navReaderBtn.classList.toggle('is-active', state.view === 'reader');
    dom.navHeatmapBtn.classList.toggle('is-active', state.view === 'heatmap');
    dom.navArchiveBtn.classList.toggle('is-active', state.view === 'archive');
    renderActiveView();
  });

  // Global Keyboard Shortcuts
  document.addEventListener('keydown', (e) => {
    // Ctrl+Shift+G -> Open GitHub Sync Settings
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'g') {
      e.preventDefault();
      openGithubModal();
      return;
    }

    // Esc -> Close modals / popover
    if (e.key === 'Escape') {
      if (!dom.modalConfirm.hidden) {
        closeConfirm(false);
      } else if (state.composer.isOpen) {
        closeEntryComposer();
      } else if (!dom.modalGithub.hidden) {
        dom.modalGithub.hidden = true;
      } else if (!dom.modalVault.hidden) {
        dom.modalVault.hidden = true;
      } else {
        hideQuotePopover();
      }
      return;
    }

    // Ignore navigation arrows while typing in inputs or when a modal is open
    const tag = document.activeElement?.tagName;
    if (
      tag === 'INPUT' ||
      tag === 'TEXTAREA' ||
      tag === 'SELECT' ||
      state.composer.isOpen ||
      !dom.modalGithub.hidden ||
      !dom.modalVault.hidden ||
      !dom.lockScreen.hidden
    ) {
      return;
    }

    if (state.view === 'reader' && !state.compareMode) {
      if (e.key === 'ArrowLeft') {
        if (e.shiftKey) {
          dom.columnsTrack.scrollBy({ left: -380, behavior: 'smooth' });
        } else {
          state.activeMmDd = stepMmDd(state.activeMmDd, -1);
          syncHashToUrl();
          renderReaderView();
        }
      } else if (e.key === 'ArrowRight') {
        if (e.shiftKey) {
          dom.columnsTrack.scrollBy({ left: 380, behavior: 'smooth' });
        } else {
          state.activeMmDd = stepMmDd(state.activeMmDd, 1);
          syncHashToUrl();
          renderReaderView();
        }
      }
    }
  });
}

/* ==========================================================================
   INITIALIZATION BOOTSTRAP
   ========================================================================== */
async function init() {
  // 1. Apply saved theme
  const savedTheme = localStorage.getItem(LS_THEME_KEY) || 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);

  // 2. Load UI preferences & GitHub configuration
  loadUiPrefs();
  loadGithubConfigFromStorage();
  updateModeBadge();

  // 3. Populate Month/Day pickers and mount both Hold-and-Drag Alignment Studios
  populateMonthSelect();
  state.composer.studio = new AlignmentStudio(dom.composerAlignmentStudio, {
    onChange: (meta) => {
      state.composer.imageMeta = meta;
    },
  });
  state.commentComposer.studio = new AlignmentStudio(dom.commentAlignmentStudio, {
    onChange: (meta) => {
      state.commentComposer.imageMeta = meta;
    },
  });

  // 4. Bind all DOM & keyboard listeners
  bindEvents();

  // 5. Load Vault metadata and check Lock Gate BEFORE displaying any diary prose
  await loadVaultMetadata();

  if (state.vault.enabled && hasVaultConfigured()) {
    let unlockedFromSession = false;
    try {
      const savedPass = sessionStorage.getItem(SS_PASSPHRASE_KEY);
      if (savedPass) {
        unlockedFromSession = await unlockWithPassword(savedPass, true);
      }
    } catch {
      unlockedFromSession = false;
    }

    if (!unlockedFromSession) {
      dom.lockScreen.hidden = false;
      dom.lockPasswordInput.focus();
      updateSecurityHeaderControls();
      // Preload index silently so once unlocked, reader renders immediately
      await loadIndexData().catch(() => {});
      parseHashRoute();
      return;
    }
  } else {
    state.vaultUnlocked = true;
    // If passphrase exists in session for per-entry decryption, restore silently
    try {
      const savedPass = sessionStorage.getItem(SS_PASSPHRASE_KEY);
      if (savedPass && (!hasVaultConfigured() || (await verifyVaultPassword(savedPass, state.vault)))) {
        state.passphrase = savedPass;
        await tryAutoDecryptStoredPat(savedPass);
      }
    } catch {
      // Ignore
    }
  }

  updateSecurityHeaderControls();

  // 6. Load lightweight index manifest, resolve route, and render active view
  await loadIndexData();
  parseHashRoute();
  dom.viewReader.hidden = state.view !== 'reader';
  dom.viewHeatmap.hidden = state.view !== 'heatmap';
  dom.viewArchive.hidden = state.view !== 'archive';
  dom.navReaderBtn.classList.toggle('is-active', state.view === 'reader');
  dom.navHeatmapBtn.classList.toggle('is-active', state.view === 'heatmap');
  dom.navArchiveBtn.classList.toggle('is-active', state.view === 'archive');
  syncHashToUrl(true);

  await renderActiveView();
}

init().catch((err) => {
  showToast(`Startup error: ${err.message}`, 'error', 8000);
});