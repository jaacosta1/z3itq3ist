// js/recovery.js — Emergency Paper Recovery Card & Standalone Offline HTML Decryptor
// Generates a printable archival recovery sheet and a zero-dependency offline decryptor file.

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function splitRecoveryIntoRows(recoveryCode) {
  const clean = String(recoveryCode || '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toUpperCase();
  const groups = clean.match(/.{1,4}/g) || [];
  const rows = [];
  for (let i = 0; i < groups.length; i += 4) {
    rows.push(groups.slice(i, i + 4).join(' - '));
  }
  return rows;
}

export function buildPrintableRecoveryCardHtml({
  recoveryCode = '',
  vaultMeta = null,
  repoConfig = {},
}) {
  const generatedDate = new Date().toISOString().slice(0, 10);
  const appRepo =
    repoConfig.owner && repoConfig.repo
      ? `${repoConfig.owner}/${repoConfig.repo} (${repoConfig.branch || 'main'})`
      : 'Not configured (Sandbox)';
  const vaultRepo = repoConfig.usePrivateVault
    ? `${repoConfig.vaultOwner || repoConfig.owner || 'owner'}/${
        repoConfig.vaultRepo || 'perpetual-diary-vault'
      } (${repoConfig.vaultBranch || 'main'})`
    : appRepo;

  const pwSlot = (vaultMeta?.keySlots || []).find((s) => s && s.type === 'password');
  const kdfDesc = pwSlot
    ? `${pwSlot.kdf || 'PBKDF2-SHA256'} · ${Number(pwSlot.iterations || 250000).toLocaleString()} iterations`
    : 'PBKDF2-SHA256 · 250,000 iterations';
  const dekFp = vaultMeta?.dekFingerprint || 'UNAVAILABLE';
  const rows = splitRecoveryIntoRows(recoveryCode);

  const keyBlockHtml = rows.length
    ? rows
        .map(
          (row, idx) =>
            `<div class="key-row"><span class="row-num">0${idx + 1}</span><code>${escapeHtml(row)}</code></div>`
        )
        .join('')
    : '<div class="key-row"><code>No recovery key generated yet. Generate one inside the Vault modal first.</code></div>';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Perpetual Diary — Emergency Paper Recovery Kit</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 28px;
      font-family: Georgia, "Times New Roman", serif;
      background: #f5f4ef;
      color: #111111;
    }
    .sheet {
      max-width: 780px;
      margin: 0 auto;
      background: #ffffff;
      border: 2px solid #111111;
      padding: 28px 32px;
    }
    .kicker {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: #555555;
    }
    h1 {
      margin: 6px 0 4px;
      font-size: 26px;
      letter-spacing: -0.02em;
    }
    .subtitle {
      margin: 0 0 18px;
      font-size: 14px;
      color: #333333;
      line-height: 1.45;
    }
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-bottom: 18px;
    }
    .meta-box {
      border: 1px solid #111111;
      padding: 10px 12px;
    }
    .meta-label {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #555555;
      margin-bottom: 4px;
    }
    .meta-val {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      word-break: break-all;
    }
    .key-panel {
      border: 2px solid #111111;
      background: #faf9f5;
      padding: 16px 18px;
      margin-bottom: 18px;
    }
    .key-title {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      margin-bottom: 10px;
    }
    .key-row {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 6px 0;
      border-bottom: 1px dashed #cccccc;
    }
    .key-row:last-child { border-bottom: none; }
    .row-num {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11px;
      color: #666666;
      width: 24px;
    }
    .key-row code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 16px;
      font-weight: 700;
      letter-spacing: 0.08em;
    }
    .instructions {
      border-top: 1px solid #111111;
      padding-top: 14px;
      font-size: 13px;
      line-height: 1.55;
    }
    .instructions h2 {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      margin: 0 0 8px;
    }
    .instructions ol {
      margin: 0;
      padding-left: 18px;
    }
    .instructions li { margin-bottom: 6px; }
    .toolbar {
      max-width: 780px;
      margin: 0 auto 14px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .print-btn {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      background: #111111;
      color: #ffffff;
      border: none;
      padding: 8px 16px;
      cursor: pointer;
    }
    @media print {
      body { background: #ffffff; padding: 0; }
      .toolbar { display: none; }
      .sheet { border: 2px solid #000000; max-width: none; }
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <span class="kicker">STORE PRINTED SHEET IN A SAFE PHYSICAL LOCATION</span>
    <button class="print-btn" onclick="window.print()">Print / Save as PDF</button>
  </div>
  <main class="sheet">
    <div class="kicker">PERPETUAL SIDE-BY-SIDE DIARY · ARCHIVAL RECOVERY KIT · GENERATED ${escapeHtml(generatedDate)}</div>
    <h1>Emergency Paper Recovery Card</h1>
    <p class="subtitle">
      This 256-bit recovery key unwraps your Envelope Data Encryption Key (DEK) independently of your master password.
      Anyone with this sheet and your <code>vault.json</code> + diary archive can decrypt your entries. Keep offline and secure.
    </p>

    <div class="grid">
      <div class="meta-box">
        <div class="meta-label">App Repository</div>
        <div class="meta-val">${escapeHtml(appRepo)}</div>
      </div>
      <div class="meta-box">
        <div class="meta-label">Vault Data Repository</div>
        <div class="meta-val">${escapeHtml(vaultRepo)}</div>
      </div>
      <div class="meta-box">
        <div class="meta-label">DEK Fingerprint (SHA-256)</div>
        <div class="meta-val">${escapeHtml(dekFp)}</div>
      </div>
      <div class="meta-box">
        <div class="meta-label">Cipher &amp; KDF Specification</div>
        <div class="meta-val">AES-256-GCM (v2/v3 AAD) · ${escapeHtml(kdfDesc)}</div>
      </div>
    </div>

    <section class="key-panel">
      <div class="key-title">256-Bit Paper Recovery Key (Hyphens &amp; Spaces Ignored)</div>
      ${keyBlockHtml}
    </section>

    <section class="instructions">
      <h2>How to Recover Your Diary (Live Site or Decades Later Offline)</h2>
      <ol>
        <li><strong>On the live web app (if you forgot your password):</strong> Paste or type all 64 characters above directly into the Lock Screen password field to unlock your diary, then open the Vault modal (⛨) to set a fresh Master Password.</li>
        <li><strong>Completely offline without GitHub:</strong> Open your saved <code>perpetual-offline-decryptor.html</code> file in any modern web browser (no internet required), load your exported <code>perpetual-diary-archive.json</code> (or any <code>MM-DD.json</code>) alongside <code>vault.json</code>, and enter either your Master Password or the 64-character Recovery Key above.</li>
        <li><strong>Revocation:</strong> Generating a new Paper Recovery Key inside the Vault modal immediately replaces the recovery slot in <code>vault.json</code> and invalidates this sheet.</li>
      </ol>
    </section>
  </main>
</body>
</html>`;
}

export function openPrintableRecoveryCard(options) {
  const html = buildPrintableRecoveryCardHtml(options);
  const popup = window.open('', '_blank', 'noopener,noreferrer');
  if (popup) {
    popup.document.open();
    popup.document.write(html);
    popup.document.close();
    return { openedWindow: true };
  }
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `perpetual-recovery-card-${new Date().toISOString().slice(0, 10)}.html`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
  return { openedWindow: false, downloadedFallback: true };
}

export function buildOfflineDecryptorHtml({ vaultMeta = null, repoConfig = {} } = {}) {
  // Embed non-secret vault metadata snapshot (stripped of encryptedPat) for convenience; user can also load any vault.json file.
  const sanitizedVault = vaultMeta
    ? {
        version: vaultMeta.version,
        architecture: vaultMeta.architecture,
        dekFingerprint: vaultMeta.dekFingerprint,
        canary: vaultMeta.canary || vaultMeta.canaryCipher || null,
        salt: vaultMeta.salt || null,
        iterations: vaultMeta.iterations || 250000,
        keySlots: Array.isArray(vaultMeta.keySlots) ? vaultMeta.keySlots : [],
        wrappedLegacyKey: vaultMeta.wrappedLegacyKey || null,
      }
    : null;

  const embeddedVaultJson = JSON.stringify(sanitizedVault, null, 2).replace(/<\/script/gi, '<\\/script');
  const repoLabel =
    repoConfig.usePrivateVault && repoConfig.vaultRepo
      ? `${repoConfig.vaultOwner || repoConfig.owner || ''}/${repoConfig.vaultRepo}`
      : repoConfig.owner && repoConfig.repo
        ? `${repoConfig.owner}/${repoConfig.repo}`
        : 'Local / Offline Archive';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Perpetual Diary — Standalone Offline Decryptor</title>
  <style>
    :root {
      --bg: #0d0d0d;
      --surface: #161616;
      --elev: #1e1e1e;
      --border: #2c2c2c;
      --ink: #eaeaea;
      --muted: #9a9a9a;
      --accent: #e0b354;
      --err: #f87171;
      --ok: #4ade80;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px 16px 64px;
      background: var(--bg);
      color: var(--ink);
      font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      line-height: 1.55;
    }
    .wrap { max-width: 920px; margin: 0 auto; }
    .kicker {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--accent);
    }
    h1 { margin: 6px 0 8px; font-family: Georgia, serif; font-weight: 500; }
    .sub { color: var(--muted); font-size: 14px; margin: 0 0 22px; }
    .panel {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 18px;
      margin-bottom: 18px;
    }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    @media (max-width: 680px) { .grid { grid-template-columns: 1fr; } }
    label { display: block; font-size: 13px; color: var(--muted); margin-bottom: 6px; }
    input[type="file"], input[type="password"], input[type="text"] {
      width: 100%;
      padding: 10px 12px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--elev);
      color: var(--ink);
      font-size: 14px;
    }
    .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-top: 14px; }
    button {
      padding: 9px 16px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--elev);
      color: var(--ink);
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
    }
    button.primary {
      background: var(--accent);
      color: #111111;
      border-color: var(--accent);
    }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .status {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      padding: 10px 12px;
      border-radius: 6px;
      margin-top: 12px;
      border: 1px solid var(--border);
      background: var(--elev);
    }
    .status.ok { border-color: rgba(74, 222, 128, 0.45); color: var(--ok); }
    .status.err { border-color: rgba(248, 113, 113, 0.5); color: var(--err); }
    .day-block {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface);
      padding: 18px;
      margin-bottom: 16px;
    }
    .day-heading {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 13px;
      color: var(--accent);
      margin: 0 0 12px;
      letter-spacing: 0.06em;
    }
    .entry-card {
      border-top: 1px solid var(--border);
      padding-top: 12px;
      margin-top: 12px;
    }
    .entry-meta {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      color: var(--muted);
      margin-bottom: 6px;
    }
    .entry-title { font-family: Georgia, serif; font-size: 19px; margin: 4px 0 8px; }
    .entry-body {
      font-family: Georgia, serif;
      white-space: pre-wrap;
      font-size: 15px;
      line-height: 1.65;
    }
    .tamper { color: var(--err); font-family: ui-monospace, monospace; font-size: 12px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="kicker">ZERO-DEPENDENCY ARCHIVAL TOOL · WEB CRYPTO API · WORKS 100% OFFLINE</div>
    <h1>Perpetual Diary — Offline Decryptor</h1>
    <p class="sub">
      Source archive reference: <strong>${escapeHtml(repoLabel)}</strong>. Decrypts v1, v2 Envelope, and v3 AAD diary exports locally in your browser without internet access or GitHub.
    </p>

    <section class="panel">
      <div class="grid">
        <div>
          <label for="archive-file">1. Load Archive (.json) or Single Day File (MM-DD.json)</label>
          <input type="file" id="archive-file" accept=".json,application/json" />
        </div>
        <div>
          <label for="vault-file">2. Load vault.json (Optional if embedded snapshot matches)</label>
          <input type="file" id="vault-file" accept=".json,application/json" />
        </div>
      </div>

      <div style="margin-top: 14px;">
        <label for="secret-input">3. Enter Master Password OR 64-Character Paper Recovery Key</label>
        <input type="password" id="secret-input" placeholder="Master password or XXXX-XXXX-... Paper Recovery Key" autocomplete="off" />
      </div>

      <div class="row">
        <button type="button" id="decrypt-btn" class="primary">Decrypt Archive Offline</button>
        <button type="button" id="export-md-btn" disabled>Download Decrypted .MD</button>
        <button type="button" id="export-json-btn" disabled>Download Decrypted .JSON</button>
      </div>

      <div id="status-box" class="status">Ready. Embedded vault snapshot: ${sanitizedVault ? `v${sanitizedVault.version || 1} (DEK ${escapeHtml(sanitizedVault.dekFingerprint || 'legacy')})` : 'None (load vault.json)'}.</div>
    </section>

    <section id="output-stage"></section>
  </div>

  <script>
    const EMBEDDED_VAULT = ${embeddedVaultJson};
    const CANARY_OK = 'PERPETUAL_VAULT_OK';
    let loadedArchive = null;
    let loadedVault = EMBEDDED_VAULT;
    let decryptedBundle = null;

    function b64ToBytes(b64) {
      const clean = String(b64 || '').replace(/\\s+/g, '');
      const bin = atob(clean);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }

    function hexToBytes(hex) {
      const clean = String(hex || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
      const out = new Uint8Array(clean.length / 2);
      for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
      return out;
    }

    function setStatus(msg, cls) {
      const box = document.getElementById('status-box');
      box.className = 'status' + (cls ? ' ' + cls : '');
      box.textContent = msg;
    }

    async function derivePbkdf2(password, saltB64, iterations) {
      const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), { name: 'PBKDF2' }, false, ['deriveKey']);
      return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: b64ToBytes(saltB64), iterations: Number(iterations) || 250000, hash: 'SHA-256' },
        base,
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']
      );
    }

    async function unwrapDek(wrappedB64, ivB64, kek) {
      return crypto.subtle.unwrapKey(
        'raw',
        b64ToBytes(wrappedB64),
        kek,
        { name: 'AES-GCM', iv: b64ToBytes(ivB64) },
        { name: 'AES-GCM', length: 256 },
        true,
        ['decrypt', 'unwrapKey']
      );
    }

    async function decryptRaw(ivB64, cipherB64, key, aad) {
      const algo = aad
        ? { name: 'AES-GCM', iv: b64ToBytes(ivB64), additionalData: new TextEncoder().encode(aad) }
        : { name: 'AES-GCM', iv: b64ToBytes(ivB64) };
      const buf = await crypto.subtle.decrypt(algo, key, b64ToBytes(cipherB64));
      return new TextDecoder().decode(buf);
    }

    async function decryptPayload(payload, keyring, aad) {
      if (typeof payload !== 'string') return '';
      if (!payload.startsWith('ENC:AES256GCM:')) return payload;
      const parts = payload.split(':');
      const candidates = [keyring.dek, keyring.legacyKey].filter(Boolean);

      if (payload.startsWith('ENC:AES256GCM:v3:') && parts.length === 5) {
        for (const k of candidates) {
          try { return await decryptRaw(parts[3], parts[4], k, aad); } catch {}
        }
        throw new Error('AAD integrity mismatch');
      }
      if (payload.startsWith('ENC:AES256GCM:v2:') && parts.length === 5) {
        for (const k of candidates) {
          try { return await decryptRaw(parts[3], parts[4], k, ''); } catch {}
        }
        throw new Error('Failed to decrypt v2');
      }
      if (payload.startsWith('ENC:AES256GCM:v1:')) {
        const hasSalt = parts.length === 6;
        const iv = hasSalt ? parts[4] : parts[3];
        const ct = hasSalt ? parts[5] : parts[4];
        for (const k of candidates) {
          try { return await decryptRaw(iv, ct, k, ''); } catch {}
        }
        if (hasSalt && keyring.password) {
          const derived = await derivePbkdf2(keyring.password, parts[3], 250000);
          return await decryptRaw(iv, ct, derived, '');
        }
      }
      throw new Error('Unsupported ciphertext');
    }

    async function unlockOfflineVault(secret, vm) {
      if (!vm) throw new Error('Please load vault.json to unlock encrypted entries.');
      if (Number(vm.version) === 2 && Array.isArray(vm.keySlots)) {
        for (const slot of vm.keySlots.filter((s) => s && s.type === 'password')) {
          try {
            const kek = await derivePbkdf2(secret, slot.salt, slot.iterations);
            const dek = await unwrapDek(slot.wrappedDek, slot.iv, kek);
            const check = await decryptPayload(vm.canary, { dek }, '');
            if (check === CANARY_OK) {
              let legacyKey = null;
              if (vm.wrappedLegacyKey && vm.wrappedLegacyKey.wrappedKey) {
                try { legacyKey = await unwrapDek(vm.wrappedLegacyKey.wrappedKey, vm.wrappedLegacyKey.iv, dek); } catch {}
              }
              return { dek, legacyKey, password: secret };
            }
          } catch {}
        }
        const cleanHex = String(secret || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
        if (/^[0-9A-F]{64}$/.test(cleanHex)) {
          const recKek = await crypto.subtle.importKey('raw', hexToBytes(cleanHex), { name: 'AES-GCM', length: 256 }, false, ['unwrapKey']);
          for (const slot of vm.keySlots.filter((s) => s && s.type === 'recovery')) {
            try {
              const dek = await unwrapDek(slot.wrappedDek, slot.iv, recKek);
              const check = await decryptPayload(vm.canary, { dek }, '');
              if (check === CANARY_OK) {
                let legacyKey = null;
                if (vm.wrappedLegacyKey && vm.wrappedLegacyKey.wrappedKey) {
                  try { legacyKey = await unwrapDek(vm.wrappedLegacyKey.wrappedKey, vm.wrappedLegacyKey.iv, dek); } catch {}
                }
                return { dek, legacyKey, password: null };
              }
            } catch {}
          }
        }
        throw new Error('Incorrect master password or recovery key.');
      }

      const legacyKey = await derivePbkdf2(secret, vm.salt, vm.iterations || 250000);
      const canary = vm.canary || vm.canaryCipher;
      const check = await decryptPayload(canary, { legacyKey, password: secret }, '');
      if (check !== CANARY_OK) throw new Error('Incorrect password.');
      return { dek: null, legacyKey, password: secret };
    }

    document.getElementById('archive-file').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      loadedArchive = JSON.parse(await f.text());
      setStatus('Loaded archive file: ' + f.name, 'ok');
    });

    document.getElementById('vault-file').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      loadedVault = JSON.parse(await f.text());
      setStatus('Loaded vault metadata: ' + f.name, 'ok');
    });

    document.getElementById('decrypt-btn').addEventListener('click', async () => {
      try {
        if (!loadedArchive) throw new Error('Select a perpetual-diary-archive.json or MM-DD.json file first.');
        const secret = document.getElementById('secret-input').value.trim();
        const daysMap = loadedArchive.days ? loadedArchive.days : (loadedArchive.day ? { [loadedArchive.day]: loadedArchive } : {});
        let keyring = null;
        if (secret) keyring = await unlockOfflineVault(secret, loadedVault);

        const outDays = {};
        const stage = document.getElementById('output-stage');
        stage.innerHTML = '';
        let okCount = 0;

        for (const dayStr of Object.keys(daysMap).sort()) {
          const doc = daysMap[dayStr];
          const decEntries = {};
          const decComments = [];
          const block = document.createElement('article');
          block.className = 'day-block';
          block.innerHTML = '<h2 class="day-heading">CALENDAR DAY · ' + dayStr + '</h2>';

          for (const yr of Object.keys(doc.entries || {}).sort()) {
            const e = doc.entries[yr];
            const expectedDate = yr + '-' + dayStr;
            let body = e.body || '';
            let title = e.title || '';
            let tamperMsg = '';
            if (e.encrypted || String(body).startsWith('ENC:AES256GCM:')) {
              if (!keyring) {
                body = '[Encrypted — enter password or recovery key above]';
                title = title ? '[Encrypted]' : '';
              } else {
                try {
                  body = await decryptPayload(e.body, keyring, 'perpetual:v3:entry:' + expectedDate + ':' + yr + ':body');
                  title = e.title ? await decryptPayload(e.title, keyring, 'perpetual:v3:entry:' + expectedDate + ':' + yr + ':title') : '';
                  okCount++;
                } catch (err) {
                  tamperMsg = err.message;
                  body = '[Decryption failed: ' + err.message + ']';
                }
              }
            } else {
              okCount++;
            }

            decEntries[yr] = { ...e, title, body, encrypted: false };
            const card = document.createElement('div');
            card.className = 'entry-card';
            card.innerHTML =
              '<div class="entry-meta">' + (e.diaryDate || expectedDate) + (e.mood ? ' · mood: ' + e.mood : '') + '</div>' +
              (title ? '<div class="entry-title"></div>' : '') +
              (tamperMsg ? '<div class="tamper">⚠ ' + tamperMsg + '</div>' : '') +
              '<div class="entry-body"></div>';
            if (title) card.querySelector('.entry-title').textContent = title;
            card.querySelector('.entry-body').textContent = body;
            block.appendChild(card);
          }

          for (const c of doc.comments || []) {
            let cBody = c.body || '';
            if (c.encrypted || String(cBody).startsWith('ENC:AES256GCM:')) {
              if (keyring) {
                try {
                  cBody = await decryptPayload(c.body, keyring, 'perpetual:v3:comment:' + dayStr + ':' + c.id + ':body');
                } catch {
                  cBody = '[Comment decryption failed]';
                }
              } else {
                cBody = '[Encrypted comment]';
              }
            }
            decComments.push({ ...c, body: cBody, encrypted: false });
          }

          outDays[dayStr] = { day: dayStr, entries: decEntries, comments: decComments };
          stage.appendChild(block);
        }

        decryptedBundle = { decryptedAt: new Date().toISOString(), days: outDays };
        document.getElementById('export-md-btn').disabled = false;
        document.getElementById('export-json-btn').disabled = false;
        setStatus('Decrypted ' + okCount + ' entry/entries offline.', 'ok');
      } catch (err) {
        setStatus(err.message || 'Decryption failed.', 'err');
      }
    });

    function triggerDownload(name, text, mime) {
      const a = document.createElement('a');
      const url = URL.createObjectURL(new Blob([text], { type: mime }));
      a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    document.getElementById('export-json-btn').addEventListener('click', () => {
      if (!decryptedBundle) return;
      triggerDownload('perpetual-diary-decrypted.json', JSON.stringify(decryptedBundle, null, 2), 'application/json');
    });

    document.getElementById('export-md-btn').addEventListener('click', () => {
      if (!decryptedBundle) return;
      const lines = ['# Perpetual Diary — Offline Decrypted Export', ''];
      for (const d of Object.keys(decryptedBundle.days).sort()) {
        lines.push('## ' + d, '');
        const doc = decryptedBundle.days[d];
        for (const yr of Object.keys(doc.entries).sort()) {
          const e = doc.entries[yr];
          lines.push('### ' + yr + (e.title ? ' — ' + e.title : ''), '', e.body, '');
        }
        if (doc.comments.length) {
          lines.push('#### Margin Notes', '');
          for (const c of doc.comments) lines.push('- **' + (c.author || 'Self') + '**: ' + c.body);
          lines.push('');
        }
      }
      triggerDownload('perpetual-diary-decrypted.md', lines.join('\\n'), 'text/markdown');
    });
  </script>
</body>
</html>`;
}
