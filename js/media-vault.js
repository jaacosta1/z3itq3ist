/**
 * js/media-vault.js — Batch Plaintext-to-.enc Encrypted Media Vault Migrator
 * Phase 6A:
 * Scans all indexed days, encrypts older plaintext photos stored in data/media/
 * (or IndexedDB in Sandbox Mode) into AAD-bound .enc binary blobs, updates references,
 * and deletes the unencrypted originals in ONE atomic Git commit.
 */

import { encryptBinary, buildMediaAad, isEncryptedMediaPath } from './crypto.js';
import { fetchRawMediaBytes } from './media.js';

/**
 * Encrypts all unencrypted local/GitHub photos referenced by entries and comments.
 * @param {{ app: Object, onProgress?: (msg: string) => void }} options
 * @returns {Promise<{ encryptedCount: number, updatedDays: number, commitSha: string }>}
 */
export async function migratePlaintextMediaToEncryptedVault({
  app,
  onProgress = () => {},
}) {
  if (!app || typeof app.hasActiveSessionKey !== 'function' || !app.hasActiveSessionKey()) {
    throw new Error('Unlock your Vault first before encrypting existing photos.');
  }

  const keyring = app.state.keyring || app.state.cryptoKey;
  const dayKeys = Object.keys(app.state.indexData?.days || {}).sort();
  const basePath = app.gh.getDataTarget().basePath || 'data';
  const basePrefix = `${basePath}/`;

  let encryptedCount = 0;
  let updatedDays = 0;
  const batchChanges = [];

  for (let i = 0; i < dayKeys.length; i += 1) {
    const dayStr = dayKeys[i];
    onProgress(`Scanning ${i + 1}/${dayKeys.length} (${dayStr})...`);
    const doc = await app.getDayDocument(dayStr, true);
    let dirty = false;

    const encryptOneImageObj = async (imgObj) => {
      if (!imgObj || !imgObj.src) return false;
      const src = String(imgObj.src);

      // Skip already-encrypted blobs, external URLs, and inline data URLs
      if (isEncryptedMediaPath(src) || /^https?:\/\//i.test(src) || src.startsWith('data:')) {
        return false;
      }

      const fetched = await fetchRawMediaBytes(
        src,
        app.gh,
        app.state.zeroFootprint ? null : app.mediaStore
      );
      if (!fetched || !fetched.bytes) return false;

      const oldSubpath = fetched.subpath;
      const newSubpath = `${oldSubpath}.enc`;
      const aad = buildMediaAad(newSubpath);
      const encBytes = await encryptBinary(fetched.bytes, keyring, {
        mime: fetched.mime || 'image/webp',
        aad,
      });

      if (app.gh.hasToken() && src.startsWith(basePrefix)) {
        batchChanges.push({
          subpath: newSubpath,
          content: encBytes,
          isBinary: true,
        });
        batchChanges.push({
          subpath: oldSubpath,
          delete: true,
        });
        imgObj.src = `${basePrefix}${newSubpath}`;
        imgObj.encrypted = true;
      } else if (src.startsWith('idb:') || src.startsWith('idb://')) {
        await app.mediaStore.putImage(newSubpath, encBytes, 'application/octet-stream');
        await app.mediaStore.deleteImage(oldSubpath).catch(() => {});
        imgObj.src = `idb:${newSubpath}`;
        imgObj.encrypted = true;
      } else {
        return false;
      }

      encryptedCount += 1;
      return true;
    };

    for (const entry of Object.values(doc.entries || {})) {
      if (entry?.image && (await encryptOneImageObj(entry.image))) {
        entry.updatedAt = new Date().toISOString();
        dirty = true;
      }
    }

    for (const cmt of doc.comments || []) {
      if (cmt?.image && (await encryptOneImageObj(cmt.image))) {
        cmt.updatedAt = new Date().toISOString();
        dirty = true;
      }
    }

    if (dirty) {
      updatedDays += 1;
      app.state.dayCache[dayStr] = doc;
      if (app.gh.hasToken()) {
        batchChanges.push({
          subpath: `days/${dayStr}.json`,
          content: `${JSON.stringify(doc, null, 2)}\n`,
          isBase64: false,
        });
      } else if (typeof app.persistSandboxDay === 'function') {
        await app.persistSandboxDay(dayStr, doc);
      }
    }
  }

  let commitSha = '';
  if (app.gh.hasToken() && batchChanges.length > 0) {
    onProgress(`Committing ${encryptedCount} encrypted photo(s) in 1 atomic commit...`);
    if (typeof app.gh.commitBatch === 'function') {
      const res = await app.gh.commitBatch(
        batchChanges,
        `diary: encrypt ${encryptedCount} photo(s) into .enc media vault`
      );
      commitSha = res.commitSha || '';
    } else {
      for (const ch of batchChanges) {
        if (ch.delete) {
          await app.gh.deleteFile(ch.subpath, `diary: remove plaintext ${ch.subpath}`).catch(() => {});
        } else if (ch.isBinary) {
          await app.gh.uploadBinaryMedia(ch.subpath, ch.content, `diary: encrypt ${ch.subpath}`);
        } else {
          await app.gh.putFile(ch.subpath, ch.content, `diary: update ${ch.subpath}`);
        }
      }
    }
  }

  return { encryptedCount, updatedDays, commitSha };
}
