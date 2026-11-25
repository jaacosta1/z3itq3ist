/**
 * js/github.js — Perpetual Side-by-Side Web Diary GitHub API Client (File 1 of 5 · Clean Build)
 *
 * Capabilities:
 * - Split-Repo Architecture (Public Pages/Neocities App Repo + Private Data Vault Repo)
 * - Multi-Entry-Per-Year support (`getYearEntriesList` backward-compatible with legacy single entries)
 * - Atomic Multi-File Commits via GitHub Git Data API (blobs -> tree -> commit -> ref)
 * - Optimistic Concurrency & SyncConflictError for the Interactive 3-Way Conflict Resolver
 * - Yearly / Era Media-Repo Sharding (`getMediaTarget`, `testMediaShard`, `uploadMediaToShard`)
 * - Metadata Cloaking (`index.enc`, HMAC day shards, generic `sync: update` commit masking)
 * - Repo Health, 1 GB Pages Storage Quota, Pages Build Status & PAT Expiry Radar
 * - Offline Commit Queue detection & transaction serialization/replay hooks
 */

import { resolveShardRepoName } from './media-sharding.js';

/* ============================================================================
   UTF-8 & BINARY BASE64 UTILITIES
   ============================================================================ */

/**
 * Encodes a UTF-8 string (including emojis and non-Latin scripts) to Base64 safely.
 * @param {string} str
 * @returns {string}
 */
export function encodeBase64Utf8(str) {
  const bytes = new TextEncoder().encode(String(str ?? ''));
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * Decodes a Base64 string back into a UTF-8 string cleanly.
 * @param {string} base64
 * @returns {string}
 */
export function decodeBase64Utf8(base64) {
  const clean = String(base64 ?? '').replace(/\s+/g, '');
  if (!clean) return '';
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Encodes an ArrayBuffer or Uint8Array to Base64 without stack overflow on large files.
 * @param {ArrayBuffer | Uint8Array} buffer
 * @returns {string}
 */
export function arrayBufferToBase64(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * Decodes a Base64 string into a Uint8Array (used for Offline Commit Queue media replay).
 * @param {string} base64
 * @returns {Uint8Array}
 */
export function base64ToUint8Array(base64) {
  const clean = String(base64 ?? '').replace(/\s+/g, '');
  if (!clean) return new Uint8Array(0);
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/* ============================================================================
   CUSTOM ERRORS & OFFLINE DETECTION
   ============================================================================ */

/**
 * Thrown when another device committed changes to the same (MM-DD, YYYY, entryId)
 * since the local composer opened it.
 */
export class SyncConflictError extends Error {
  constructor({ dayStr, yearKey, remoteEntry, remoteSha, remoteDoc, message }) {
    super(
      message ||
        `Sync conflict on ${yearKey}-${dayStr}: another device updated this entry on GitHub.`
    );
    this.name = 'SyncConflictError';
    this.code = 'SYNC_CONFLICT';
    this.dayStr = dayStr;
    this.yearKey = String(yearKey);
    this.remoteEntry = remoteEntry || null;
    this.remoteSha = remoteSha || null;
    this.remoteDoc = remoteDoc || null;
  }
}

/**
 * Checks whether an error was caused by the browser being offline or unreachable.
 * @param {unknown} err
 * @returns {boolean}
 */
export function isNetworkOfflineError(err) {
  if (!err) return false;
  if (err.isNetworkError || err.code === 'NETWORK_OFFLINE') return true;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  const msg = String(err.message || '').toLowerCase();
  return (
    msg.includes('failed to fetch') ||
    msg.includes('networkerror') ||
    msg.includes('network error') ||
    msg.includes('load failed')
  );
}

/* ============================================================================
   DAY DOCUMENT & INDEX MANIFEST HELPERS (MULTI-ENTRY SUPPORT)
   ============================================================================ */

export function emptyDayData(mmdd) {
  return {
    day: String(mmdd || '').trim(),
    entries: {},
    comments: [],
  };
}

/**
 * Backward-compatible normalizer: returns a clean array of entries for a single year.
 * Accepts legacy single-entry objects (`entries["2026"] = { ... }`) OR multi-entry arrays
 * (`entries["2026"] = [ { id: "...", ... }, ... ]`).
 *
 * @param {Object | Array | null} rawYearSlot
 * @param {string | number} [fallbackYear]
 * @param {string} [fallbackDayStr]
 * @returns {Array<Object>}
 */
export function getYearEntriesList(rawYearSlot, fallbackYear = '', fallbackDayStr = '') {
  if (!rawYearSlot) return [];
  const items = Array.isArray(rawYearSlot) ? rawYearSlot : [rawYearSlot];
  return items
    .filter((item) => item && typeof item === 'object')
    .map((item, idx) => {
      const yr = Number(item.year || fallbackYear) || new Date().getFullYear();
      const diaryDate =
        item.diaryDate || (fallbackDayStr ? `${yr}-${fallbackDayStr}` : `${yr}-01-01`);
      return {
        ...item,
        id: item.id || `ent-${yr}-${idx + 1}`,
        year: yr,
        diaryDate,
      };
    });
}

/**
 * Recomputes the lightweight manifest summary entry for a single calendar day (`MM-DD`).
 * Supports both legacy single-entry objects and multi-entry arrays per year.
 *
 * @param {Object | null} existingIndex
 * @param {string} dayStr
 * @param {Object} dayDoc
 * @returns {Object}
 */
export function recalculateIndexForDay(existingIndex, dayStr, dayDoc) {
  const idx = {
    version: Number(existingIndex?.version) || 1,
    updatedAt: new Date().toISOString(),
    days: { ...(existingIndex?.days || {}) },
  };

  const entries = dayDoc?.entries && typeof dayDoc.entries === 'object' ? dayDoc.entries : {};
  const comments = Array.isArray(dayDoc?.comments) ? dayDoc.comments : [];

  const years = Object.keys(entries)
    .map((y) => Number(y))
    .filter((n) => Number.isFinite(n) && getYearEntriesList(entries[String(n)], n, dayStr).length > 0)
    .sort((a, b) => a - b);

  const tagSet = new Set();
  const arcSet = new Set();
  const wordCounts = {};
  const entryCounts = {};
  const moods = {};
  const metrics = {};
  const sealed = {};

  for (const yr of years) {
    const yrKey = String(yr);
    const list = getYearEntriesList(entries[yrKey], yr, dayStr);
    if (list.length === 0) continue;

    entryCounts[yrKey] = list.length;
    let totalYearWords = 0;

    for (const entry of list) {
      if (Array.isArray(entry.tags)) {
        for (const t of entry.tags) {
          const cleaned = String(t || '').trim();
          if (!cleaned) continue;
          tagSet.add(cleaned);
          if (cleaned.toLowerCase().startsWith('arc:')) {
            arcSet.add(cleaned.slice(4).trim());
          }
        }
      }

      if (typeof entry.wordCount === 'number' && Number.isFinite(entry.wordCount)) {
        totalYearWords += Math.max(0, Math.round(entry.wordCount));
      } else {
        const plain = entry.encrypted
          ? ''
          : String(entry.body || '')
              .replace(/[#*_`>~-]+/g, ' ')
              .trim();
        totalYearWords += plain ? plain.split(/\s+/).filter(Boolean).length : 0;
      }

      if (entry.mood && typeof entry.mood === 'string' && entry.mood.trim()) {
        moods[yrKey] = entry.mood.trim();
      }

      if (
        entry.metrics &&
        typeof entry.metrics === 'object' &&
        Object.keys(entry.metrics).length > 0
      ) {
        metrics[yrKey] = { ...entry.metrics };
      }

      if (entry.sealedUntil && typeof entry.sealedUntil === 'string') {
        sealed[yrKey] = entry.sealedUntil;
      }
    }

    wordCounts[yrKey] = totalYearWords;
  }

  if (years.length === 0 && comments.length === 0) {
    delete idx.days[dayStr];
  } else {
    const summary = {
      years,
      tags: Array.from(tagSet),
      wordCounts,
      entryCounts,
      commentCount: comments.length,
    };
    if (arcSet.size > 0) summary.arcs = Array.from(arcSet);
    if (Object.keys(moods).length > 0) summary.moods = moods;
    if (Object.keys(metrics).length > 0) summary.metrics = metrics;
    if (Object.keys(sealed).length > 0) summary.sealed = sealed;
    idx.days[dayStr] = summary;
  }

  return idx;
}

/* ============================================================================
   DEFAULT CONFIGURATION & GITHUB CLIENT
   ============================================================================ */

export const DEFAULT_CONFIG = Object.freeze({
  owner: '',
  repo: '',
  branch: 'main',
  dataPath: 'data',
  token: '',
  tokenExpiresAt: '',
  readFromApiWhenAuthed: true,
  usePrivateVault: true,
  vaultOwner: '',
  vaultRepo: 'perpetual-diary-vault',
  vaultBranch: 'main',
  vaultPath: 'data',
  useMediaSharding: false,
  mediaShardPattern: 'diary-media-{year}',
  mediaShardBranch: 'main',
  genericCommitMessages: false,
});

const STORAGE_KEY = 'perpetual_diary_gh_config_v1';

export class GitHubClient {
  constructor(initialConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...initialConfig };
    this.lastCommitSha = '';
  }

  static loadConfig(storageTarget = null) {
    try {
      const store = storageTarget || (typeof window !== 'undefined' ? window.localStorage : null);
      if (!store) return { ...DEFAULT_CONFIG };
      const raw = store.getItem(STORAGE_KEY);
      if (!raw) return { ...DEFAULT_CONFIG };
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_CONFIG, ...(parsed || {}) };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  static saveConfig(cfg, storageTarget = null) {
    const merged = { ...DEFAULT_CONFIG, ...(cfg || {}) };
    if (storageTarget) {
      try {
        storageTarget.setItem(STORAGE_KEY, JSON.stringify(merged));
      } catch {
        // ignore storage quota errors
      }
    }
    return merged;
  }

  static clearConfig(storageTarget = null) {
    if (storageTarget) {
      try {
        storageTarget.removeItem(STORAGE_KEY);
      } catch {
        // ignore storage errors
      }
    }
    return { ...DEFAULT_CONFIG };
  }

  updateConfig(partial = {}) {
    this.config = { ...this.config, ...(partial || {}) };
    return this.config;
  }

  isConfigured() {
    const target = this.getDataTarget();
    return Boolean(
      (String(this.config.owner || '').trim() && String(this.config.repo || '').trim()) ||
        (target.owner && target.repo)
    );
  }

  hasToken() {
    return Boolean(String(this.config.token || '').trim());
  }

  canWrite() {
    return this.isConfigured() && this.hasToken();
  }

  getDataTarget() {
    const useVault = Boolean(this.config.usePrivateVault);
    const owner = useVault
      ? String(this.config.vaultOwner || this.config.owner || '').trim()
      : String(this.config.owner || '').trim();
    const repo = useVault
      ? String(this.config.vaultRepo || 'perpetual-diary-vault').trim()
      : String(this.config.repo || '').trim();
    const branch = useVault
      ? String(this.config.vaultBranch || this.config.branch || 'main').trim()
      : String(this.config.branch || 'main').trim();
    const basePath = String(
      useVault ? this.config.vaultPath || 'data' : this.config.dataPath || 'data'
    )
      .trim()
      .replace(/^\/+|\/+$/g, '');

    return {
      isSplitVault: useVault && Boolean(owner && repo),
      owner,
      repo,
      branch: branch || 'main',
      basePath: basePath || 'data',
    };
  }

  resolveDataPath(relativeSubpath) {
    const { basePath } = this.getDataTarget();
    const cleanSub = String(relativeSubpath || '').replace(/^\/+/, '');
    return basePath ? `${basePath}/${cleanSub}` : cleanSub;
  }

  resolveCommitMessage(rawMessage, forceGeneric = false) {
    if (forceGeneric || this.config.genericCommitMessages) {
      return 'sync: update';
    }
    return String(rawMessage || 'diary: update');
  }

  getMediaTarget(year = new Date().getFullYear()) {
    const dataTarget = this.getDataTarget();
    if (!this.config.useMediaSharding) {
      return {
        isSharded: false,
        owner: dataTarget.owner,
        repo: dataTarget.repo,
        branch: dataTarget.branch,
        basePath: dataTarget.basePath,
      };
    }

    const shardRepo = resolveShardRepoName(
      this.config.mediaShardPattern || 'diary-media-{year}',
      year
    );

    return {
      isSharded: true,
      owner: dataTarget.owner,
      repo: shardRepo,
      branch: String(this.config.mediaShardBranch || 'main').trim() || 'main',
      basePath: '',
    };
  }

  async testMediaShard(year = new Date().getFullYear()) {
    const target = this.getMediaTarget(year);
    if (!target.owner || !target.repo) {
      throw new Error('Configure your GitHub username and media shard pattern first.');
    }
    const repoData = await this._apiRequest(
      `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(
        target.repo
      )}`
    );
    return {
      ok: true,
      fullName: repoData.full_name,
      isPrivate: Boolean(repoData.private),
      canPush: Boolean(repoData?.permissions?.push || repoData?.permissions?.admin),
      sizeKb: Number(repoData.size || 0),
    };
  }

  async uploadMediaToShard(year, mediaSubpath, arrayBufferOrBytes, commitMessage) {
    if (!this.hasToken()) {
      throw new Error('GitHub Personal Access Token is required to upload sharded media.');
    }
    const target = this.getMediaTarget(year);
    const base64 = arrayBufferToBase64(arrayBufferOrBytes);
    const cleanSub = String(mediaSubpath || '').replace(/^\/+/, '');
    const repoPath = target.basePath ? `${target.basePath}/${cleanSub}` : cleanSub;

    const encodedPath = repoPath.split('/').map(encodeURIComponent).join('/');
    const endpoint = `https://api.github.com/repos/${encodeURIComponent(
      target.owner
    )}/${encodeURIComponent(target.repo)}/contents/${encodedPath}`;

    let sha = null;
    try {
      const existing = await this._apiRequest(
        `${endpoint}?ref=${encodeURIComponent(target.branch)}&_t=${Date.now()}`
      );
      if (existing?.sha) sha = existing.sha;
    } catch (err) {
      if (err.status !== 404 && err.status !== 409) throw err;
    }

    const payload = {
      message: this.resolveCommitMessage(
        commitMessage || `diary: upload sharded media ${repoPath}`
      ),
      content: base64,
      branch: target.branch,
    };
    if (sha) payload.sha = sha;

    await this._apiRequest(endpoint, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });

    return {
      isSharded: target.isSharded,
      repo: target.repo,
      path: repoPath,
    };
  }

  async deleteShardedMedia(owner, repo, branch, subpath, commitMessage) {
    if (!this.hasToken()) return { deleted: false };
    const cleanSub = String(subpath || '').replace(/^\/+/, '');
    const encodedPath = cleanSub.split('/').map(encodeURIComponent).join('/');
    const endpoint = `https://api.github.com/repos/${encodeURIComponent(
      owner
    )}/${encodeURIComponent(repo)}/contents/${encodedPath}`;

    let sha = null;
    try {
      const existing = await this._apiRequest(
        `${endpoint}?ref=${encodeURIComponent(branch || 'main')}&_t=${Date.now()}`
      );
      sha = existing?.sha || null;
    } catch (err) {
      if (err.status === 404) return { deleted: false };
      throw err;
    }
    if (!sha) return { deleted: false };

    await this._apiRequest(endpoint, {
      method: 'DELETE',
      body: JSON.stringify({
        message: this.resolveCommitMessage(
          commitMessage || `diary: delete sharded media ${cleanSub}`
        ),
        sha,
        branch: branch || 'main',
      }),
    });
    return { deleted: true };
  }

  /* ==========================================================================
     CORE REST TRANSPORT
     ========================================================================== */

  async _apiRequest(url, options = {}) {
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {}),
    };
    if (options.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    if (this.hasToken()) {
      headers.Authorization = `Bearer ${String(this.config.token).trim()}`;
    }

    let res;
    try {
      res = await fetch(url, {
        ...options,
        headers,
        cache: 'no-store',
      });
    } catch (networkErr) {
      const offlineErr = new Error(
        typeof navigator !== 'undefined' && navigator.onLine === false
          ? 'Device is offline. Changes can be queued and synced automatically when online.'
          : `Network error contacting GitHub API: ${networkErr?.message || 'unreachable'}`
      );
      offlineErr.isNetworkError = true;
      offlineErr.code = 'NETWORK_OFFLINE';
      throw offlineErr;
    }

    if (!res.ok) {
      let detail = res.statusText;
      try {
        const errJson = await res.json();
        if (errJson && errJson.message) detail = errJson.message;
      } catch {
        // ignore JSON parse failure
      }
      const err = new Error(`GitHub API (${res.status}): ${detail}`);
      err.status = res.status;
      throw err;
    }

    const expirationHeader = res.headers.get('github-authentication-token-expiration');
    if (expirationHeader && !this.config.tokenExpiresAt) {
      this.config.tokenExpiresAt = expirationHeader;
    }

    if (res.status === 204) return null;
    return res.json();
  }

  /* ==========================================================================
     REPO HEALTH, PAGES STATUS & CONNECTION TEST
     ========================================================================== */

  async getRepoHealth() {
    const target = this.getDataTarget();
    const appOwner = String(this.config.owner || '').trim();
    const appRepo = String(this.config.repo || '').trim();
    const isOnline = typeof navigator === 'undefined' ? true : navigator.onLine !== false;

    if (!this.hasToken() && !appOwner) {
      return {
        mode: 'sandbox',
        online: isOnline,
        vaultRepoName: target.repo || 'perpetual-diary-vault',
        vaultPrivate: true,
        vaultSizeKb: 0,
        appSizeKb: 0,
        totalSizeKb: 0,
        pagesLimitKb: 1024 * 1024,
        usagePercent: 0,
        pagesStatus: '',
        lastCommitSha: this.lastCommitSha || '',
        tokenExpiry: this.config.tokenExpiresAt || '',
      };
    }

    let vaultMeta = null;
    let appMeta = null;
    let pagesStatus = '';

    if (target.owner && target.repo) {
      try {
        vaultMeta = await this._apiRequest(
          `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(
            target.repo
          )}`
        );
      } catch (err) {
        if (!this.hasToken() || isNetworkOfflineError(err)) {
          return {
            mode: isNetworkOfflineError(err) ? 'offline' : 'static',
            online: isOnline,
            vaultRepoName: `${target.owner}/${target.repo}`,
            vaultPrivate: Boolean(this.config.usePrivateVault),
            vaultSizeKb: 0,
            appSizeKb: 0,
            totalSizeKb: 0,
            pagesLimitKb: 1024 * 1024,
            usagePercent: 0,
            pagesStatus: '',
            lastCommitSha: this.lastCommitSha || '',
            error: err.message,
            tokenExpiry: this.config.tokenExpiresAt || '',
          };
        }
        throw err;
      }
    }

    if (appOwner && appRepo && `${appOwner}/${appRepo}` !== `${target.owner}/${target.repo}`) {
      try {
        appMeta = await this._apiRequest(
          `https://api.github.com/repos/${encodeURIComponent(appOwner)}/${encodeURIComponent(
            appRepo
          )}`
        );
      } catch {
        appMeta = null;
      }
    }

    if (appOwner && appRepo && this.hasToken()) {
      try {
        const pagesInfo = await this._apiRequest(
          `https://api.github.com/repos/${encodeURIComponent(appOwner)}/${encodeURIComponent(
            appRepo
          )}/pages`
        );
        pagesStatus = pagesInfo?.status || (pagesInfo?.html_url ? 'built' : '');
      } catch {
        pagesStatus = '';
      }
    }

    let headSha = this.lastCommitSha || '';
    if (!headSha && this.hasToken() && target.owner && target.repo) {
      try {
        const refData = await this._apiRequest(
          `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(
            target.repo
          )}/git/ref/heads/${encodeURIComponent(target.branch)}?_t=${Date.now()}`
        );
        headSha = refData?.object?.sha || '';
      } catch {
        // Repo may be empty before first commit
      }
    }

    const vaultSizeKb = Number(vaultMeta?.size || 0);
    const appSizeKb = Number(appMeta?.size || 0);
    const combinedKb = target.isSplitVault ? vaultSizeKb : vaultSizeKb || appSizeKb;
    const pagesLimitKb = 1024 * 1024;
    const usagePercent = Math.min(100, Number(((combinedKb / pagesLimitKb) * 100).toFixed(2)));

    return {
      mode: this.hasToken() ? 'live-api' : 'public-api',
      online: isOnline,
      vaultRepoName: vaultMeta?.full_name || `${target.owner}/${target.repo}`,
      vaultPrivate: Boolean(vaultMeta?.private ?? this.config.usePrivateVault),
      defaultBranch: vaultMeta?.default_branch || target.branch,
      vaultSizeKb,
      appSizeKb,
      totalSizeKb: combinedKb,
      pagesLimitKb,
      usagePercent,
      pagesStatus,
      lastCommitSha: headSha,
      tokenExpiry: this.config.tokenExpiresAt || '',
    };
  }

  async testConnection() {
    const target = this.getDataTarget();
    if (!target.owner || !target.repo) {
      throw new Error('Please enter your GitHub username and repository name first.');
    }
    const repoData = await this._apiRequest(
      `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(
        target.repo
      )}`
    );
    const canPush = Boolean(repoData?.permissions?.push || repoData?.permissions?.admin);
    return {
      ok: true,
      fullName: repoData.full_name,
      isPrivate: Boolean(repoData.private),
      canPush,
      defaultBranch: repoData.default_branch || target.branch,
    };
  }

  /* ==========================================================================
     FILE READ / WRITE / DELETE (CONTENTS API + STATIC FALLBACK)
     ========================================================================== */

  async getFileMeta(relativeSubpath, explicitTarget = null) {
    const target = explicitTarget || this.getDataTarget();
    const cleanSub = String(relativeSubpath || '').replace(/^\/+/, '');
    const repoPath = target.basePath ? `${target.basePath}/${cleanSub}` : cleanSub;

    if (this.hasToken() && this.config.readFromApiWhenAuthed && target.owner && target.repo) {
      try {
        const apiUrl = `https://api.github.com/repos/${encodeURIComponent(
          target.owner
        )}/${encodeURIComponent(target.repo)}/contents/${repoPath
          .split('/')
          .map(encodeURIComponent)
          .join('/')}?ref=${encodeURIComponent(target.branch)}&_t=${Date.now()}`;
        const data = await this._apiRequest(apiUrl);
        if (Array.isArray(data)) {
          return { exists: false, sha: null, content: null, raw: data };
        }
        let b64 = data.content || '';
        if (!b64 && data.sha) {
          const blob = await this._apiRequest(
            `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(
              target.repo
            )}/git/blobs/${encodeURIComponent(data.sha)}`
          );
          b64 = blob?.content || '';
        }
        const decodedText = decodeBase64Utf8(b64);
        return {
          exists: true,
          sha: data.sha || null,
          content: decodedText,
          raw: data,
        };
      } catch (err) {
        if (err.status === 404 || err.status === 409) {
          return { exists: false, sha: null, content: null, raw: null };
        }
        throw err;
      }
    }

    const staticUrl = `./${repoPath}?t=${Date.now()}`;
    const res = await fetch(staticUrl, { cache: 'no-store' });
    if (res.status === 404) {
      return { exists: false, sha: null, content: null, raw: null };
    }
    if (!res.ok) {
      throw new Error(`Failed to fetch static file (${res.status}): ${repoPath}`);
    }
    const text = await res.text();
    return { exists: true, sha: null, content: text, raw: null };
  }

  async readJsonWithMeta(relativeSubpath, fallback = null) {
    const meta = await this.getFileMeta(relativeSubpath);
    if (!meta.exists || !meta.content) {
      return { exists: false, sha: null, data: fallback };
    }
    try {
      return { exists: true, sha: meta.sha, data: JSON.parse(meta.content) };
    } catch {
      return { exists: true, sha: meta.sha, data: fallback };
    }
  }

  async readJson(relativeSubpath, fallback = null) {
    const res = await this.readJsonWithMeta(relativeSubpath, fallback);
    return res.data;
  }

  async putFile(relativeSubpath, contentStringOrBase64, commitMessage, options = {}) {
    if (!this.hasToken()) {
      throw new Error('GitHub Personal Access Token is required to write to GitHub.');
    }
    const target = options.target || this.getDataTarget();
    if (!target.owner || !target.repo) {
      throw new Error('GitHub owner and repository are not configured.');
    }

    const cleanSub = String(relativeSubpath || '').replace(/^\/+/, '');
    const repoPath = target.basePath ? `${target.basePath}/${cleanSub}` : cleanSub;
    const encodedPath = repoPath.split('/').map(encodeURIComponent).join('/');
    const endpoint = `https://api.github.com/repos/${encodeURIComponent(
      target.owner
    )}/${encodeURIComponent(target.repo)}/contents/${encodedPath}`;

    const base64Content = options.isBase64
      ? String(contentStringOrBase64 || '')
      : encodeBase64Utf8(String(contentStringOrBase64 ?? ''));

    const attemptPut = async (knownSha) => {
      let sha = knownSha;
      if (!sha) {
        try {
          const existing = await this._apiRequest(
            `${endpoint}?ref=${encodeURIComponent(target.branch)}&_t=${Date.now()}`
          );
          if (existing && existing.sha) sha = existing.sha;
        } catch (err) {
          if (err.status !== 404 && err.status !== 409) throw err;
        }
      }

      const payload = {
        message: this.resolveCommitMessage(
          commitMessage || `diary: update ${repoPath}`,
          Boolean(options.genericCommit)
        ),
        content: base64Content,
        branch: target.branch,
      };
      if (sha) payload.sha = sha;

      const out = await this._apiRequest(endpoint, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      if (out?.commit?.sha) this.lastCommitSha = out.commit.sha;
      return out;
    };

    try {
      return await attemptPut(options.sha || null);
    } catch (err) {
      if (err.status === 409 && !options._retried) {
        return this.putFile(relativeSubpath, contentStringOrBase64, commitMessage, {
          ...options,
          sha: null,
          _retried: true,
        });
      }
      throw err;
    }
  }

  async putJson(relativeSubpath, obj, commitMessage, options = {}) {
    const serialized = `${JSON.stringify(obj, null, 2)}\n`;
    return this.putFile(relativeSubpath, serialized, commitMessage, {
      ...options,
      isBase64: false,
    });
  }

  async uploadBinaryMedia(relativeMediaSubpath, arrayBufferOrBytes, commitMessage, options = {}) {
    const base64 = arrayBufferToBase64(arrayBufferOrBytes);
    return this.putFile(relativeMediaSubpath, base64, commitMessage, {
      ...options,
      isBase64: true,
    });
  }

  async deleteFile(relativeSubpath, commitMessage, options = {}) {
    if (!this.hasToken()) {
      throw new Error('GitHub Personal Access Token is required to delete files on GitHub.');
    }
    const target = options.target || this.getDataTarget();
    const cleanSub = String(relativeSubpath || '').replace(/^\/+/, '');
    const repoPath = target.basePath ? `${target.basePath}/${cleanSub}` : cleanSub;
    const encodedPath = repoPath.split('/').map(encodeURIComponent).join('/');
    const endpoint = `https://api.github.com/repos/${encodeURIComponent(
      target.owner
    )}/${encodeURIComponent(target.repo)}/contents/${encodedPath}`;

    let sha = options.sha || null;
    if (!sha) {
      try {
        const existing = await this._apiRequest(
          `${endpoint}?ref=${encodeURIComponent(target.branch)}&_t=${Date.now()}`
        );
        sha = existing?.sha || null;
      } catch (err) {
        if (err.status === 404) return { deleted: false, reason: 'not-found' };
        throw err;
      }
    }

    if (!sha) return { deleted: false, reason: 'missing-sha' };

    const out = await this._apiRequest(endpoint, {
      method: 'DELETE',
      body: JSON.stringify({
        message: this.resolveCommitMessage(
          commitMessage || `diary: delete ${repoPath}`,
          Boolean(options.genericCommit)
        ),
        sha,
        branch: target.branch,
      }),
    });
    if (out?.commit?.sha) this.lastCommitSha = out.commit.sha;

    return { deleted: true, path: repoPath };
  }

  /* ==========================================================================
     ATOMIC MULTI-FILE COMMIT ENGINE (GIT DATA / TREES API)
     ========================================================================== */

  async commitBatch(changes, commitMessage, options = {}) {
    if (!this.hasToken()) {
      throw new Error('GitHub Personal Access Token is required for atomic commits.');
    }
    if (!Array.isArray(changes) || changes.length === 0) {
      return { commitSha: this.lastCommitSha || '', treeSha: '', fileShas: {} };
    }

    const target = options.target || this.getDataTarget();
    if (!target.owner || !target.repo) {
      throw new Error('GitHub owner and repository are not configured.');
    }

    const repoApiBase = `https://api.github.com/repos/${encodeURIComponent(
      target.owner
    )}/${encodeURIComponent(target.repo)}`;

    const finalMessage = this.resolveCommitMessage(
      commitMessage || 'diary: atomic sync',
      Boolean(options.genericCommit)
    );

    let headCommitSha = null;
    try {
      const refData = await this._apiRequest(
        `${repoApiBase}/git/ref/heads/${encodeURIComponent(target.branch)}?_t=${Date.now()}`
      );
      headCommitSha = refData?.object?.sha || null;
    } catch (err) {
      if (err.status === 404 || err.status === 409) {
        headCommitSha = null;
      } else {
        throw err;
      }
    }

    if (!headCommitSha) {
      const fileShas = {};
      let lastSha = '';
      for (const ch of changes) {
        if (ch.delete) continue;
        const isB64 = Boolean(ch.isBase64 || ch.isBinary);
        const payload = ch.isBinary ? arrayBufferToBase64(ch.content) : ch.content;
        const putRes = await this.putFile(ch.subpath, payload, finalMessage, {
          target,
          isBase64: isB64,
          genericCommit: Boolean(options.genericCommit),
        });
        if (putRes?.content?.sha) fileShas[ch.subpath] = putRes.content.sha;
        if (putRes?.commit?.sha) lastSha = putRes.commit.sha;
      }
      this.lastCommitSha = lastSha;
      return { commitSha: lastSha, treeSha: '', fileShas };
    }

    const headCommit = await this._apiRequest(
      `${repoApiBase}/git/commits/${encodeURIComponent(headCommitSha)}`
    );
    const baseTreeSha = headCommit?.tree?.sha;
    if (!baseTreeSha) {
      throw new Error('Could not resolve base tree SHA for atomic Git commit.');
    }

    const fileShas = {};
    const treeItems = await Promise.all(
      changes.map(async (ch) => {
        const cleanSub = String(ch.subpath || '').replace(/^\/+/, '');
        const fullPath = target.basePath ? `${target.basePath}/${cleanSub}` : cleanSub;

        if (ch.delete) {
          return {
            path: fullPath,
            mode: '100644',
            type: 'blob',
            sha: null,
          };
        }

        let b64Content;
        if (ch.isBinary) {
          b64Content = arrayBufferToBase64(ch.content);
        } else if (ch.isBase64) {
          b64Content = String(ch.content || '').replace(/\s+/g, '');
        } else {
          b64Content = encodeBase64Utf8(String(ch.content ?? ''));
        }

        const blobRes = await this._apiRequest(`${repoApiBase}/git/blobs`, {
          method: 'POST',
          body: JSON.stringify({
            content: b64Content,
            encoding: 'base64',
          }),
        });

        fileShas[cleanSub] = blobRes.sha;
        return {
          path: fullPath,
          mode: '100644',
          type: 'blob',
          sha: blobRes.sha,
        };
      })
    );

    const newTree = await this._apiRequest(`${repoApiBase}/git/trees`, {
      method: 'POST',
      body: JSON.stringify({
        base_tree: baseTreeSha,
        tree: treeItems,
      }),
    });

    const newCommit = await this._apiRequest(`${repoApiBase}/git/commits`, {
      method: 'POST',
      body: JSON.stringify({
        message: finalMessage,
        tree: newTree.sha,
        parents: [headCommitSha],
      }),
    });

    await this._apiRequest(
      `${repoApiBase}/git/refs/heads/${encodeURIComponent(target.branch)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          sha: newCommit.sha,
          force: false,
        }),
      }
    );

    this.lastCommitSha = newCommit.sha;
    return {
      commitSha: newCommit.sha,
      treeSha: newTree.sha,
      fileShas,
    };
  }

  /**
   * High-level conflict-safe atomic transaction for day entries (multi-entry per year),
   * date moves, comments, media uploads/deletions, and index manifest updates in ONE Git commit.
   */
  async commitAtomicDayMutations(tx, _attempt = 1) {
    const dayMutations = Array.isArray(tx.dayMutations) ? tx.dayMutations : [];
    const mediaUploads = Array.isArray(tx.mediaUploads) ? tx.mediaUploads : [];
    const mediaDeletes = Array.isArray(tx.mediaDeletes) ? tx.mediaDeletes : [];
    const cloak = tx.cloak && tx.cloak.enabled ? tx.cloak : null;

    const uniqueDays = Array.from(new Set(dayMutations.map((m) => m.dayStr).filter(Boolean)));

    const remoteDayMap = {};
    for (const dayStr of uniqueDays) {
      const targetSubpath = cloak ? await cloak.getDaySubpath(dayStr) : `days/${dayStr}.json`;

      let meta = await this.getFileMeta(targetSubpath);
      let loadedLegacyFallback = false;

      if (!meta.exists && cloak) {
        const legacyMeta = await this.getFileMeta(`days/${dayStr}.json`);
        if (legacyMeta.exists) {
          meta = legacyMeta;
          loadedLegacyFallback = true;
        }
      }

      let parsedDoc = null;
      if (meta.exists && meta.content) {
        try {
          parsedDoc = cloak
            ? await cloak.deserializeDay(dayStr, meta.content)
            : JSON.parse(meta.content);
        } catch {
          parsedDoc = null;
        }
      }

      const doc =
        parsedDoc && typeof parsedDoc === 'object'
          ? {
              day: dayStr,
              entries:
                parsedDoc.entries && typeof parsedDoc.entries === 'object'
                  ? { ...parsedDoc.entries }
                  : {},
              comments: Array.isArray(parsedDoc.comments) ? [...parsedDoc.comments] : [],
            }
          : emptyDayData(dayStr);

      remoteDayMap[dayStr] = {
        subpath: targetSubpath,
        deleteLegacyPath: loadedLegacyFallback ? `days/${dayStr}.json` : null,
        doc,
        sha: meta.sha || null,
        exists: meta.exists,
      };
    }

    const indexSubpath = cloak ? cloak.indexSubpath || 'index.enc' : 'index.json';
    let indexMeta = await this.getFileMeta(indexSubpath);
    let loadedLegacyIndex = false;
    if (!indexMeta.exists && cloak) {
      const legacyIdx = await this.getFileMeta('index.json');
      if (legacyIdx.exists) {
        indexMeta = legacyIdx;
        loadedLegacyIndex = true;
      }
    }

    let parsedIdx = null;
    if (indexMeta.exists && indexMeta.content) {
      try {
        parsedIdx = cloak
          ? await cloak.deserializeIndex(indexMeta.content)
          : JSON.parse(indexMeta.content);
      } catch {
        parsedIdx = null;
      }
    }

    let workingIndex =
      parsedIdx && typeof parsedIdx === 'object' && parsedIdx.days
        ? parsedIdx
        : { version: 1, updatedAt: new Date().toISOString(), days: {} };

    for (const mut of dayMutations) {
      const remoteSlot = remoteDayMap[mut.dayStr];
      const doc = remoteSlot.doc;

      if (mut.mode === 'entry-save') {
        const yKey = String(mut.yearKey);
        const list = getYearEntriesList(doc.entries[yKey], yKey, mut.dayStr);
        const targetId = mut.entryId || mut.entryRecord?.id || null;
        const existingIdx = targetId ? list.findIndex((item) => item.id === targetId) : -1;
        const existingRemoteEntry = existingIdx >= 0 ? list[existingIdx] : null;

        const shaChanged = Boolean(
          mut.expectedSha && remoteSlot.sha && remoteSlot.sha !== mut.expectedSha
        );
        const timestampDiverged = Boolean(
          existingRemoteEntry &&
            mut.expectedUpdatedAt &&
            existingRemoteEntry.updatedAt &&
            existingRemoteEntry.updatedAt !== mut.expectedUpdatedAt
        );
        const concurrentSameIdCreate = Boolean(
          !mut.expectedUpdatedAt && shaChanged && existingRemoteEntry
        );

        if ((shaChanged && timestampDiverged) || concurrentSameIdCreate) {
          throw new SyncConflictError({
            dayStr: mut.dayStr,
            yearKey: yKey,
            remoteEntry: existingRemoteEntry,
            remoteSha: remoteSlot.sha,
            remoteDoc: doc,
          });
        }

        const recordToSave = {
          ...mut.entryRecord,
          id: targetId || `ent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        };

        if (existingIdx >= 0) {
          list[existingIdx] = recordToSave;
        } else {
          list.push(recordToSave);
        }

        // Preserve single-object storage if count === 1 for clean backward compatibility,
        // and store as an array whenever 2+ entries exist on the same date/year.
        doc.entries[yKey] = list.length === 1 ? list[0] : list;
      } else if (mut.mode === 'entry-delete') {
        const yKey = String(mut.yearKey);
        const list = getYearEntriesList(doc.entries[yKey], yKey, mut.dayStr);
        const remaining = mut.entryId
          ? list.filter((item) => item.id !== mut.entryId)
          : [];
        if (remaining.length === 0) {
          delete doc.entries[yKey];
        } else {
          doc.entries[yKey] = remaining.length === 1 ? remaining[0] : remaining;
        }
      } else if (mut.mode === 'comment' && mut.commentMutation) {
        const cm = mut.commentMutation;
        if (cm.op === 'add' && cm.comment) {
          doc.comments.push(cm.comment);
        } else if (cm.op === 'edit' && cm.comment) {
          const idx = doc.comments.findIndex((c) => c.id === cm.comment.id);
          if (idx !== -1) {
            doc.comments[idx] = cm.comment;
          } else {
            doc.comments.push(cm.comment);
          }
        } else if (cm.op === 'delete' && cm.id) {
          doc.comments = doc.comments.filter((c) => c.id !== cm.id);
        }
      }
    }

    const changes = [];
    const outDocs = {};

    for (const dayStr of uniqueDays) {
      const slot = remoteDayMap[dayStr];
      const updatedDoc = slot.doc;
      outDocs[dayStr] = updatedDoc;
      workingIndex = recalculateIndexForDay(workingIndex, dayStr, updatedDoc);

      const serializedDay = cloak
        ? await cloak.serializeDay(dayStr, updatedDoc)
        : `${JSON.stringify(updatedDoc, null, 2)}\n`;

      changes.push({
        subpath: slot.subpath,
        content: serializedDay,
        isBase64: false,
      });

      if (slot.deleteLegacyPath) {
        changes.push({ subpath: slot.deleteLegacyPath, delete: true });
      }
    }

    const serializedIndex = cloak
      ? await cloak.serializeIndex(workingIndex)
      : `${JSON.stringify(workingIndex, null, 2)}\n`;

    changes.push({
      subpath: indexSubpath,
      content: serializedIndex,
      isBase64: false,
    });

    if (loadedLegacyIndex && cloak) {
      changes.push({ subpath: 'index.json', delete: true });
    }

    for (const upload of mediaUploads) {
      if (upload.base64) {
        changes.push({
          subpath: upload.subpath,
          content: upload.base64,
          isBase64: true,
        });
      } else {
        changes.push({
          subpath: upload.subpath,
          content: upload.buffer,
          isBinary: true,
        });
      }
    }

    for (const delSubpath of mediaDeletes) {
      changes.push({ subpath: delSubpath, delete: true });
    }

    try {
      const res = await this.commitBatch(changes, tx.commitMessage || 'diary: atomic update', {
        genericCommit: Boolean(cloak?.genericCommits),
      });
      const dayShas = {};
      for (const dayStr of uniqueDays) {
        const targetSub = remoteDayMap[dayStr].subpath;
        const sha = res.fileShas[targetSub];
        if (sha) dayShas[dayStr] = sha;
      }
      return {
        commitSha: res.commitSha,
        docs: outDocs,
        dayShas,
        index: workingIndex,
      };
    } catch (err) {
      if ((err.status === 422 || err.status === 409) && _attempt < 2) {
        return this.commitAtomicDayMutations(tx, _attempt + 1);
      }
      throw err;
    }
  }

  async updateDayAndIndex(dayStr, dayDoc, commitMessage, cloak = null) {
    const activeCloak = cloak && cloak.enabled ? cloak : null;
    const indexSubpath = activeCloak ? activeCloak.indexSubpath || 'index.enc' : 'index.json';
    const daySubpath = activeCloak
      ? await activeCloak.getDaySubpath(dayStr)
      : `days/${dayStr}.json`;

    let indexMeta = await this.getFileMeta(indexSubpath);
    if (!indexMeta.exists && activeCloak) {
      indexMeta = await this.getFileMeta('index.json');
    }

    let currentIdx = null;
    if (indexMeta.exists && indexMeta.content) {
      try {
        currentIdx = activeCloak
          ? await activeCloak.deserializeIndex(indexMeta.content)
          : JSON.parse(indexMeta.content);
      } catch {
        currentIdx = null;
      }
    }

    const nextIndex = recalculateIndexForDay(currentIdx, dayStr, dayDoc);

    const serializedDay = activeCloak
      ? await activeCloak.serializeDay(dayStr, dayDoc)
      : `${JSON.stringify(dayDoc, null, 2)}\n`;
    const serializedIndex = activeCloak
      ? await activeCloak.serializeIndex(nextIndex)
      : `${JSON.stringify(nextIndex, null, 2)}\n`;

    const changes = [
      { subpath: daySubpath, content: serializedDay, isBase64: false },
      { subpath: indexSubpath, content: serializedIndex, isBase64: false },
    ];

    const res = await this.commitBatch(changes, commitMessage || `diary: update ${dayStr}`, {
      genericCommit: Boolean(activeCloak?.genericCommits),
    });
    return {
      commitSha: res.commitSha,
      daySha: res.fileShas[daySubpath] || null,
      index: nextIndex,
    };
  }

  /* ==========================================================================
     OFFLINE COMMIT QUEUE SERIALIZATION & REPLAY HOOKS
     ========================================================================== */

  static serializeTransactionForQueue(tx) {
    const mediaUploads = (Array.isArray(tx.mediaUploads) ? tx.mediaUploads : []).map((u) => ({
      subpath: u.subpath,
      base64: u.base64 ? u.base64 : arrayBufferToBase64(u.buffer),
    }));

    const dayMutations = (Array.isArray(tx.dayMutations) ? tx.dayMutations : []).map((m) => ({
      ...m,
      expectedSha: null,
      expectedUpdatedAt: null,
    }));

    return {
      id: `qtx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      queuedAt: new Date().toISOString(),
      dayMutations,
      mediaUploads,
      mediaDeletes: Array.isArray(tx.mediaDeletes) ? [...tx.mediaDeletes] : [],
      commitMessage: tx.commitMessage || 'diary: offline queued sync',
      useCloak: Boolean(tx.cloak && tx.cloak.enabled),
    };
  }

  async replayQueuedTransaction(queuedTx, cloakAdapter = null) {
    if (!queuedTx) return null;
    const mediaUploads = (Array.isArray(queuedTx.mediaUploads) ? queuedTx.mediaUploads : []).map(
      (u) => ({
        subpath: u.subpath,
        base64: u.base64,
        buffer: u.base64 ? base64ToUint8Array(u.base64) : u.buffer,
      })
    );

    return this.commitAtomicDayMutations({
      dayMutations: queuedTx.dayMutations || [],
      mediaUploads,
      mediaDeletes: queuedTx.mediaDeletes || [],
      commitMessage: queuedTx.commitMessage || 'diary: sync offline queued changes',
      cloak: queuedTx.useCloak ? cloakAdapter : null,
    });
  }
}
