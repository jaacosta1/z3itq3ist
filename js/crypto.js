/**
 * Perpetual Side-by-Side Web Diary — Client-Side Cryptography Engine
 * Uses native Web Crypto API: PBKDF2 (SHA-256, 250,000 iterations) + AES-256-GCM.
 * Zero plaintext passwords or keys are ever persisted to GitHub or external storage.
 */

export const VAULT_CANARY_PLAINTEXT = 'PERPETUAL_VAULT_OK';
export const CIPHER_PREFIX = 'ENC:AES256GCM:v1:';
export const DEFAULT_ITERATIONS = 250000;

const SALT_BYTES = 16;
const IV_BYTES = 12;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Ensures the Web Crypto SubtleCrypto API is available in the current context.
 */
function assertCryptoAvailable() {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error(
      'Web Crypto API (crypto.subtle) is unavailable. Please serve this site over HTTPS or localhost.'
    );
  }
}

/**
 * Checks whether a string is formatted as a Perpetual AES-256-GCM ciphertext payload.
 * Format: ENC:AES256GCM:v1:<saltB64>:<ivB64>:<cipherB64>
 * @param {unknown} str
 * @returns {boolean}
 */
export function isEncryptedPayload(str) {
  if (typeof str !== 'string' || !str.startsWith(CIPHER_PREFIX)) {
    return false;
  }
  const rest = str.slice(CIPHER_PREFIX.length);
  const parts = rest.split(':');
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

/**
 * Generates cryptographically strong random bytes.
 * @param {number} length
 * @returns {Uint8Array}
 */
export function generateRandomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * Encodes a Uint8Array (or ArrayBuffer) to a standard Base64 string.
 * Chunked to avoid call-stack overflow on large buffers.
 * @param {Uint8Array | ArrayBuffer} bytes
 * @returns {string}
 */
export function bytesToBase64(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < arr.length; i += chunkSize) {
    const slice = arr.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, slice);
  }
  return btoa(binary);
}

/**
 * Decodes a Base64 string into a Uint8Array.
 * @param {string} b64
 * @returns {Uint8Array}
 */
export function base64ToBytes(b64) {
  const cleaned = String(b64 || '').replace(/\s+/g, '');
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Derives an AES-256-GCM CryptoKey from a user password and salt using PBKDF2-SHA256.
 * @param {string} password
 * @param {Uint8Array} saltBytes
 * @param {number} [iterations=DEFAULT_ITERATIONS]
 * @returns {Promise<CryptoKey>}
 */
export async function deriveKey(password, saltBytes, iterations = DEFAULT_ITERATIONS) {
  assertCryptoAvailable();
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('Password is required to derive encryption key.');
  }

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: saltBytes,
      iterations: Number(iterations) || DEFAULT_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypts plaintext UTF-8 text into:
 * ENC:AES256GCM:v1:<saltB64>:<ivB64>:<cipherB64>
 * @param {string} plaintext
 * @param {string} password
 * @param {number} [iterations=DEFAULT_ITERATIONS]
 * @returns {Promise<string>}
 */
export async function encryptText(plaintext, password, iterations = DEFAULT_ITERATIONS) {
  assertCryptoAvailable();
  const salt = generateRandomBytes(SALT_BYTES);
  const iv = generateRandomBytes(IV_BYTES);
  const key = await deriveKey(password, salt, iterations);

  const cipherBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    textEncoder.encode(String(plaintext ?? ''))
  );

  return `${CIPHER_PREFIX}${bytesToBase64(salt)}:${bytesToBase64(iv)}:${bytesToBase64(cipherBuffer)}`;
}

/**
 * Decrypts a Perpetual AES-256-GCM payload back to UTF-8 plaintext.
 * If the input is not an encrypted payload, returns it unchanged.
 * @param {string} payload
 * @param {string} password
 * @param {number} [iterations=DEFAULT_ITERATIONS]
 * @returns {Promise<string>}
 */
export async function decryptText(payload, password, iterations = DEFAULT_ITERATIONS) {
  if (!isEncryptedPayload(payload)) {
    return String(payload ?? '');
  }
  assertCryptoAvailable();

  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('Passphrase required to decrypt content.');
  }

  const body = payload.slice(CIPHER_PREFIX.length);
  const [saltB64, ivB64, cipherB64] = body.split(':');

  try {
    const salt = base64ToBytes(saltB64);
    const iv = base64ToBytes(ivB64);
    const cipherBytes = base64ToBytes(cipherB64);
    const key = await deriveKey(password, salt, iterations);

    const plainBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      cipherBytes
    );

    return textDecoder.decode(plainBuffer);
  } catch {
    throw new Error('Incorrect password or corrupted encrypted payload.');
  }
}

/**
 * Builds the non-secret /data/vault.json verification canary metadata object.
 * @param {string} password
 * @param {{ enabled?: boolean, iterations?: number, encryptedPat?: string | null }} [options]
 * @returns {Promise<Object>}
 */
export async function createVaultConfig(password, options = {}) {
  assertCryptoAvailable();
  const enabled = options.enabled !== undefined ? Boolean(options.enabled) : true;
  const iterations = Number(options.iterations) || DEFAULT_ITERATIONS;

  const salt = generateRandomBytes(SALT_BYTES);
  const iv = generateRandomBytes(IV_BYTES);
  const key = await deriveKey(password, salt, iterations);

  const cipherBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    textEncoder.encode(VAULT_CANARY_PLAINTEXT)
  );

  const saltB64 = bytesToBase64(salt);
  const ivB64 = bytesToBase64(iv);
  const cipherB64 = bytesToBase64(cipherBuffer);

  return {
    version: 1,
    enabled,
    kdf: 'PBKDF2-SHA256',
    iterations,
    salt: saltB64,
    canaryCipher: `${CIPHER_PREFIX}${saltB64}:${ivB64}:${cipherB64}`,
    encryptedPat: options.encryptedPat || null,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Verifies a candidate password against /data/vault.json by attempting to decrypt
 * the AES-256-GCM canary and comparing it to VAULT_CANARY_PLAINTEXT.
 * Returns false on invalid password without throwing.
 * @param {string} password
 * @param {Object} vaultConfig
 * @returns {Promise<boolean>}
 */
export async function verifyVaultPassword(password, vaultConfig) {
  if (!password || !vaultConfig || typeof vaultConfig.canaryCipher !== 'string') {
    return false;
  }

  const iterations = Number(vaultConfig.iterations) || DEFAULT_ITERATIONS;

  try {
    if (isEncryptedPayload(vaultConfig.canaryCipher)) {
      const decrypted = await decryptText(vaultConfig.canaryCipher, password, iterations);
      return decrypted === VAULT_CANARY_PLAINTEXT;
    }

    // Fallback compatibility if salt + iv + raw canaryCipher were stored separately
    if (vaultConfig.salt && vaultConfig.iv) {
      assertCryptoAvailable();
      const salt = base64ToBytes(vaultConfig.salt);
      const iv = base64ToBytes(vaultConfig.iv);
      const cipherBytes = base64ToBytes(vaultConfig.canaryCipher);
      const key = await deriveKey(password, salt, iterations);
      const plainBuffer = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        key,
        cipherBytes
      );
      return textDecoder.decode(plainBuffer) === VAULT_CANARY_PLAINTEXT;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Encrypts a GitHub Personal Access Token with the user's diary master password.
 * @param {string} pat
 * @param {string} password
 * @param {number} [iterations=DEFAULT_ITERATIONS]
 * @returns {Promise<string>}
 */
export async function encryptPat(pat, password, iterations = DEFAULT_ITERATIONS) {
  const trimmed = String(pat || '').trim();
  if (!trimmed) {
    throw new Error('Cannot encrypt an empty Personal Access Token.');
  }
  return encryptText(trimmed, password, iterations);
}

/**
 * Decrypts a stored GitHub Personal Access Token blob using the user's diary master password.
 * @param {string} encryptedPatPayload
 * @param {string} password
 * @param {number} [iterations=DEFAULT_ITERATIONS]
 * @returns {Promise<string>}
 */
export async function decryptPat(encryptedPatPayload, password, iterations = DEFAULT_ITERATIONS) {
  if (!isEncryptedPayload(encryptedPatPayload)) {
    throw new Error('Stored PAT payload is not a valid encrypted blob.');
  }
  return decryptText(encryptedPatPayload, password, iterations);
}