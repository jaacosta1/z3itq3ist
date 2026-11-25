/**
 * js/vault-auth.js — Phase 9 Advanced Vault Authentication & Plausible Deniability
 * 1. Biometric / Passkey Unlock via WebAuthn PRF Extension (Face ID, Touch ID, Windows Hello, YubiKey)
 *    deriving a deterministic 256-bit KEK via HKDF-SHA256 to unwrap your Envelope DEK.
 * 2. Plausible Deniability ("Decoy" Vault) with an independent Decoy DEK & encrypted policy
 *    so entering the decoy password opens a seamless casual diary with zero visible trace of hidden entries.
 * 3. Double-Lock Entries protected by an independent per-entry second passphrase (PBKDF2-SHA256 + AES-256-GCM AAD).
 */

import {
  VAULT_CANARY_PLAINTEXT,
  DEFAULT_PBKDF2_ITERATIONS,
  bytesToBase64,
  base64ToBytes,
  randomBytes,
  deriveKey,
  generateDEK,
  computeKeyFingerprint,
  wrapKeyWithKEK,
  unwrapKeyWithKEK,
  encryptText,
  decryptText,
  decryptPatToken,
  unlockVault,
  createPasswordSlot,
} from './crypto.js';

const DOUBLE_LOCK_PREFIX = 'DLOCK:PBKDF2:AES256GCM:v1:';
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/* ============================================================================
   1. DOUBLE-LOCK ENTRIES (PER-ENTRY SECOND PASSPHRASE + AAD)
   ============================================================================ */

/**
 * Detects whether a decrypted (or plaintext) string is sealed with a Double-Lock passphrase.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isDoubleLockedPayload(value) {
  return typeof value === 'string' && value.startsWith(DOUBLE_LOCK_PREFIX);
}

/**
 * Builds canonical AAD binding a double-locked entry field to its exact calendar date & year.
 * @param {string} diaryDate
 * @param {string | number} year
 * @param {string} [field='body']
 * @returns {string}
 */
export function buildDoubleLockAad(diaryDate, year, field = 'body') {
  return `perpetual:v1:doublelock:${String(diaryDate || '').trim()}:${String(year || '').trim()}:${String(
    field || 'body'
  ).trim()}`;
}

/**
 * Encrypts sensitive prose or a title under an independent second passphrase using
 * PBKDF2-SHA256 (250,000 iterations) + AES-256-GCM with AAD date binding.
 * @param {string} plaintext
 * @param {string} secondPassphrase
 * @param {string} aad
 * @returns {Promise<string>}
 */
export async function encryptDoubleLockedText(plaintext, secondPassphrase, aad = '') {
  if (!secondPassphrase || String(secondPassphrase).length < 4) {
    throw new Error('Double-Lock passphrase must be at least 4 characters.');
  }
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(secondPassphrase, salt, DEFAULT_PBKDF2_ITERATIONS, false);
  const aadStr = String(aad || '').trim();
  const algo = aadStr
    ? { name: 'AES-GCM', iv, additionalData: textEncoder.encode(aadStr) }
    : { name: 'AES-GCM', iv };

  const cipherBuf = await window.crypto.subtle.encrypt(
    algo,
    key,
    textEncoder.encode(String(plaintext ?? ''))
  );

  return `${DOUBLE_LOCK_PREFIX}${bytesToBase64(salt)}:${bytesToBase64(iv)}:${bytesToBase64(
    new Uint8Array(cipherBuf)
  )}`;
}

/**
 * Decrypts a Double-Locked entry field using the per-entry second passphrase.
 * @param {string} payload
 * @param {string} secondPassphrase
 * @param {string} aad
 * @returns {Promise<string>}
 */
export async function decryptDoubleLockedText(payload, secondPassphrase, aad = '') {
  if (!isDoubleLockedPayload(payload)) return String(payload ?? '');
  const body = payload.slice(DOUBLE_LOCK_PREFIX.length);
  const parts = body.split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed Double-Lock payload.');
  }

  const [saltB64, ivB64, cipherB64] = parts;
  const key = await deriveKey(secondPassphrase, saltB64, DEFAULT_PBKDF2_ITERATIONS, false);
  const iv = base64ToBytes(ivB64);
  const cipherBytes = base64ToBytes(cipherB64);
  const aadStr = String(aad || '').trim();
  const algo = aadStr
    ? { name: 'AES-GCM', iv, additionalData: textEncoder.encode(aadStr) }
    : { name: 'AES-GCM', iv };

  try {
    const plainBuf = await window.crypto.subtle.decrypt(algo, key, cipherBytes);
    return textDecoder.decode(plainBuf);
  } catch {
    throw new Error('Incorrect Double-Lock passphrase or integrity mismatch.');
  }
}

/* ============================================================================
   2. BIOMETRIC / PASSKEY UNLOCK (WEBAUTHN PRF EXTENSION)
   ============================================================================ */

/**
 * Checks whether the current browser & secure context expose WebAuthn PublicKeyCredential APIs.
 * @returns {boolean}
 */
export function isWebAuthnSupported() {
  return Boolean(
    typeof window !== 'undefined' &&
      window.isSecureContext &&
      window.PublicKeyCredential &&
      navigator.credentials &&
      typeof navigator.credentials.create === 'function' &&
      typeof navigator.credentials.get === 'function'
  );
}

/**
 * Checks whether the current vault has at least one registered Passkey PRF slot.
 * @param {Object | null} vaultMeta
 * @returns {boolean}
 */
export function hasPasskeySlots(vaultMeta) {
  return Boolean(
    vaultMeta &&
      Number(vaultMeta.version) === 2 &&
      Array.isArray(vaultMeta.keySlots) &&
      vaultMeta.keySlots.some((s) => s && s.type === 'passkey')
  );
}

/**
 * Derives an AES-256-GCM wrapping KEK from a 32-byte WebAuthn PRF output via HKDF-SHA256.
 * @param {ArrayBuffer | Uint8Array} prfOutput
 * @param {Uint8Array} saltBytes
 * @returns {Promise<CryptoKey>}
 */
async function deriveKekFromPrfOutput(prfOutput, saltBytes) {
  const rawBytes = prfOutput instanceof Uint8Array ? prfOutput : new Uint8Array(prfOutput);
  if (rawBytes.byteLength < 16) {
    throw new Error('Authenticator returned an invalid PRF output.');
  }
  const hkdfBase = await window.crypto.subtle.importKey('raw', rawBytes, 'HKDF', false, [
    'deriveKey',
  ]);
  return window.crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: saltBytes,
      info: textEncoder.encode('perpetual:v1:webauthn-prf-kek'),
    },
    hkdfBase,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey']
  );
}

/**
 * Registers a new platform/hardware Passkey (Touch ID, Face ID, Windows Hello, YubiKey)
 * using the WebAuthn PRF extension and wraps the active v2 Envelope DEK into a new key slot.
 * @param {Object} vaultMeta
 * @param {Object} keyring
 * @param {{ label?: string }} [options]
 * @returns {Promise<{ slot: Object, vaultMeta: Object }>}
 */
export async function registerPasskeySlot(vaultMeta, keyring, options = {}) {
  if (!isWebAuthnSupported()) {
    throw new Error('WebAuthn Passkeys require HTTPS (or localhost) and a modern browser.');
  }
  if (!vaultMeta || Number(vaultMeta.version) !== 2 || !keyring?.dek) {
    throw new Error('Unlock a v2 Envelope Vault first before registering a biometric passkey.');
  }
  if (keyring.isDecoy) {
    throw new Error('Passkey enrollment is unavailable in this session.');
  }

  const rpId = window.location.hostname || 'localhost';
  const label = String(options.label || 'Biometric Passkey').trim() || 'Biometric Passkey';
  const prfSaltBytes = randomBytes(32);
  const challenge = randomBytes(32);
  const userId = randomBytes(16);

  const createCred = await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: {
        name: 'Perpetual Diary Vault',
        id: rpId,
      },
      user: {
        id: userId,
        name: `vault-${vaultMeta.dekFingerprint || 'owner'}`,
        displayName: label,
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 }, // ES256
        { type: 'public-key', alg: -257 }, // RS256
      ],
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'required',
      },
      timeout: 60000,
      extensions: {
        prf: {
          eval: {
            first: prfSaltBytes,
          },
        },
      },
    },
  });

  if (!createCred || !createCred.rawId) {
    throw new Error('Passkey registration was cancelled.');
  }

  const createExt = createCred.getClientExtensionResults?.() || {};
  const prfExt = createExt.prf || {};
  let prfFirstOutput = prfExt.results?.first || null;

  // Most browsers enable PRF during create() and evaluate the secret on the first get() assertion
  if (!prfFirstOutput) {
    if (prfExt.enabled === false) {
      throw new Error(
        'Your current authenticator or browser does not support the WebAuthn PRF extension required for encryption.'
      );
    }

    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: randomBytes(32),
        rpId,
        allowCredentials: [{ type: 'public-key', id: createCred.rawId }],
        userVerification: 'required',
        timeout: 60000,
        extensions: {
          prf: {
            eval: {
              first: prfSaltBytes,
            },
          },
        },
      },
    });

    const getExt = assertion?.getClientExtensionResults?.() || {};
    prfFirstOutput = getExt.prf?.results?.first || null;
  }

  if (!prfFirstOutput) {
    throw new Error(
      'Authenticator did not return a WebAuthn PRF key output. Try Chrome, Edge, Safari 18+, or Firefox with Windows Hello / Touch ID / YubiKey.'
    );
  }

  const kek = await deriveKekFromPrfOutput(prfFirstOutput, prfSaltBytes);
  const { iv, wrappedKey } = await wrapKeyWithKEK(keyring.dek, kek);
  const nowIso = new Date().toISOString();

  const slot = {
    id: `slot-passkey-${Date.now().toString(36)}`,
    type: 'passkey',
    label,
    rpId,
    credentialId: bytesToBase64(new Uint8Array(createCred.rawId)),
    prfSalt: bytesToBase64(prfSaltBytes),
    iv,
    wrappedDek: wrappedKey,
    createdAt: nowIso,
    rotatedAt: nowIso,
  };

  const nextVault = {
    ...vaultMeta,
    keySlots: [...(Array.isArray(vaultMeta.keySlots) ? vaultMeta.keySlots : []), slot],
    updatedAt: nowIso,
  };

  return { slot, vaultMeta: nextVault };
}

/**
 * Unlocks a v2 Envelope Vault using a previously registered WebAuthn PRF Passkey.
 * @param {Object} vaultMeta
 * @returns {Promise<{ ok: boolean, version?: number, keyring?: Object, pat?: string | null, unlockedVia?: string, error?: string }>}
 */
export async function unlockVaultWithPasskey(vaultMeta) {
  if (!isWebAuthnSupported()) {
    return { ok: false, error: 'WebAuthn Passkeys are not supported in this browser context.' };
  }
  if (!hasPasskeySlots(vaultMeta)) {
    return { ok: false, error: 'No biometric passkey is registered for this vault.' };
  }

  const passkeySlots = vaultMeta.keySlots.filter((s) => s && s.type === 'passkey' && s.credentialId);
  const rpId = window.location.hostname || passkeySlots[0].rpId || 'localhost';

  const allowCredentials = passkeySlots.map((slot) => ({
    type: 'public-key',
    id: base64ToBytes(slot.credentialId),
  }));

  // Build evalByCredential map for multi-passkey support (with fallback eval.first for single slot)
  const evalByCredential = {};
  for (const slot of passkeySlots) {
    evalByCredential[slot.credentialId] = {
      first: base64ToBytes(slot.prfSalt),
    };
  }

  const prfExtensionPayload =
    passkeySlots.length === 1
      ? { eval: { first: base64ToBytes(passkeySlots[0].prfSalt) } }
      : { evalByCredential, eval: { first: base64ToBytes(passkeySlots[0].prfSalt) } };

  try {
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: randomBytes(32),
        rpId,
        allowCredentials,
        userVerification: 'required',
        timeout: 60000,
        extensions: {
          prf: prfExtensionPayload,
        },
      },
    });

    if (!assertion || !assertion.rawId) {
      return { ok: false, error: 'Passkey verification was cancelled.' };
    }

    const matchedIdB64 = bytesToBase64(new Uint8Array(assertion.rawId));
    const slot =
      passkeySlots.find((s) => s.credentialId === matchedIdB64) || passkeySlots[0];
    const prfOutput = assertion.getClientExtensionResults?.()?.prf?.results?.first;

    if (!prfOutput) {
      return {
        ok: false,
        error: 'Passkey verified, but this device did not return a PRF encryption key.',
      };
    }

    const kek = await deriveKekFromPrfOutput(prfOutput, base64ToBytes(slot.prfSalt));
    const dek = await unwrapKeyWithKEK(slot.wrappedDek, slot.iv, kek, true);
    const canaryCheck = await decryptText(vaultMeta.canary, dek);
    if (canaryCheck !== VAULT_CANARY_PLAINTEXT) {
      return { ok: false, error: 'Passkey unwrapped an invalid vault key.' };
    }

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
      unlockedVia: 'passkey',
      isDecoy: false,
    };

    let pat = null;
    if (vaultMeta.encryptedPat) {
      try {
        pat = await decryptPatToken(vaultMeta.encryptedPat, keyring);
      } catch {
        pat = null;
      }
    }

    return { ok: true, version: 2, keyring, pat, unlockedVia: 'passkey', isDecoy: false };
  } catch (err) {
    return {
      ok: false,
      error: err?.name === 'NotAllowedError' ? 'Biometric prompt dismissed or timed out.' : err.message,
    };
  }
}

/**
 * Revokes a registered Passkey slot from `vault.json`.
 * @param {Object} vaultMeta
 * @param {string} slotId
 * @returns {Object}
 */
export function removePasskeySlot(vaultMeta, slotId) {
  const slots = Array.isArray(vaultMeta?.keySlots) ? vaultMeta.keySlots : [];
  return {
    ...vaultMeta,
    keySlots: slots.filter((s) => !(s && s.type === 'passkey' && s.id === slotId)),
    updatedAt: new Date().toISOString(),
  };
}

/* ============================================================================
   3. PLAUSIBLE DENIABILITY ("DECOY" VAULT)
   ============================================================================ */

/**
 * Configures or rotates a Plausible Deniability Decoy Password inside `vaultMeta`.
 * Uses a completely separate random 256-bit Decoy DEK so the Decoy password can NEVER
 * unwrap the real DEK or decrypt real entries.
 *
 * @param {Object} vaultMeta
 * @param {string} decoyPassword
 * @param {{ includePlaintext?: boolean, allowedTags?: string[] }} [policy]
 * @returns {Promise<{ vaultMeta: Object, decoyFingerprint: string }>}
 */
export async function configureDecoyVault(vaultMeta, decoyPassword, policy = {}) {
  if (!vaultMeta || Number(vaultMeta.version) !== 2) {
    throw new Error('Upgrade to a v2 Envelope Vault first before configuring a Decoy Vault.');
  }
  if (!decoyPassword || String(decoyPassword).length < 4) {
    throw new Error('Decoy password must be at least 4 characters.');
  }

  // Guard: ensure the decoy password is not identical to the real master password
  const realCollision = await unlockVault(decoyPassword, vaultMeta);
  if (realCollision.ok) {
    throw new Error('Decoy password must be different from your real Master Password.');
  }

  const decoyDek = await generateDEK();
  const decoyFingerprint = await computeKeyFingerprint(decoyDek);
  const decoyCanary = await encryptText(VAULT_CANARY_PLAINTEXT, decoyDek);
  const decoySlot = await createPasswordSlot(decoyPassword, decoyDek, {
    id: 'slot-decoy-password',
    label: 'Secondary Profile',
  });

  const cleanPolicy = {
    includePlaintext: policy.includePlaintext !== undefined ? Boolean(policy.includePlaintext) : true,
    allowedTags: Array.isArray(policy.allowedTags)
      ? policy.allowedTags.map((t) => String(t || '').trim().toLowerCase()).filter(Boolean)
      : [],
  };
  const encryptedPolicy = await encryptText(JSON.stringify(cleanPolicy), decoyDek);

  const nextVault = {
    ...vaultMeta,
    // Stored under neutral key name "altProfile" so inspecting vault.json gives minimal hint
    altProfile: {
      version: 1,
      dekFingerprint: decoyFingerprint,
      canary: decoyCanary,
      slot: decoySlot,
      policy: encryptedPolicy,
      updatedAt: new Date().toISOString(),
    },
    updatedAt: new Date().toISOString(),
  };

  return { vaultMeta: nextVault, decoyFingerprint };
}

/**
 * Removes the Decoy Vault profile from `vaultMeta`.
 * @param {Object} vaultMeta
 * @returns {Object}
 */
export function removeDecoyVault(vaultMeta) {
  const next = { ...(vaultMeta || {}), updatedAt: new Date().toISOString() };
  delete next.altProfile;
  return next;
}

/**
 * Attempts real vault unlock first (Master Password or Paper Recovery Key),
 * then silently falls back to the Plausible Deniability Decoy profile if configured.
 * @param {string} secretInput
 * @param {Object} vaultMeta
 */
export async function unlockVaultOrDecoy(secretInput, vaultMeta) {
  const realRes = await unlockVault(secretInput, vaultMeta);
  if (realRes.ok) {
    return {
      ...realRes,
      isDecoy: false,
      decoyPolicy: null,
      keyring: { ...realRes.keyring, isDecoy: false },
    };
  }

  const alt = vaultMeta?.altProfile;
  if (!alt || !alt.slot || !alt.canary) {
    return realRes;
  }

  try {
    const kek = await deriveKey(
      secretInput,
      alt.slot.salt,
      alt.slot.iterations || DEFAULT_PBKDF2_ITERATIONS,
      false
    );
    const decoyDek = await unwrapKeyWithKEK(alt.slot.wrappedDek, alt.slot.iv, kek, true);
    const check = await decryptText(alt.canary, decoyDek);
    if (check !== VAULT_CANARY_PLAINTEXT) {
      return realRes;
    }

    let decoyPolicy = { includePlaintext: true, allowedTags: [] };
    if (alt.policy) {
      try {
        const plainPol = await decryptText(alt.policy, decoyDek);
        decoyPolicy = { ...decoyPolicy, ...(JSON.parse(plainPol) || {}) };
      } catch {
        // default decoy policy
      }
    }

    const dekFingerprint = alt.dekFingerprint || (await computeKeyFingerprint(decoyDek));
    return {
      ok: true,
      version: 2,
      isDecoy: true,
      decoyPolicy,
      pat: null,
      unlockedVia: 'password',
      keyring: {
        version: 2,
        dek: decoyDek,
        legacyKey: null,
        dekFingerprint,
        matchedSlotId: alt.slot.id,
        unlockedVia: 'password',
        isDecoy: true,
      },
    };
  } catch {
    return realRes;
  }
}
