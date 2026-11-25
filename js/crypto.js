/**
 * js/crypto.js — Client-Side Envelope Cryptography & Binary Media (.enc) Vault
 * Phase 6A:
 * - Supports v3 AAD Text, v2 DEK Envelope, v1 Legacy PBKDF2, and 256-bit Paper Recovery Keys
 * - Adds binary media encryption (.enc) with encrypted MIME header + AES-256-GCM AAD binding
 * - Keeps backward-compatible helper exports so existing modules remain unbroken
 */

export const VAULT_CANARY_PLAINTEXT = 'PERPETUAL_VAULT_OK';
export const DEFAULT_PBKDF2_ITERATIONS = 250000;
export const DEFAULT_ITERATIONS = DEFAULT_PBKDF2_ITERATIONS;
export const CIPHER_PREFIX = 'ENC:AES256GCM:v1:';

const V3_PREFIX = 'ENC:AES256GCM:v3:';
const V2_PREFIX = 'ENC:AES256GCM:v2:';
const V1_PREFIX = 'ENC:AES256GCM:v1:';

// Binary media envelope header: [4B "PENC"][1B ver=1][1B flags][12B IV][AES-GCM ciphertext]
const PENC_MAGIC = new Uint8Array([0x50, 0x45, 0x4e, 0x43]); // "PENC"
const PENC_VERSION = 1;
const PENC_FLAG_AAD = 0x01;
const PENC_HEADER_LEN = 18;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Verifies SubtleCrypto availability (requires HTTPS or localhost).
 */
function assertCryptoAvailable() {
  if (typeof window === 'undefined' || !window.crypto || !window.crypto.subtle) {
    throw new Error(
      'Web Crypto API (crypto.subtle) is unavailable. Serve this site over HTTPS or localhost.'
    );
  }
}

export function bytesToBase64(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < arr.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, arr.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function base64ToBytes(base64) {
  const clean = String(base64 ?? '').replace(/\s+/g, '');
  if (!clean) return new Uint8Array(0);
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function bytesToHex(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex) {
  const clean = String(hex ?? '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toLowerCase();
  if (clean.length % 2 !== 0 || clean.length === 0) {
    throw new Error('Invalid hexadecimal key format.');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function randomBytes(length) {
  const buf = new Uint8Array(length);
  window.crypto.getRandomValues(buf);
  return buf;
}

export const generateRandomBytes = randomBytes;

export function normalizeRecoveryCode(code) {
  return String(code ?? '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toUpperCase();
}

export function isRecoveryCodeFormat(input) {
  return /^[0-9A-F]{64}$/.test(normalizeRecoveryCode(input));
}

export function formatRecoveryCode(rawHex) {
  const clean = normalizeRecoveryCode(rawHex);
  const groups = clean.match(/.{1,4}/g) || [];
  return groups.join('-');
}

export function generateRecoveryCode() {
  const rawHex = bytesToHex(randomBytes(32)).toUpperCase();
  return formatRecoveryCode(rawHex);
}

export function isEncryptedPayload(value) {
  if (typeof value !== 'string') return false;
  return (
    value.startsWith(V3_PREFIX) ||
    value.startsWith(V2_PREFIX) ||
    value.startsWith(V1_PREFIX)
  );
}

export function getPayloadVersion(value) {
  if (typeof value !== 'string') return 0;
  if (value.startsWith(V3_PREFIX)) return 3;
  if (value.startsWith(V2_PREFIX)) return 2;
  if (value.startsWith(V1_PREFIX)) return 1;
  return 0;
}

/**
 * Checks whether a media path points to an encrypted .enc binary vault blob.
 * @param {unknown} src
 * @returns {boolean}
 */
export function isEncryptedMediaPath(src) {
  if (typeof src !== 'string') return false;
  const clean = src.split('?')[0].split('#')[0].toLowerCase();
  return clean.endsWith('.enc');
}

export function buildEntryAad(diaryDate, year, field = 'body') {
  return `perpetual:v3:entry:${String(diaryDate || '').trim()}:${String(year || '').trim()}:${String(
    field || 'body'
  ).trim()}`;
}

export function buildCommentAad(dayStr, commentId, field = 'body') {
  return `perpetual:v3:comment:${String(dayStr || '').trim()}:${String(commentId || '').trim()}:${String(
    field || 'body'
  ).trim()}`;
}

/**
 * Builds canonical AES-GCM AAD binding a binary .enc media blob to its exact path.
 * @param {string} mediaSubpath
 * @returns {string}
 */
export function buildMediaAad(mediaSubpath) {
  const normalized = String(mediaSubpath || '')
    .replace(/^(idb:\/\/|idb:|ram:)/i, '')
    .replace(/^\/+/, '')
    .replace(/^data\//i, '');
  return `perpetual:v3:media:${normalized}`;
}

function resolvePrimaryKey(keyOrKeyring) {
  if (!keyOrKeyring) return null;
  if (keyOrKeyring instanceof CryptoKey) return keyOrKeyring;
  return keyOrKeyring.dek || keyOrKeyring.legacyKey || null;
}

function getCandidateKeys(keyOrKeyring) {
  if (!keyOrKeyring) return [];
  if (keyOrKeyring instanceof CryptoKey) return [keyOrKeyring];
  return [keyOrKeyring.dek, keyOrKeyring.legacyKey].filter(Boolean);
}

export async function deriveKey(
  password,
  saltInput,
  iterations = DEFAULT_PBKDF2_ITERATIONS,
  extractable = false
) {
  assertCryptoAvailable();
  const baseKey = await window.crypto.subtle.importKey(
    'raw',
    textEncoder.encode(String(password ?? '')),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  const salt =
    typeof saltInput === 'string' ? base64ToBytes(saltInput) : new Uint8Array(saltInput);

  return window.crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: Number(iterations) || DEFAULT_PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    Boolean(extractable),
    ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']
  );
}

export async function importRecoveryKek(recoveryCode) {
  assertCryptoAvailable();
  const cleanHex = normalizeRecoveryCode(recoveryCode);
  if (!/^[0-9A-F]{64}$/.test(cleanHex)) {
    throw new Error('Recovery key must contain 64 hexadecimal characters.');
  }
  const keyBytes = hexToBytes(cleanHex);
  return window.crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey']
  );
}

export async function generateDEK() {
  assertCryptoAvailable();
  return window.crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']
  );
}

export async function computeKeyFingerprint(cryptoKey) {
  const raw = await window.crypto.subtle.exportKey('raw', cryptoKey);
  const hash = await window.crypto.subtle.digest('SHA-256', raw);
  return bytesToHex(new Uint8Array(hash)).slice(0, 12).toUpperCase();
}

export async function wrapKeyWithKEK(targetKey, kek) {
  const iv = randomBytes(12);
  const wrapped = await window.crypto.subtle.wrapKey('raw', targetKey, kek, {
    name: 'AES-GCM',
    iv,
  });
  return {
    iv: bytesToBase64(iv),
    wrappedKey: bytesToBase64(new Uint8Array(wrapped)),
  };
}

export async function unwrapKeyWithKEK(wrappedB64, ivB64, kek, extractable = true) {
  const wrappedBytes = base64ToBytes(wrappedB64);
  const ivBytes = base64ToBytes(ivB64);
  return window.crypto.subtle.unwrapKey(
    'raw',
    wrappedBytes,
    kek,
    { name: 'AES-GCM', iv: ivBytes },
    { name: 'AES-GCM', length: 256 },
    Boolean(extractable),
    ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']
  );
}

/**
 * Encrypts UTF-8 text.
 * Supports Envelope DEK/Keyring (+ optional AAD for v3) as well as legacy raw password strings.
 */
export async function encryptText(plaintext, keyOrKeyringOrPassword, aadOrIterations = '') {
  assertCryptoAvailable();

  // Backward-compatible legacy call signature: encryptText(plain, "password", iterations)
  if (typeof keyOrKeyringOrPassword === 'string') {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const iterations =
      typeof aadOrIterations === 'number' ? aadOrIterations : DEFAULT_PBKDF2_ITERATIONS;
    const derived = await deriveKey(keyOrKeyringOrPassword, salt, iterations, false);
    const cipherBuf = await window.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      derived,
      textEncoder.encode(String(plaintext ?? ''))
    );
    return `${V1_PREFIX}${bytesToBase64(salt)}:${bytesToBase64(iv)}:${bytesToBase64(
      new Uint8Array(cipherBuf)
    )}`;
  }

  const key = resolvePrimaryKey(keyOrKeyringOrPassword);
  if (!key) {
    throw new Error('No encryption key available in session.');
  }

  const iv = randomBytes(12);
  const data = textEncoder.encode(String(plaintext ?? ''));
  const aadStr = typeof aadOrIterations === 'string' ? aadOrIterations.trim() : '';

  if (aadStr) {
    const cipherBuffer = await window.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: textEncoder.encode(aadStr) },
      key,
      data
    );
    return `${V3_PREFIX}${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(cipherBuffer))}`;
  }

  const cipherBuffer = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  return `${V2_PREFIX}${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(cipherBuffer))}`;
}

async function decryptAesGcmRaw(ivB64, cipherB64, key, aadStr = '') {
  const iv = base64ToBytes(ivB64);
  const cipherBytes = base64ToBytes(cipherB64);
  const algo = aadStr
    ? { name: 'AES-GCM', iv, additionalData: textEncoder.encode(aadStr) }
    : { name: 'AES-GCM', iv };

  const plainBuf = await window.crypto.subtle.decrypt(algo, key, cipherBytes);
  return textDecoder.decode(plainBuf);
}

/**
 * Decrypts v3 (AAD), v2 (DEK), or v1 (Legacy PBKDF2) text payloads.
 */
export async function decryptText(payload, keyOrKeyringOrPassword, aadOrIterations = '') {
  if (typeof payload !== 'string' || !isEncryptedPayload(payload)) {
    return String(payload ?? '');
  }
  assertCryptoAvailable();

  const isLegacyStringPass = typeof keyOrKeyringOrPassword === 'string';
  const dek =
    !isLegacyStringPass && keyOrKeyringOrPassword instanceof CryptoKey
      ? keyOrKeyringOrPassword
      : !isLegacyStringPass
        ? keyOrKeyringOrPassword?.dek || null
        : null;
  const legacyKey =
    !isLegacyStringPass && keyOrKeyringOrPassword instanceof CryptoKey
      ? keyOrKeyringOrPassword
      : !isLegacyStringPass
        ? keyOrKeyringOrPassword?.legacyKey || null
        : null;
  const sessionPassword = isLegacyStringPass
    ? keyOrKeyringOrPassword
    : keyOrKeyringOrPassword?.password || null;

  const parts = payload.split(':');
  const aadStr = typeof aadOrIterations === 'string' ? aadOrIterations.trim() : '';
  const fallbackIterations =
    typeof aadOrIterations === 'number' ? aadOrIterations : DEFAULT_PBKDF2_ITERATIONS;

  // v3 AAD format
  if (payload.startsWith(V3_PREFIX) && parts.length === 5) {
    const [, , , ivB64, cipherB64] = parts;
    for (const key of [dek, legacyKey].filter(Boolean)) {
      try {
        return await decryptAesGcmRaw(ivB64, cipherB64, key, aadStr);
      } catch {
        // try next key candidate
      }
    }
    const tamperErr = new Error(
      'Cryptographic integrity check failed (AAD mismatch or tampered ciphertext).'
    );
    tamperErr.code = 'AAD_TAMPER_ERROR';
    tamperErr.isTamperSuspected = true;
    throw tamperErr;
  }

  // v2 Envelope format
  if (payload.startsWith(V2_PREFIX) && parts.length === 5) {
    const [, , , ivB64, cipherB64] = parts;
    for (const key of [dek, legacyKey].filter(Boolean)) {
      try {
        return await decryptAesGcmRaw(ivB64, cipherB64, key);
      } catch {
        // try next candidate
      }
    }
    const err = new Error('Unable to decrypt v2 ciphertext with active session key.');
    err.code = 'DECRYPT_FAILED';
    throw err;
  }

  // v1 Legacy format
  if (payload.startsWith(V1_PREFIX)) {
    const hasEmbeddedSalt = parts.length === 6;
    const saltB64 = hasEmbeddedSalt ? parts[3] : null;
    const ivB64 = hasEmbeddedSalt ? parts[4] : parts[3];
    const cipherB64 = hasEmbeddedSalt ? parts[5] : parts[4];

    for (const key of [legacyKey, dek].filter(Boolean)) {
      try {
        return await decryptAesGcmRaw(ivB64, cipherB64, key);
      } catch {
        // try next candidate
      }
    }

    if (hasEmbeddedSalt && saltB64 && sessionPassword) {
      try {
        const derived = await deriveKey(sessionPassword, saltB64, fallbackIterations, false);
        return await decryptAesGcmRaw(ivB64, cipherB64, derived);
      } catch {
        // fall through
      }
    }

    const err = new Error('Unable to decrypt v1 ciphertext with active session key.');
    err.code = 'DECRYPT_FAILED';
    throw err;
  }

  throw new Error('Unsupported ciphertext envelope format.');
}

/**
 * Encrypts raw binary media (images/audio) into an opaque .enc PENC v1 blob
 * containing an encrypted MIME header + optional AES-256-GCM AAD path binding.
 * @param {ArrayBuffer | Uint8Array} rawBufferOrBytes
 * @param {CryptoKey | Object} keyOrKeyring
 * @param {{ mime?: string, aad?: string }} [options]
 * @returns {Promise<Uint8Array>}
 */
export async function encryptBinary(
  rawBufferOrBytes,
  keyOrKeyring,
  { mime = 'image/webp', aad = '' } = {}
) {
  assertCryptoAvailable();
  const key = resolvePrimaryKey(keyOrKeyring);
  if (!key) {
    throw new Error('Unlock your Vault before encrypting media files.');
  }

  const rawBytes =
    rawBufferOrBytes instanceof Uint8Array
      ? rawBufferOrBytes
      : new Uint8Array(rawBufferOrBytes);

  const metaJsonBytes = textEncoder.encode(
    JSON.stringify({ mime: String(mime || 'application/octet-stream') })
  );
  if (metaJsonBytes.length > 65535) {
    throw new Error('Media metadata header exceeds size limit.');
  }

  // Inner plaintext: [2B big-endian metaLen][metaJsonBytes][rawBytes]
  const innerPlain = new Uint8Array(2 + metaJsonBytes.length + rawBytes.length);
  innerPlain[0] = (metaJsonBytes.length >> 8) & 0xff;
  innerPlain[1] = metaJsonBytes.length & 0xff;
  innerPlain.set(metaJsonBytes, 2);
  innerPlain.set(rawBytes, 2 + metaJsonBytes.length);

  const iv = randomBytes(12);
  const aadStr = String(aad || '').trim();
  const flags = aadStr ? PENC_FLAG_AAD : 0x00;

  const algo = aadStr
    ? { name: 'AES-GCM', iv, additionalData: textEncoder.encode(aadStr) }
    : { name: 'AES-GCM', iv };

  const cipherBuf = await window.crypto.subtle.encrypt(algo, key, innerPlain);
  const cipherBytes = new Uint8Array(cipherBuf);

  const out = new Uint8Array(PENC_HEADER_LEN + cipherBytes.length);
  out.set(PENC_MAGIC, 0);
  out[4] = PENC_VERSION;
  out[5] = flags;
  out.set(iv, 6);
  out.set(cipherBytes, PENC_HEADER_LEN);
  return out;
}

/**
 * Decrypts a PENC v1 .enc binary blob back into { bytes, mime, aadBound }.
 * Rejects tampered or path-transplanted files when AAD is enabled.
 * @param {ArrayBuffer | Uint8Array} encryptedBufferOrBytes
 * @param {CryptoKey | Object} keyOrKeyring
 * @param {{ aad?: string }} [options]
 * @returns {Promise<{ bytes: Uint8Array, mime: string, aadBound: boolean }>}
 */
export async function decryptBinary(encryptedBufferOrBytes, keyOrKeyring, { aad = '' } = {}) {
  assertCryptoAvailable();
  const candidates = getCandidateKeys(keyOrKeyring);
  if (candidates.length === 0) {
    const lockErr = new Error('Vault is locked. Unlock to decrypt this photo.');
    lockErr.code = 'VAULT_LOCKED';
    throw lockErr;
  }

  const data =
    encryptedBufferOrBytes instanceof Uint8Array
      ? encryptedBufferOrBytes
      : new Uint8Array(encryptedBufferOrBytes);

  if (data.length <= PENC_HEADER_LEN + 16) {
    throw new Error('Encrypted media blob is truncated or malformed.');
  }

  for (let i = 0; i < 4; i += 1) {
    if (data[i] !== PENC_MAGIC[i]) {
      throw new Error('Unrecognized encrypted media header.');
    }
  }

  const version = data[4];
  if (version !== PENC_VERSION) {
    throw new Error(`Unsupported encrypted media version: ${version}`);
  }

  const flags = data[5];
  const aadBound = Boolean(flags & PENC_FLAG_AAD);
  const iv = data.subarray(6, 18);
  const cipherBytes = data.subarray(PENC_HEADER_LEN);
  const aadStr = String(aad || '').trim();

  const algo =
    aadBound && aadStr
      ? { name: 'AES-GCM', iv, additionalData: textEncoder.encode(aadStr) }
      : { name: 'AES-GCM', iv };

  let plainBuf = null;
  for (const key of candidates) {
    try {
      plainBuf = await window.crypto.subtle.decrypt(algo, key, cipherBytes);
      break;
    } catch {
      // try next key candidate
    }
  }

  if (!plainBuf) {
    const err = new Error(
      aadBound
        ? 'Encrypted photo failed AAD integrity verification or key mismatch.'
        : 'Unable to decrypt photo with active session key.'
    );
    err.code = aadBound ? 'AAD_TAMPER_ERROR' : 'DECRYPT_FAILED';
    throw err;
  }

  const plainBytes = new Uint8Array(plainBuf);
  if (plainBytes.length < 2) {
    throw new Error('Decrypted media payload is corrupted.');
  }
  const metaLen = (plainBytes[0] << 8) | plainBytes[1];
  if (2 + metaLen > plainBytes.length) {
    throw new Error('Decrypted media metadata length is invalid.');
  }

  let mime = 'image/webp';
  try {
    const metaJson = textDecoder.decode(plainBytes.subarray(2, 2 + metaLen));
    const parsed = JSON.parse(metaJson);
    if (parsed && parsed.mime) mime = String(parsed.mime);
  } catch {
    mime = 'image/webp';
  }

  const mediaBytes = plainBytes.slice(2 + metaLen);
  return { bytes: mediaBytes, mime, aadBound };
}

export async function createPasswordSlot(password, dek, options = {}) {
  const salt = bytesToBase64(randomBytes(16));
  const iterations = Number(options.iterations) || DEFAULT_PBKDF2_ITERATIONS;
  const kek = await deriveKey(password, salt, iterations, false);
  const { iv, wrappedKey } = await wrapKeyWithKEK(dek, kek);
  const nowIso = new Date().toISOString();

  return {
    id: options.id || `slot-pw-${Date.now().toString(36)}`,
    type: 'password',
    label: options.label || 'Master Password',
    kdf: 'PBKDF2-SHA256',
    iterations,
    salt,
    iv,
    wrappedDek: wrappedKey,
    createdAt: options.createdAt || nowIso,
    rotatedAt: nowIso,
  };
}

export async function createRecoverySlot(recoveryCode, dek, options = {}) {
  const kek = await importRecoveryKek(recoveryCode);
  const { iv, wrappedKey } = await wrapKeyWithKEK(dek, kek);
  const nowIso = new Date().toISOString();

  return {
    id: options.id || 'slot-recovery-paper',
    type: 'recovery',
    label: options.label || 'Paper Recovery Key',
    format: 'raw-hex-256',
    iv,
    wrappedDek: wrappedKey,
    createdAt: nowIso,
    rotatedAt: nowIso,
  };
}

export async function attachPaperRecoverySlot(vaultMeta, keyring) {
  if (!vaultMeta || Number(vaultMeta.version) !== 2 || !keyring?.dek) {
    throw new Error('Unlock a v2 Envelope Vault first before generating a Paper Recovery Key.');
  }
  const recoveryCode = generateRecoveryCode();
  const recoverySlot = await createRecoverySlot(recoveryCode, keyring.dek);
  const nonRecoverySlots = (Array.isArray(vaultMeta.keySlots) ? vaultMeta.keySlots : []).filter(
    (s) => s && s.type !== 'recovery'
  );

  const nextVault = {
    ...vaultMeta,
    keySlots: [...nonRecoverySlots, recoverySlot],
    updatedAt: new Date().toISOString(),
  };

  return { recoveryCode, recoverySlot, vaultMeta: nextVault };
}

export async function createEnvelopeVault(password, options = {}) {
  const dek = options.existingDek || (await generateDEK());
  const dekFingerprint = await computeKeyFingerprint(dek);
  const canary = await encryptText(VAULT_CANARY_PLAINTEXT, dek);
  const primarySlot = await createPasswordSlot(password, dek, {
    id: 'slot-primary-password',
    label: options.slotLabel || 'Master Password',
    iterations: options.iterations || DEFAULT_PBKDF2_ITERATIONS,
  });

  const wrappedLegacyKey = options.legacyKey ? await wrapKeyWithKEK(options.legacyKey, dek) : null;
  const encryptedPat = options.patToken ? await encryptPatToken(options.patToken, dek) : null;

  const nowIso = new Date().toISOString();
  const vaultMeta = {
    version: 2,
    enabled: options.enabled !== undefined ? Boolean(options.enabled) : true,
    architecture: 'envelope-dek-kek',
    aadSupported: true,
    encryptedMediaDefault: true,
    autoLockMinutes: Number.isFinite(Number(options.autoLockMinutes))
      ? Number(options.autoLockMinutes)
      : 15,
    dekFingerprint,
    canary,
    keySlots: [primarySlot],
    wrappedLegacyKey,
    encryptedPat,
    createdAt: options.createdAt || nowIso,
    updatedAt: nowIso,
  };

  return {
    vaultMeta,
    keyring: {
      version: 2,
      dek,
      legacyKey: options.legacyKey || null,
      dekFingerprint,
      matchedSlotId: primarySlot.id,
      unlockedVia: 'password',
    },
  };
}

async function finishEnvelopeUnlock(vaultMeta, dek, slot, unlockedVia) {
  const check = await decryptText(vaultMeta.canary, dek);
  if (check !== VAULT_CANARY_PLAINTEXT) return null;

  let legacyKey = null;
  if (vaultMeta.wrappedLegacyKey?.wrappedKey && vaultMeta.wrappedLegacyKey?.iv) {
    try {
      legacyKey = await unwrapKeyWithKEK(
        vaultMeta.wrappedLegacyKey.wrappedKey,
        vaultMeta.wrappedLegacyKey.iv,
        dek,
        true
      );
    } catch {
      legacyKey = null;
    }
  }

  const dekFingerprint = vaultMeta.dekFingerprint || (await computeKeyFingerprint(dek));
  const keyring = {
    version: 2,
    dek,
    legacyKey,
    dekFingerprint,
    matchedSlotId: slot.id,
    unlockedVia,
  };

  let pat = null;
  if (vaultMeta.encryptedPat) {
    try {
      pat = await decryptPatToken(vaultMeta.encryptedPat, keyring);
    } catch {
      pat = null;
    }
  }

  return { ok: true, version: 2, keyring, pat, unlockedVia };
}

export async function unlockVault(secretInput, vaultMeta) {
  if (!vaultMeta || typeof vaultMeta !== 'object') {
    return { ok: false, error: 'Vault metadata not found.' };
  }

  if (Number(vaultMeta.version) === 2 && Array.isArray(vaultMeta.keySlots)) {
    const pwSlots = vaultMeta.keySlots.filter((s) => s && s.type === 'password');
    for (const slot of pwSlots) {
      try {
        const kek = await deriveKey(
          secretInput,
          slot.salt,
          slot.iterations || DEFAULT_PBKDF2_ITERATIONS,
          false
        );
        const dek = await unwrapKeyWithKEK(slot.wrappedDek, slot.iv, kek, true);
        const done = await finishEnvelopeUnlock(vaultMeta, dek, slot, 'password');
        if (done) return done;
      } catch {
        // try next slot
      }
    }

    if (isRecoveryCodeFormat(secretInput)) {
      const recSlots = vaultMeta.keySlots.filter((s) => s && s.type === 'recovery');
      for (const slot of recSlots) {
        try {
          const kek = await importRecoveryKek(secretInput);
          const dek = await unwrapKeyWithKEK(slot.wrappedDek, slot.iv, kek, true);
          const done = await finishEnvelopeUnlock(vaultMeta, dek, slot, 'recovery');
          if (done) return done;
        } catch {
          // try next slot
        }
      }
    }

    return { ok: false, error: 'Incorrect password or recovery key.' };
  }

  const canaryCipher = vaultMeta.canary || vaultMeta.canaryCipher;
  if (!vaultMeta.salt || !canaryCipher) {
    return { ok: false, error: 'Invalid vault configuration.' };
  }

  try {
    const legacyKey = await deriveKey(
      secretInput,
      vaultMeta.salt,
      vaultMeta.iterations || DEFAULT_PBKDF2_ITERATIONS,
      true
    );
    const decrypted = await decryptText(canaryCipher, { legacyKey, password: secretInput });
    if (decrypted !== VAULT_CANARY_PLAINTEXT) {
      return { ok: false, error: 'Incorrect password.' };
    }

    const dekFingerprint = await computeKeyFingerprint(legacyKey);
    const keyring = {
      version: 1,
      dek: null,
      legacyKey,
      dekFingerprint,
      matchedSlotId: 'legacy-v1',
      unlockedVia: 'password',
    };

    let pat = null;
    if (vaultMeta.encryptedPat) {
      try {
        pat = await decryptPatToken(vaultMeta.encryptedPat, keyring);
      } catch {
        pat = null;
      }
    }

    return { ok: true, version: 1, keyring, pat, unlockedVia: 'password' };
  } catch {
    return { ok: false, error: 'Incorrect password.' };
  }
}

export async function rotateVaultPasswordWithKeyring(vaultMeta, keyring, newPassword, options = {}) {
  if (!newPassword || String(newPassword).length < 4) {
    throw new Error('New master password must be at least 4 characters.');
  }
  if (!keyring?.dek) {
    throw new Error('Active v2 Envelope DEK is required to reset the master password.');
  }

  const { dek, legacyKey, dekFingerprint } = keyring;
  const existingSlots = Array.isArray(vaultMeta.keySlots) ? [...vaultMeta.keySlots] : [];
  const pwIdx = existingSlots.findIndex((s) => s && s.type === 'password');
  const originalSlot = pwIdx >= 0 ? existingSlots[pwIdx] : null;

  const rotatedSlot = await createPasswordSlot(newPassword, dek, {
    id: originalSlot?.id || 'slot-primary-password',
    label: originalSlot?.label || 'Master Password',
    createdAt: originalSlot?.createdAt,
    iterations: options.iterations || DEFAULT_PBKDF2_ITERATIONS,
  });

  if (pwIdx >= 0) {
    existingSlots[pwIdx] = rotatedSlot;
  } else {
    existingSlots.unshift(rotatedSlot);
  }

  let encryptedPat = vaultMeta.encryptedPat || null;
  if (options.encryptPat === false) {
    encryptedPat = null;
  } else if (options.encryptPat === true && options.patToken) {
    encryptedPat = await encryptPatToken(options.patToken, dek);
  }

  const nextVault = {
    ...vaultMeta,
    version: 2,
    aadSupported: true,
    enabled: options.enabled !== undefined ? Boolean(options.enabled) : Boolean(vaultMeta.enabled),
    autoLockMinutes: Number.isFinite(Number(options.autoLockMinutes))
      ? Number(options.autoLockMinutes)
      : Number(vaultMeta.autoLockMinutes ?? 15),
    dekFingerprint,
    keySlots: existingSlots,
    encryptedPat,
    updatedAt: new Date().toISOString(),
  };

  return {
    vaultMeta: nextVault,
    keyring: {
      version: 2,
      dek,
      legacyKey,
      dekFingerprint,
      matchedSlotId: rotatedSlot.id,
      unlockedVia: 'password',
    },
    rotatedInstantly: true,
  };
}

export async function rotateVaultPassword(vaultMeta, currentPassword, newPassword, options = {}) {
  if (!newPassword || String(newPassword).length < 4) {
    throw new Error('New master password must be at least 4 characters.');
  }
  const unlocked = await unlockVault(currentPassword, vaultMeta);
  if (!unlocked.ok) {
    throw new Error('Current master password or recovery key is incorrect.');
  }
  if (unlocked.version === 1) {
    return upgradeLegacyVaultToEnvelope(vaultMeta, currentPassword, { ...options, newPassword });
  }
  return rotateVaultPasswordWithKeyring(vaultMeta, unlocked.keyring, newPassword, options);
}

export async function upgradeLegacyVaultToEnvelope(vaultMeta, currentPassword, options = {}) {
  const unlocked = await unlockVault(currentPassword, vaultMeta);
  if (!unlocked.ok) {
    throw new Error('Current master password is incorrect.');
  }
  if (unlocked.version === 2) {
    return { vaultMeta, keyring: unlocked.keyring, upgraded: false };
  }
  const targetPassword = options.newPassword || currentPassword;
  const patToSave = options.encryptPat === false ? null : options.patToken || unlocked.pat || null;
  const created = await createEnvelopeVault(targetPassword, {
    enabled: options.enabled !== undefined ? Boolean(options.enabled) : Boolean(vaultMeta.enabled),
    autoLockMinutes: options.autoLockMinutes ?? 15,
    legacyKey: unlocked.keyring.legacyKey,
    patToken: options.encryptPat === false ? null : patToSave,
    createdAt: vaultMeta.createdAt,
  });
  return { ...created, upgraded: true };
}

// Backward-compatible legacy helpers
export async function createVaultCanary(password, iterations = DEFAULT_PBKDF2_ITERATIONS) {
  const salt = bytesToBase64(randomBytes(16));
  const key = await deriveKey(password, salt, iterations, false);
  const iv = randomBytes(12);
  const cipherBuf = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    textEncoder.encode(VAULT_CANARY_PLAINTEXT)
  );
  const canary = `${V1_PREFIX}${salt}:${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(cipherBuf))}`;
  return { salt, iterations, canary, canaryCipher: canary };
}

export async function createVaultConfig(password, options = {}) {
  const iterations = Number(options.iterations) || DEFAULT_PBKDF2_ITERATIONS;
  const c = await createVaultCanary(password, iterations);
  return {
    version: 1,
    enabled: options.enabled !== undefined ? Boolean(options.enabled) : true,
    kdf: 'PBKDF2-SHA256',
    iterations,
    salt: c.salt,
    canaryCipher: c.canaryCipher,
    encryptedPat: options.encryptedPat || null,
    updatedAt: new Date().toISOString(),
  };
}

export async function verifyVaultCanary(password, vaultMeta) {
  const res = await unlockVault(password, vaultMeta);
  return Boolean(res.ok);
}

export const verifyVaultPassword = verifyVaultCanary;

export async function encryptPatToken(pat, keyOrKeyringOrPassword, iterations = DEFAULT_PBKDF2_ITERATIONS) {
  if (!pat) return null;
  return encryptText(String(pat).trim(), keyOrKeyringOrPassword, iterations);
}

export async function decryptPatToken(encryptedPat, keyOrKeyringOrPassword, iterations = DEFAULT_PBKDF2_ITERATIONS) {
  if (!encryptedPat) return null;
  return decryptText(encryptedPat, keyOrKeyringOrPassword, iterations);
}

export const encryptPat = encryptPatToken;
export const decryptPat = decryptPatToken;
