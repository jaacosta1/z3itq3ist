/**
 * js/kdf.js — Memory-Hard Argon2id Web Worker Bridge
 * Phase 10:
 * Spawns `js/argon2-worker.js` to execute RFC 9106 Argon2id off the main thread,
 * returning an AES-256-GCM Web Crypto KEK without blocking UI animations or input.
 */

export const ARGON2ID_PRESETS = Object.freeze({
  balanced: {
    id: 'balanced',
    label: 'Argon2id Balanced (16 MB · t=2)',
    memoryKiB: 16384,
    timeCost: 2,
    parallelism: 1,
  },
  hardened: {
    id: 'hardened',
    label: 'Argon2id Hardened (32 MB · t=3)',
    memoryKiB: 32768,
    timeCost: 3,
    parallelism: 1,
  },
  mobile: {
    id: 'mobile',
    label: 'Argon2id Fast / Mobile (8 MB · t=2)',
    memoryKiB: 8192,
    timeCost: 2,
    parallelism: 1,
  },
});

const textEncoder = new TextEncoder();
let workerInstance = null;
let requestCounter = 0;
const pendingRequests = new Map();

function getArgon2Worker() {
  if (typeof Worker === 'undefined') {
    throw new Error('Web Workers are unavailable in this browser environment.');
  }
  if (!workerInstance) {
    const workerUrl = new URL('./argon2-worker.js', import.meta.url);
    workerInstance = new Worker(workerUrl);
    workerInstance.onmessage = (event) => {
      const { id, ok, keyBytes, elapsedMs, error } = event.data || {};
      const pending = pendingRequests.get(id);
      if (!pending) return;
      pendingRequests.delete(id);
      if (ok) {
        pending.resolve({ bytes: new Uint8Array(keyBytes), elapsedMs });
      } else {
        pending.reject(new Error(error || 'Argon2id worker derivation failed.'));
      }
    };
    workerInstance.onerror = (err) => {
      const failure = new Error(err?.message || 'Argon2id worker encountered an error.');
      for (const pending of pendingRequests.values()) {
        pending.reject(failure);
      }
      pendingRequests.clear();
      workerInstance = null;
    };
  }
  return workerInstance;
}

/**
 * Runs Argon2id inside the dedicated Web Worker and returns raw 32-byte key material.
 * @param {string} password
 * @param {Uint8Array} saltBytes
 * @param {{ memoryKiB?: number, timeCost?: number, hashLen?: number }} [params]
 * @returns {Promise<{ bytes: Uint8Array, elapsedMs: number }>}
 */
export async function deriveArgon2idRaw(
  password,
  saltBytes,
  { memoryKiB = 16384, timeCost = 2, hashLen = 32 } = {}
) {
  const worker = getArgon2Worker();
  const pwBytes = textEncoder.encode(String(password ?? ''));
  const saltArr = saltBytes instanceof Uint8Array ? new Uint8Array(saltBytes) : new Uint8Array(saltBytes);
  const id = ++requestCounter;

  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    worker.postMessage(
      {
        id,
        passwordBytes: pwBytes.buffer,
        saltBytes: saltArr.buffer,
        memoryKiB: Number(memoryKiB) || 16384,
        timeCost: Number(timeCost) || 2,
        hashLen: Number(hashLen) || 32,
      },
      [pwBytes.buffer, saltArr.buffer]
    );
  });
}

/**
 * Derives an AES-256-GCM CryptoKey using RFC 9106 Argon2id in a background Web Worker.
 * @param {string} password
 * @param {Uint8Array} saltBytes
 * @param {{ memoryKiB?: number, timeCost?: number, extractable?: boolean }} [options]
 * @returns {Promise<{ key: CryptoKey, elapsedMs: number }>}
 */
export async function deriveArgon2idCryptoKey(password, saltBytes, options = {}) {
  const { bytes, elapsedMs } = await deriveArgon2idRaw(password, saltBytes, {
    memoryKiB: options.memoryKiB || 16384,
    timeCost: options.timeCost || 2,
    hashLen: 32,
  });

  const key = await window.crypto.subtle.importKey(
    'raw',
    bytes,
    { name: 'AES-GCM', length: 256 },
    Boolean(options.extractable),
    ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']
  );

  // Scrub raw key material immediately after SubtleCrypto import
  bytes.fill(0);
  return { key, elapsedMs };
}
