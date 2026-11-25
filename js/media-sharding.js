/**
 * js/media-sharding.js — Yearly / Era Media-Repo Sharding & Offline Original Archival
 * Phase 7:
 * - Routes heavy photo binaries to dedicated sibling GitHub repos (e.g. diary-media-2026)
 *   so your main diary repository stays permanently lightweight below the 1 GB ceiling.
 * - Supports Thumbnail-in-GitHub + Offline Originals workflow with SHA-256 archival naming.
 */

import { bytesToHex } from './crypto.js';

const SHARD_PREFIX = 'gh:';

/**
 * Checks whether an image `src` uses a media-repo shard pointer (`gh:<repo>/<path>`).
 * @param {unknown} src
 * @returns {boolean}
 */
export function isShardPointer(src) {
  return typeof src === 'string' && src.startsWith(SHARD_PREFIX);
}

/**
 * Resolves a repo naming pattern such as `diary-media-{year}` or `diary-media-{decade}s`.
 * @param {string} pattern
 * @param {number | string} year
 * @returns {string}
 */
export function resolveShardRepoName(pattern, year) {
  const yrNum = Number(year) || new Date().getFullYear();
  const decade = Math.floor(yrNum / 10) * 10;
  const tpl = String(pattern || 'diary-media-{year}').trim();
  return tpl
    .replace(/\{year\}/gi, String(yrNum))
    .replace(/\{decade\}/gi, String(decade))
    .replace(/[^a-zA-Z0-9._-]/g, '-');
}

/**
 * Builds a compact portable shard pointer stored inside `entry.image.src`.
 * Format: `gh:<repo>/<subpath>`
 * @param {string} repoName
 * @param {string} subpath
 * @returns {string}
 */
export function buildShardPointer(repoName, subpath) {
  const cleanRepo = String(repoName || '')
    .trim()
    .replace(/^\/+|\/+$/g, '');
  const cleanSub = String(subpath || '')
    .trim()
    .replace(/^\/+/, '');
  return `${SHARD_PREFIX}${cleanRepo}/${cleanSub}`;
}

/**
 * Parses a shard pointer into `{ owner, repo, branch, subpath }`.
 * Supports both:
 *   - `gh:<repo>/<subpath>` (inherits defaultOwner & defaultBranch)
 *   - `gh:<owner>/<repo>@<branch>/<subpath>` (explicit owner/branch override)
 * @param {string} src
 * @param {string} [defaultOwner='']
 * @param {string} [defaultBranch='main']
 */
export function parseShardPointer(src, defaultOwner = '', defaultBranch = 'main') {
  if (!isShardPointer(src)) return null;
  const body = src.slice(SHARD_PREFIX.length).replace(/^\/+/, '');
  const segments = body.split('/').filter(Boolean);
  if (segments.length < 2) return null;

  if (segments.length >= 3 && segments[1].includes('@')) {
    const owner = segments[0];
    const [repo, branch] = segments[1].split('@');
    const subpath = segments.slice(2).join('/');
    return {
      owner: owner || defaultOwner,
      repo,
      branch: branch || defaultBranch || 'main',
      subpath,
    };
  }

  const repo = segments[0];
  const subpath = segments.slice(1).join('/');
  return {
    owner: defaultOwner,
    repo,
    branch: defaultBranch || 'main',
    subpath,
  };
}

/**
 * Computes a short 10-character SHA-256 hex digest of an untouched original photo
 * so you can verify and locate it inside your offline hard-drive archive years later.
 * @param {File | ArrayBuffer | Uint8Array} fileOrBuffer
 * @returns {Promise<string>}
 */
export async function computeFileShortHash(fileOrBuffer) {
  const buf =
    fileOrBuffer instanceof ArrayBuffer
      ? fileOrBuffer
      : fileOrBuffer instanceof Uint8Array
        ? fileOrBuffer.buffer
        : await fileOrBuffer.arrayBuffer();
  const digest = await window.crypto.subtle.digest('SHA-256', buf);
  return bytesToHex(new Uint8Array(digest)).slice(0, 10).toLowerCase();
}

/**
 * Triggers a local browser download of the untouched full-resolution original file
 * with a deterministic archival filename (`YYYY-MM-DD-<hash>-<originalName>`).
 * @param {File} file
 * @param {string} datePrefix
 * @param {string} shortHash
 * @returns {string | null}
 */
export function downloadOriginalForColdArchive(file, datePrefix, shortHash) {
  if (!file) return null;
  const safeOrigName = String(file.name || 'photo.jpg')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 80);
  const archiveFilename = `${datePrefix || 'undated'}-${shortHash}-${safeOrigName}`;
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = archiveFilename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
  return archiveFilename;
}
