/**
 * Perpetual Side-by-Side Web Diary — GitHub Contents API & Sync Engine
 * Provides UTF-8/emoji-safe Base64 encoding, binary media uploads to /data/media/,
 * conflict-safe JSON updates with automatic 409 retry, Neocities-safe overwrite
 * deletion support, and cache-busted static fallback reads.
 */

import { countWords } from './markdown.js';
import { isEncryptedPayload } from './crypto.js';

const GITHUB_API_BASE = 'https://api.github.com';
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8');

const EXT_MIME_MAP = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
};

/**
 * Safely encodes any UTF-8 string (including emoji and CJK/non-ASCII) to Base64.
 * @param {string} str
 * @returns {string}
 */
export function encodeBase64Utf8(str) {
  const bytes = textEncoder.encode(String(str ?? ''));
  return arrayBufferToBase64(bytes);
}

/**
 * Safely decodes a Base64 string (with or without GitHub line breaks) into UTF-8 text.
 * @param {string} b64
 * @returns {string}
 */
export function decodeBase64Utf8(b64) {
  const cleaned = String(b64 ?? '').replace(/\s+/g, '');
  if (!cleaned) return '';
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return textDecoder.decode(bytes);
}

/**
 * Encodes an ArrayBuffer or Uint8Array into Base64 in safe chunks.
 * @param {ArrayBuffer | Uint8Array} buffer
 * @returns {string}
 */
export function arrayBufferToBase64(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

/**
 * Creates a clean empty day structure for a given MM-DD calendar date.
 * @param {string} mmdd
 * @returns {{ day: string, entries: Record<string, any>, comments: any[] }}
 */
export function emptyDayData(mmdd) {
  return {
    day: mmdd,
    entries: {},
    comments: [],
  };
}

/**
 * Recalculates /data/index.json metadata for a single MM-DD day from its dayData.
 * Removes the day key from index.days when no entries and no comments remain.
 * @param {Object | null} indexData
 * @param {string} mmdd
 * @param {Object} dayData
 * @returns {Object}
 */
export function recalculateIndexForDay(indexData, mmdd, dayData) {
  const nextIndex = {
    version: 1,
    updatedAt: new Date().toISOString(),
    days: {
      ...(indexData && indexData.days && typeof indexData.days === 'object' ? indexData.days : {}),
    },
  };

  const entriesObj = dayData && dayData.entries && typeof dayData.entries === 'object'
    ? dayData.entries
    : {};
  const commentsArr = dayData && Array.isArray(dayData.comments) ? dayData.comments : [];

  const years = Object.keys(entriesObj)
    .map((y) => Number(y))
    .filter((n) => Number.isInteger(n) && n >= 1000 && n <= 9999)
    .sort((a, b) => a - b);

  const tagSet = new Set();
  const wordCounts = {};

  for (const yearNum of years) {
    const entry = entriesObj[String(yearNum)];
    if (!entry) continue;

    if (Array.isArray(entry.tags)) {
      for (const rawTag of entry.tags) {
        const cleaned = String(rawTag || '').trim().toLowerCase();
        if (cleaned) tagSet.add(cleaned);
      }
    }

    if (entry.encrypted && isEncryptedPayload(entry.body)) {
      // Preserve previously computed count if available rather than counting ciphertext tokens
      const prevCount =
        typeof entry.wordCount === 'number'
          ? entry.wordCount
          : nextIndex.days[mmdd]?.wordCounts?.[String(yearNum)] || 0;
      wordCounts[String(yearNum)] = prevCount;
    } else {
      wordCounts[String(yearNum)] = countWords(entry.body || '');
    }
  }

  const commentCount = commentsArr.length;

  if (years.length === 0 && commentCount === 0) {
    delete nextIndex.days[mmdd];
  } else {
    nextIndex.days[mmdd] = {
      years,
      tags: Array.from(tagSet).sort(),
      wordCounts,
      commentCount,
    };
  }

  return nextIndex;
}

/**
 * Encodes each segment of a repository file path while preserving slashes.
 * @param {string} path
 * @returns {string}
 */
function encodeRepoPath(path) {
  return path
    .split('/')
    .filter((seg) => seg.length > 0)
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

/**
 * GitHub Contents API & static fallback client.
 */
export class GitHubClient {
  /**
   * @param {{
   *   owner?: string,
   *   repo?: string,
   *   branch?: string,
   *   dataPath?: string,
   *   token?: string,
   *   readFromApi?: boolean
   * }} [config]
   */
  constructor(config = {}) {
    this.owner = '';
    this.repo = '';
    this.branch = 'main';
    this.dataPath = 'data';
    this.token = '';
    this.readFromApi = true;
    this.updateConfig(config);
  }

  /**
   * Updates client settings cleanly.
   * @param {Object} partialConfig
   */
  updateConfig(partialConfig = {}) {
    if (partialConfig.owner !== undefined) this.owner = String(partialConfig.owner || '').trim();
    if (partialConfig.repo !== undefined) this.repo = String(partialConfig.repo || '').trim();
    if (partialConfig.branch !== undefined) {
      this.branch = String(partialConfig.branch || 'main').trim() || 'main';
    }
    if (partialConfig.dataPath !== undefined) {
      this.dataPath = String(partialConfig.dataPath || 'data')
        .trim()
        .replace(/^\/+|\/+$/g, '') || 'data';
    }
    if (partialConfig.token !== undefined) this.token = String(partialConfig.token || '').trim();
    if (partialConfig.readFromApi !== undefined) {
      this.readFromApi = Boolean(partialConfig.readFromApi);
    }
  }

  /**
   * True when owner & repository are specified.
   * @returns {boolean}
   */
  isConfigured() {
    return Boolean(this.owner && this.repo);
  }

  /**
   * True when owner, repository, and Personal Access Token are all present.
   * @returns {boolean}
   */
  canWrite() {
    return Boolean(this.owner && this.repo && this.token);
  }

  /**
   * Resolves a data-relative path (e.g., "days/11-24.json" or "data/days/11-24.json")
   * against the configured dataPath folder without double-prefixing.
   * @param {string} relativePath
   * @returns {string}
   */
  resolvePath(relativePath) {
    let clean = String(relativePath || '')
      .trim()
      .replace(/^\.\/+/, '')
      .replace(/^\/+/, '');

    if (!clean) return this.dataPath;

    if (clean === this.dataPath || clean.startsWith(`${this.dataPath}/`)) {
      return clean;
    }

    // Normalize canonical "data/..." paths if user configured a custom dataPath
    if (clean.startsWith('data/')) {
      clean = clean.slice('data/'.length);
    }

    return this.dataPath ? `${this.dataPath}/${clean}` : clean;
  }

  /**
   * Builds standard headers for GitHub REST API v3 calls.
   * @param {boolean} [includeContentType=false]
   * @returns {Record<string, string>}
   */
  _headers(includeContentType = false) {
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    if (includeContentType) {
      headers['Content-Type'] = 'application/json';
    }
    return headers;
  }

  /**
   * Parses GitHub API error payloads into clean Error instances with HTTP status.
   * @param {Response} res
   * @param {string} fallbackMessage
   */
  async _buildApiError(res, fallbackMessage) {
    let detail = fallbackMessage;
    try {
      const json = await res.json();
      if (json && json.message) {
        detail = json.message;
      }
    } catch {
      // Ignore JSON parse failure on non-JSON error responses
    }
    const err = new Error(`GitHub API (${res.status}): ${detail}`);
    err.status = res.status;
    return err;
  }

  /**
   * Tests repository visibility, branch existence, and write/push permission.
   * @returns {Promise<{ ok: boolean, repoFullName: string, permissions: Object | null, message: string }>}
   */
  async testConnection() {
    if (!this.isConfigured()) {
      return {
        ok: false,
        repoFullName: '',
        permissions: null,
        message: 'Enter both GitHub Username/Owner and Repository Name first.',
      };
    }

    const repoUrl = `${GITHUB_API_BASE}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`;
    const res = await fetch(repoUrl, {
      method: 'GET',
      headers: this._headers(false),
      cache: 'no-store',
    });

    if (!res.ok) {
      const err = await this._buildApiError(res, 'Unable to reach repository.');
      return {
        ok: false,
        repoFullName: `${this.owner}/${this.repo}`,
        permissions: null,
        message: err.message,
      };
    }

    const repoData = await res.json();
    const permissions = repoData.permissions || null;

    // Verify configured branch exists
    const branchUrl = `${repoUrl}/branches/${encodeURIComponent(this.branch)}`;
    const branchRes = await fetch(branchUrl, {
      method: 'GET',
      headers: this._headers(false),
      cache: 'no-store',
    });

    if (!branchRes.ok) {
      return {
        ok: false,
        repoFullName: repoData.full_name || `${this.owner}/${this.repo}`,
        permissions,
        message: `Connected to ${repoData.full_name}, but branch "${this.branch}" was not found.`,
      };
    }

    if (!this.token) {
      return {
        ok: true,
        repoFullName: repoData.full_name,
        permissions,
        message: `Connected to ${repoData.full_name} (${this.branch}) in read-only mode. Add a Fine-Grained PAT with Contents: Read & Write to enable live saving.`,
      };
    }

    const canPush = permissions ? Boolean(permissions.push || permissions.admin) : true;
    if (!canPush) {
      return {
        ok: false,
        repoFullName: repoData.full_name,
        permissions,
        message: `Connected to ${repoData.full_name}, but this token lacks push/write permission. Ensure Contents: Read and write is enabled.`,
      };
    }

    return {
      ok: true,
      repoFullName: repoData.full_name,
      permissions,
      message: `Connected to ${repoData.full_name} (branch: ${this.branch}) with push/write access verified.`,
    };
  }

  /**
   * Fetches a file and its current SHA directly from the GitHub Contents API.
   * Transparently handles >1MB blobs via the Git Blobs API.
   * @param {string} relativePath
   * @returns {Promise<{ exists: boolean, sha: string | null, content: string | null, rawBase64: string | null, path: string }>}
   */
  async getFile(relativePath) {
    if (!this.isConfigured()) {
      throw new Error('GitHub repository is not configured.');
    }

    const path = this.resolvePath(relativePath);
    const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(
      this.repo
    )}/contents/${encodeRepoPath(path)}?ref=${encodeURIComponent(this.branch)}&t=${Date.now()}`;

    const res = await fetch(url, {
      method: 'GET',
      headers: this._headers(false),
      cache: 'no-store',
    });

    if (res.status === 404) {
      return { exists: false, sha: null, content: null, rawBase64: null, path };
    }

    if (!res.ok) {
      throw await this._buildApiError(res, `Failed to read ${path}`);
    }

    const payload = await res.json();
    let rawBase64 = typeof payload.content === 'string' ? payload.content.replace(/\s+/g, '') : '';

    // GitHub omits inline content for files > 1MB; fetch via Git Blobs API
    if (!rawBase64 && payload.sha) {
      const blobUrl = `${GITHUB_API_BASE}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(
        this.repo
      )}/git/blobs/${encodeURIComponent(payload.sha)}`;
      const blobRes = await fetch(blobUrl, {
        method: 'GET',
        headers: this._headers(false),
        cache: 'no-store',
      });
      if (!blobRes.ok) {
        throw await this._buildApiError(blobRes, `Failed to fetch blob for ${path}`);
      }
      const blobData = await blobRes.json();
      rawBase64 = typeof blobData.content === 'string' ? blobData.content.replace(/\s+/g, '') : '';
    }

    return {
      exists: true,
      sha: payload.sha || null,
      rawBase64,
      content: rawBase64 ? decodeBase64Utf8(rawBase64) : '',
      path,
    };
  }

  /**
   * Fetches and parses a JSON file from the GitHub Contents API.
   * @param {string} relativePath
   * @returns {Promise<{ exists: boolean, sha: string | null, data: any, path: string }>}
   */
  async getJson(relativePath) {
    const file = await this.getFile(relativePath);
    if (!file.exists) {
      return { exists: false, sha: null, data: null, path: file.path };
    }
    try {
      const data = JSON.parse(file.content || '{}');
      return { exists: true, sha: file.sha, data, path: file.path };
    } catch (err) {
      throw new Error(`Invalid JSON in ${file.path}: ${err.message}`);
    }
  }

  /**
   * Creates or overwrites a file in GitHub via PUT /repos/{owner}/{repo}/contents/{path}.
   * @param {string} relativePath
   * @param {string} contentStr
   * @param {string} message
   * @param {{ sha?: string | null, isBase64?: boolean }} [options]
   * @returns {Promise<{ sha: string | null, commitSha: string | null, path: string }>}
   */
  async putFile(relativePath, contentStr, message, options = {}) {
    if (!this.canWrite()) {
      throw new Error('GitHub write credentials are not configured.');
    }

    const path = this.resolvePath(relativePath);
    let targetSha = options.sha;

    // Auto-resolve latest SHA if caller omitted sha (undefined), unless explicitly null (new file)
    if (targetSha === undefined) {
      const existing = await this.getFile(path);
      targetSha = existing.exists ? existing.sha : null;
    }

    const body = {
      message: message || `diary: update ${path}`,
      content: options.isBase64 ? String(contentStr).replace(/\s+/g, '') : encodeBase64Utf8(contentStr),
      branch: this.branch,
    };

    if (targetSha) {
      body.sha = targetSha;
    }

    const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(
      this.repo
    )}/contents/${encodeRepoPath(path)}`;

    const res = await fetch(url, {
      method: 'PUT',
      headers: this._headers(true),
      body: JSON.stringify(body),
      cache: 'no-store',
    });

    if (!res.ok) {
      throw await this._buildApiError(res, `Failed to commit ${path}`);
    }

    const result = await res.json();
    return {
      sha: result.content?.sha || null,
      commitSha: result.commit?.sha || null,
      path,
    };
  }

  /**
   * Commits a pretty-printed JSON object to GitHub (2-space indent + trailing newline).
   * @param {string} relativePath
   * @param {any} dataObj
   * @param {string} message
   * @param {string | null} [sha]
   * @returns {Promise<{ sha: string | null, commitSha: string | null, path: string }>}
   */
  async putJson(relativePath, dataObj, message, sha) {
    const serialized = `${JSON.stringify(dataObj, null, 2)}\n`;
    return this.putFile(relativePath, serialized, message, { sha, isBase64: false });
  }

  /**
   * Uploads a binary file (e.g., PNG/JPG/WebP/GIF image) directly to GitHub.
   * @param {string} relativePath
   * @param {ArrayBuffer | Uint8Array} arrayBuffer
   * @param {string} message
   * @returns {Promise<{ sha: string | null, commitSha: string | null, path: string }>}
   */
  async putBinary(relativePath, arrayBuffer, message) {
    const b64 = arrayBufferToBase64(arrayBuffer);
    return this.putFile(relativePath, b64, message, { sha: undefined, isBase64: true });
  }

  /**
   * Deletes a file from GitHub (used for optional orphaned /data/media/ cleanup).
   * Note: For day JSON deletions under Neocities cleanup: false, overwrite the day JSON
   * with empty entries instead of calling deleteFile.
   * @param {string} relativePath
   * @param {string} message
   * @param {string | null} [sha]
   * @returns {Promise<{ deleted: boolean, path: string }>}
   */
  async deleteFile(relativePath, message, sha) {
    if (!this.canWrite()) {
      throw new Error('GitHub write credentials are not configured.');
    }

    const path = this.resolvePath(relativePath);
    let targetSha = sha;

    if (!targetSha) {
      const existing = await this.getFile(path);
      if (!existing.exists || !existing.sha) {
        return { deleted: false, path };
      }
      targetSha = existing.sha;
    }

    const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(
      this.repo
    )}/contents/${encodeRepoPath(path)}`;

    const res = await fetch(url, {
      method: 'DELETE',
      headers: this._headers(true),
      body: JSON.stringify({
        message: message || `diary: remove ${path}`,
        sha: targetSha,
        branch: this.branch,
      }),
      cache: 'no-store',
    });

    if (res.status === 404) {
      return { deleted: false, path };
    }

    if (!res.ok) {
      throw await this._buildApiError(res, `Failed to delete ${path}`);
    }

    return { deleted: true, path };
  }

  /**
   * Conflict-safe read-modify-write helper for JSON files.
   * Automatically retries once on HTTP 409 Conflict (or 422 stale SHA) by re-fetching
   * the latest remote state and re-applying mutatorFn.
   * @param {string} relativePath
   * @param {(currentData: any) => Promise<any> | any} mutatorFn
   * @param {string} commitMessage
   * @returns {Promise<{ data: any, sha: string | null, commitSha: string | null }>}
   */
  async updateJsonWithRetry(relativePath, mutatorFn, commitMessage) {
    const maxAttempts = 2;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const remote = await this.getJson(relativePath);
      const nextData = await mutatorFn(remote.exists ? remote.data : null);

      try {
        const res = await this.putJson(
          relativePath,
          nextData,
          commitMessage,
          remote.exists ? remote.sha : null
        );
        return {
          data: nextData,
          sha: res.sha,
          commitSha: res.commitSha,
        };
      } catch (err) {
        lastError = err;
        const isConflict = err && (err.status === 409 || err.status === 422);
        if (isConflict && attempt < maxAttempts) {
          continue;
        }
        throw err;
      }
    }

    throw lastError || new Error(`Failed to update ${relativePath}`);
  }

  /**
   * Fetches a static JSON file directly from the hosted Neocities/static origin
   * with strict cache-busting so deployed edits and deletions never show stale data.
   * @param {string} relativePath
   * @returns {Promise<{ exists: boolean, data: any }>}
   */
  async fetchStaticJson(relativePath) {
    const path = this.resolvePath(relativePath);
    const url = `./${path}?t=${Date.now()}`;

    const res = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
    });

    if (res.status === 404) {
      return { exists: false, data: null };
    }

    if (!res.ok) {
      throw new Error(`Failed to load static file ${path} (HTTP ${res.status})`);
    }

    const data = await res.json();
    return { exists: true, data };
  }

  /**
   * Unified JSON reader:
   * - Uses GitHub API directly when authenticated and readFromApi is enabled (zero deploy lag).
   * - Falls back to cache-busted static Neocities files otherwise.
   * @param {string} relativePath
   * @returns {Promise<{ exists: boolean, data: any, sha: string | null, source: 'github' | 'static' }>}
   */
  async readJson(relativePath) {
    if (this.canWrite() && this.readFromApi) {
      const remote = await this.getJson(relativePath);
      return {
        exists: remote.exists,
        data: remote.data,
        sha: remote.sha,
        source: 'github',
      };
    }

    const localStatic = await this.fetchStaticJson(relativePath);
    return {
      exists: localStatic.exists,
      data: localStatic.data,
      sha: null,
      source: 'static',
    };
  }

  /**
   * Fetches a media file directly from the GitHub API and returns an object URL,
   * allowing newly uploaded images to render immediately before Neocities finishes deploying.
   * @param {string} relativePath
   * @returns {Promise<string>}
   */
  async fetchRawMediaBlobUrl(relativePath) {
    const file = await this.getFile(relativePath);
    if (!file.exists || !file.rawBase64) {
      throw new Error(`Media file not found on GitHub: ${file.path}`);
    }

    const extMatch = file.path.toLowerCase().match(/\.([a-z0-9]+)$/);
    const ext = extMatch ? extMatch[1] : 'jpg';
    const mimeType = EXT_MIME_MAP[ext] || 'application/octet-stream';

    const binary = atob(file.rawBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }

    const blob = new Blob([bytes], { type: mimeType });
    return URL.createObjectURL(blob);
  }
}