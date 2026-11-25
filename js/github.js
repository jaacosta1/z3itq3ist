/**
 * js/github.js — GitHub Contents & Git Trees API Client (Phase 5)
 * Features:
 * - Split-Repo Architecture (Public App Repo + Private Data Vault)
 * - Atomic Multi-File Commits via Git Data API (blobs -> tree -> commit -> ref)
 * - Optimistic Concurrency & SyncConflictError detection for 3-Way Conflict Resolution
 * - Repo Health, 1 GB Pages Quota & PAT Expiry Telemetry
 * - UTF-8 / Emoji-safe Base64 encoding and cache-busted static fallback reads
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
 * Thrown when another device committed changes to the same entry slot
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

export function recalculateIndexForDay(existingIndex, dayStr, dayDoc) {
  const idx = {
    updatedAt: new Date().toISOString(),
    days: { ...(existingIndex?.days || {}) },
  };

  const entries = dayDoc?.entries && typeof dayDoc.entries === 'object' ? dayDoc.entries : {};
  const comments = Array.isArray(dayDoc?.comments) ? dayDoc.comments : [];

  const years = Object.keys(entries)
    .map((y) => Number(y))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);

  const tagSet = new Set();
  const wordCounts = {};

  for (const yr of years) {
    const entry = entries[String(yr)];
    if (!entry) continue;
    if (Array.isArray(entry.tags)) {
      for (const t of entry.tags) {
        const cleaned = String(t || '').trim();
        if (cleaned) tagSet.add(cleaned);
      }
    }
    const plain = entry.encrypted
      ? ''
      : String(entry.body || '')
          .replace(/[#*_`>~-]+/g, ' ')
          .trim();
    const words = plain ? plain.split(/\s+/).filter(Boolean).length : 0;
    wordCounts[String(yr)] = words;
  }

  if (years.length === 0 && comments.length === 0) {
    delete idx.days[dayStr];
  } else {
    idx.days[dayStr] = {
      years,
      tags: Array.from(tagSet),
      wordCounts,
      commentCount: comments.length,
    };
  }

  return idx;
}

const DEFAULT_CONFIG = Object.freeze({
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
      storageTarget.setItem(STORAGE_KEY, JSON.stringify(merged));
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
    return Boolean(
      String(this.config.owner || '').trim() && String(this.config.repo || '').trim()
    );
  }

  hasToken() {
    return Boolean(String(this.config.token || '').trim());
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

    const res = await fetch(url, {
      ...options,
      headers,
      cache: 'no-store',
    });

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

  async getRepoHealth() {
    const target = this.getDataTarget();
    const appOwner = String(this.config.owner || '').trim();
    const appRepo = String(this.config.repo || '').trim();

    if (!this.hasToken() && !appOwner) {
      return {
        mode: 'sandbox',
        vaultRepoName: target.repo || 'perpetual-diary-vault',
        vaultPrivate: true,
        vaultSizeKb: 0,
        appSizeKb: 0,
        totalSizeKb: 0,
        pagesLimitKb: 1024 * 1024,
        usagePercent: 0,
        lastCommitSha: this.lastCommitSha || '',
        tokenExpiry: this.config.tokenExpiresAt || '',
      };
    }

    let vaultMeta = null;
    let appMeta = null;

    if (target.owner && target.repo) {
      try {
        vaultMeta = await this._apiRequest(
          `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(
            target.repo
          )}`
        );
      } catch (err) {
        if (!this.hasToken()) {
          return {
            mode: 'static',
            vaultRepoName: `${target.owner}/${target.repo}`,
            vaultPrivate: Boolean(this.config.usePrivateVault),
            vaultSizeKb: 0,
            appSizeKb: 0,
            totalSizeKb: 0,
            pagesLimitKb: 1024 * 1024,
            usagePercent: 0,
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
      vaultRepoName: vaultMeta?.full_name || `${target.owner}/${target.repo}`,
      vaultPrivate: Boolean(vaultMeta?.private ?? this.config.usePrivateVault),
      defaultBranch: vaultMeta?.default_branch || target.branch,
      vaultSizeKb,
      appSizeKb,
      totalSizeKb: combinedKb,
      pagesLimitKb,
      usagePercent,
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
        message: commitMessage || `diary: update ${repoPath}`,
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

  async uploadBinaryMedia(relativeMediaSubpath, arrayBufferOrBytes, commitMessage) {
    const base64 = arrayBufferToBase64(arrayBufferOrBytes);
    return this.putFile(relativeMediaSubpath, base64, commitMessage, {
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
        message: commitMessage || `diary: delete ${repoPath}`,
        sha,
        branch: target.branch,
      }),
    });
    if (out?.commit?.sha) this.lastCommitSha = out.commit.sha;

    return { deleted: true, path: repoPath };
  }

  /**
   * Atomic Multi-File Commit via the GitHub Git Data API (Git Trees API).
   * Bundles any combination of text files, binary media uploads, and deletions
   * into ONE single Git commit and ONE single Pages rebuild.
   *
   * @param {Array<{
   *   subpath: string,
   *   content?: string | ArrayBuffer | Uint8Array,
   *   isBase64?: boolean,
   *   isBinary?: boolean,
   *   delete?: boolean
   * }>} changes
   * @param {string} commitMessage
   * @param {{ target?: Object }} [options]
   * @returns {Promise<{ commitSha: string, treeSha: string, fileShas: Record<string, string> }>}
   */
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

    // Step 1: Fetch branch HEAD ref (handle brand-new empty repo gracefully via sequential bootstrap)
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

    // Empty repository bootstrap fallback (Git Data API requires at least one initial commit)
    if (!headCommitSha) {
      const fileShas = {};
      let lastSha = '';
      for (const ch of changes) {
        if (ch.delete) continue;
        const isB64 = Boolean(ch.isBase64 || ch.isBinary);
        const payload = ch.isBinary ? arrayBufferToBase64(ch.content) : ch.content;
        const putRes = await this.putFile(ch.subpath, payload, commitMessage, {
          target,
          isBase64: isB64,
        });
        if (putRes?.content?.sha) fileShas[ch.subpath] = putRes.content.sha;
        if (putRes?.commit?.sha) lastSha = putRes.commit.sha;
      }
      this.lastCommitSha = lastSha;
      return { commitSha: lastSha, treeSha: '', fileShas };
    }

    // Step 2: Fetch base tree SHA of HEAD commit
    const headCommit = await this._apiRequest(
      `${repoApiBase}/git/commits/${encodeURIComponent(headCommitSha)}`
    );
    const baseTreeSha = headCommit?.tree?.sha;
    if (!baseTreeSha) {
      throw new Error('Could not resolve base tree SHA for atomic Git commit.');
    }

    // Step 3: Create blobs for all added/updated files in parallel
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

    // Step 4: Create new Git tree anchored to base_tree
    const newTree = await this._apiRequest(`${repoApiBase}/git/trees`, {
      method: 'POST',
      body: JSON.stringify({
        base_tree: baseTreeSha,
        tree: treeItems,
      }),
    });

    // Step 5: Create single commit referencing new tree and HEAD parent
    const newCommit = await this._apiRequest(`${repoApiBase}/git/commits`, {
      method: 'POST',
      body: JSON.stringify({
        message: commitMessage || 'diary: atomic sync',
        tree: newTree.sha,
        parents: [headCommitSha],
      }),
    });

    // Step 6: Fast-forward branch ref (force: false guarantees we never silently clobber concurrent commits)
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
   * High-level conflict-safe atomic transaction for day entries, date moves,
   * comments, media uploads/deletions, and index.json updates in ONE Git commit.
   *
   * - Detects concurrent edits to the same (MM-DD, YYYY) entry and throws SyncConflictError
   *   so the UI can launch the Interactive 3-Way Conflict Resolver.
   * - Automatically merges non-overlapping edits (different years or comments on the same day)
   *   and retries once if the branch HEAD moved mid-flight (HTTP 422).
   *
   * @param {{
   *   dayMutations: Array<{
   *     dayStr: string,
   *     mode: 'entry-save' | 'entry-delete' | 'comment',
   *     yearKey?: string,
   *     entryRecord?: Object,
   *     expectedSha?: string | null,
   *     expectedUpdatedAt?: string | null,
   *     commentMutation?: { op: 'add' | 'edit' | 'delete', comment?: Object, id?: string }
   *   }>,
   *   mediaUploads?: Array<{ subpath: string, buffer: ArrayBuffer | Uint8Array }>,
   *   mediaDeletes?: string[],
   *   commitMessage: string
   * }} tx
   */
  async commitAtomicDayMutations(tx, _attempt = 1) {
    const dayMutations = Array.isArray(tx.dayMutations) ? tx.dayMutations : [];
    const mediaUploads = Array.isArray(tx.mediaUploads) ? tx.mediaUploads : [];
    const mediaDeletes = Array.isArray(tx.mediaDeletes) ? tx.mediaDeletes : [];

    // Collect unique calendar days touched by this transaction
    const uniqueDays = Array.from(new Set(dayMutations.map((m) => m.dayStr).filter(Boolean)));

    // Fetch fresh remote state + SHA for each touched day and for index.json
    const remoteDayMap = {};
    for (const dayStr of uniqueDays) {
      const meta = await this.readJsonWithMeta(`days/${dayStr}.json`, null);
      const doc =
        meta.exists && meta.data && typeof meta.data === 'object'
          ? {
              day: dayStr,
              entries:
                meta.data.entries && typeof meta.data.entries === 'object'
                  ? { ...meta.data.entries }
                  : {},
              comments: Array.isArray(meta.data.comments) ? [...meta.data.comments] : [],
            }
          : { day: dayStr, entries: {}, comments: [] };

      remoteDayMap[dayStr] = {
        doc,
        sha: meta.sha || null,
        exists: meta.exists,
      };
    }

    const indexMeta = await this.readJsonWithMeta('index.json', null);
    let workingIndex =
      indexMeta.exists && indexMeta.data && typeof indexMeta.data === 'object'
        ? indexMeta.data
        : { version: 1, updatedAt: new Date().toISOString(), days: {} };

    // Apply each mutation with strict entry-level conflict detection
    for (const mut of dayMutations) {
      const remoteSlot = remoteDayMap[mut.dayStr];
      const doc = remoteSlot.doc;

      if (mut.mode === 'entry-save') {
        const yKey = String(mut.yearKey);
        const existingRemoteEntry = doc.entries[yKey] || null;

        // Detect concurrent modification to the SAME year entry by another device
        const shaChanged = Boolean(mut.expectedSha && remoteSlot.sha && remoteSlot.sha !== mut.expectedSha);
        const timestampDiverged = Boolean(
          existingRemoteEntry &&
            mut.expectedUpdatedAt &&
            existingRemoteEntry.updatedAt &&
            existingRemoteEntry.updatedAt !== mut.expectedUpdatedAt
        );
        const concurrentNewCreate = Boolean(
          !mut.expectedUpdatedAt && shaChanged && existingRemoteEntry
        );

        if ((shaChanged && timestampDiverged) || concurrentNewCreate) {
          throw new SyncConflictError({
            dayStr: mut.dayStr,
            yearKey: yKey,
            remoteEntry: existingRemoteEntry,
            remoteSha: remoteSlot.sha,
            remoteDoc: doc,
          });
        }

        doc.entries[yKey] = mut.entryRecord;
      } else if (mut.mode === 'entry-delete') {
        const yKey = String(mut.yearKey);
        delete doc.entries[yKey];
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

    // Build atomic commit file list
    const changes = [];
    const outDocs = {};

    for (const dayStr of uniqueDays) {
      const updatedDoc = remoteDayMap[dayStr].doc;
      outDocs[dayStr] = updatedDoc;
      workingIndex = recalculateIndexForDay(workingIndex, dayStr, updatedDoc);
      changes.push({
        subpath: `days/${dayStr}.json`,
        content: `${JSON.stringify(updatedDoc, null, 2)}\n`,
        isBase64: false,
      });
    }

    changes.push({
      subpath: 'index.json',
      content: `${JSON.stringify(workingIndex, null, 2)}\n`,
      isBase64: false,
    });

    for (const upload of mediaUploads) {
      changes.push({
        subpath: upload.subpath,
        content: upload.buffer,
        isBinary: true,
      });
    }

    for (const delSubpath of mediaDeletes) {
      changes.push({
        subpath: delSubpath,
        delete: true,
      });
    }

    try {
      const res = await this.commitBatch(changes, tx.commitMessage || 'diary: atomic update');
      const dayShas = {};
      for (const dayStr of uniqueDays) {
        const sha = res.fileShas[`days/${dayStr}.json`];
        if (sha) dayShas[dayStr] = sha;
      }
      return {
        commitSha: res.commitSha,
        docs: outDocs,
        dayShas,
        index: workingIndex,
      };
    } catch (err) {
      // Branch HEAD moved during commit (HTTP 422 / 409) -> re-fetch & re-check once
      if ((err.status === 422 || err.status === 409) && _attempt < 2) {
        return this.commitAtomicDayMutations(tx, _attempt + 1);
      }
      throw err;
    }
  }

  /**
   * Atomically updates one calendar day file and index.json in a single Git commit.
   */
  async updateDayAndIndex(dayStr, dayDoc, commitMessage) {
    const indexMeta = await this.readJsonWithMeta('index.json', null);
    const nextIndex = recalculateIndexForDay(indexMeta.data, dayStr, dayDoc);

    const changes = [
      {
        subpath: `days/${dayStr}.json`,
        content: `${JSON.stringify(dayDoc, null, 2)}\n`,
        isBase64: false,
      },
      {
        subpath: 'index.json',
        content: `${JSON.stringify(nextIndex, null, 2)}\n`,
        isBase64: false,
      },
    ];

    const res = await this.commitBatch(changes, commitMessage || `diary: update ${dayStr}`);
    return {
      commitSha: res.commitSha,
      daySha: res.fileShas[`days/${dayStr}.json`] || null,
      index: nextIndex,
    };
  }
}
