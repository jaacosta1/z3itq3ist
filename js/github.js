// js/github.js — GitHub Contents API Client, Split-Repo Vault Support & Index Sync

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
    return `${basePath}/${cleanSub}`;
  }

  async _apiRequest(url, options = {}) {
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {}),
    };
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
        rateLimitRemaining: null,
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

    const vaultSizeKb = Number(vaultMeta?.size || 0);
    const appSizeKb = Number(appMeta?.size || 0);
    const combinedKb = target.isSplitVault ? vaultSizeKb : vaultSizeKb || appSizeKb;
    const pagesLimitKb = 1024 * 1024; // 1 GB GitHub Pages reference limit
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
    const repoPath = `${target.basePath}/${String(relativeSubpath || '').replace(/^\/+/, '')}`;

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
        const decodedText = decodeBase64Utf8(data.content || '');
        return {
          exists: true,
          sha: data.sha,
          content: decodedText,
          raw: data,
        };
      } catch (err) {
        if (err.status === 404) {
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

  async readJson(relativeSubpath, fallback = null) {
    const meta = await this.getFileMeta(relativeSubpath);
    if (!meta.exists || !meta.content) return fallback;
    try {
      return JSON.parse(meta.content);
    } catch {
      return fallback;
    }
  }

  async putFile(relativeSubpath, contentStringOrBase64, commitMessage, options = {}) {
    if (!this.hasToken()) {
      throw new Error('GitHub Personal Access Token is required to write to GitHub.');
    }
    const target = options.target || this.getDataTarget();
    if (!target.owner || !target.repo) {
      throw new Error('GitHub owner and repository are not configured.');
    }

    const repoPath = `${target.basePath}/${String(relativeSubpath || '').replace(/^\/+/, '')}`;
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
          if (err.status !== 404) throw err;
        }
      }

      const payload = {
        message: commitMessage || `diary: update ${repoPath}`,
        content: base64Content,
        branch: target.branch,
      };
      if (sha) payload.sha = sha;

      return this._apiRequest(endpoint, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
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
    const serialized = JSON.stringify(obj, null, 2);
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
    const repoPath = `${target.basePath}/${String(relativeSubpath || '').replace(/^\/+/, '')}`;
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

    await this._apiRequest(endpoint, {
      method: 'DELETE',
      body: JSON.stringify({
        message: commitMessage || `diary: delete ${repoPath}`,
        sha,
        branch: target.branch,
      }),
    });

    return { deleted: true, path: repoPath };
  }

  async updateDayAndIndex(dayStr, dayDoc, commitMessage, options = {}) {
    const daySubpath = `days/${dayStr}.json`;
    const indexSubpath = 'index.json';

    const saveDayResult = await this.putJson(daySubpath, dayDoc, commitMessage, options);

    let currentIndex = null;
    try {
      const existingIdxMeta = await this.getFileMeta(indexSubpath);
      if (existingIdxMeta.exists && existingIdxMeta.content) {
        currentIndex = JSON.parse(existingIdxMeta.content);
      }
    } catch {
      currentIndex = null;
    }

    const nextIndex = recalculateIndexForDay(currentIndex, dayStr, dayDoc);
    const saveIndexResult = await this.putJson(
      indexSubpath,
      nextIndex,
      `${commitMessage} (index ${dayStr})`,
      { _retried: false }
    );

    return {
      dayResult: saveDayResult,
      indexResult: saveIndexResult,
      index: nextIndex,
    };
  }
}
