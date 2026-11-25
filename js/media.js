/**
 * js/media.js — Perpetual Side-by-Side Web Diary Media Engine (File 6 of 11 · Final Build)
 *
 * Capabilities:
 * - Phase 6: Browser-side WebP compression presets (`thumb`, `compact`, `balanced`, `high`, `original`)
 *   + AES-256-GCM AAD Encrypted Media Vault (`.enc` binary blobs) with RAM Blob URL lifecycle registry
 * - Phase 7: Yearly / Era Media-Repo Sharding (`gh:<repo>/<subpath>`) & Split-Repo Vault binary loader
 * - Phase 18:
 *   1. Multi-Photo Galleries (`normalizeEntryImages`) & Keyboard/Touch Lightbox (`openMediaLightbox`)
 *   2. Ink Sketch / Margin Doodle Pad (`class InkSketchPad`) exporting crisp WebP sketches
 *   3. Encrypted Voice Notes (`class VoiceNoteRecorder` + `prepareAudioPayloadForStorage`)
 * - IndexedDB Sandbox Media Store (`class LocalMediaStore`)
 * - Interactive Hold-and-Drag Alignment Studio (`class AlignmentStudio`, `attachInlineAlignController`)
 */

import {
  base64ToBytes,
  encryptBinary,
  decryptBinary,
  buildMediaAad,
  isEncryptedMediaPath,
} from './crypto.js';
import { isShardPointer, parseShardPointer } from './media-sharding.js';

export const WEBP_PRESETS = Object.freeze({
  thumb: { maxDim: 480, quality: 0.6, label: 'Thumbnail (480px · ~30 KB)' },
  compact: { maxDim: 960, quality: 0.65, label: 'Compact (960px · 65%)' },
  balanced: { maxDim: 1200, quality: 0.74, label: 'Balanced (1200px · 74%)' },
  high: { maxDim: 1600, quality: 0.82, label: 'High Detail (1600px · 82%)' },
  original: { maxDim: 0, quality: 1, label: 'Original (No Resize)' },
});

export const DEFAULT_IMAGE_META = Object.freeze({
  src: '',
  caption: '',
  align: 'full',
  posX: 50,
  posY: 50,
  width: 100,
  height: 240,
});

export const ALLOWED_IMAGE_TYPES = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

export const MAX_IMAGE_BYTES = 25 * 1024 * 1024; // 25 MB pre-compression ceiling
export const MAX_VOICE_DURATION_SEC = 300; // 5 minutes max per voice note

const ALLOWED_MIMES = new Set(ALLOWED_IMAGE_TYPES);
const VALID_ALIGNS = new Set(['left', 'center', 'right', 'full']);
const PRESET_STORAGE_KEY = 'perpetual_diary_webp_preset_v1';

// In-memory registry of decrypted/fetched Blob URLs — wiped cleanly on Lock / Panic Lock / Unload
const managedBlobUrlCache = new Map();

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function clamp(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/**
 * Revokes all RAM-managed Blob URLs (decrypted photos, sketches, voice notes).
 * Called automatically on Lock, Auto-Lock, Panic Lock (Ctrl+Shift+L), and page unload.
 */
export function revokeAllManagedMediaUrls() {
  for (const url of managedBlobUrlCache.values()) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // ignore revoke errors
    }
  }
  managedBlobUrlCache.clear();
}

export function formatBytesCompact(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatDurationSec(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function getSavedWebpPreset(zeroFootprint = false) {
  if (zeroFootprint) return 'balanced';
  try {
    const val = window.localStorage.getItem(PRESET_STORAGE_KEY);
    return val && WEBP_PRESETS[val] ? val : 'balanced';
  } catch {
    return 'balanced';
  }
}

export function saveWebpPreset(presetKey, zeroFootprint = false) {
  const valid = WEBP_PRESETS[presetKey] ? presetKey : 'balanced';
  if (!zeroFootprint) {
    try {
      window.localStorage.setItem(PRESET_STORAGE_KEY, valid);
    } catch {
      // ignore storage errors
    }
  }
  return valid;
}

/**
 * Normalizes a single image/sketch metadata object cleanly.
 */
export function normalizeImageMeta(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const src = typeof raw.src === 'string' ? raw.src.trim() : '';
  if (!src) return null;
  const align = VALID_ALIGNS.has(raw.align) ? raw.align : DEFAULT_IMAGE_META.align;
  const normalized = {
    id: raw.id || `img-${Math.random().toString(36).slice(2, 9)}`,
    src,
    caption: typeof raw.caption === 'string' ? raw.caption : '',
    align,
    posX: Math.round(clamp(raw.posX ?? DEFAULT_IMAGE_META.posX, 0, 100)),
    posY: Math.round(clamp(raw.posY ?? DEFAULT_IMAGE_META.posY, 0, 100)),
    width: Math.round(clamp(raw.width ?? DEFAULT_IMAGE_META.width, 30, 100)),
    height: Math.round(clamp(raw.height ?? DEFAULT_IMAGE_META.height, 110, 420)),
    encrypted: Boolean(raw.encrypted || isEncryptedMediaPath(src)),
    kind: raw.kind === 'sketch' ? 'sketch' : 'photo',
  };
  if (raw.originalRef && typeof raw.originalRef === 'object') {
    normalized.originalRef = { ...raw.originalRef };
  }
  return normalized;
}

/**
 * Backward-compatible multi-photo gallery normalizer.
 * Combines legacy `entry.image` and Phase 18 `entry.images[]` into one deduplicated array.
 * @param {Object | null} entry
 * @returns {Array<Object>}
 */
export function normalizeEntryImages(entry) {
  if (!entry || typeof entry !== 'object') return [];
  const list = [];
  const seenSrc = new Set();

  const pushIfValid = (item) => {
    const norm = normalizeImageMeta(item);
    if (!norm) return;
    if (seenSrc.has(norm.src)) return;
    seenSrc.add(norm.src);
    list.push(norm);
  };

  if (Array.isArray(entry.images) && entry.images.length > 0) {
    for (const img of entry.images) pushIfValid(img);
  }
  if (entry.image && typeof entry.image === 'object') {
    pushIfValid(entry.image);
  }
  return list;
}

export function buildMediaFilename(diaryDate, ext = 'webp', encrypted = false) {
  const safeDate = /^\d{4}-\d{2}-\d{2}$/.test(String(diaryDate || ''))
    ? diaryDate
    : new Date().toISOString().slice(0, 10);
  const cleanExt = String(ext || 'webp')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  const suffix = encrypted ? `${cleanExt}.enc` : cleanExt;
  return `data/media/${safeDate}-${Date.now()}.${suffix}`;
}

/* ============================================================================
   WEBP COMPRESSION & BINARY VAULT PREPARATION
   ============================================================================ */

let cachedWebpSupport = null;
function supportsWebpEncoding() {
  if (cachedWebpSupport !== null) return cachedWebpSupport;
  try {
    const c = document.createElement('canvas');
    c.width = 2;
    c.height = 2;
    cachedWebpSupport = c.toDataURL('image/webp').startsWith('data:image/webp');
  } catch {
    cachedWebpSupport = false;
  }
  return cachedWebpSupport;
}

function extFromMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('webp')) return 'webp';
  if (m.includes('png')) return 'png';
  if (m.includes('gif')) return 'gif';
  if (m.includes('webm')) return 'webm';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('mp4') || m.includes('m4a')) return 'm4a';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  return 'jpg';
}

function mimeFromPath(pathStr) {
  const clean = String(pathStr || '').split('?')[0].toLowerCase().replace(/\.enc$/, '');
  if (clean.endsWith('.webp')) return 'image/webp';
  if (clean.endsWith('.png')) return 'image/png';
  if (clean.endsWith('.gif')) return 'image/gif';
  if (clean.endsWith('.webm')) return 'audio/webm';
  if (clean.endsWith('.ogg')) return 'audio/ogg';
  if (clean.endsWith('.m4a') || clean.endsWith('.mp4')) return 'audio/mp4';
  if (clean.endsWith('.mp3')) return 'audio/mpeg';
  return 'image/jpeg';
}

function loadImageElementFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not decode image file.'));
    };
    img.src = url;
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read preview data URL.'));
    reader.readAsDataURL(blob);
  });
}

function canvasToBlob(canvas, mime, quality) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), mime, quality);
  });
}

/**
 * Compresses and resizes an uploaded photo in the browser to WebP (or JPEG fallback).
 * Preserves animated GIFs untouched so animation frames are never flattened.
 */
export async function processImageFile(file, options = {}) {
  if (!file) throw new Error('No file selected.');
  if (!ALLOWED_MIMES.has(file.type)) {
    throw new Error('Unsupported image format. Please choose PNG, JPG, WebP, or GIF.');
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error('Image exceeds 25 MB maximum upload limit.');
  }

  const presetKey = WEBP_PRESETS[options.preset] ? options.preset : 'balanced';
  const preset = WEBP_PRESETS[presetKey];
  const originalBytes = file.size;

  if (file.type === 'image/gif' || presetKey === 'original') {
    const arrayBuffer = await file.arrayBuffer();
    const dataUrl = await blobToDataUrl(file);
    return {
      blob: file,
      arrayBuffer,
      bytes: new Uint8Array(arrayBuffer),
      dataUrl,
      ext: extFromMime(file.type),
      mime: file.type,
      mimeType: file.type,
      size: arrayBuffer.byteLength,
      originalBytes,
      compressedBytes: arrayBuffer.byteLength,
      savedPercent: 0,
      preset: presetKey,
      formatLabel: file.type === 'image/gif' ? 'GIF (animated preserved)' : 'Original',
    };
  }

  const img = await loadImageElementFromFile(file);
  const srcW = img.naturalWidth || img.width;
  const srcH = img.naturalHeight || img.height;

  let targetW = srcW;
  let targetH = srcH;
  if (preset.maxDim > 0 && Math.max(srcW, srcH) > preset.maxDim) {
    const scale = preset.maxDim / Math.max(srcW, srcH);
    targetW = Math.max(1, Math.round(srcW * scale));
    targetH = Math.max(1, Math.round(srcH * scale));
  }

  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d', { alpha: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, targetW, targetH);

  const targetMime = supportsWebpEncoding() ? 'image/webp' : 'image/jpeg';
  const compressedBlob = await canvasToBlob(canvas, targetMime, preset.quality);

  if (!compressedBlob || compressedBlob.size >= originalBytes) {
    const fallbackBuf = await file.arrayBuffer();
    const fallbackUrl = await blobToDataUrl(file);
    return {
      blob: file,
      arrayBuffer: fallbackBuf,
      bytes: new Uint8Array(fallbackBuf),
      dataUrl: fallbackUrl,
      ext: extFromMime(file.type),
      mime: file.type,
      mimeType: file.type,
      width: srcW,
      height: srcH,
      size: fallbackBuf.byteLength,
      originalBytes,
      compressedBytes: fallbackBuf.byteLength,
      savedPercent: 0,
      preset: presetKey,
      formatLabel: `${extFromMime(file.type).toUpperCase()} (already optimal)`,
    };
  }

  const arrayBuffer = await compressedBlob.arrayBuffer();
  const dataUrl = await blobToDataUrl(compressedBlob);
  const savedPercent = Math.max(
    0,
    Math.round(((originalBytes - arrayBuffer.byteLength) / originalBytes) * 100)
  );

  return {
    blob: compressedBlob,
    arrayBuffer,
    bytes: new Uint8Array(arrayBuffer),
    dataUrl,
    ext: extFromMime(targetMime),
    mime: targetMime,
    mimeType: targetMime,
    width: targetW,
    height: targetH,
    size: arrayBuffer.byteLength,
    originalBytes,
    compressedBytes: arrayBuffer.byteLength,
    savedPercent,
    preset: presetKey,
    formatLabel: `${targetMime === 'image/webp' ? 'WebP' : 'JPEG'} ${targetW}×${targetH}`,
  };
}

/**
 * Prepares an image/sketch binary buffer for either plaintext or AES-256-GCM AAD `.enc` storage.
 */
export async function prepareMediaPayloadForStorage({
  buffer,
  mime = 'image/webp',
  ext = 'webp',
  datePrefix = '2026-11-24',
  encrypt = false,
  keyring = null,
  namePrefix = '',
}) {
  const randSuffix = Math.random().toString(36).slice(2, 6);
  const prefixTag = namePrefix ? `${namePrefix}-` : '';
  const stamp = `${prefixTag}${datePrefix}-${Date.now()}-${randSuffix}`;

  if (encrypt) {
    if (!keyring?.dek && !keyring?.legacyKey) {
      throw new Error('Unlock your Vault first to encrypt media (.enc).');
    }
    const mediaSubpath = `media/${stamp}.${ext}.enc`;
    const aad = buildMediaAad(mediaSubpath);
    const encBytes = await encryptBinary(buffer, keyring, { mime, aad });
    return {
      mediaSubpath,
      uploadBuffer: encBytes.buffer,
      uploadMime: 'application/octet-stream',
      encrypted: true,
    };
  }

  const mediaSubpath = `media/${stamp}.${ext}`;
  const outBuf = buffer instanceof Uint8Array ? buffer.slice().buffer : buffer;
  return {
    mediaSubpath,
    uploadBuffer: outBuf,
    uploadMime: mime,
    encrypted: false,
  };
}

/**
 * Prepares a recorded Voice Note binary buffer for encrypted `.enc` (or plaintext) storage.
 */
export async function prepareAudioPayloadForStorage({
  buffer,
  mime = 'audio/webm',
  ext = 'webm',
  datePrefix = '2026-11-24',
  encrypt = true,
  keyring = null,
}) {
  return prepareMediaPayloadForStorage({
    buffer,
    mime,
    ext: ext || extFromMime(mime),
    datePrefix,
    encrypt,
    keyring,
    namePrefix: 'voice',
  });
}

/* ============================================================================
   INDEXEDDB SANDBOX MEDIA STORE
   ============================================================================ */

export class LocalMediaStore {
  constructor(dbName = 'PerpetualDiaryMediaDB', storeName = 'images') {
    this.dbName = dbName;
    this.storeName = storeName;
    this.db = null;
  }

  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB is unavailable.'));
        return;
      }
      const req = window.indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => {
        this.db = req.result;
        resolve(this.db);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async putImage(id, arrayBufferOrBytes, mime = 'image/webp') {
    const db = await this.open();
    const buf =
      arrayBufferOrBytes instanceof Uint8Array
        ? arrayBufferOrBytes.slice().buffer
        : arrayBufferOrBytes instanceof Blob
          ? await arrayBufferOrBytes.arrayBuffer()
          : arrayBufferOrBytes;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      tx.objectStore(this.storeName).put({
        id,
        buffer: buf,
        mime,
        savedAt: new Date().toISOString(),
      });
      tx.oncomplete = () => resolve(id);
      tx.onerror = () => reject(tx.error);
    });
  }

  async saveBlob(id, blob) {
    return this.putImage(id, blob, blob?.type || 'image/webp');
  }

  async getImageRecord(id) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readonly');
      const req = tx.objectStore(this.storeName).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async getBlob(id) {
    const rec = await this.getImageRecord(id);
    if (!rec || !rec.buffer) return null;
    return new Blob([rec.buffer], { type: rec.mime || 'image/webp' });
  }

  async getObjectUrl(id) {
    const blob = await this.getBlob(id);
    return blob ? URL.createObjectURL(blob) : null;
  }

  async deleteImage(id) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      tx.objectStore(this.storeName).delete(id);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  async deleteBlob(id) {
    return this.deleteImage(id);
  }
}

/* ============================================================================
   SPLIT-REPO, SHARDED & ENCRYPTED (.ENC) MEDIA LOADER
   ============================================================================ */

/**
 * Fetches raw binary bytes from IndexedDB, Yearly Media Shards (`gh:`),
 * Split-Repo Vault GitHub API (with >1 MB Git Blobs fallback), or static hosted path.
 */
export async function fetchRawMediaBytes(src, ghClient, mediaStore = null) {
  if (!src) return null;

  if (src.startsWith('idb://') || src.startsWith('idb:')) {
    if (!mediaStore) return null;
    const key = src.startsWith('idb://') ? src.slice(6) : src.slice(4);
    const rec = (await mediaStore.getImageRecord(key)) || (await mediaStore.getImageRecord(src));
    if (!rec?.buffer) return null;
    return {
      bytes: new Uint8Array(rec.buffer),
      mime: rec.mime || mimeFromPath(key),
      subpath: key.replace(/^data\//i, ''),
    };
  }

  // Yearly/era sibling media-repo shard pointer (`gh:<repo>/<subpath>`)
  if (isShardPointer(src)) {
    const dataTarget = ghClient?.getDataTarget
      ? ghClient.getDataTarget()
      : { owner: '', branch: 'main' };
    const shard = parseShardPointer(
      src,
      dataTarget.owner,
      ghClient?.config?.mediaShardBranch || 'main'
    );
    if (!shard || !shard.owner || !shard.repo) {
      throw new Error(`Invalid media shard pointer: ${src}`);
    }

    const encodedPath = shard.subpath.split('/').map(encodeURIComponent).join('/');
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    const tokenVal = ghClient?.config?.token || ghClient?.token || '';
    if (tokenVal) {
      headers.Authorization = `Bearer ${String(tokenVal).trim()}`;
    }

    const metaUrl = `https://api.github.com/repos/${encodeURIComponent(
      shard.owner
    )}/${encodeURIComponent(shard.repo)}/contents/${encodedPath}?ref=${encodeURIComponent(
      shard.branch
    )}&_t=${Date.now()}`;

    const res = await fetch(metaUrl, { headers, cache: 'no-store' });
    if (!res.ok) {
      throw new Error(
        `Failed to load sharded media (${res.status}): ${shard.repo}/${shard.subpath}`
      );
    }
    const meta = await res.json();
    let b64 = meta?.content ? String(meta.content).replace(/\s+/g, '') : '';

    if (!b64 && meta?.sha) {
      const blobUrl = `https://api.github.com/repos/${encodeURIComponent(
        shard.owner
      )}/${encodeURIComponent(shard.repo)}/git/blobs/${encodeURIComponent(meta.sha)}`;
      const blobRes = await fetch(blobUrl, { headers, cache: 'no-store' });
      if (!blobRes.ok) throw new Error(`Failed to fetch large sharded blob (${blobRes.status}).`);
      const blobJson = await blobRes.json();
      b64 = String(blobJson?.content || '').replace(/\s+/g, '');
    }

    if (!b64) return null;
    return {
      bytes: base64ToBytes(b64),
      mime: mimeFromPath(shard.subpath),
      subpath: shard.subpath,
      sha: meta.sha || null,
    };
  }

  if (/^https?:\/\//i.test(src)) {
    const res = await fetch(src, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Failed to fetch external media (${res.status}).`);
    const buf = await res.arrayBuffer();
    return {
      bytes: new Uint8Array(buf),
      mime: res.headers.get('content-type') || mimeFromPath(src),
      subpath: src,
    };
  }

  const cleanRel = String(src).replace(/^\.\/+/, '').replace(/^\/+/, '');
  const target = ghClient?.getDataTarget ? ghClient.getDataTarget() : null;
  const basePrefix = target?.basePath ? `${target.basePath}/` : 'data/';
  const subpath = cleanRel.startsWith(basePrefix) ? cleanRel.slice(basePrefix.length) : cleanRel;

  const hasGhAuth = Boolean(
    ghClient &&
      ((typeof ghClient.hasToken === 'function' && ghClient.hasToken()) ||
        (typeof ghClient.canWrite === 'function' && ghClient.canWrite()))
  );

  if (hasGhAuth && target?.owner && target?.repo) {
    const fullRepoPath = cleanRel.startsWith(basePrefix) ? cleanRel : `${basePrefix}${cleanRel}`;
    const encodedPath = fullRepoPath.split('/').map(encodeURIComponent).join('/');
    const tokenVal = ghClient.config?.token || ghClient.token || '';
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: `Bearer ${String(tokenVal).trim()}`,
    };
    const metaUrl = `https://api.github.com/repos/${encodeURIComponent(
      target.owner
    )}/${encodeURIComponent(target.repo)}/contents/${encodedPath}?ref=${encodeURIComponent(
      target.branch
    )}&_t=${Date.now()}`;

    const res = await fetch(metaUrl, { headers, cache: 'no-store' });
    if (!res.ok) {
      throw new Error(`Failed to load vault media (${res.status}): ${fullRepoPath}`);
    }
    const meta = await res.json();
    let b64 = meta?.content ? String(meta.content).replace(/\s+/g, '') : '';

    if (!b64 && meta?.sha) {
      const blobUrl = `https://api.github.com/repos/${encodeURIComponent(
        target.owner
      )}/${encodeURIComponent(target.repo)}/git/blobs/${encodeURIComponent(meta.sha)}`;
      const blobRes = await fetch(blobUrl, { headers, cache: 'no-store' });
      if (!blobRes.ok) throw new Error(`Failed to fetch large media blob (${blobRes.status}).`);
      const blobJson = await blobRes.json();
      b64 = String(blobJson?.content || '').replace(/\s+/g, '');
    }

    if (!b64) return null;
    return {
      bytes: base64ToBytes(b64),
      mime: mimeFromPath(fullRepoPath),
      subpath,
      sha: meta.sha || null,
    };
  }

  const staticUrl = `./${cleanRel}?t=${Date.now()}`;
  const staticRes = await fetch(staticUrl, { cache: 'no-store' });
  if (!staticRes.ok) return null;
  const buf = await staticRes.arrayBuffer();
  return {
    bytes: new Uint8Array(buf),
    mime: staticRes.headers.get('content-type') || mimeFromPath(cleanRel),
    subpath,
  };
}

/**
 * Resolves any photo, sketch, or voice-note source (plaintext or `.enc`) into a RAM-managed `blob:` URL.
 */
export async function resolveMediaAsset(
  src,
  ghClient,
  mediaStore = null,
  keyring = null,
  ramMap = null
) {
  if (!src) return { status: 'empty', url: '', encrypted: false, mime: '' };
  const isEnc = isEncryptedMediaPath(src);

  if (src.startsWith('data:image/') || src.startsWith('data:audio/') || src.startsWith('blob:')) {
    return { status: 'ok', url: src, encrypted: false, mime: '' };
  }

  if (src.startsWith('ram:')) {
    if (!isEnc) {
      const url = ramMap?.get(src) || '';
      return { status: url ? 'ok' : 'error', url, encrypted: false, mime: mimeFromPath(src) };
    }
    if (!keyring?.dek && !keyring?.legacyKey) {
      return { status: 'locked', url: '', encrypted: true, mime: '' };
    }
    const cacheKey = `${src}::${keyring.dekFingerprint || 'key'}`;
    if (managedBlobUrlCache.has(cacheKey)) {
      return { status: 'ok', url: managedBlobUrlCache.get(cacheKey), encrypted: true, mime: '' };
    }
    const rawEncBytes = ramMap?.get(src);
    if (!rawEncBytes) return { status: 'error', url: '', encrypted: true, mime: '' };
    try {
      const decrypted = await decryptBinary(rawEncBytes, keyring, {
        aad: buildMediaAad(src.slice(4)),
      });
      const blobUrl = URL.createObjectURL(new Blob([decrypted.bytes], { type: decrypted.mime }));
      managedBlobUrlCache.set(cacheKey, blobUrl);
      return { status: 'ok', url: blobUrl, encrypted: true, mime: decrypted.mime };
    } catch (err) {
      return {
        status: err?.code === 'AAD_TAMPER_ERROR' ? 'tampered' : 'error',
        url: '',
        encrypted: true,
        mime: '',
        error: err.message,
      };
    }
  }

  if (/^https:\/\//i.test(src) && !isEnc) {
    return { status: 'ok', url: src, encrypted: false, mime: mimeFromPath(src) };
  }

  if (isEnc && !keyring?.dek && !keyring?.legacyKey) {
    return { status: 'locked', url: '', encrypted: true, mime: '' };
  }

  const cacheKey = isEnc ? `${src}::${keyring?.dekFingerprint || 'key'}` : src;
  if (managedBlobUrlCache.has(cacheKey)) {
    return { status: 'ok', url: managedBlobUrlCache.get(cacheKey), encrypted: isEnc, mime: '' };
  }

  try {
    const hasToken = Boolean(
      ghClient && typeof ghClient.hasToken === 'function' && ghClient.hasToken()
    );
    if (
      !isEnc &&
      !src.startsWith('idb:') &&
      !src.startsWith('idb://') &&
      !isShardPointer(src) &&
      !hasToken
    ) {
      const cleanRel = String(src).replace(/^\.\/+/, '').replace(/^\/+/, '');
      return {
        status: 'ok',
        url: `./${cleanRel}?t=${Date.now()}`,
        encrypted: false,
        mime: mimeFromPath(cleanRel),
      };
    }

    const fetched = await fetchRawMediaBytes(src, ghClient, mediaStore);
    if (!fetched || !fetched.bytes) {
      return { status: 'error', url: '', encrypted: isEnc, mime: '' };
    }

    if (isEnc) {
      const decrypted = await decryptBinary(fetched.bytes, keyring, {
        aad: buildMediaAad(fetched.subpath),
      });
      const blobUrl = URL.createObjectURL(new Blob([decrypted.bytes], { type: decrypted.mime }));
      managedBlobUrlCache.set(cacheKey, blobUrl);
      return { status: 'ok', url: blobUrl, encrypted: true, mime: decrypted.mime };
    }

    const blobUrl = URL.createObjectURL(new Blob([fetched.bytes], { type: fetched.mime }));
    managedBlobUrlCache.set(cacheKey, blobUrl);
    return { status: 'ok', url: blobUrl, encrypted: false, mime: fetched.mime };
  } catch (err) {
    return {
      status: err?.code === 'AAD_TAMPER_ERROR' ? 'tampered' : 'error',
      url: '',
      encrypted: isEnc,
      mime: '',
      error: err.message,
    };
  }
}

export async function resolveMediaSrc(
  src,
  ghOrContext = null,
  mediaStore = null,
  keyring = null,
  ramMap = null
) {
  if (
    ghOrContext &&
    (ghOrContext.localStore !== undefined || ghOrContext.githubClient !== undefined)
  ) {
    const asset = await resolveMediaAsset(
      src,
      ghOrContext.githubClient || null,
      ghOrContext.localStore || null,
      ghOrContext.keyring || null,
      ghOrContext.ramMap || null
    );
    return asset.status === 'ok' ? asset.url : '';
  }
  const asset = await resolveMediaAsset(src, ghOrContext, mediaStore, keyring, ramMap);
  return asset.status === 'ok' ? asset.url : '';
}

/* ============================================================================
   PHASE 18A: FULL-SCREEN MULTI-PHOTO GALLERY LIGHTBOX
   ============================================================================ */

let activeLightboxCleanup = null;

/**
 * Closes any currently open Media Lightbox cleanly.
 */
export function closeMediaLightbox() {
  if (typeof activeLightboxCleanup === 'function') {
    activeLightboxCleanup();
    activeLightboxCleanup = null;
  }
}

/**
 * Opens an accessible full-screen Lightbox viewer for a single image or multi-photo gallery.
 * Supports ArrowLeft / ArrowRight / Escape keys, click-outside close, zoom toggle, and captions.
 *
 * @param {Array<{ url: string, caption?: string, diaryDate?: string, encrypted?: boolean, kind?: string }>} items
 * @param {number} [startIndex=0]
 */
export function openMediaLightbox(items, startIndex = 0) {
  closeMediaLightbox();
  const validItems = (Array.isArray(items) ? items : []).filter((it) => it && it.url);
  if (validItems.length === 0) return;

  let currentIdx = Math.min(validItems.length - 1, Math.max(0, Number(startIndex) || 0));
  let zoomed = false;

  const overlay = document.createElement('div');
  overlay.className = 'media-lightbox-backdrop';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Photo Gallery Lightbox');

  overlay.innerHTML = `
    <div class="lightbox-topbar">
      <div class="lightbox-meta-left">
        <span class="mono-meta lightbox-counter"></span>
        <span class="lightbox-enc-pill" hidden>🔒 .ENC RAM DECRYPTED</span>
      </div>
      <div class="lightbox-controls">
        <button type="button" class="btn btn-ghost btn-sm lightbox-zoom-btn" title="Toggle Zoom">⊕ Zoom</button>
        <button type="button" class="icon-btn lightbox-close-btn" aria-label="Close Lightbox">✕</button>
      </div>
    </div>
    <div class="lightbox-stage">
      <button type="button" class="lightbox-nav-btn lightbox-prev-btn" aria-label="Previous Photo">‹</button>
      <div class="lightbox-img-wrap">
        <img class="lightbox-img" src="" alt="" />
      </div>
      <button type="button" class="lightbox-nav-btn lightbox-next-btn" aria-label="Next Photo">›</button>
    </div>
    <div class="lightbox-caption-bar">
      <p class="lightbox-caption-text"></p>
      <div class="lightbox-thumbs" hidden></div>
    </div>
  `;

  const counterEl = overlay.querySelector('.lightbox-counter');
  const encPillEl = overlay.querySelector('.lightbox-enc-pill');
  const zoomBtn = overlay.querySelector('.lightbox-zoom-btn');
  const closeBtn = overlay.querySelector('.lightbox-close-btn');
  const prevBtn = overlay.querySelector('.lightbox-prev-btn');
  const nextBtn = overlay.querySelector('.lightbox-next-btn');
  const imgWrap = overlay.querySelector('.lightbox-img-wrap');
  const imgEl = overlay.querySelector('.lightbox-img');
  const captionEl = overlay.querySelector('.lightbox-caption-text');
  const thumbsEl = overlay.querySelector('.lightbox-thumbs');

  const renderSlide = () => {
    const item = validItems[currentIdx];
    zoomed = false;
    imgWrap.classList.remove('is-zoomed');
    zoomBtn.textContent = '⊕ Zoom';

    imgEl.src = item.url;
    imgEl.alt = item.caption || `Diary media ${currentIdx + 1}`;
    counterEl.textContent =
      validItems.length > 1
        ? `${currentIdx + 1} / ${validItems.length}${item.diaryDate ? ` · ${item.diaryDate}` : ''}`
        : item.diaryDate || 'Photo View';
    encPillEl.hidden = !item.encrypted;

    captionEl.textContent =
      item.caption || (item.kind === 'sketch' ? 'Margin Ink Sketch' : '');
    prevBtn.hidden = validItems.length <= 1;
    nextBtn.hidden = validItems.length <= 1;

    if (validItems.length > 1) {
      thumbsEl.hidden = false;
      thumbsEl.querySelectorAll('.lightbox-thumb-btn').forEach((btn, idx) => {
        btn.classList.toggle('is-active', idx === currentIdx);
      });
    }
  };

  if (validItems.length > 1) {
    thumbsEl.innerHTML = validItems
      .map(
        (it, idx) =>
          `<button type="button" class="lightbox-thumb-btn${idx === currentIdx ? ' is-active' : ''}" data-lb-idx="${idx}" aria-label="Open photo ${idx + 1}"><img src="${escapeHtml(it.url)}" alt="" /></button>`
      )
      .join('');
    thumbsEl.querySelectorAll('.lightbox-thumb-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        currentIdx = Number(btn.dataset.lbIdx) || 0;
        renderSlide();
      });
    });
  }

  const step = (delta) => {
    if (validItems.length <= 1) return;
    currentIdx = (currentIdx + delta + validItems.length) % validItems.length;
    renderSlide();
  };

  prevBtn.addEventListener('click', () => step(-1));
  nextBtn.addEventListener('click', () => step(1));

  const toggleZoom = () => {
    zoomed = !zoomed;
    imgWrap.classList.toggle('is-zoomed', zoomed);
    zoomBtn.textContent = zoomed ? '⊖ Fit' : '⊕ Zoom';
  };
  zoomBtn.addEventListener('click', toggleZoom);
  imgEl.addEventListener('click', toggleZoom);

  const onKeyDown = (ev) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      closeMediaLightbox();
    } else if (ev.key === 'ArrowLeft') {
      ev.preventDefault();
      step(-1);
    } else if (ev.key === 'ArrowRight') {
      ev.preventDefault();
      step(1);
    }
  };

  // Touch swipe navigation on mobile
  let touchStartX = null;
  overlay.addEventListener(
    'touchstart',
    (ev) => {
      if (ev.touches.length === 1) touchStartX = ev.touches[0].clientX;
    },
    { passive: true }
  );
  overlay.addEventListener(
    'touchend',
    (ev) => {
      if (touchStartX === null || ev.changedTouches.length !== 1) return;
      const dx = ev.changedTouches[0].clientX - touchStartX;
      touchStartX = null;
      if (Math.abs(dx) > 48) {
        step(dx > 0 ? -1 : 1);
      }
    },
    { passive: true }
  );

  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay || ev.target === overlay.querySelector('.lightbox-stage')) {
      closeMediaLightbox();
    }
  });
  closeBtn.addEventListener('click', () => closeMediaLightbox());

  document.addEventListener('keydown', onKeyDown);
  document.body.appendChild(overlay);
  renderSlide();
  closeBtn.focus();

  activeLightboxCleanup = () => {
    document.removeEventListener('keydown', onKeyDown);
    overlay.remove();
  };
}

/* ============================================================================
   PHASE 18B: INK SKETCH / MARGIN DOODLE PAD
   ============================================================================ */

const SKETCH_COLORS = Object.freeze([
  { id: 'ink', label: 'Charcoal Ink', hex: '#1a1816' },
  { id: 'amber', label: 'Warm Amber', hex: '#c88a28' },
  { id: 'crimson', label: 'Vermilion', hex: '#b83b32' },
  { id: 'cobalt', label: 'Fountain Blue', hex: '#28527a' },
  { id: 'moss', label: 'Pine Ink', hex: '#2e6146' },
]);

/**
 * Interactive HTML5 Canvas Ink Sketch / Margin Doodle Pad supporting Mouse, Touch,
 * and Apple Pencil / Stylus Pointer Events with undo stack & compact WebP export.
 */
export class InkSketchPad {
  constructor(hostEl, { width = 720, height = 420 } = {}) {
    this.hostEl = hostEl;
    this.canvasWidth = width;
    this.canvasHeight = height;
    this.strokes = [];
    this.currentStroke = null;
    this.tool = 'pen'; // 'pen' | 'eraser'
    this.color = SKETCH_COLORS[0].hex;
    this.strokeWidth = 3;
    this.paperStyle = 'dot'; // 'plain' | 'dot' | 'ruled'
    this.canvas = null;
    this.ctx = null;
    this._drawing = false;
    this._mounted = false;
  }

  mount() {
    if (!this.hostEl) return;
    this.hostEl.innerHTML = `
      <div class="sketch-pad-shell">
        <div class="sketch-toolbar">
          <div class="sketch-swatches" role="group" aria-label="Ink Color">
            ${SKETCH_COLORS.map(
              (c, i) =>
                `<button type="button" class="sketch-swatch${i === 0 ? ' is-active' : ''}" data-sketch-color="${c.hex}" title="${c.label}" style="background:${c.hex};"></button>`
            ).join('')}
            <button type="button" class="btn btn-ghost btn-sm sketch-eraser-btn" title="Eraser">Eraser</button>
          </div>
          <div class="sketch-controls">
            <label class="field-inline">
              <span class="mono-meta">Nib</span>
              <input type="range" class="sketch-width-range" min="1" max="14" value="3" />
            </label>
            <select class="select-compact select-xs sketch-paper-select" title="Paper Texture">
              <option value="dot" selected>Dot Grid</option>
              <option value="ruled">Ruled Lines</option>
              <option value="plain">Warm Paper</option>
            </select>
            <button type="button" class="btn btn-ghost btn-sm sketch-undo-btn" title="Undo Last Stroke">↶ Undo</button>
            <button type="button" class="btn btn-ghost btn-sm sketch-clear-btn" title="Clear Canvas">Clear</button>
          </div>
        </div>
        <div class="sketch-canvas-frame">
          <canvas class="sketch-canvas" width="${this.canvasWidth}" height="${this.canvasHeight}"></canvas>
        </div>
      </div>
    `;

    this.canvas = this.hostEl.querySelector('.sketch-canvas');
    this.ctx = this.canvas.getContext('2d');
    this._mounted = true;

    this.hostEl.querySelectorAll('.sketch-swatch').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.tool = 'pen';
        this.color = btn.dataset.sketchColor;
        this.hostEl.querySelectorAll('.sketch-swatch').forEach((b) => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        this.hostEl.querySelector('.sketch-eraser-btn')?.classList.remove('is-active');
      });
    });

    const eraserBtn = this.hostEl.querySelector('.sketch-eraser-btn');
    eraserBtn?.addEventListener('click', () => {
      this.tool = 'eraser';
      this.hostEl.querySelectorAll('.sketch-swatch').forEach((b) => b.classList.remove('is-active'));
      eraserBtn.classList.add('is-active');
    });

    this.hostEl.querySelector('.sketch-width-range')?.addEventListener('input', (e) => {
      this.strokeWidth = Number(e.target.value) || 3;
    });

    this.hostEl.querySelector('.sketch-paper-select')?.addEventListener('change', (e) => {
      this.paperStyle = e.target.value;
      this.redraw();
    });

    this.hostEl.querySelector('.sketch-undo-btn')?.addEventListener('click', () => this.undo());
    this.hostEl.querySelector('.sketch-clear-btn')?.addEventListener('click', () => this.clear());

    this._bindCanvasPointerEvents();
    this.redraw();
  }

  _getCanvasPoint(ev) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / Math.max(1, rect.width);
    const scaleY = this.canvas.height / Math.max(1, rect.height);
    const pressure =
      ev.pointerType === 'pen' && Number.isFinite(ev.pressure) && ev.pressure > 0
        ? ev.pressure
        : 0.5;
    return {
      x: (ev.clientX - rect.left) * scaleX,
      y: (ev.clientY - rect.top) * scaleY,
      p: pressure,
    };
  }

  _bindCanvasPointerEvents() {
    if (!this.canvas) return;

    this.canvas.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      this.canvas.setPointerCapture(ev.pointerId);
      this._drawing = true;
      const pt = this._getCanvasPoint(ev);
      this.currentStroke = {
        tool: this.tool,
        color: this.tool === 'eraser' ? '#f7f4ec' : this.color,
        width: this.tool === 'eraser' ? Math.max(10, this.strokeWidth * 3) : this.strokeWidth,
        points: [pt],
      };
      this.strokes.push(this.currentStroke);
      this.redraw();
    });

    this.canvas.addEventListener('pointermove', (ev) => {
      if (!this._drawing || !this.currentStroke) return;
      ev.preventDefault();
      const pt = this._getCanvasPoint(ev);
      const pts = this.currentStroke.points;
      const prev = pts[pts.length - 1];
      const dist = Math.hypot(pt.x - prev.x, pt.y - prev.y);
      if (dist < 1.2) return;
      pts.push(pt);
      this._drawSegment(this.currentStroke, prev, pt);
    });

    const endStroke = () => {
      this._drawing = false;
      this.currentStroke = null;
    };

    this.canvas.addEventListener('pointerup', endStroke);
    this.canvas.addEventListener('pointercancel', endStroke);
  }

  _drawPaperBackground() {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.fillStyle = '#f7f4ec';
    ctx.fillRect(0, 0, w, h);

    if (this.paperStyle === 'dot') {
      ctx.fillStyle = 'rgba(110, 102, 88, 0.24)';
      for (let y = 24; y < h; y += 24) {
        for (let x = 24; x < w; x += 24) {
          ctx.beginPath();
          ctx.arc(x, y, 1.15, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    } else if (this.paperStyle === 'ruled') {
      ctx.strokeStyle = 'rgba(110, 102, 88, 0.16)';
      ctx.lineWidth = 1;
      for (let y = 32; y < h; y += 28) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
    }
  }

  _drawSegment(stroke, fromPt, toPt) {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = stroke.color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const pressureFactor = stroke.tool === 'eraser' ? 1 : 0.65 + (toPt.p || 0.5) * 0.85;
    ctx.lineWidth = Math.max(1, stroke.width * pressureFactor);
    ctx.beginPath();
    ctx.moveTo(fromPt.x, fromPt.y);
    ctx.lineTo(toPt.x, toPt.y);
    ctx.stroke();
    ctx.restore();
  }

  redraw() {
    if (!this.ctx || !this.canvas) return;
    this._drawPaperBackground();

    for (const stroke of this.strokes) {
      const pts = stroke.points;
      if (!pts || pts.length === 0) continue;
      if (pts.length === 1) {
        this.ctx.save();
        this.ctx.fillStyle = stroke.color;
        this.ctx.beginPath();
        this.ctx.arc(pts[0].x, pts[0].y, Math.max(1, stroke.width / 2), 0, Math.PI * 2);
        this.ctx.fill();
        this.ctx.restore();
        continue;
      }
      for (let i = 1; i < pts.length; i += 1) {
        this._drawSegment(stroke, pts[i - 1], pts[i]);
      }
    }
  }

  hasStrokes() {
    return this.strokes.length > 0;
  }

  undo() {
    if (this.strokes.length === 0) return;
    this.strokes.pop();
    this.redraw();
  }

  clear() {
    this.strokes = [];
    this.currentStroke = null;
    this.redraw();
  }

  /**
   * Exports the sketch canvas as a compact WebP (or PNG fallback) ready for entry attachment.
   */
  async exportWebp() {
    if (!this.canvas || !this.hasStrokes()) {
      throw new Error('Draw a sketch on the pad before attaching it.');
    }
    this.redraw();
    const mime = supportsWebpEncoding() ? 'image/webp' : 'image/png';
    const blob = await canvasToBlob(this.canvas, mime, 0.82);
    if (!blob) throw new Error('Could not export sketch image.');
    const arrayBuffer = await blob.arrayBuffer();
    const dataUrl = await blobToDataUrl(blob);
    return {
      blob,
      arrayBuffer,
      bytes: new Uint8Array(arrayBuffer),
      dataUrl,
      mime,
      ext: extFromMime(mime),
      size: arrayBuffer.byteLength,
      width: this.canvas.width,
      height: this.canvas.height,
      kind: 'sketch',
    };
  }

  destroy() {
    this.strokes = [];
    this.currentStroke = null;
    this._mounted = false;
    if (this.hostEl) this.hostEl.innerHTML = '';
  }
}

/* ============================================================================
   PHASE 18C: ENCRYPTED VOICE NOTES RECORDER (MEDIARECORDER API)
   ============================================================================ */

export function isAudioRecordingSupported() {
  return Boolean(
    typeof window !== 'undefined' &&
      window.isSecureContext &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function' &&
      typeof window.MediaRecorder !== 'undefined'
  );
}

function pickSupportedAudioMime() {
  if (typeof window.MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) {
    return { mime: 'audio/webm', ext: 'webm' };
  }
  const candidates = [
    { mime: 'audio/webm;codecs=opus', ext: 'webm' },
    { mime: 'audio/ogg;codecs=opus', ext: 'ogg' },
    { mime: 'audio/webm', ext: 'webm' },
    { mime: 'audio/mp4', ext: 'm4a' },
  ];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c.mime)) return c;
  }
  return { mime: '', ext: 'webm' };
}

/**
 * Self-contained Voice Note recorder with live duration ticker, Web Audio RMS level meter,
 * auto-stop safety ceiling (5 minutes), and clean microphone release.
 */
export class VoiceNoteRecorder {
  constructor({ onTick = null, onLevel = null, onAutoStop = null, maxSeconds = MAX_VOICE_DURATION_SEC } = {}) {
    this.onTick = onTick;
    this.onLevel = onLevel;
    this.onAutoStop = onAutoStop;
    this.maxSeconds = Number(maxSeconds) || MAX_VOICE_DURATION_SEC;

    this.stream = null;
    this.recorder = null;
    this.chunks = [];
    this.startedAt = 0;
    this.timerId = null;
    this.rafId = null;
    this.audioCtx = null;
    this.analyser = null;
    this.chosenFormat = { mime: 'audio/webm', ext: 'webm' };
    this._stopResolver = null;
  }

  isRecording() {
    return Boolean(this.recorder && this.recorder.state === 'recording');
  }

  async start() {
    if (!isAudioRecordingSupported()) {
      throw new Error('Voice recording requires HTTPS (or localhost) and microphone permission.');
    }
    if (this.isRecording()) return;

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    this.chosenFormat = pickSupportedAudioMime();
    const recOpts = { audioBitsPerSecond: 32000 }; // Crisp spoken voice at ~240 KB / minute
    if (this.chosenFormat.mime) recOpts.mimeType = this.chosenFormat.mime;

    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream, recOpts);
    this.recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) this.chunks.push(ev.data);
    };

    this.startedAt = Date.now();
    this.recorder.start(250);

    // Live elapsed timer
    this.timerId = window.setInterval(() => {
      const elapsedSec = Math.floor((Date.now() - this.startedAt) / 1000);
      if (typeof this.onTick === 'function') this.onTick(elapsedSec);
      if (elapsedSec >= this.maxSeconds && this.isRecording()) {
        this.stop().then((result) => {
          if (typeof this.onAutoStop === 'function') this.onAutoStop(result);
        });
      }
    }, 250);

    // Optional live microphone level meter via Web Audio API
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx && typeof this.onLevel === 'function') {
        this.audioCtx = new AudioCtx();
        const source = this.audioCtx.createMediaStreamSource(this.stream);
        this.analyser = this.audioCtx.createAnalyser();
        this.analyser.fftSize = 256;
        source.connect(this.analyser);
        const dataArr = new Uint8Array(this.analyser.frequencyBinCount);

        const pumpLevel = () => {
          if (!this.isRecording() || !this.analyser) return;
          this.analyser.getByteTimeDomainData(dataArr);
          let sumSq = 0;
          for (let i = 0; i < dataArr.length; i += 1) {
            const norm = (dataArr[i] - 128) / 128;
            sumSq += norm * norm;
          }
          const rms = Math.min(1, Math.sqrt(sumSq / dataArr.length) * 3.2);
          this.onLevel(rms);
          this.rafId = window.requestAnimationFrame(pumpLevel);
        };
        this.rafId = window.requestAnimationFrame(pumpLevel);
      }
    } catch {
      // Non-fatal if AudioContext is unavailable
    }
  }

  _releaseTracksAndTimers() {
    if (this.timerId) {
      window.clearInterval(this.timerId);
      this.timerId = null;
    }
    if (this.rafId) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.audioCtx) {
      this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
      this.analyser = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
  }

  async stop() {
    if (!this.recorder) return null;
    const elapsedSec = Math.max(1, Math.round((Date.now() - this.startedAt) / 1000));

    return new Promise((resolve) => {
      const finalize = async () => {
        this._releaseTracksAndTimers();
        const rawMime = this.recorder?.mimeType || this.chosenFormat.mime || 'audio/webm';
        const cleanMime = rawMime.split(';')[0] || 'audio/webm';
        const blob = new Blob(this.chunks, { type: cleanMime });
        const arrayBuffer = await blob.arrayBuffer();
        const previewUrl = URL.createObjectURL(blob);
        this.recorder = null;
        this.chunks = [];
        resolve({
          blob,
          arrayBuffer,
          bytes: new Uint8Array(arrayBuffer),
          previewUrl,
          mime: cleanMime,
          ext: this.chosenFormat.ext || extFromMime(cleanMime),
          durationSec: elapsedSec,
          size: arrayBuffer.byteLength,
        });
      };

      if (this.recorder.state === 'inactive') {
        finalize();
        return;
      }
      this.recorder.onstop = finalize;
      this.recorder.stop();
    });
  }

  cancel() {
    try {
      if (this.recorder && this.recorder.state !== 'inactive') {
        this.recorder.onstop = null;
        this.recorder.stop();
      }
    } catch {
      // ignore
    }
    this._releaseTracksAndTimers();
    this.recorder = null;
    this.chunks = [];
  }
}

/* ============================================================================
   INTERACTIVE HOLD-AND-DRAG ALIGNMENT STUDIO (MOUSE & TOUCH POINTER EVENTS)
   ============================================================================ */

export class AlignmentStudio {
  constructor(hostEl, { onChange = null } = {}) {
    this.hostEl = hostEl;
    this.onChange = onChange;
    this.layout = { align: 'full', posX: 50, posY: 50, width: 100, height: 220 };
    this.src = '';
    this.metaNote = '';
  }

  setMedia(src, layout = {}, metaNote = '') {
    this.src = src || '';
    this.metaNote = metaNote || '';
    this.layout = {
      align: VALID_ALIGNS.has(layout.align) ? layout.align : 'full',
      posX: Math.round(clamp(layout.posX ?? 50, 0, 100)),
      posY: Math.round(clamp(layout.posY ?? 50, 0, 100)),
      width: Math.round(clamp(layout.width ?? 100, 30, 100)),
      height: Math.round(clamp(layout.height ?? 220, 110, 420)),
    };
    this.render();
  }

  setImage(meta, previewUrl) {
    if (!meta) {
      this.clear();
      return;
    }
    this.setMedia(previewUrl || meta.src, meta);
  }

  getMeta() {
    return this.src ? { src: this.src, ...this.layout } : null;
  }

  clear() {
    this.src = '';
    this.metaNote = '';
    if (this.hostEl) {
      this.hostEl.innerHTML = '';
      this.hostEl.hidden = true;
    }
  }

  emitChange() {
    if (typeof this.onChange === 'function') {
      this.onChange({ ...this.layout });
    }
  }

  render() {
    if (!this.hostEl) return;
    if (!this.src) {
      this.clear();
      return;
    }

    this.hostEl.hidden = false;
    this.hostEl.innerHTML = `
      <div class="align-studio">
        <div class="align-studio-top">
          <div class="align-preset-group" role="group" aria-label="Layout Preset">
            <button type="button" class="btn btn-ghost btn-sm align-preset-btn" data-align="left">Left Wrap</button>
            <button type="button" class="btn btn-ghost btn-sm align-preset-btn" data-align="center">Center</button>
            <button type="button" class="btn btn-ghost btn-sm align-preset-btn" data-align="right">Right Wrap</button>
            <button type="button" class="btn btn-ghost btn-sm align-preset-btn" data-align="full">Full Width</button>
          </div>
          <div class="align-hud-group">
            ${this.metaNote ? `<span class="media-stats-pill">${escapeHtml(this.metaNote)}</span>` : ''}
            <span class="mono-meta align-hud-readout">PAN: ${Math.round(this.layout.posX)}% × ${Math.round(this.layout.posY)}%</span>
            <button type="button" class="btn btn-ghost btn-sm align-reset-btn">Reset Focus</button>
          </div>
        </div>

        <div class="align-canvas">
          <div class="snap-zones-overlay" hidden>
            <div class="snap-zone" data-zone="left">LEFT WRAP</div>
            <div class="snap-zone" data-zone="center">CENTER</div>
            <div class="snap-zone" data-zone="right">RIGHT WRAP</div>
            <div class="snap-zone" data-zone="full">FULL WIDTH</div>
          </div>

          <div class="align-preview-box">
            <div class="align-drag-bar" title="Hold & drag to snap layout (Left / Center / Right / Full)">
              <span>⋮⋮ DRAG TO SNAP LAYOUT</span>
            </div>
            <div class="align-img-viewport" title="Hold & drag inside photo to pan focal point">
              <img src="${escapeHtml(this.src)}" alt="Alignment preview" draggable="false" />
              <div class="align-resize-grip" title="Hold & drag corner to resize">↘</div>
            </div>
          </div>

          <p class="align-dummy-prose">
            Hold the amber bar above to snap between Left Wrap, Center, Right Wrap, and Full Width. Hold directly inside the image to pan the focal crop, or drag the bottom-right corner grip to adjust width and frame height.
          </p>
        </div>
      </div>
    `;

    const studioEl = this.hostEl.querySelector('.align-studio');
    const canvasEl = studioEl.querySelector('.align-canvas');
    const overlayEl = studioEl.querySelector('.snap-zones-overlay');
    const previewBox = studioEl.querySelector('.align-preview-box');
    const dragBar = studioEl.querySelector('.align-drag-bar');
    const viewportEl = studioEl.querySelector('.align-img-viewport');
    const imgEl = viewportEl.querySelector('img');
    const resizeGrip = studioEl.querySelector('.align-resize-grip');
    const hudEl = studioEl.querySelector('.align-hud-readout');

    const applyVisuals = () => {
      previewBox.className = `align-preview-box align-${this.layout.align}`;
      previewBox.style.width =
        this.layout.align === 'full' ? '100%' : `${clamp(this.layout.width, 30, 100)}%`;
      viewportEl.style.height = `${clamp(this.layout.height, 110, 420)}px`;
      imgEl.style.objectPosition = `${this.layout.posX}% ${this.layout.posY}%`;
      hudEl.textContent = `PAN: ${Math.round(this.layout.posX)}% × ${Math.round(
        this.layout.posY
      )}% · W:${Math.round(this.layout.width)}% H:${Math.round(this.layout.height)}px`;

      studioEl.querySelectorAll('.align-preset-btn').forEach((b) => {
        b.classList.toggle('is-active', b.dataset.align === this.layout.align);
      });
    };

    applyVisuals();

    studioEl.querySelectorAll('.align-preset-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.layout.align = btn.dataset.align;
        if (this.layout.align === 'full') this.layout.width = 100;
        else if (this.layout.width > 75) this.layout.width = 52;
        applyVisuals();
        this.emitChange();
      });
    });

    studioEl.querySelector('.align-reset-btn').addEventListener('click', () => {
      this.layout.posX = 50;
      this.layout.posY = 50;
      applyVisuals();
      this.emitChange();
    });

    // 1. Hold-and-Drag Snap Zones via Amber Bar
    dragBar.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      dragBar.setPointerCapture(ev.pointerId);
      overlayEl.hidden = false;
      let hoveredZone = this.layout.align;

      const onMove = (moveEv) => {
        const rect = canvasEl.getBoundingClientRect();
        const relX = (moveEv.clientX - rect.left) / Math.max(1, rect.width);
        const relY = (moveEv.clientY - rect.top) / Math.max(1, rect.height);
        if (relY > 0.72) hoveredZone = 'full';
        else if (relX < 0.33) hoveredZone = 'left';
        else if (relX > 0.66) hoveredZone = 'right';
        else hoveredZone = 'center';

        overlayEl.querySelectorAll('.snap-zone').forEach((z) => {
          z.classList.toggle('is-hovered', z.dataset.zone === hoveredZone);
        });
      };

      const onUp = () => {
        overlayEl.hidden = true;
        this.layout.align = hoveredZone;
        if (hoveredZone === 'full') this.layout.width = 100;
        else if (this.layout.width > 75) this.layout.width = 52;
        applyVisuals();
        this.emitChange();
        dragBar.removeEventListener('pointermove', onMove);
        dragBar.removeEventListener('pointerup', onUp);
        dragBar.removeEventListener('pointercancel', onUp);
      };

      dragBar.addEventListener('pointermove', onMove);
      dragBar.addEventListener('pointerup', onUp);
      dragBar.addEventListener('pointercancel', onUp);
    });

    // 2. Hold-and-Drag Focal Point Panning
    viewportEl.addEventListener('pointerdown', (ev) => {
      if (ev.target === resizeGrip) return;
      ev.preventDefault();
      viewportEl.setPointerCapture(ev.pointerId);
      const startX = ev.clientX;
      const startY = ev.clientY;
      const origPosX = this.layout.posX;
      const origPosY = this.layout.posY;
      const boxRect = viewportEl.getBoundingClientRect();

      const onMove = (moveEv) => {
        const dxPct = ((moveEv.clientX - startX) / Math.max(40, boxRect.width)) * 100;
        const dyPct = ((moveEv.clientY - startY) / Math.max(40, boxRect.height)) * 100;
        this.layout.posX = Math.round(clamp(origPosX - dxPct, 0, 100));
        this.layout.posY = Math.round(clamp(origPosY - dyPct, 0, 100));
        applyVisuals();
      };

      const onUp = () => {
        this.emitChange();
        viewportEl.removeEventListener('pointermove', onMove);
        viewportEl.removeEventListener('pointerup', onUp);
        viewportEl.removeEventListener('pointercancel', onUp);
      };

      viewportEl.addEventListener('pointermove', onMove);
      viewportEl.addEventListener('pointerup', onUp);
      viewportEl.addEventListener('pointercancel', onUp);
    });

    // 3. Hold-and-Drag Bottom-Right Corner Resize
    resizeGrip.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      resizeGrip.setPointerCapture(ev.pointerId);
      const startX = ev.clientX;
      const startY = ev.clientY;
      const origW = this.layout.width;
      const origH = this.layout.height;
      const canvasWidth = Math.max(200, canvasEl.getBoundingClientRect().width);

      const onMove = (moveEv) => {
        const deltaWPct = ((moveEv.clientX - startX) / canvasWidth) * 100;
        const deltaHPx = moveEv.clientY - startY;
        this.layout.width = Math.round(clamp(origW + deltaWPct, 30, 100));
        this.layout.height = Math.round(clamp(origH + deltaHPx, 110, 420));
        applyVisuals();
      };

      const onUp = () => {
        this.emitChange();
        resizeGrip.removeEventListener('pointermove', onMove);
        resizeGrip.removeEventListener('pointerup', onUp);
        resizeGrip.removeEventListener('pointercancel', onUp);
      };

      resizeGrip.addEventListener('pointermove', onMove);
      resizeGrip.addEventListener('pointerup', onUp);
      resizeGrip.addEventListener('pointercancel', onUp);
    });
  }
}

/**
 * On-Page Live Photo Re-Alignment Controller for rendered entry/comment figures.
 */
export function attachInlineAlignController(figureEl, currentLayout, onSaveOrCallbacks) {
  if (!figureEl) return () => {};
  const frameEl =
    figureEl.querySelector('.entry-figure-frame') || figureEl.querySelector('.diary-figure-viewport');
  const imgEl = figureEl.querySelector('img');
  if (!frameEl || !imgEl) return () => {};

  const onSave =
    typeof onSaveOrCallbacks === 'function' ? onSaveOrCallbacks : onSaveOrCallbacks?.onSave;

  const draft = {
    align: VALID_ALIGNS.has(currentLayout.align) ? currentLayout.align : 'full',
    posX: Math.round(clamp(currentLayout.posX ?? 50, 0, 100)),
    posY: Math.round(clamp(currentLayout.posY ?? 50, 0, 100)),
    width: Math.round(clamp(currentLayout.width ?? 100, 30, 100)),
    height: Math.round(clamp(currentLayout.height ?? 240, 110, 420)),
  };

  figureEl.classList.add('is-inline-aligning');
  const bar = document.createElement('div');
  bar.className = 'inline-align-bar';
  bar.innerHTML = `
    <div class="inline-align-btns">
      <button type="button" class="btn btn-ghost btn-sm" data-al="left">L</button>
      <button type="button" class="btn btn-ghost btn-sm" data-al="center">C</button>
      <button type="button" class="btn btn-ghost btn-sm" data-al="right">R</button>
      <button type="button" class="btn btn-ghost btn-sm" data-al="full">Full</button>
    </div>
    <span class="mono-meta inline-pan-hud">PAN ${draft.posX}%×${draft.posY}%</span>
    <div class="inline-align-btns">
      <button type="button" class="btn btn-primary btn-sm inline-save-btn">Save</button>
      <button type="button" class="btn btn-ghost btn-sm inline-cancel-btn">Cancel</button>
    </div>
  `;
  figureEl.prepend(bar);

  const hud = bar.querySelector('.inline-pan-hud');
  const apply = () => {
    figureEl.className = `entry-figure is-inline-aligning align-${draft.align}`;
    figureEl.style.width = draft.align === 'full' ? '100%' : `${draft.width}%`;
    frameEl.style.height = `${draft.height}px`;
    imgEl.style.objectPosition = `${draft.posX}% ${draft.posY}%`;
    hud.textContent = `PAN ${Math.round(draft.posX)}%×${Math.round(draft.posY)}%`;
  };
  apply();

  bar.querySelectorAll('[data-al]').forEach((btn) => {
    btn.addEventListener('click', () => {
      draft.align = btn.dataset.al;
      if (draft.align === 'full') draft.width = 100;
      else if (draft.width > 75) draft.width = 52;
      apply();
    });
  });

  const onPointerDown = (ev) => {
    ev.preventDefault();
    frameEl.setPointerCapture(ev.pointerId);
    const sx = ev.clientX;
    const sy = ev.clientY;
    const ox = draft.posX;
    const oy = draft.posY;
    const r = frameEl.getBoundingClientRect();

    const onMove = (m) => {
      draft.posX = Math.round(clamp(ox - ((m.clientX - sx) / Math.max(40, r.width)) * 100, 0, 100));
      draft.posY = Math.round(clamp(oy - ((m.clientY - sy) / Math.max(40, r.height)) * 100, 0, 100));
      apply();
    };
    const onUp = () => {
      frameEl.removeEventListener('pointermove', onMove);
      frameEl.removeEventListener('pointerup', onUp);
    };
    frameEl.addEventListener('pointermove', onMove);
    frameEl.addEventListener('pointerup', onUp);
  };

  frameEl.addEventListener('pointerdown', onPointerDown);

  const cleanup = () => {
    frameEl.removeEventListener('pointerdown', onPointerDown);
    figureEl.classList.remove('is-inline-aligning');
    bar.remove();
  };

  bar.querySelector('.inline-cancel-btn').addEventListener('click', () => {
    cleanup();
    figureEl.className = `entry-figure align-${currentLayout.align || 'full'}`;
    figureEl.style.width = `${currentLayout.width ?? 100}%`;
    imgEl.style.objectPosition = `${currentLayout.posX ?? 50}% ${currentLayout.posY ?? 50}%`;
  });

  bar.querySelector('.inline-save-btn').addEventListener('click', async () => {
    cleanup();
    if (typeof onSave === 'function') {
      await onSave({ ...draft });
    }
  });

  return cleanup;
}
