/**
 * Perpetual Side-by-Side Web Diary — Media Engine & Hold-and-Drag Alignment Studio
 * Handles IndexedDB binary storage for Local Sandbox Mode, safe image validation &
 * client-side compression, static/GitHub/IndexedDB URL resolution, the interactive
 * Pointer Events Alignment Studio (snap zones, focal panning, corner resizing),
 * and on-page live photo re-alignment.
 */

import { sanitizeUrl } from './markdown.js';

export const DEFAULT_IMAGE_META = Object.freeze({
  src: '',
  caption: '',
  align: 'left',
  posX: 50,
  posY: 50,
  width: 52,
  height: 220,
});

export const ALLOWED_IMAGE_TYPES = Object.freeze([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4 MB

const VALID_ALIGNS = new Set(['left', 'center', 'right', 'full']);
const IDB_NAME = 'perpetual_diary_media_v1';
const IDB_STORE = 'blobs';
const IDB_VERSION = 1;

const MIME_TO_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const SAMPLE_STUDIO_PROSE = [
  'The morning light shifted across the desk while the kettle finished boiling. Holding and dragging the amber bar above lets you snap this photograph into Left Wrap, Center, Right Wrap, or Full Width.',
  'Hold and drag directly inside the photo viewport to pan the focal point, or drag the bottom-right amber corner grip to adjust width and frame height smoothly.',
];

// Session cache for media fetched directly via the GitHub API
const githubMediaUrlCache = new Map();

/**
 * Clamps a numeric value between min and max.
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return min;
  return Math.min(max, Math.max(min, num));
}

/**
 * Normalizes and validates an image metadata object against the schema.
 * Returns null if no valid image src is present.
 * @param {any} raw
 * @returns {{ src: string, caption: string, align: 'left'|'center'|'right'|'full', posX: number, posY: number, width: number, height: number } | null}
 */
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
  };
}

/**
 * Builds a deterministic, Neocities-safe relative path for an uploaded photo.
 * Example: data/media/2026-11-24-1732460000123.jpg
 * @param {string} diaryDate - YYYY-MM-DD
 * @param {string} ext
 * @returns {string}
 */
export function buildMediaFilename(diaryDate, ext) {
  const safeDate = /^\d{4}-\d{2}-\d{2}$/.test(String(diaryDate || ''))
    ? diaryDate
    : new Date().toISOString().slice(0, 10);

  const cleanExt = String(ext || 'jpg')
    .toLowerCase()
    .replace(/^\.+/, '')
    .replace(/[^a-z0-9]/g, '');

  const allowedExt = ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(cleanExt)
    ? cleanExt === 'jpeg'
      ? 'jpg'
      : cleanExt
    : 'jpg';

  return `data/media/${safeDate}-${Date.now()}.${allowedExt}`;
}

/**
 * IndexedDB binary store for uploaded images in Local Sandbox Mode
 * (and instant local preview caching before GitHub/Neocities deploy completes).
 */
export class LocalMediaStore {
  constructor() {
    /** @type {Promise<IDBDatabase> | null} */
    this._dbPromise = null;
    /** @type {Map<string, string>} */
    this._urlCache = new Map();
  }

  /**
   * Opens (or creates) the IndexedDB media database.
   * @returns {Promise<IDBDatabase>}
   */
  open() {
    if (this._dbPromise) return this._dbPromise;

    this._dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB is unavailable in this browser context.'));
        return;
      }

      const request = indexedDB.open(IDB_NAME, IDB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE, { keyPath: 'key' });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        this._dbPromise = null;
        reject(request.error || new Error('Failed to open local media store.'));
      };
    });

    return this._dbPromise;
  }

  /**
   * Saves a Blob under a unique key (e.g. "idb://data/media/..." or "data/media/...").
   * @param {string} key
   * @param {Blob} blob
   * @returns {Promise<string>}
   */
  async saveBlob(key, blob) {
    const db = await this.open();
    const cleanKey = String(key);

    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      store.put({
        key: cleanKey,
        blob,
        updatedAt: Date.now(),
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Failed to save media blob.'));
    });

    if (this._urlCache.has(cleanKey)) {
      URL.revokeObjectURL(this._urlCache.get(cleanKey));
      this._urlCache.delete(cleanKey);
    }

    return cleanKey;
  }

  /**
   * Retrieves a stored Blob by key.
   * @param {string} key
   * @returns {Promise<Blob | null>}
   */
  async getBlob(key) {
    const db = await this.open();
    const cleanKey = String(key);

    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const store = tx.objectStore(IDB_STORE);
      const req = store.get(cleanKey);

      req.onsuccess = () => {
        resolve(req.result ? req.result.blob : null);
      };
      req.onerror = () => reject(req.error || new Error('Failed to read media blob.'));
    });
  }

  /**
   * Deletes a stored Blob and revokes any cached object URL.
   * @param {string} key
   * @returns {Promise<boolean>}
   */
  async deleteBlob(key) {
    const db = await this.open();
    const cleanKey = String(key);

    if (this._urlCache.has(cleanKey)) {
      URL.revokeObjectURL(this._urlCache.get(cleanKey));
      this._urlCache.delete(cleanKey);
    }

    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      store.delete(cleanKey);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Failed to delete media blob.'));
    });

    return true;
  }

  /**
   * Returns a cached or newly created blob: object URL for the stored key.
   * @param {string} key
   * @returns {Promise<string | null>}
   */
  async getObjectUrl(key) {
    const cleanKey = String(key);
    if (this._urlCache.has(cleanKey)) {
      return this._urlCache.get(cleanKey);
    }

    const blob = await this.getBlob(cleanKey);
    if (!blob) return null;

    const url = URL.createObjectURL(blob);
    this._urlCache.set(cleanKey, url);
    return url;
  }

  /**
   * Clears all locally stored sandbox images and revokes cached object URLs.
   * @returns {Promise<void>}
   */
  async clearAll() {
    for (const url of this._urlCache.values()) {
      URL.revokeObjectURL(url);
    }
    this._urlCache.clear();

    const db = await this.open();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Failed to clear local media store.'));
    });
  }
}

/**
 * Loads a Blob/File into an HTMLImageElement to read its natural dimensions.
 * @param {Blob} blob
 * @returns {Promise<HTMLImageElement>}
 */
function loadImageElement(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not decode image file. Make sure it is a valid PNG, JPG, WebP, or GIF.'));
    };
    img.src = url;
  });
}

/**
 * Encodes an HTMLCanvasElement into a Blob of the requested MIME type and quality.
 * @param {HTMLCanvasElement} canvas
 * @param {string} mimeType
 * @param {number} quality
 * @returns {Promise<Blob>}
 */
function canvasToBlob(canvas, mimeType, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error('Browser failed to encode compressed image.'));
        }
      },
      mimeType,
      quality
    );
  });
}

/**
 * Validates and optionally downscales/compresses an uploaded image file so GitHub
 * commits remain fast and lightweight. Preserves animated GIFs untouched.
 * @param {File} file
 * @param {{ maxDimension?: number, quality?: number, maxBytes?: number, compress?: boolean }} [options]
 * @returns {Promise<{ blob: Blob, arrayBuffer: ArrayBuffer, ext: string, mimeType: string, width: number, height: number, size: number }>}
 */
export async function processImageFile(file, options = {}) {
  if (!file || !(file instanceof Blob)) {
    throw new Error('No image file provided.');
  }

  const mimeType = file.type;
  if (!ALLOWED_IMAGE_TYPES.includes(mimeType)) {
    throw new Error('Unsupported image type. Please upload a JPG, PNG, WebP, or GIF image.');
  }

  const maxDimension = Number(options.maxDimension) || 1800;
  const quality = Number(options.quality) || 0.86;
  const maxBytes = Number(options.maxBytes) || MAX_IMAGE_BYTES;
  const shouldCompress = options.compress !== false;

  const img = await loadImageElement(file);
  const naturalW = img.naturalWidth || 0;
  const naturalH = img.naturalHeight || 0;

  // Preserve animated GIFs directly without canvas re-encoding
  if (mimeType === 'image/gif') {
    if (file.size > maxBytes) {
      throw new Error(
        `GIF file is too large (${(file.size / (1024 * 1024)).toFixed(2)} MB). Maximum allowed size is ${(
          maxBytes /
          (1024 * 1024)
        ).toFixed(0)} MB.`
      );
    }
    const arrayBuffer = await file.arrayBuffer();
    return {
      blob: file,
      arrayBuffer,
      ext: 'gif',
      mimeType: 'image/gif',
      width: naturalW,
      height: naturalH,
      size: file.size,
    };
  }

  const needsResize = naturalW > maxDimension || naturalH > maxDimension;
  const needsSizeShrink = file.size > Math.min(maxBytes, 1.4 * 1024 * 1024);

  if (!shouldCompress || (!needsResize && !needsSizeShrink)) {
    if (file.size > maxBytes) {
      throw new Error(
        `Image exceeds maximum size of ${(maxBytes / (1024 * 1024)).toFixed(0)} MB.`
      );
    }
    const arrayBuffer = await file.arrayBuffer();
    return {
      blob: file,
      arrayBuffer,
      ext: MIME_TO_EXT[mimeType] || 'jpg',
      mimeType,
      width: naturalW,
      height: naturalH,
      size: file.size,
    };
  }

  // Proportional downscale
  const scale = Math.min(1, maxDimension / Math.max(naturalW || 1, naturalH || 1));
  const targetW = Math.max(1, Math.round(naturalW * scale));
  const targetH = Math.max(1, Math.round(naturalH * scale));

  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Unable to acquire 2D canvas context for image processing.');
  }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, targetW, targetH);

  // Use WebP/JPEG when shrinking large PNGs, otherwise retain original format
  let outputMime = mimeType;
  if (mimeType === 'image/png' && file.size > 1.5 * 1024 * 1024) {
    outputMime = 'image/webp';
  }

  let outBlob = await canvasToBlob(canvas, outputMime, quality);

  // Fallback to JPEG if browser does not support WebP encoding
  if (outputMime === 'image/webp' && outBlob.type !== 'image/webp') {
    outputMime = 'image/jpeg';
    outBlob = await canvasToBlob(canvas, outputMime, quality);
  }

  // Second compression pass if still above maxBytes
  if (outBlob.size > maxBytes) {
    outputMime = 'image/jpeg';
    outBlob = await canvasToBlob(canvas, outputMime, 0.72);
  }

  if (outBlob.size > maxBytes) {
    throw new Error(
      `Image is still too large after compression (${(outBlob.size / (1024 * 1024)).toFixed(2)} MB). Please choose a smaller image.`
    );
  }

  // If compressed result is somehow larger than original and original already fits bounds, keep original
  if (!needsResize && outBlob.size >= file.size && file.size <= maxBytes) {
    const arrayBuffer = await file.arrayBuffer();
    return {
      blob: file,
      arrayBuffer,
      ext: MIME_TO_EXT[mimeType] || 'jpg',
      mimeType,
      width: naturalW,
      height: naturalH,
      size: file.size,
    };
  }

  const finalMime = outBlob.type || outputMime;
  const arrayBuffer = await outBlob.arrayBuffer();

  return {
    blob: outBlob,
    arrayBuffer,
    ext: MIME_TO_EXT[finalMime] || 'jpg',
    mimeType: finalMime,
    width: targetW,
    height: targetH,
    size: outBlob.size,
  };
}

/**
 * Resolves a stored media src into a browser-renderable URL across:
 * 1. Local IndexedDB sandbox blobs ("idb://...")
 * 2. Safe external https:// URLs
 * 3. Direct GitHub API blobs (when authenticated, so uploads render immediately before Neocities deploy finishes)
 * 4. Static relative Neocities paths ("./data/media/...")
 * @param {string} src
 * @param {{ localStore?: LocalMediaStore | null, githubClient?: any }} [context]
 * @returns {Promise<string>}
 */
export async function resolveMediaSrc(src, context = {}) {
  if (typeof src !== 'string') return '';
  const trimmed = src.trim();
  if (!trimmed) return '';

  const { localStore = null, githubClient = null } = context;

  // Already a live browser blob or inline data image
  if (trimmed.startsWith('blob:') || trimmed.startsWith('data:image/')) {
    return trimmed;
  }

  // IndexedDB sandbox image
  if (trimmed.startsWith('idb://')) {
    if (!localStore) return '';
    try {
      const objUrl = await localStore.getObjectUrl(trimmed);
      return objUrl || '';
    } catch {
      return '';
    }
  }

  // External HTTP/HTTPS URL
  if (/^https?:\/\//i.test(trimmed)) {
    return sanitizeUrl(trimmed) || '';
  }

  // Relative repository media path (e.g., data/media/2026-11-24-12345.jpg)
  const cleanPath = trimmed.replace(/^\.\/+/, '').replace(/^\/+/, '');
  if (!cleanPath || cleanPath.includes('..')) return '';

  // Check IndexedDB cache first (gives instant zero-latency preview right after upload)
  if (localStore) {
    try {
      const cachedLocal = await localStore.getObjectUrl(cleanPath);
      if (cachedLocal) return cachedLocal;
    } catch {
      // Ignore local store miss and proceed
    }
  }

  // In Live Authenticated Mode, read newly committed photos directly from GitHub API
  if (githubClient && typeof githubClient.canWrite === 'function' && githubClient.canWrite() && githubClient.readFromApi) {
    const cacheKey = `${githubClient.owner}/${githubClient.repo}@${githubClient.branch}:${cleanPath}`;
    if (githubMediaUrlCache.has(cacheKey)) {
      return githubMediaUrlCache.get(cacheKey);
    }
    try {
      const blobUrl = await githubClient.fetchRawMediaBlobUrl(cleanPath);
      githubMediaUrlCache.set(cacheKey, blobUrl);
      return blobUrl;
    } catch {
      // Fall back to static Neocities path
    }
  }

  return `./${cleanPath}`;
}

/**
 * Interactive Hold-and-Drag Alignment Studio mounted inside the Entry Composer
 * and Comment Composer. Supports:
 * - Dragging the amber handle bar to snap into Left Wrap, Center, Right Wrap, or Full Width
 * - Holding and dragging inside the viewport to pan focal point (object-position)
 * - Holding and dragging the bottom-right corner grip to resize width % and height px
 * - Quick preset buttons, Reset Focus, and optional caption editing
 */
export class AlignmentStudio {
  /**
   * @param {HTMLElement} mountEl
   * @param {{ onChange?: (meta: Object | null) => void, sampleText?: string }} [options]
   */
  constructor(mountEl, options = {}) {
    this.mountEl = mountEl;
    this.onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
    this.sampleText = options.sampleText || '';

    /** @type {Object | null} */
    this.meta = null;
    /** @type {string} */
    this.displayUrl = '';

    /** @type {Array<() => void>} */
    this._cleanups = [];

    // Cached DOM refs populated on render
    this._els = {};
  }

  /**
   * Loads an image and its alignment metadata into the studio.
   * Passing null clears the studio.
   * @param {Object | null} meta
   * @param {string} [previewDisplayUrl]
   */
  setImage(meta, previewDisplayUrl) {
    const normalized = normalizeImageMeta(meta);
    if (!normalized) {
      this.clear();
      return;
    }

    this.meta = normalized;
    this.displayUrl = previewDisplayUrl || normalized.src;
    this._render();
  }

  /**
   * Returns a normalized copy of the current image metadata, or null if empty.
   * @returns {Object | null}
   */
  getMeta() {
    return this.meta ? { ...this.meta } : null;
  }

  /**
   * Updates layout alignment mode ('left' | 'center' | 'right' | 'full').
   * @param {'left' | 'center' | 'right' | 'full'} align
   */
  setAlign(align) {
    if (!this.meta || !VALID_ALIGNS.has(align)) return;
    this.meta.align = align;
    this._syncVisuals();
    this.onChange(this.getMeta());
  }

  /**
   * Resets focal panning to center (50% × 50%).
   */
  resetFocus() {
    if (!this.meta) return;
    this.meta.posX = 50;
    this.meta.posY = 50;
    this._syncVisuals();
    this.onChange(this.getMeta());
  }

  /**
   * Clears the active image and unmounts studio DOM/listeners.
   */
  clear() {
    this._teardownListeners();
    this.meta = null;
    this.displayUrl = '';
    this._els = {};
    if (this.mountEl) {
      this.mountEl.innerHTML = '';
    }
  }

  /**
   * Permanently destroys the studio instance.
   */
  destroy() {
    this.clear();
  }

  _teardownListeners() {
    while (this._cleanups.length > 0) {
      const fn = this._cleanups.pop();
      try {
        fn();
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  _addListener(target, eventName, handler, options) {
    target.addEventListener(eventName, handler, options);
    this._cleanups.push(() => target.removeEventListener(eventName, handler, options));
  }

  _render() {
    if (!this.mountEl || !this.meta) return;
    this._teardownListeners();
    this.mountEl.innerHTML = '';

    const shell = document.createElement('div');
    shell.className = 'studio-shell';

    // Top toolbar: quick alignment presets + reset focus + live HUD readout
    const toolbar = document.createElement('div');
    toolbar.className = 'studio-toolbar';

    const presets = document.createElement('div');
    presets.className = 'studio-presets';

    const presetDefs = [
      { key: 'left', label: 'Left Wrap' },
      { key: 'center', label: 'Center' },
      { key: 'right', label: 'Right Wrap' },
      { key: 'full', label: 'Full Width' },
    ];

    const presetButtons = {};
    for (const def of presetDefs) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-ghost btn-xs';
      btn.dataset.alignPreset = def.key;
      btn.textContent = def.label;
      this._addListener(btn, 'click', () => this.setAlign(def.key));
      presets.appendChild(btn);
      presetButtons[def.key] = btn;
    }

    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'btn btn-ghost btn-xs';
    resetBtn.textContent = 'Reset Focus';
    this._addListener(resetBtn, 'click', () => this.resetFocus());
    presets.appendChild(resetBtn);

    const hudReadout = document.createElement('span');
    hudReadout.className = 'studio-hud-readout';

    toolbar.appendChild(presets);
    toolbar.appendChild(hudReadout);

    // Live Prose Preview Canvas
    const canvas = document.createElement('div');
    canvas.className = 'studio-canvas';

    // Draggable Frame
    const frame = document.createElement('div');
    frame.className = 'studio-frame';

    // 1. Amber Handle Bar for Hold-and-Drag Snap Zones
    const dragHandle = document.createElement('div');
    dragHandle.className = 'studio-drag-handle';
    dragHandle.title = 'Hold and drag to snap layout (Left, Center, Right, Full)';
    dragHandle.innerHTML = '<span>⠿ HOLD &amp; DRAG TO ALIGN</span><span data-role="align-tag"></span>';
    const alignTagEl = dragHandle.querySelector('[data-role="align-tag"]');

    // 2. Focal Pan Viewport
    const viewport = document.createElement('div');
    viewport.className = 'studio-viewport';
    viewport.title = 'Hold and drag inside image to pan focal point';

    const img = document.createElement('img');
    img.alt = this.meta.caption || 'Diary photo preview';
    img.draggable = false;
    img.src = this.displayUrl;

    const panHud = document.createElement('div');
    panHud.className = 'studio-pan-hud';

    viewport.appendChild(img);
    viewport.appendChild(panHud);

    // 3. Bottom-Right Corner Resize Grip
    const resizeGrip = document.createElement('div');
    resizeGrip.className = 'studio-resize-grip';
    resizeGrip.title = 'Drag corner to resize width & height';

    frame.appendChild(dragHandle);
    frame.appendChild(viewport);
    frame.appendChild(resizeGrip);

    // Sample Editorial Prose wrapping around the frame
    const prose = document.createElement('div');
    prose.className = 'studio-prose-sample';
    const paragraphs = this.sampleText
      ? [this.sampleText, SAMPLE_STUDIO_PROSE[1]]
      : SAMPLE_STUDIO_PROSE;
    for (const pText of paragraphs) {
      const p = document.createElement('p');
      p.textContent = pText;
      prose.appendChild(p);
    }

    // Translucent 4-Zone Snap Overlay (visible only while dragging the amber bar)
    const snapOverlay = document.createElement('div');
    snapOverlay.className = 'studio-snap-overlay';
    snapOverlay.hidden = true;

    const zoneDefs = [
      { zone: 'left', label: 'Left Wrap' },
      { zone: 'center', label: 'Center' },
      { zone: 'right', label: 'Right Wrap' },
      { zone: 'full', label: 'Full Width' },
    ];
    const snapZones = [];
    for (const z of zoneDefs) {
      const zoneEl = document.createElement('div');
      zoneEl.className = 'snap-zone';
      zoneEl.dataset.zone = z.zone;
      zoneEl.textContent = z.label;
      snapOverlay.appendChild(zoneEl);
      snapZones.push(zoneEl);
    }

    canvas.appendChild(frame);
    canvas.appendChild(prose);
    canvas.appendChild(snapOverlay);

    // Caption Input Row
    const captionRow = document.createElement('div');
    captionRow.className = 'studio-caption-row';

    const captionInput = document.createElement('input');
    captionInput.type = 'text';
    captionInput.className = 'input input-sm';
    captionInput.placeholder = 'Optional photo caption…';
    captionInput.maxLength = 180;
    captionInput.value = this.meta.caption || '';
    this._addListener(captionInput, 'input', () => {
      if (!this.meta) return;
      this.meta.caption = captionInput.value;
      img.alt = this.meta.caption || 'Diary photo preview';
      this.onChange(this.getMeta());
    });

    captionRow.appendChild(captionInput);

    shell.appendChild(toolbar);
    shell.appendChild(canvas);
    shell.appendChild(captionRow);
    this.mountEl.appendChild(shell);

    this._els = {
      presetButtons,
      hudReadout,
      canvas,
      frame,
      dragHandle,
      alignTagEl,
      viewport,
      img,
      panHud,
      resizeGrip,
      snapOverlay,
      snapZones,
      captionInput,
    };

    this._bindDragAlign();
    this._bindFocalPan();
    this._bindCornerResize();
    this._syncVisuals();
  }

  _syncVisuals() {
    if (!this.meta || !this._els.frame) return;

    const { align, posX, posY, width, height } = this.meta;
    const { frame, viewport, img, panHud, hudReadout, alignTagEl, presetButtons } = this._els;

    frame.classList.remove('align-left', 'align-center', 'align-right', 'align-full');
    frame.classList.add(`align-${align}`);
    frame.style.width = align === 'full' ? '100%' : `${width}%`;

    viewport.style.height = `${height}px`;
    img.style.objectPosition = `${posX}% ${posY}%`;

    panHud.textContent = `PAN: ${posX}% × ${posY}%`;
    if (alignTagEl) {
      alignTagEl.textContent = align.toUpperCase();
    }

    const displayW = align === 'full' ? 100 : width;
    hudReadout.textContent = `${align.toUpperCase()} · W:${displayW}% · H:${height}px · PAN:${posX}%×${posY}%`;

    for (const [key, btn] of Object.entries(presetButtons)) {
      btn.classList.toggle('is-active', key === align);
    }
  }

  /**
   * 1. Drag-to-Align Snap Zones via Pointer Events on the amber drag handle.
   */
  _bindDragAlign() {
    const { dragHandle, snapOverlay, snapZones } = this._els;
    let dragging = false;
    let activeZone = null;

    const hitTestZone = (clientX, clientY) => {
      for (const zEl of snapZones) {
        const rect = zEl.getBoundingClientRect();
        if (
          clientX >= rect.left &&
          clientX <= rect.right &&
          clientY >= rect.top &&
          clientY <= rect.bottom
        ) {
          return zEl.dataset.zone;
        }
      }
      return null;
    };

    const setHoveredZone = (zoneName) => {
      activeZone = zoneName;
      for (const zEl of snapZones) {
        zEl.classList.toggle('is-hovered', zEl.dataset.zone === zoneName);
      }
    };

    this._addListener(dragHandle, 'pointerdown', (e) => {
      if (!this.meta || e.button > 0) return;
      e.preventDefault();
      dragging = true;
      dragHandle.setPointerCapture(e.pointerId);
      snapOverlay.hidden = false;
      setHoveredZone(this.meta.align);
    });

    this._addListener(dragHandle, 'pointermove', (e) => {
      if (!dragging) return;
      const hit = hitTestZone(e.clientX, e.clientY);
      if (hit) {
        setHoveredZone(hit);
      }
    });

    const finishDrag = (e, commit) => {
      if (!dragging) return;
      dragging = false;
      try {
        if (dragHandle.hasPointerCapture(e.pointerId)) {
          dragHandle.releasePointerCapture(e.pointerId);
        }
      } catch {
        // Ignore capture release errors
      }
      snapOverlay.hidden = true;
      const chosen = activeZone;
      setHoveredZone(null);
      if (commit && chosen && VALID_ALIGNS.has(chosen)) {
        this.setAlign(chosen);
      }
    };

    this._addListener(dragHandle, 'pointerup', (e) => finishDrag(e, true));
    this._addListener(dragHandle, 'pointercancel', (e) => finishDrag(e, false));
  }

  /**
   * 2. Hold-and-Drag Focal Panning via Pointer Events inside the image viewport.
   */
  _bindFocalPan() {
    const { viewport } = this._els;
    let panning = false;
    let startX = 0;
    let startY = 0;
    let startPosX = 50;
    let startPosY = 50;

    this._addListener(viewport, 'pointerdown', (e) => {
      if (!this.meta || e.button > 0) return;
      e.preventDefault();
      panning = true;
      startX = e.clientX;
      startY = e.clientY;
      startPosX = this.meta.posX;
      startPosY = this.meta.posY;
      viewport.classList.add('is-panning');
      viewport.setPointerCapture(e.pointerId);
    });

    this._addListener(viewport, 'pointermove', (e) => {
      if (!panning || !this.meta) return;
      const rect = viewport.getBoundingClientRect();
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      // Dragging the photo naturally moves the image under the pointer
      const nextX = clamp(startPosX - (dx / Math.max(rect.width, 80)) * 100, 0, 100);
      const nextY = clamp(startPosY - (dy / Math.max(rect.height, 80)) * 100, 0, 100);

      this.meta.posX = Math.round(nextX);
      this.meta.posY = Math.round(nextY);
      this._syncVisuals();
    });

    const finishPan = (e) => {
      if (!panning) return;
      panning = false;
      viewport.classList.remove('is-panning');
      try {
        if (viewport.hasPointerCapture(e.pointerId)) {
          viewport.releasePointerCapture(e.pointerId);
        }
      } catch {
        // Ignore capture release errors
      }
      this.onChange(this.getMeta());
    };

    this._addListener(viewport, 'pointerup', finishPan);
    this._addListener(viewport, 'pointercancel', finishPan);
  }

  /**
   * 3. Hold-and-Drag Corner Resizing via Pointer Events on the bottom-right grip.
   */
  _bindCornerResize() {
    const { resizeGrip, canvas } = this._els;
    let resizing = false;
    let startX = 0;
    let startY = 0;
    let startWidth = 52;
    let startHeight = 220;
    let canvasWidth = 400;

    this._addListener(resizeGrip, 'pointerdown', (e) => {
      if (!this.meta || e.button > 0) return;
      e.preventDefault();
      e.stopPropagation();
      resizing = true;
      startX = e.clientX;
      startY = e.clientY;
      startWidth = this.meta.width;
      startHeight = this.meta.height;
      const rect = canvas.getBoundingClientRect();
      canvasWidth = Math.max(rect.width - 28, 200);
      resizeGrip.setPointerCapture(e.pointerId);
    });

    this._addListener(resizeGrip, 'pointermove', (e) => {
      if (!resizing || !this.meta) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      if (this.meta.align !== 'full') {
        const deltaPct = (dx / canvasWidth) * 100;
        this.meta.width = Math.round(clamp(startWidth + deltaPct, 30, 100));
      }

      this.meta.height = Math.round(clamp(startHeight + dy, 110, 420));
      this._syncVisuals();
    });

    const finishResize = (e) => {
      if (!resizing) return;
      resizing = false;
      try {
        if (resizeGrip.hasPointerCapture(e.pointerId)) {
          resizeGrip.releasePointerCapture(e.pointerId);
        }
      } catch {
        // Ignore capture release errors
      }
      this.onChange(this.getMeta());
    };

    this._addListener(resizeGrip, 'pointerup', finishResize);
    this._addListener(resizeGrip, 'pointercancel', finishResize);
  }
}

/**
 * Attaches an on-page live re-alignment controller directly to a rendered
 * .diary-figure inside a diary column or comment card.
 * Lets the user hold-and-drag pan the focal point or switch Left/Center/Right/Full
 * alignment and click Save to commit the updated coordinates directly to GitHub.
 *
 * @param {HTMLElement} figureEl
 * @param {Object} imageMeta
 * @param {{ onSave: (updatedMeta: Object) => Promise<void> | void, onCancel?: () => void }} callbacks
 * @returns {{ destroy: () => void }}
 */
export function attachInlineAlignController(figureEl, imageMeta, callbacks = {}) {
  const original = normalizeImageMeta(imageMeta);
  if (!figureEl || !original) {
    return { destroy: () => {} };
  }

  // Prevent attaching duplicate controllers to the same figure
  if (figureEl.classList.contains('is-inline-aligning')) {
    return { destroy: () => {} };
  }

  const draft = { ...original };
  const viewport = figureEl.querySelector('.diary-figure-viewport');
  const img = figureEl.querySelector('img');
  const triggerBtn = figureEl.querySelector('.figure-align-trigger');

  if (!viewport || !img) {
    return { destroy: () => {} };
  }

  const cleanups = [];
  const addEvt = (el, type, fn, opts) => {
    el.addEventListener(type, fn, opts);
    cleanups.push(() => el.removeEventListener(type, fn, opts));
  };

  figureEl.classList.add('is-inline-aligning');
  if (triggerBtn) triggerBtn.hidden = true;

  // Live PAN coordinate HUD
  const hud = document.createElement('div');
  hud.className = 'inline-align-hud';
  viewport.appendChild(hud);

  // Control Bar (Left / Center / Right / Full + Reset + Cancel / Save)
  const bar = document.createElement('div');
  bar.className = 'inline-align-bar';

  const modesWrap = document.createElement('div');
  modesWrap.className = 'inline-align-modes';

  const modeBtns = {};
  for (const mode of ['left', 'center', 'right', 'full']) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-ghost btn-xs';
    btn.textContent = mode[0].toUpperCase() + mode.slice(1);
    addEvt(btn, 'click', () => {
      draft.align = mode;
      applyDraft(draft);
    });
    modesWrap.appendChild(btn);
    modeBtns[mode] = btn;
  }

  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'btn btn-ghost btn-xs';
  resetBtn.textContent = 'Reset';
  addEvt(resetBtn, 'click', () => {
    draft.posX = 50;
    draft.posY = 50;
    applyDraft(draft);
  });
  modesWrap.appendChild(resetBtn);

  const actionWrap = document.createElement('div');
  actionWrap.className = 'inline-align-modes';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn btn-ghost btn-xs';
  cancelBtn.textContent = 'Cancel';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn btn-primary btn-xs';
  saveBtn.textContent = 'Save';

  actionWrap.appendChild(cancelBtn);
  actionWrap.appendChild(saveBtn);

  bar.appendChild(modesWrap);
  bar.appendChild(actionWrap);
  figureEl.appendChild(bar);

  function applyDraft(state) {
    figureEl.classList.remove('align-left', 'align-center', 'align-right', 'align-full');
    figureEl.classList.add(`align-${state.align}`);
    figureEl.style.width = state.align === 'full' ? '100%' : `${state.width}%`;
    viewport.style.height = `${state.height}px`;
    img.style.objectPosition = `${state.posX}% ${state.posY}%`;
    hud.textContent = `PAN: ${state.posX}% × ${state.posY}% · ${state.align.toUpperCase()}`;

    for (const [mode, btn] of Object.entries(modeBtns)) {
      btn.classList.toggle('is-active', mode === state.align);
    }
  }

  // Interactive Pointer Events panning inside the rendered image viewport
  let panning = false;
  let startX = 0;
  let startY = 0;
  let startPosX = draft.posX;
  let startPosY = draft.posY;

  addEvt(viewport, 'pointerdown', (e) => {
    if (e.button > 0) return;
    e.preventDefault();
    panning = true;
    startX = e.clientX;
    startY = e.clientY;
    startPosX = draft.posX;
    startPosY = draft.posY;
    viewport.classList.add('is-panning');
    viewport.setPointerCapture(e.pointerId);
  });

  addEvt(viewport, 'pointermove', (e) => {
    if (!panning) return;
    const rect = viewport.getBoundingClientRect();
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    draft.posX = Math.round(clamp(startPosX - (dx / Math.max(rect.width, 80)) * 100, 0, 100));
    draft.posY = Math.round(clamp(startPosY - (dy / Math.max(rect.height, 80)) * 100, 0, 100));
    applyDraft(draft);
  });

  const endPan = (e) => {
    if (!panning) return;
    panning = false;
    viewport.classList.remove('is-panning');
    try {
      if (viewport.hasPointerCapture(e.pointerId)) {
        viewport.releasePointerCapture(e.pointerId);
      }
    } catch {
      // Ignore pointer capture release errors
    }
  };

  addEvt(viewport, 'pointerup', endPan);
  addEvt(viewport, 'pointercancel', endPan);

  let destroyed = false;
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      try {
        fn();
      } catch {
        // Ignore cleanup errors
      }
    }
    figureEl.classList.remove('is-inline-aligning');
    viewport.classList.remove('is-panning');
    hud.remove();
    bar.remove();
    if (triggerBtn) triggerBtn.hidden = false;
  }

  addEvt(cancelBtn, 'click', () => {
    applyDraft(original);
    destroy();
    if (typeof callbacks.onCancel === 'function') {
      callbacks.onCancel();
    }
  });

  addEvt(saveBtn, 'click', async () => {
    saveBtn.disabled = true;
    cancelBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      if (typeof callbacks.onSave === 'function') {
        await callbacks.onSave({ ...draft });
      }
      destroy();
    } catch {
      saveBtn.disabled = false;
      cancelBtn.disabled = false;
      saveBtn.textContent = 'Save';
    }
  });

  applyDraft(draft);
  return { destroy };
}