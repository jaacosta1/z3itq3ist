/**
 * js/history.js — Phase 11: Git Revision "Time Machine" & Cross-Device `drafts` Branch
 *
 * 1. Git Revision "Time Machine":
 *    - Queries GitHub's Commits API for any calendar day (`data/days/MM-DD.json` or
 *      cloaked `data/shards/<hmac>.enc`), fetches historical snapshots at any commit SHA,
 *      decrypts v1/v2/v3 AAD prose client-side, and enables line-diffing & one-click restore.
 *    - Also keeps a lightweight local snapshot ring buffer in Sandbox Mode so revision
 *      history works offline without GitHub.
 *
 * 2. Cross-Device `drafts` Branch:
 *    - Lazily creates a dedicated `drafts` branch in your data/vault repository from `main`.
 *    - Saves unfinished reflections to `data/drafts/YYYY-MM-DD.json` on the `drafts` branch
 *      (encrypted with AES-256-GCM + AAD whenever your Vault is unlocked) so works-in-progress
 *      sync seamlessly across phone and desktop without publishing to `main`.
 */

import {
  encryptText,
  decryptText,
  isEncryptedPayload,
  buildEntryAad,
} from './crypto.js';
import { decodeBase64Utf8 } from './github.js';

export const DRAFTS_BRANCH_NAME = 'drafts';
const SANDBOX_HISTORY_KEY = 'perpetual_sandbox_history_v1';
const SANDBOX_CLOUD_DRAFTS_KEY = 'perpetual_cloud_drafts_v1';
const MAX_SANDBOX_REVISIONS_PER_DAY = 15;
const CLOUD_DRAFT_FORMAT = 'perpetual-cloud-draft-v1';

function buildDraftAad(diaryDate) {
  return `perpetual:v3:draft:${String(diaryDate || '').trim()}`;
}

function getDraftsBranchTarget(ghClient) {
  const base = ghClient.getDataTarget();
  return {
    ...base,
    branch: DRAFTS_BRANCH_NAME,
  };
}

/* ============================================================================
   1. SANDBOX REVISION SNAPSHOTS (LOCAL FALLBACK FOR TIME MACHINE)
   ============================================================================ */

export function recordSandboxRevision(dayStr, dayDoc, commitMessage, zeroFootprint = false) {
  if (zeroFootprint || !dayStr || !dayDoc) return;
  try {
    const raw = window.localStorage.getItem(SANDBOX_HISTORY_KEY);
    const store = raw ? JSON.parse(raw) : {};
    const list = Array.isArray(store[dayStr]) ? store[dayStr] : [];
    const nowIso = new Date().toISOString();
    const syntheticSha = `local-${Date.now().toString(16)}`;
    list.unshift({
      sha: syntheticSha,
      shortSha: syntheticSha.slice(-7),
      date: nowIso,
      message: commitMessage || `sandbox: save ${dayStr}`,
      authorName: 'Local Sandbox',
      source: 'sandbox',
      doc: JSON.parse(JSON.stringify(dayDoc)),
    });
    store[dayStr] = list.slice(0, MAX_SANDBOX_REVISIONS_PER_DAY);
    window.localStorage.setItem(SANDBOX_HISTORY_KEY, JSON.stringify(store));
  } catch {
    // ignore storage quota errors
  }
}

function loadSandboxRevisions(dayStr) {
  try {
    const raw = window.localStorage.getItem(SANDBOX_HISTORY_KEY);
    if (!raw) return [];
    const store = JSON.parse(raw);
    return Array.isArray(store[dayStr]) ? store[dayStr] : [];
  } catch {
    return [];
  }
}

/* ============================================================================
   2. GIT REVISION "TIME MACHINE" (COMMITS API + HISTORICAL SNAPSHOT DECRYPTION)
   ============================================================================ */

/**
 * Fetches commit history for a specific calendar day (`MM-DD`).
 * Supports Split-Repo Vault, Metadata-Cloaked HMAC shards, and Sandbox local history.
 *
 * @param {Object} ghClient
 * @param {string} dayStr
 * @param {{ cloakAdapter?: Object | null, limit?: number }} [options]
 * @returns {Promise<Array<{
 *   sha: string,
 *   shortSha: string,
 *   date: string,
 *   message: string,
 *   authorName: string,
 *   repoPath: string,
 *   source: 'github' | 'sandbox',
 *   doc?: Object
 * }>>}
 */
export async function fetchDayCommitHistory(
  ghClient,
  dayStr,
  { cloakAdapter = null, limit = 20 } = {}
) {
  if (!ghClient || (!ghClient.hasToken() && !ghClient.isConfigured())) {
    return loadSandboxRevisions(dayStr);
  }

  const target = ghClient.getDataTarget();
  if (!target.owner || !target.repo) {
    return loadSandboxRevisions(dayStr);
  }

  const candidateSubpaths = [];
  if (cloakAdapter && cloakAdapter.enabled) {
    const shardSub = await cloakAdapter.getDaySubpath(dayStr);
    candidateSubpaths.push(shardSub);
  }
  candidateSubpaths.push(`days/${dayStr}.json`);

  const seenShas = new Set();
  const collected = [];

  for (const sub of candidateSubpaths) {
    const repoPath = target.basePath ? `${target.basePath}/${sub}` : sub;
    const url = `https://api.github.com/repos/${encodeURIComponent(
      target.owner
    )}/${encodeURIComponent(target.repo)}/commits?path=${encodeURIComponent(
      repoPath
    )}&sha=${encodeURIComponent(target.branch)}&per_page=${Math.min(50, Math.max(1, limit))}&_t=${Date.now()}`;

    try {
      const commits = await ghClient._apiRequest(url);
      if (!Array.isArray(commits)) continue;
      for (const item of commits) {
        if (!item?.sha || seenShas.has(item.sha)) continue;
        seenShas.add(item.sha);
        collected.push({
          sha: item.sha,
          shortSha: item.sha.slice(0, 7),
          date:
            item.commit?.author?.date ||
            item.commit?.committer?.date ||
            new Date().toISOString(),
          message: String(item.commit?.message || 'Commit').split('\n')[0],
          authorName:
            item.commit?.author?.name ||
            item.author?.login ||
            target.owner,
          repoPath,
          isCloakedPath: sub.startsWith('shards/'),
          source: 'github',
        });
      }
    } catch (err) {
      if (err.status !== 404 && err.status !== 409) {
        throw err;
      }
    }
  }

  collected.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  return collected.slice(0, limit);
}

/**
 * Fetches and decrypts a single historical entry snapshot at a specific Git commit SHA.
 *
 * @param {Object} ghClient
 * @param {string} dayStr
 * @param {string} yearKey
 * @param {Object} revision
 * @param {{ keyring?: Object | null, cloakAdapter?: Object | null }} [options]
 */
export async function fetchEntryAtRevision(
  ghClient,
  dayStr,
  yearKey,
  revision,
  { keyring = null, cloakAdapter = null } = {}
) {
  let dayDoc = null;

  if (revision.source === 'sandbox' && revision.doc) {
    dayDoc = revision.doc;
  } else {
    const target = ghClient.getDataTarget();
    const encodedPath = String(revision.repoPath || '')
      .split('/')
      .map(encodeURIComponent)
      .join('/');
    const url = `https://api.github.com/repos/${encodeURIComponent(
      target.owner
    )}/${encodeURIComponent(target.repo)}/contents/${encodedPath}?ref=${encodeURIComponent(
      revision.sha
    )}&_t=${Date.now()}`;

    const fileMeta = await ghClient._apiRequest(url);
    let b64 = fileMeta?.content || '';
    if (!b64 && fileMeta?.sha) {
      const blob = await ghClient._apiRequest(
        `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(
          target.repo
        )}/git/blobs/${encodeURIComponent(fileMeta.sha)}`
      );
      b64 = blob?.content || '';
    }
    const rawText = decodeBase64Utf8(b64);
    if (!rawText) {
      return { found: false, entry: null };
    }

    if (revision.isCloakedPath && cloakAdapter) {
      dayDoc = await cloakAdapter.deserializeDay(dayStr, rawText);
    } else {
      dayDoc = JSON.parse(rawText);
    }
  }

  const rawEntry = dayDoc?.entries?.[String(yearKey)] || null;
  if (!rawEntry) {
    return { found: false, entry: null };
  }

  const expectedDate = `${yearKey}-${dayStr}`;
  let plainTitle = rawEntry.title || '';
  let plainBody = rawEntry.body || '';
  let decryptionError = '';

  const needsDecrypt =
    Boolean(rawEntry.encrypted) ||
    isEncryptedPayload(rawEntry.body) ||
    isEncryptedPayload(rawEntry.title);

  if (needsDecrypt) {
    if (!keyring) {
      return {
        found: true,
        locked: true,
        entry: {
          ...rawEntry,
          title: '[Encrypted]',
          body: '[Unlock Vault to inspect this historical revision]',
        },
      };
    }
    try {
      if (rawEntry.body && isEncryptedPayload(rawEntry.body)) {
        plainBody = await decryptText(
          rawEntry.body,
          keyring,
          buildEntryAad(expectedDate, String(yearKey), 'body')
        );
      }
      if (rawEntry.title && isEncryptedPayload(rawEntry.title)) {
        plainTitle = await decryptText(
          rawEntry.title,
          keyring,
          buildEntryAad(expectedDate, String(yearKey), 'title')
        );
      }
    } catch (err) {
      decryptionError = err.message || 'Could not decrypt this revision.';
    }
  }

  return {
    found: true,
    locked: false,
    decryptionError,
    entry: {
      ...rawEntry,
      title: plainTitle,
      body: plainBody,
      tags: Array.isArray(rawEntry.tags) ? rawEntry.tags : [],
      mood: rawEntry.mood || '',
    },
  };
}

/* ============================================================================
   3. CROSS-DEVICE `drafts` BRANCH SYNC ENGINE
   ============================================================================ */

/**
 * Ensures the dedicated `drafts` branch exists in the data/vault repository.
 * If missing, creates it cleanly from the current HEAD of the primary data branch.
 * @param {Object} ghClient
 */
export async function ensureDraftsBranch(ghClient) {
  if (!ghClient || !ghClient.hasToken()) {
    throw new Error('Connect a GitHub PAT to sync drafts across devices.');
  }

  const target = ghClient.getDataTarget();
  const repoBase = `https://api.github.com/repos/${encodeURIComponent(
    target.owner
  )}/${encodeURIComponent(target.repo)}`;

  try {
    const existing = await ghClient._apiRequest(
      `${repoBase}/git/ref/heads/${encodeURIComponent(DRAFTS_BRANCH_NAME)}?_t=${Date.now()}`
    );
    if (existing?.object?.sha) {
      return { created: false, sha: existing.object.sha };
    }
  } catch (err) {
    if (err.status !== 404) throw err;
  }

  // Resolve primary branch HEAD SHA to branch off from
  const mainRef = await ghClient._apiRequest(
    `${repoBase}/git/ref/heads/${encodeURIComponent(target.branch)}?_t=${Date.now()}`
  );
  const baseSha = mainRef?.object?.sha;
  if (!baseSha) {
    throw new Error(
      `Cannot create "${DRAFTS_BRANCH_NAME}" branch: primary branch "${target.branch}" has no commits yet.`
    );
  }

  await ghClient._apiRequest(`${repoBase}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({
      ref: `refs/heads/${DRAFTS_BRANCH_NAME}`,
      sha: baseSha,
    }),
  });

  return { created: true, sha: baseSha };
}

function loadSandboxCloudDraftsMap(zeroFootprint = false) {
  if (zeroFootprint) return {};
  try {
    const raw = window.localStorage.getItem(SANDBOX_CLOUD_DRAFTS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveSandboxCloudDraftsMap(map, zeroFootprint = false) {
  if (zeroFootprint) return;
  try {
    window.localStorage.setItem(SANDBOX_CLOUD_DRAFTS_KEY, JSON.stringify(map));
  } catch {
    // ignore storage errors
  }
}

/**
 * Saves an unfinished entry draft to the dedicated `drafts` Git branch
 * (`data/drafts/YYYY-MM-DD.json`), encrypted with AES-256-GCM AAD if the Vault is unlocked.
 */
export async function saveCloudDraft(
  ghClient,
  draftData,
  { keyring = null, encrypt = true, zeroFootprint = false } = {}
) {
  const diaryDate = String(draftData?.diaryDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(diaryDate)) {
    throw new Error('Select a valid diary date (YYYY-MM-DD) before saving a draft.');
  }

  const nowIso = new Date().toISOString();
  const payloadObj = {
    diaryDate,
    title: String(draftData.title || ''),
    mood: String(draftData.mood || ''),
    tags: Array.isArray(draftData.tags) ? draftData.tags : [],
    body: String(draftData.body || ''),
    encryptOnPublish: Boolean(draftData.encryptOnPublish),
    updatedAt: nowIso,
  };

  const shouldEncrypt = Boolean(encrypt && keyring);
  let envelope;
  if (shouldEncrypt) {
    const cipher = await encryptText(
      JSON.stringify(payloadObj),
      keyring,
      buildDraftAad(diaryDate)
    );
    envelope = {
      format: CLOUD_DRAFT_FORMAT,
      diaryDate,
      encrypted: true,
      updatedAt: nowIso,
      payload: cipher,
    };
  } else {
    envelope = {
      format: CLOUD_DRAFT_FORMAT,
      diaryDate,
      encrypted: false,
      updatedAt: nowIso,
      data: payloadObj,
    };
  }

  if (ghClient && ghClient.hasToken()) {
    await ensureDraftsBranch(ghClient);
    const draftsTarget = getDraftsBranchTarget(ghClient);
    await ghClient.putJson(
      `drafts/${diaryDate}.json`,
      envelope,
      `draft: save ${diaryDate}`,
      { target: draftsTarget }
    );
    return { diaryDate, branch: DRAFTS_BRANCH_NAME, encrypted: shouldEncrypt, updatedAt: nowIso };
  }

  if (zeroFootprint) {
    throw new Error(
      'Zero-Footprint Sandbox cannot persist drafts without a connected GitHub token.'
    );
  }

  const map = loadSandboxCloudDraftsMap(false);
  map[diaryDate] = envelope;
  saveSandboxCloudDraftsMap(map, false);
  return { diaryDate, branch: 'sandbox-drafts', encrypted: shouldEncrypt, updatedAt: nowIso };
}

/**
 * Lists all drafts currently saved on the `drafts` branch (or Sandbox drafts store).
 */
export async function listCloudDrafts(ghClient, { zeroFootprint = false } = {}) {
  if (ghClient && ghClient.hasToken()) {
    const target = getDraftsBranchTarget(ghClient);
    const draftsDir = target.basePath ? `${target.basePath}/drafts` : 'drafts';
    const encodedDir = draftsDir.split('/').map(encodeURIComponent).join('/');
    const url = `https://api.github.com/repos/${encodeURIComponent(
      target.owner
    )}/${encodeURIComponent(target.repo)}/contents/${encodedDir}?ref=${encodeURIComponent(
      target.branch
    )}&_t=${Date.now()}`;

    try {
      const items = await ghClient._apiRequest(url);
      if (!Array.isArray(items)) return [];
      return items
        .filter((f) => f && f.type === 'file' && /^\d{4}-\d{2}-\d{2}\.json$/.test(f.name))
        .map((f) => ({
          diaryDate: f.name.replace(/\.json$/, ''),
          filename: f.name,
          sha: f.sha,
          size: Number(f.size || 0),
          source: 'github',
        }))
        .sort((a, b) => b.diaryDate.localeCompare(a.diaryDate));
    } catch (err) {
      if (err.status === 404) return [];
      throw err;
    }
  }

  const map = loadSandboxCloudDraftsMap(zeroFootprint);
  return Object.keys(map)
    .sort((a, b) => b.localeCompare(a))
    .map((diaryDate) => ({
      diaryDate,
      filename: `${diaryDate}.json`,
      sha: null,
      size: JSON.stringify(map[diaryDate]).length,
      updatedAt: map[diaryDate]?.updatedAt || '',
      encrypted: Boolean(map[diaryDate]?.encrypted),
      source: 'sandbox',
    }));
}

/**
 * Loads and decrypts a specific draft from the `drafts` branch.
 */
export async function loadCloudDraft(
  ghClient,
  diaryDate,
  { keyring = null, zeroFootprint = false } = {}
) {
  let envelope = null;
  let sha = null;

  if (ghClient && ghClient.hasToken()) {
    const draftsTarget = getDraftsBranchTarget(ghClient);
    const meta = await ghClient.getFileMeta(`drafts/${diaryDate}.json`, draftsTarget);
    if (!meta.exists || !meta.content) {
      throw new Error(`Draft for ${diaryDate} was not found on the "${DRAFTS_BRANCH_NAME}" branch.`);
    }
    sha = meta.sha;
    envelope = JSON.parse(meta.content);
  } else {
    const map = loadSandboxCloudDraftsMap(zeroFootprint);
    envelope = map[diaryDate] || null;
    if (!envelope) {
      throw new Error(`Draft for ${diaryDate} was not found.`);
    }
  }

  if (envelope.encrypted && envelope.payload) {
    if (!keyring) {
      throw new Error('Unlock your Vault first to decrypt this synced draft.');
    }
    const plainJson = await decryptText(envelope.payload, keyring, buildDraftAad(diaryDate));
    return {
      ...JSON.parse(plainJson),
      encrypted: true,
      sha,
    };
  }

  return {
    ...(envelope.data || envelope),
    encrypted: false,
    sha,
  };
}

/**
 * Deletes a draft from the `drafts` branch (used on manual discard or after publishing to `main`).
 */
export async function deleteCloudDraft(ghClient, diaryDate, { zeroFootprint = false } = {}) {
  if (ghClient && ghClient.hasToken()) {
    const draftsTarget = getDraftsBranchTarget(ghClient);
    return ghClient.deleteFile(`drafts/${diaryDate}.json`, `draft: delete ${diaryDate}`, {
      target: draftsTarget,
    });
  }

  const map = loadSandboxCloudDraftsMap(zeroFootprint);
  if (map[diaryDate]) {
    delete map[diaryDate];
    saveSandboxCloudDraftsMap(map, zeroFootprint);
  }
  return { deleted: true };
}
