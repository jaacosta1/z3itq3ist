/**
 * js/cloak.js — Metadata Cloaking Engine (Phase 8)
 * Eliminates plaintext metadata leakage on GitHub:
 * 1. Encrypted Manifest (`data/index.enc`) hides writing dates, tags, moods, and word counts.
 * 2. HMAC-SHA256 Day Shards (`data/shards/<24-hex>.enc`) obfuscate `MM-DD` filenames
 *    and seal the entire day document (tags, moods, timestamps, authors, quotes, and prose).
 * 3. Generic Commit Messages (`sync: update`) prevent timeline/activity profiling in Git logs.
 * 4. One-click atomic repository migration from plaintext `days/*.json` + `index.json` to cloaked shards.
 */

import { encryptText, decryptText, bytesToHex, isEncryptedPayload } from './crypto.js';

export const GENERIC_COMMIT_MESSAGE = 'sync: update';
export const CLOAKED_SHARD_FORMAT = 'perpetual-cloaked-shard-v1';
export const CLOAKED_INDEX_AAD = 'perpetual:v3:manifest:index';

const textEncoder = new TextEncoder();

// Cache derived HMAC CryptoKeys per DEK fingerprint in volatile RAM only
const hmacKeyCache = new WeakMap();

/**
 * Resolves the primary active AES-GCM CryptoKey from a keyring or direct CryptoKey.
 * @param {CryptoKey | Object | null} keyOrKeyring
 * @returns {CryptoKey | null}
 */
function resolveMasterKey(keyOrKeyring) {
  if (!keyOrKeyring) return null;
  if (keyOrKeyring instanceof CryptoKey) return keyOrKeyring;
  return keyOrKeyring.dek || keyOrKeyring.legacyKey || null;
}

/**
 * Derives a domain-separated HMAC-SHA256 key from the active extractable DEK.
 * Requires no second password; stays strictly in volatile browser memory.
 * @param {CryptoKey | Object} keyOrKeyring
 * @returns {Promise<CryptoKey>}
 */
export async function deriveCloakHmacKey(keyOrKeyring) {
  const masterKey = resolveMasterKey(keyOrKeyring);
  if (!masterKey) {
    throw new Error('Unlock your Vault first to derive the metadata cloaking HMAC key.');
  }

  if (hmacKeyCache.has(masterKey)) {
    return hmacKeyCache.get(masterKey);
  }

  const rawDek = new Uint8Array(await window.crypto.subtle.exportKey('raw', masterKey));
  const domainTag = textEncoder.encode('perpetual:v1:hmac-shard-key:');
  const combined = new Uint8Array(domainTag.length + rawDek.length);
  combined.set(domainTag, 0);
  combined.set(rawDek, domainTag.length);

  const derivedBytes = await window.crypto.subtle.digest('SHA-256', combined);
  const hmacKey = await window.crypto.subtle.importKey(
    'raw',
    derivedBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  hmacKeyCache.set(masterKey, hmacKey);
  return hmacKey;
}

/**
 * Deterministically maps a calendar day (`MM-DD`) to an opaque HMAC shard path:
 *   `11-24` -> `shards/a9f3c1...24hex.enc`
 * @param {string} dayStr
 * @param {CryptoKey | Object} keyOrKeyring
 * @returns {Promise<string>}
 */
export async function computeDayShardSubpath(dayStr, keyOrKeyring) {
  const cleanDay = String(dayStr || '').trim();
  const hmacKey = await deriveCloakHmacKey(keyOrKeyring);
  const sig = await window.crypto.subtle.sign(
    'HMAC',
    hmacKey,
    textEncoder.encode(`perpetual:v1:day-shard:${cleanDay}`)
  );
  const shortHex = bytesToHex(new Uint8Array(sig)).slice(0, 24);
  return `shards/${shortHex}.enc`;
}

/**
 * Encrypts the entire 366-day manifest object into a tamper-bound ciphertext envelope for `index.enc`.
 * @param {Object} indexObj
 * @param {CryptoKey | Object} keyOrKeyring
 * @returns {Promise<string>}
 */
export async function encryptManifestIndex(indexObj, keyOrKeyring) {
  const serialized = JSON.stringify(indexObj || { version: 1, updatedAt: '', days: {} });
  const cipher = await encryptText(serialized, keyOrKeyring, CLOAKED_INDEX_AAD);
  return `${JSON.stringify(
    {
      format: 'perpetual-cloaked-index-v1',
      payload: cipher,
    },
    null,
    2
  )}\n`;
}

/**
 * Decrypts `index.enc` back into the standard `{ updatedAt, days }` manifest object.
 * @param {string | Object} rawContent
 * @param {CryptoKey | Object} keyOrKeyring
 * @returns {Promise<Object | null>}
 */
export async function decryptManifestIndex(rawContent, keyOrKeyring) {
  if (!rawContent) return null;
  let parsed = rawContent;
  if (typeof rawContent === 'string') {
    const trimmed = rawContent.trim();
    if (!trimmed) return null;
    if (isEncryptedPayload(trimmed)) {
      const plain = await decryptText(trimmed, keyOrKeyring, CLOAKED_INDEX_AAD);
      return JSON.parse(plain);
    }
    parsed = JSON.parse(trimmed);
  }

  if (parsed && parsed.format === 'perpetual-cloaked-index-v1' && parsed.payload) {
    const plain = await decryptText(parsed.payload, keyOrKeyring, CLOAKED_INDEX_AAD);
    return JSON.parse(plain);
  }

  // Plaintext fallback if caller passed an uncloaked manifest object
  if (parsed && typeof parsed === 'object' && parsed.days) {
    return parsed;
  }

  return null;
}

/**
 * Seals an entire calendar day document (entries, tags, moods, timestamps, comments, quotes)
 * inside a single AES-256-GCM AAD-bound shard payload so zero metadata is readable in GitHub.
 * @param {string} dayStr
 * @param {Object} dayDoc
 * @param {CryptoKey | Object} keyOrKeyring
 * @returns {Promise<string>}
 */
export async function sealDayDocument(dayStr, dayDoc, keyOrKeyring) {
  const aad = `perpetual:v3:shard:${String(dayStr || '').trim()}`;
  const cipher = await encryptText(JSON.stringify(dayDoc), keyOrKeyring, aad);
  return `${JSON.stringify(
    {
      format: CLOAKED_SHARD_FORMAT,
      payload: cipher,
    },
    null,
    2
  )}\n`;
}

/**
 * Unseals a cloaked day shard back into `{ day, entries, comments }`.
 * Transparently passes through legacy uncloaked day objects for seamless backward compatibility.
 * @param {string} dayStr
 * @param {string | Object} rawContent
 * @param {CryptoKey | Object} keyOrKeyring
 * @returns {Promise<Object | null>}
 */
export async function unsealDayDocument(dayStr, rawContent, keyOrKeyring) {
  if (!rawContent) return null;
  let parsed = rawContent;
  if (typeof rawContent === 'string') {
    const trimmed = rawContent.trim();
    if (!trimmed) return null;
    parsed = JSON.parse(trimmed);
  }

  if (parsed && parsed.format === CLOAKED_SHARD_FORMAT && parsed.payload) {
    const aad = `perpetual:v3:shard:${String(dayStr || '').trim()}`;
    const plainJson = await decryptText(parsed.payload, keyOrKeyring, aad);
    return JSON.parse(plainJson);
  }

  return parsed;
}

/**
 * Returns a generic non-profiling commit message when generic commits or cloaking is enabled.
 * @param {string} originalMessage
 * @param {boolean} useGeneric
 * @returns {string}
 */
export function sanitizeCommitMessage(originalMessage, useGeneric = false) {
  return useGeneric ? GENERIC_COMMIT_MESSAGE : String(originalMessage || GENERIC_COMMIT_MESSAGE);
}

/**
 * Builds the cloaking transaction adapter consumed by GitHubClient atomic commits.
 * @param {CryptoKey | Object} keyring
 * @param {boolean} useGenericCommits
 */
export function createCloakAdapter(keyring, useGenericCommits = true) {
  return {
    enabled: true,
    genericCommits: Boolean(useGenericCommits),
    indexSubpath: 'index.enc',
    getDaySubpath: (dayStr) => computeDayShardSubpath(dayStr, keyring),
    serializeDay: (dayStr, doc) => sealDayDocument(dayStr, doc, keyring),
    deserializeDay: (dayStr, rawText) => unsealDayDocument(dayStr, rawText, keyring),
    serializeIndex: (idx) => encryptManifestIndex(idx, keyring),
    deserializeIndex: (rawText) => decryptManifestIndex(rawText, keyring),
  };
}

/**
 * Atomically migrates an entire repository from plaintext `days/MM-DD.json` + `index.json`
 * to Metadata-Cloaked HMAC shards (`shards/<hash>.enc`) + `index.enc`, deleting old plaintext
 * files and updating `vault.json` in ONE single generic commit (`sync: update`).
 *
 * @param {{ app: Object, onProgress?: (msg: string) => void }} options
 * @returns {Promise<{ migratedDays: number, commitSha: string }>}
 */
export async function migrateRepositoryToCloakedMode({ app, onProgress = () => {} }) {
  if (!app || !app.hasActiveSessionKey() || Number(app.state.vaultMeta?.version) !== 2) {
    throw new Error(
      'Unlock a v2 Envelope Vault first before migrating your repository to Metadata Cloaking.'
    );
  }

  const keyring = app.state.keyring;
  const dayKeys = Object.keys(app.state.indexData?.days || {}).sort();
  const batchChanges = [];
  let migratedDays = 0;

  for (let i = 0; i < dayKeys.length; i += 1) {
    const dayStr = dayKeys[i];
    onProgress(`Cloaking ${i + 1}/${dayKeys.length} (${dayStr})...`);

    const doc = await app.getDayDocument(dayStr, true);
    const shardSubpath = await computeDayShardSubpath(dayStr, keyring);
    const sealedContent = await sealDayDocument(dayStr, doc, keyring);

    if (app.gh.hasToken()) {
      batchChanges.push({
        subpath: shardSubpath,
        content: sealedContent,
        isBase64: false,
      });

      // Check if a legacy plaintext `days/MM-DD.json` file exists so we only delete real files
      const legacyMeta = await app.gh.getFileMeta(`days/${dayStr}.json`).catch(() => ({ exists: false }));
      if (legacyMeta?.exists) {
        batchChanges.push({
          subpath: `days/${dayStr}.json`,
          delete: true,
        });
      }
    }

    migratedDays += 1;
  }

  const nextVault = {
    ...app.state.vaultMeta,
    metadataCloaking: true,
    genericCommitMessages: true,
    updatedAt: new Date().toISOString(),
  };

  let commitSha = '';
  if (app.gh.hasToken()) {
    onProgress('Encrypting manifest (index.enc) & committing atomically...');
    const encryptedIdx = await encryptManifestIndex(app.state.indexData, keyring);
    batchChanges.push({
      subpath: 'index.enc',
      content: encryptedIdx,
      isBase64: false,
    });

    const legacyIdxMeta = await app.gh.getFileMeta('index.json').catch(() => ({ exists: false }));
    if (legacyIdxMeta?.exists) {
      batchChanges.push({
        subpath: 'index.json',
        delete: true,
      });
    }

    batchChanges.push({
      subpath: 'vault.json',
      content: `${JSON.stringify(nextVault, null, 2)}\n`,
      isBase64: false,
    });

    const res = await app.gh.commitBatch(batchChanges, GENERIC_COMMIT_MESSAGE);
    commitSha = res.commitSha || '';
  }

  app.state.vaultMeta = nextVault;
  app.storageSet('perpetual_diary_vault_local_v1', JSON.stringify(nextVault));
  app.gh.updateConfig({ genericCommitMessages: true });
  if (!app.state.zeroFootprint) {
    app.saveGitHubConfigLocally();
  }

  return { migratedDays, commitSha };
}
