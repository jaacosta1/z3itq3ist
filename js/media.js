/**
 * js/media.js — Browser-Side WebP Compression, Split-Repo Loader, Encrypted Media Vault (.enc),
 * RAM Blob URL Registry, IndexedDB Store, and Interactive Hold-and-Drag Alignment Studio.
 */

import {
  base64ToBytes,
  encryptBinary,
  decryptBinary,
  buildMediaAad,
  isEncryptedMediaPath,
} from './crypto.js';

export const WEBP_PRESETS = Object.freeze({
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

const ALLOWED_MIMES = new Set(ALLOWED_IMAGE_TYPES);
const VALID_ALIGNS = new Set(['left', 'center', 'right', 'full']);
const PRESET_STORAGE_KEY = 'perpetual_diary_webp_preset_v1';

// In-memory registry of decrypted/fetched Blob URLs — wiped cleanly on Lock / Panic Lock / Unload
const managedBlobUrlCache = new Map();

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

function clamp(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

export function normalizeImageMeta(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const src = typeof raw.src === 'string' ? raw.src.trim() : '';
  if (!src) return null;
  const align = VALID_ALIGNS.has(raw.align) ? raw.align : DEFAULT_IMAGE_META.align;
  return {
    src,
    caption: typeof raw.caption === 'string' ? raw.caption : '',
    align,
    posX: Math.round(clamp(raw.posX ?? DEFAULT_IMAGE_META.posX, 0, 100)),
    posY: Math.round(clamp(raw.posY ?? DEFAULT_IMAGE_META.posY, 0, 100)),
    width: Math.round(clamp(raw.width ?? DEFAULT_IMAGE_META.width, 30, 100)),
    height: Math.round(clamp(raw.height ?? DEFAULT_IMAGE_META.height, 110, 420)),
    encrypted: Boolean(raw.encrypted || isEncryptedMediaPath(src)),
  };
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
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/gif') return 'gif';
  return 'jpg';
}

function mimeFromPath(pathStr) {
  const clean = String(pathStr || '').split('?')[0].toLowerCase();
  if (clean.endsWith('.webp')) return 'image/webp';
  if (clean.endsWith('.png')) return 'image/png';
  if (clean.endsWith('.gif')) return 'image/gif';
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
    reader.onerror = () => reject(new Error('Could not read image preview.'));
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
 * Preserves animated GIFs untouched so animation frames are never lost.
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
 * Prepares a compressed image buffer for either plaintext or AES-256-GCM .enc storage.
 */
export async function prepareMediaPayloadForStorage({
  buffer,
  mime = 'image/webp',
  ext = 'webp',
  datePrefix = '2026-11-24',
  encrypt = false,
  keyring = null,
}) {
  const stamp = `${datePrefix}-${Date.now()}`;
  if (encrypt) {
    if (!keyring?.dek && !keyring?.legacyKey) {
      throw new Error('Unlock your Vault first to encrypt photos (.enc).');
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
  const outBuf = buffer instanceof Uint8Array ? buffer.buffer : buffer;
  return {
    mediaSubpath,
    uploadBuffer: outBuf,
    uploadMime: mime,
    encrypted: false,
  };
}

/**
 * IndexedDB binary store for Sandbox Mode (supports both raw ArrayBuffer and Blob records).
 */
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

/**
 * Fetches raw binary bytes from IndexedDB, Split-Repo/Vault GitHub API (with >1 MB Git Blobs fallback),
 * or static hosted path.
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
 * Resolves a media path (plaintext or encrypted .enc) into a managed RAM blob: URL
 * and returns a structured status so locked/tampered photos display clean states.
 */
export async function resolveMediaAsset(
  src,
  ghClient,
  mediaStore = null,
  keyring = null,
  ramMap = null
) {
  if (!src) return { status: 'empty', url: '', encrypted: false };
  const isEnc = isEncryptedMediaPath(src);

  if (src.startsWith('data:image/') || src.startsWith('blob:')) {
    return { status: 'ok', url: src, encrypted: false };
  }

  if (src.startsWith('ram:')) {
    if (!isEnc) {
      const url = ramMap?.get(src) || '';
      return { status: url ? 'ok' : 'error', url, encrypted: false };
    }
    if (!keyring?.dek && !keyring?.legacyKey) {
      return { status: 'locked', url: '', encrypted: true };
    }
    const cacheKey = `${src}::${keyring.dekFingerprint || 'key'}`;
    if (managedBlobUrlCache.has(cacheKey)) {
      return { status: 'ok', url: managedBlobUrlCache.get(cacheKey), encrypted: true };
    }
    const rawEncBytes = ramMap?.get(src);
    if (!rawEncBytes) return { status: 'error', url: '', encrypted: true };
    try {
      const decrypted = await decryptBinary(rawEncBytes, keyring, {
        aad: buildMediaAad(src.slice(4)),
      });
      const blobUrl = URL.createObjectURL(new Blob([decrypted.bytes], { type: decrypted.mime }));
      managedBlobUrlCache.set(cacheKey, blobUrl);
      return { status: 'ok', url: blobUrl, encrypted: true };
    } catch (err) {
      return {
        status: err?.code === 'AAD_TAMPER_ERROR' ? 'tampered' : 'error',
        url: '',
        encrypted: true,
        error: err.message,
      };
    }
  }

  if (/^https:\/\//i.test(src) && !isEnc) {
    return { status: 'ok', url: src, encrypted: false };
  }

  if (isEnc && !keyring?.dek && !keyring?.legacyKey) {
    return { status: 'locked', url: '', encrypted: true };
  }

  const cacheKey = isEnc ? `${src}::${keyring?.dekFingerprint || 'key'}` : src;
  if (managedBlobUrlCache.has(cacheKey)) {
    return { status: 'ok', url: managedBlobUrlCache.get(cacheKey), encrypted: isEnc };
  }

  try {
    const hasToken = Boolean(
      ghClient && typeof ghClient.hasToken === 'function' && ghClient.hasToken()
    );
    if (!isEnc && !src.startsWith('idb:') && !src.startsWith('idb://') && !hasToken) {
      const cleanRel = String(src).replace(/^\.\/+/, '').replace(/^\/+/, '');
      return { status: 'ok', url: `./${cleanRel}?t=${Date.now()}`, encrypted: false };
    }

    const fetched = await fetchRawMediaBytes(src, ghClient, mediaStore);
    if (!fetched || !fetched.bytes) {
      return { status: 'error', url: '', encrypted: isEnc };
    }

    if (isEnc) {
      const decrypted = await decryptBinary(fetched.bytes, keyring, {
        aad: buildMediaAad(fetched.subpath),
      });
      const blobUrl = URL.createObjectURL(new Blob([decrypted.bytes], { type: decrypted.mime }));
      managedBlobUrlCache.set(cacheKey, blobUrl);
      return { status: 'ok', url: blobUrl, encrypted: true };
    }

    const blobUrl = URL.createObjectURL(new Blob([fetched.bytes], { type: fetched.mime }));
    managedBlobUrlCache.set(cacheKey, blobUrl);
    return { status: 'ok', url: blobUrl, encrypted: false };
  } catch (err) {
    return {
      status: err?.code === 'AAD_TAMPER_ERROR' ? 'tampered' : 'error',
      url: '',
      encrypted: isEnc,
      error: err.message,
    };
  }
}

export async function resolveMediaSrc(src, ghOrContext = null, mediaStore = null, keyring = null, ramMap = null) {
  if (ghOrContext && (ghOrContext.localStore !== undefined || ghOrContext.githubClient !== undefined)) {
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

/**
 * Interactive Hold-and-Drag Alignment Studio (Pointer Events: Mouse & Touch).
 */
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
            ${this.metaNote ? `<span class="media-stats-pill">${this.metaNote}</span>` : ''}
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
              <img src="${this.src}" alt="Alignment preview" draggable="false" />
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
