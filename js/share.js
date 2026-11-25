/**
 * js/share.js — Zero-Knowledge Revocable Share Links (Phase 10)
 * Encrypts a single diary entry snapshot with a fresh 256-bit random AES-256-GCM key,
 * commits the opaque ciphertext to `data/shared/<shareId>.json`, and places the decryption key
 * strictly in the URL `#fragment` (which browsers never transmit to servers or logs).
 * Clicking Revoke deletes `data/shared/<shareId>.json`, rendering the link permanently dead.
 */

import {
  bytesToBase64,
  base64ToBytes,
  bytesToHex,
  randomBytes,
} from './crypto.js';

const SHARE_STORAGE_PREFIX = 'perpetual_shared_blob_v1_';
const SHARE_MANIFEST_KEY = 'perpetual_shared_manifest_v1';
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function toBase64Url(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(str) {
  const clean = String(str || '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const pad = clean.length % 4 === 0 ? '' : '='.repeat(4 - (clean.length % 4));
  return base64ToBytes(clean + pad);
}

function buildShareAad(shareId) {
  return `perpetual:v1:share:${String(shareId || '').trim()}`;
}

/**
 * Parses a zero-knowledge share hash route: `#share=<id>&k=<base64urlKey>`
 * @param {string} hashStr
 * @returns {{ shareId: string, keyB64Url: string } | null}
 */
export function parseShareHash(hashStr) {
  const raw = String(hashStr || '').replace(/^#/, '');
  if (!raw.startsWith('share=')) return null;
  const params = new URLSearchParams(raw);
  const shareId = String(params.get('share') || '').trim();
  const keyB64Url = String(params.get('k') || '').trim();
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(shareId) || !keyB64Url) return null;
  return { shareId, keyB64Url };
}

/**
 * Resolves the public hosting target for share links so recipients without a GitHub PAT
 * can fetch `data/shared/<id>.json` over static HTTPS even when Split-Repo Private Vault is on.
 */
function resolveShareRepoTarget(ghClient, usePublicAppRepo = true) {
  const cfg = ghClient?.config || {};
  if (usePublicAppRepo && cfg.owner && cfg.repo) {
    return {
      owner: String(cfg.owner).trim(),
      repo: String(cfg.repo).trim(),
      branch: String(cfg.branch || 'main').trim() || 'main',
      basePath: String(cfg.dataPath || 'data').trim().replace(/^\/+|\/+$/g, '') || 'data',
    };
  }
  return ghClient.getDataTarget();
}

/**
 * Loads the owner's local list of issued share links (non-secret metadata only; never stores keys).
 */
export function loadShareRecords(storageTarget = null) {
  try {
    const store = storageTarget || (typeof window !== 'undefined' ? window.localStorage : null);
    if (!store) return [];
    const raw = store.getItem(SHARE_MANIFEST_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveShareRecords(records, storageTarget = null) {
  try {
    const store = storageTarget || (typeof window !== 'undefined' ? window.localStorage : null);
    if (!store) return;
    store.setItem(SHARE_MANIFEST_KEY, JSON.stringify(Array.isArray(records) ? records : []));
  } catch {
    // ignore storage errors
  }
}

/**
 * Creates a Zero-Knowledge Revocable Share Link for a single decrypted entry snapshot.
 *
 * @param {{
 *   entrySnapshot: {
 *     diaryDate: string,
 *     year: number,
 *     title: string,
 *     body: string,
 *     mood?: string,
 *     tags?: string[]
 *   },
 *   expiresInHours?: number,
 *   ghClient: Object,
 *   zeroFootprint?: boolean,
 *   usePublicAppRepo?: boolean
 * }} options
 * @returns {Promise<{ shareId: string, shareUrl: string, record: Object, storageMode: string }>}
 */
export async function createRevocableShareLink({
  entrySnapshot,
  expiresInHours = 168,
  ghClient,
  zeroFootprint = false,
  usePublicAppRepo = true,
}) {
  if (!entrySnapshot || !String(entrySnapshot.body || '').trim()) {
    throw new Error('Cannot share an empty entry.');
  }

  const shareId = `sh-${bytesToHex(randomBytes(8))}`;
  const rawKeyBytes = randomBytes(32);
  const iv = randomBytes(12);

  const shareKey = await window.crypto.subtle.importKey(
    'raw',
    rawKeyBytes,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );

  const nowIso = new Date().toISOString();
  const expHours = Number(expiresInHours) || 0;
  const expiresAt =
    expHours > 0 ? new Date(Date.now() + expHours * 3600000).toISOString() : null;

  const plaintextObj = {
    diaryDate: entrySnapshot.diaryDate,
    year: entrySnapshot.year,
    title: entrySnapshot.title || '',
    body: entrySnapshot.body,
    mood: entrySnapshot.mood || '',
    tags: Array.isArray(entrySnapshot.tags) ? entrySnapshot.tags : [],
    sharedAt: nowIso,
    expiresAt,
  };

  const aad = buildShareAad(shareId);
  const cipherBuf = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: textEncoder.encode(aad) },
    shareKey,
    textEncoder.encode(JSON.stringify(plaintextObj))
  );

  const envelope = {
    format: 'perpetual-zk-share-v1',
    id: shareId,
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(cipherBuf)),
    createdAt: nowIso,
    expiresAt,
  };

  let storageMode = 'sandbox';
  let targetRepoFull = 'local-sandbox';

  if (ghClient && ghClient.hasToken()) {
    const target = resolveShareRepoTarget(ghClient, usePublicAppRepo);
    await ghClient.putJson(
      `shared/${shareId}.json`,
      envelope,
      `diary: create zero-knowledge share ${shareId}`,
      { target }
    );
    storageMode = 'github';
    targetRepoFull = `${target.owner}/${target.repo}`;
  } else if (!zeroFootprint) {
    window.localStorage.setItem(
      `${SHARE_STORAGE_PREFIX}${shareId}`,
      JSON.stringify(envelope)
    );
  } else {
    throw new Error(
      'Zero-Footprint Sandbox cannot persist share links without a connected GitHub token.'
    );
  }

  const keyFragment = toBase64Url(rawKeyBytes);
  rawKeyBytes.fill(0);

  const baseUrl = `${window.location.origin}${window.location.pathname}`;
  const shareUrl = `${baseUrl}#share=${encodeURIComponent(shareId)}&k=${encodeURIComponent(
    keyFragment
  )}`;

  const record = {
    shareId,
    diaryDate: entrySnapshot.diaryDate,
    titlePreview: String(entrySnapshot.title || entrySnapshot.diaryDate).slice(0, 60),
    createdAt: nowIso,
    expiresAt,
    storageMode,
    targetRepo: targetRepoFull,
    usePublicAppRepo: Boolean(usePublicAppRepo),
  };

  if (!zeroFootprint) {
    const existing = loadShareRecords(window.localStorage);
    saveShareRecords([record, ...existing.filter((r) => r.shareId !== shareId)], window.localStorage);
  }

  return { shareId, shareUrl, record, storageMode };
}

/**
 * Fetches and decrypts a shared entry strictly client-side using the key from `#fragment`.
 * Works with zero authentication on public GitHub Pages sites and locally in Sandbox Mode.
 * @param {string} shareId
 * @param {string} keyB64Url
 * @param {Object | null} [ghClient]
 */
export async function fetchAndDecryptShareLink(shareId, keyB64Url, ghClient = null) {
  let envelope = null;

  // 1. Try local sandbox storage first (instant local testing)
  try {
    const localRaw = window.localStorage.getItem(`${SHARE_STORAGE_PREFIX}${shareId}`);
    if (localRaw) envelope = JSON.parse(localRaw);
  } catch {
    envelope = null;
  }

  // 2. Fetch static public share blob from `./data/shared/<id>.json`
  if (!envelope) {
    const dataPath =
      String(ghClient?.config?.dataPath || 'data')
        .trim()
        .replace(/^\/+|\/+$/g, '') || 'data';
    const staticUrl = `./${dataPath}/shared/${encodeURIComponent(shareId)}.json?t=${Date.now()}`;
    const res = await fetch(staticUrl, { cache: 'no-store' });
    if (res.ok) {
      envelope = await res.json();
    } else if (ghClient && ghClient.hasToken()) {
      // Optional authenticated fallback if share lives in a private repo
      const meta = await ghClient.getFileMeta(
        `shared/${shareId}.json`,
        resolveShareRepoTarget(ghClient, true)
      );
      if (meta.exists && meta.content) {
        envelope = JSON.parse(meta.content);
      }
    }
  }

  if (!envelope || envelope.format !== 'perpetual-zk-share-v1') {
    const err = new Error('This share link has been revoked or does not exist.');
    err.code = 'SHARE_NOT_FOUND';
    throw err;
  }

  if (envelope.expiresAt && new Date(envelope.expiresAt).getTime() < Date.now()) {
    const err = new Error('This share link has expired and can no longer be viewed.');
    err.code = 'SHARE_EXPIRED';
    throw err;
  }

  const rawKey = fromBase64Url(keyB64Url);
  if (rawKey.length !== 32) {
    throw new Error('Invalid or incomplete decryption key in URL fragment.');
  }

  const key = await window.crypto.subtle.importKey(
    'raw',
    rawKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
  rawKey.fill(0);

  try {
    const plainBuf = await window.crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: base64ToBytes(envelope.iv),
        additionalData: textEncoder.encode(buildShareAad(shareId)),
      },
      key,
      base64ToBytes(envelope.ciphertext)
    );
    const payload = JSON.parse(textDecoder.decode(plainBuf));
    if (payload.expiresAt && new Date(payload.expiresAt).getTime() < Date.now()) {
      const err = new Error('This share link has expired.');
      err.code = 'SHARE_EXPIRED';
      throw err;
    }
    return payload;
  } catch (err) {
    if (err.code === 'SHARE_EXPIRED') throw err;
    throw new Error('Decryption failed — the share key in the URL fragment is invalid or tampered.');
  }
}

/**
 * Permanently revokes a share link by deleting `data/shared/<shareId>.json` from GitHub/localStorage.
 * @param {string} shareId
 * @param {Object} ghClient
 * @param {{ usePublicAppRepo?: boolean, zeroFootprint?: boolean }} [options]
 */
export async function revokeShareLink(shareId, ghClient, options = {}) {
  try {
    window.localStorage.removeItem(`${SHARE_STORAGE_PREFIX}${shareId}`);
  } catch {
    // ignore
  }

  if (ghClient && ghClient.hasToken()) {
    const target = resolveShareRepoTarget(ghClient, options.usePublicAppRepo !== false);
    await ghClient.deleteFile(
      `shared/${shareId}.json`,
      `diary: revoke zero-knowledge share ${shareId}`,
      { target }
    );
  }

  if (!options.zeroFootprint) {
    const existing = loadShareRecords(window.localStorage);
    saveShareRecords(
      existing.filter((r) => r.shareId !== shareId),
      window.localStorage
    );
  }

  return { revoked: true, shareId };
}
