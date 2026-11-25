// js/crypto.js — Client-Side Envelope Cryptography (DEK/KEK + v3 AES-GCM AAD Tamper Binding)
// Supports v3 (DEK + AAD), v2 (DEK), and v1 (Legacy direct PBKDF2) decryption seamlessly.

export const VAULT_CANARY_PLAINTEXT = 'PERPETUAL_VAULT_OK';
export const DEFAULT_PBKDF2_ITERATIONS = 250000;

const V3_PREFIX = 'ENC:AES256GCM:v3:';
const V2_PREFIX = 'ENC:AES256GCM:v2:';
const V1_PREFIX = 'ENC:AES256GCM:v1:';

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

export function randomBytes(length) {
  const buf = new Uint8Array(length);
  window.crypto.getRandomValues(buf);
  return buf;
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

function resolvePrimaryKey(keyOrKeyring) {
  if (!keyOrKeyring) return null;
  if (keyOrKeyring instanceof CryptoKey) return keyOrKeyring;
  return keyOrKeyring.dek || keyOrKeyring.legacyKey || null;
}

export async function deriveKey(
  password,
  saltB64,
  iterations = DEFAULT_PBKDF2_ITERATIONS,
  extractable = false
) {
  const enc = new TextEncoder();
  const baseKey = await window.crypto.subtle.importKey(
    'raw',
    enc.encode(String(password ?? '')),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  const salt = typeof saltB64 === 'string' ? base64ToBytes(saltB64) : new Uint8Array(saltB64);

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

export async function generateDEK() {
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
  const wrapped = await window.crypto.subtle.wrapKey(
    'raw',
    targetKey,
    kek,
    { name: 'AES-GCM', iv }
  );
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

export async function encryptText(plaintext, keyOrKeyring, aad = '') {
  const key = resolvePrimaryKey(keyOrKeyring);
  if (!key) {
    throw new Error('No encryption key available in session.');
  }
  const iv = randomBytes(12);
  const enc = new TextEncoder();
  const data = enc.encode(String(plaintext ?? ''));
  const aadStr = String(aad || '').trim();

  if (aadStr) {
    const cipherBuffer = await window.crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv,
        additionalData: enc.encode(aadStr),
      },
      key,
      data
    );
    return `${V3_PREFIX}${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(cipherBuffer))}`;
  }

  const cipherBuffer = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    data
  );
  return `${V2_PREFIX}${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(cipherBuffer))}`;
}

async function decryptAesGcmRaw(ivB64, cipherB64, key, aadStr = '') {
  const iv = base64ToBytes(ivB64);
  const cipherBytes = base64ToBytes(cipherB64);
  const algo = aadStr
    ? { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aadStr) }
    : { name: 'AES-GCM', iv };

  const plainBuf = await window.crypto.subtle.decrypt(algo, key, cipherBytes);
  return new TextDecoder().decode(plainBuf);
}

export async function decryptText(payload, keyOrKeyring, aad = '') {
  if (typeof payload !== 'string' || !isEncryptedPayload(payload)) {
    return String(payload ?? '');
  }

  const dek =
    keyOrKeyring instanceof CryptoKey ? keyOrKeyring : keyOrKeyring?.dek || null;
  const legacyKey =
    keyOrKeyring instanceof CryptoKey ? keyOrKeyring : keyOrKeyring?.legacyKey || null;
  const sessionPassword =
    keyOrKeyring && !(keyOrKeyring instanceof CryptoKey) ? keyOrKeyring.password || null : null;

  const parts = payload.split(':');
  const aadStr = String(aad || '').trim();

  // v3 format (AAD Tamper-Bound): ENC:AES256GCM:v3:<ivB64>:<cipherB64>
  if (payload.startsWith(V3_PREFIX) && parts.length === 5) {
    const [, , , ivB64, cipherB64] = parts;
    const candidates = [dek, legacyKey].filter(Boolean);
    for (const key of candidates) {
      try {
        return await decryptAesGcmRaw(ivB64, cipherB64, key, aadStr);
      } catch {
        // try next candidate
      }
    }
    const tamperErr = new Error(
      'Cryptographic integrity check failed (AAD mismatch or tampered ciphertext).'
    );
    tamperErr.code = 'AAD_TAMPER_ERROR';
    tamperErr.isTamperSuspected = true;
    throw tamperErr;
  }

  // v2 format (Envelope DEK without AAD): ENC:AES256GCM:v2:<ivB64>:<cipherB64>
  if (payload.startsWith(V2_PREFIX) && parts.length === 5) {
    const [, , , ivB64, cipherB64] = parts;
    const candidates = [dek, legacyKey].filter(Boolean);
    for (const key of candidates) {
      try {
        return await decryptAesGcmRaw(ivB64, cipherB64, key);
      } catch {
        // try next key candidate
      }
    }
    const err = new Error('Unable to decrypt v2 ciphertext with active session key.');
    err.code = 'DECRYPT_FAILED';
    throw err;
  }

  // v1 format (Legacy): ENC:AES256GCM:v1:<saltB64>:<ivB64>:<cipherB64>
  if (payload.startsWith(V1_PREFIX)) {
    const hasEmbeddedSalt = parts.length === 6;
    const saltB64 = hasEmbeddedSalt ? parts[3] : null;
    const ivB64 = hasEmbeddedSalt ? parts[4] : parts[3];
    const cipherB64 = hasEmbeddedSalt ? parts[5] : parts[4];

    const candidates = [legacyKey, dek].filter(Boolean);
    for (const key of candidates) {
      try {
        return await decryptAesGcmRaw(ivB64, cipherB64, key);
      } catch {
        // try next key candidate
      }
    }

    if (hasEmbeddedSalt && saltB64 && sessionPassword) {
      try {
        const derived = await deriveKey(sessionPassword, saltB64, DEFAULT_PBKDF2_ITERATIONS, false);
        return await decryptAesGcmRaw(ivB64, cipherB64, derived);
      } catch {
        // fall through to error
      }
    }

    const err = new Error('Unable to decrypt v1 ciphertext with active session key.');
    err.code = 'DECRYPT_FAILED';
    throw err;
  }

  throw new Error('Unsupported ciphertext envelope format.');
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

export async function createEnvelopeVault(password, options = {}) {
  const dek = options.existingDek || (await generateDEK());
  const dekFingerprint = await computeKeyFingerprint(dek);
  const canary = await encryptText(VAULT_CANARY_PLAINTEXT, dek);
  const primarySlot = await createPasswordSlot(password, dek, {
    id: 'slot-primary-password',
    label: options.slotLabel || 'Master Password',
    iterations: options.iterations || DEFAULT_PBKDF2_ITERATIONS,
  });

  let wrappedLegacyKey = null;
  if (options.legacyKey) {
    wrappedLegacyKey = await wrapKeyWithKEK(options.legacyKey, dek);
  }

  let encryptedPat = null;
  if (options.patToken) {
    encryptedPat = await encryptPatToken(options.patToken, dek);
  }

  const nowIso = new Date().toISOString();
  const vaultMeta = {
    version: 2,
    enabled: options.enabled !== undefined ? Boolean(options.enabled) : true,
    architecture: 'envelope-dek-kek',
    aadSupported: true,
    autoLockMinutes:
      Number.isFinite(Number(options.autoLockMinutes)) ? Number(options.autoLockMinutes) : 15,
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
    },
  };
}

export async function unlockVault(password, vaultMeta) {
  if (!vaultMeta || typeof vaultMeta !== 'object') {
    return { ok: false, error: 'Vault metadata not found.' };
  }

  // v2 Envelope Vault
  if (Number(vaultMeta.version) === 2 && Array.isArray(vaultMeta.keySlots)) {
    const pwSlots = vaultMeta.keySlots.filter((s) => s && s.type === 'password');
    for (const slot of pwSlots) {
      try {
        const kek = await deriveKey(
          password,
          slot.salt,
          slot.iterations || DEFAULT_PBKDF2_ITERATIONS,
          false
        );
        const dek = await unwrapKeyWithKEK(slot.wrappedDek, slot.iv, kek, true);
        const check = await decryptText(vaultMeta.canary, dek);
        if (check !== VAULT_CANARY_PLAINTEXT) continue;

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
        };

        let pat = null;
        if (vaultMeta.encryptedPat) {
          try {
            pat = await decryptPatToken(vaultMeta.encryptedPat, keyring);
          } catch {
            pat = null;
          }
        }

        return { ok: true, version: 2, keyring, pat };
      } catch {
        // try next slot
      }
    }
    return { ok: false, error: 'Incorrect password.' };
  }

  // Legacy v1 Vault fallback
  const canaryCipher = vaultMeta.canary || vaultMeta.canaryCipher;
  if (!vaultMeta.salt || !canaryCipher) {
    return { ok: false, error: 'Invalid vault configuration.' };
  }

  try {
    const legacyKey = await deriveKey(
      password,
      vaultMeta.salt,
      vaultMeta.iterations || DEFAULT_PBKDF2_ITERATIONS,
      true
    );
    const decrypted = await decryptText(canaryCipher, { legacyKey, password });
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
    };

    let pat = null;
    if (vaultMeta.encryptedPat) {
      try {
        pat = await decryptPatToken(vaultMeta.encryptedPat, keyring);
      } catch {
        pat = null;
      }
    }

    return { ok: true, version: 1, keyring, pat };
  } catch {
    return { ok: false, error: 'Incorrect password.' };
  }
}

export async function rotateVaultPassword(
  vaultMeta,
  currentPassword,
  newPassword,
  options = {}
) {
  if (!newPassword || String(newPassword).length < 4) {
    throw new Error('New master password must be at least 4 characters.');
  }

  const unlocked = await unlockVault(currentPassword, vaultMeta);
  if (!unlocked.ok) {
    throw new Error('Current master password is incorrect.');
  }

  if (unlocked.version === 1) {
    return upgradeLegacyVaultToEnvelope(vaultMeta, currentPassword, {
      ...options,
      newPassword,
    });
  }

  const { dek, legacyKey, dekFingerprint, matchedSlotId } = unlocked.keyring;
  const existingSlots = Array.isArray(vaultMeta.keySlots) ? [...vaultMeta.keySlots] : [];
  const targetIdx = existingSlots.findIndex((s) => s.id === matchedSlotId);
  const originalSlot = targetIdx >= 0 ? existingSlots[targetIdx] : null;

  const rotatedSlot = await createPasswordSlot(newPassword, dek, {
    id: originalSlot?.id || 'slot-primary-password',
    label: originalSlot?.label || 'Master Password',
    createdAt: originalSlot?.createdAt,
    iterations: options.iterations || DEFAULT_PBKDF2_ITERATIONS,
  });

  if (targetIdx >= 0) {
    existingSlots[targetIdx] = rotatedSlot;
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
    },
    rotatedInstantly: true,
  };
}

export async function upgradeLegacyVaultToEnvelope(vaultMeta, currentPassword, options = {}) {
  const unlocked = await unlockVault(currentPassword, vaultMeta);
  if (!unlocked.ok) {
    throw new Error('Current master password is incorrect.');
  }

  if (unlocked.version === 2) {
    return {
      vaultMeta,
      keyring: unlocked.keyring,
      upgraded: false,
    };
  }

  const targetPassword = options.newPassword || currentPassword;
  const patToSave =
    options.encryptPat === false
      ? null
      : options.patToken || unlocked.pat || null;

  const created = await createEnvelopeVault(targetPassword, {
    enabled: options.enabled !== undefined ? Boolean(options.enabled) : Boolean(vaultMeta.enabled),
    autoLockMinutes: options.autoLockMinutes ?? 15,
    legacyKey: unlocked.keyring.legacyKey,
    patToken: options.encryptPat === false ? null : patToSave,
    createdAt: vaultMeta.createdAt,
  });

  return {
    ...created,
    upgraded: true,
  };
}

// Backward-compatible legacy helper exports
export async function createVaultCanary(password, iterations = DEFAULT_PBKDF2_ITERATIONS) {
  const salt = bytesToBase64(randomBytes(16));
  const key = await deriveKey(password, salt, iterations, false);
  const iv = randomBytes(12);
  const cipherBuf = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(VAULT_CANARY_PLAINTEXT)
  );
  const canary = `${V1_PREFIX}${salt}:${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(cipherBuf))}`;
  return { salt, iterations, canary, canaryCipher: canary };
}

export async function verifyVaultCanary(password, vaultMeta) {
  const res = await unlockVault(password, vaultMeta);
  return Boolean(res.ok);
}

export async function encryptPatToken(pat, keyOrKeyring) {
  if (!pat) return null;
  return encryptText(String(pat), keyOrKeyring);
}

export async function decryptPatToken(encryptedPat, keyOrKeyring) {
  if (!encryptedPat) return null;
  return decryptText(encryptedPat, keyOrKeyring);
}
