/**
 * Prints the Paper Recovery Card via a popup-blocker-proof hidden iframe
 * (with HTML download fallback if printing is unavailable).
 */
export function openPrintableRecoveryCard(options) {
  const html = buildPrintableRecoveryCardHtml(options);
  try {
    const existing = document.getElementById('perpetual-recovery-print-iframe');
    if (existing) existing.remove();

    const iframe = document.createElement('iframe');
    iframe.id = 'perpetual-recovery-print-iframe';
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.position = 'fixed';
    iframe.style.right = '0';
    iframe.style.bottom = '0';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';
    iframe.style.visibility = 'hidden';

    let printed = false;
    const cleanup = () => {
      window.setTimeout(() => {
        if (iframe.parentNode) iframe.remove();
      }, 1000);
    };

    const runPrint = () => {
      if (printed) return;
      printed = true;
      try {
        const win = iframe.contentWindow;
        if (!win) throw new Error('Print frame unavailable.');
        win.addEventListener('afterprint', cleanup, { once: true });
        win.focus();
        win.print();
        window.setTimeout(cleanup, 60000);
      } catch {
        cleanup();
      }
    };

    iframe.onload = () => {
      window.requestAnimationFrame(() => window.setTimeout(runPrint, 60));
    };

    document.body.appendChild(iframe);
    const doc = iframe.contentDocument || iframe.contentWindow?.document;
    if (doc) {
      doc.open();
      doc.write(html);
      doc.close();
      window.setTimeout(runPrint, 180);
    } else {
      iframe.srcdoc = html;
    }

    return { openedWindow: true, method: 'iframe' };
  } catch {
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
}

/**
 * Generates the complete zero-dependency Standalone Offline Decryptor HTML file.
 * Embeds a pure-JS RFC 9106 Argon2id + BLAKE2b implementation alongside Web Crypto AES-256-GCM,
 * PBKDF2-SHA256, HMAC-SHA256 shard unmasking, Double-Lock decryption, and PENC v1 `.enc` media recovery.
 */
export function buildOfflineDecryptorHtml({ vaultMeta = null, repoConfig = {} } = {}) {
  // Sanitize embedded vault snapshot (strips encryptedPat so no GitHub token ever touches the offline tool)
  const sanitizedVault = vaultMeta
    ? {
        version: vaultMeta.version,
        architecture: vaultMeta.architecture,
        metadataCloaking: Boolean(vaultMeta.metadataCloaking),
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

  const embeddedDesc = sanitizedVault
    ? `v${sanitizedVault.version || 1} (DEK ${escapeHtml(sanitizedVault.dekFingerprint || 'legacy')} · ${escapeHtml(describePasswordSlotKdf(sanitizedVault))})`
    : 'None (load vault.json)';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Perpetual Diary — Standalone Offline Decryptor (v20)</title>
  <style>
    :root {
      --bg: #0d0d0d;
      --surface: #161616;
      --elev: #1e1e1e;
      --border: #2d2d2d;
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
    .wrap { max-width: 960px; margin: 0 auto; }
    .kicker {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--accent);
    }
    h1 { margin: 6px 0 8px; font-family: Georgia, serif; font-weight: 500; }
    h2 { margin: 0 0 10px; font-family: Georgia, serif; font-weight: 500; font-size: 19px; }
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
    label { display: block; font-size: 12.5px; color: var(--muted); margin-bottom: 5px; }
    input[type="file"], input[type="password"], input[type="text"] {
      width: 100%;
      padding: 9px 12px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--elev);
      color: var(--ink);
      font-size: 13.5px;
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
    .tamper { color: var(--err); font-family: ui-monospace, monospace; font-size: 12px; margin-bottom: 6px; }
    .media-preview { margin-top: 12px; }
    .media-preview img { max-width: 100%; max-height: 360px; border-radius: 6px; border: 1px solid var(--border); }
    .media-preview audio { width: 100%; margin-top: 6px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="kicker">ZERO-DEPENDENCY ARCHIVAL TOOL · ARGON2ID · PBKDF2 · AES-256-GCM AAD · CLOAKED SHARDS · .ENC MEDIA</div>
    <h1>Perpetual Diary — Standalone Offline Decryptor</h1>
    <p class="sub">
      Source archive reference: <strong>${escapeHtml(repoLabel)}</strong>. Runs 100% locally in your browser with zero internet access. Supports v1, v2 Envelope, v3 AAD, Argon2id key slots, cloaked HMAC shards (<code>shards/*.enc</code> + <code>index.enc</code>), Double-Lock entries, and encrypted <code>.enc</code> media.
    </p>

    <section class="panel">
      <h2>1. Unlock &amp; Decrypt Diary Entries / Cloaked Shards</h2>
      <div class="grid">
        <div>
          <label for="archive-files">Diary Files — Select Archive (.json), Day File(s) (MM-DD.json), or Cloaked Shards (*.enc / index.enc)</label>
          <input type="file" id="archive-files" accept=".json,.enc,application/json" multiple />
        </div>
        <div>
          <label for="vault-file">vault.json (Optional if embedded snapshot matches)</label>
          <input type="file" id="vault-file" accept=".json,application/json" />
        </div>
      </div>

      <div class="grid" style="margin-top: 12px;">
        <div>
          <label for="secret-input">Master Password (PBKDF2 / Argon2id) OR 64-Char Paper Recovery Key</label>
          <input type="password" id="secret-input" placeholder="Master password or XXXX-XXXX-... Paper Recovery Key" autocomplete="off" />
        </div>
        <div>
          <label for="doublelock-input">Optional Double-Lock 2nd Passphrase (for DLOCK entries)</label>
          <input type="password" id="doublelock-input" placeholder="Leave blank if not using Double-Lock" autocomplete="off" />
        </div>
      </div>

      <div class="row">
        <button type="button" id="decrypt-btn" class="primary">Decrypt Archive Offline</button>
        <button type="button" id="export-md-btn" disabled>Download Decrypted .MD Book</button>
        <button type="button" id="export-json-btn" disabled>Download Decrypted .JSON</button>
      </div>

      <div id="status-box" class="status">Ready. Embedded vault snapshot: ${embeddedDesc}.</div>
    </section>

    <section class="panel">
      <h2>2. Decrypt Individual Encrypted Media (.enc Photo or Voice Note)</h2>
      <div class="grid">
        <div>
          <label for="media-enc-file">Select Encrypted .enc Media Blob (from data/media/)</label>
          <input type="file" id="media-enc-file" accept=".enc,application/octet-stream" />
        </div>
        <div>
          <label for="media-aad-path">Media Subpath for AAD Verification (defaults to media/&lt;filename&gt;)</label>
          <input type="text" id="media-aad-path" placeholder="media/2026-11-24-....webp.enc" />
        </div>
      </div>
      <div class="row">
        <button type="button" id="decrypt-media-btn">Decrypt .enc Media File</button>
        <a id="download-media-link" style="display:none;color:var(--accent);font-size:13px;" download>Download Decrypted Media</a>
      </div>
      <div id="media-status-box" class="status">Unlock with your password or recovery key above, then choose any .enc photo or voice note.</div>
      <div id="media-preview" class="media-preview"></div>
    </section>

    <section id="output-stage"></section>
  </div>

  <script>
    const EMBEDDED_VAULT = ${embeddedVaultJson};
    const CANARY_OK = 'PERPETUAL_VAULT_OK';
    const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    const textEncoder = new TextEncoder();
    const textDecoder = new TextDecoder();

    let selectedDiaryFiles = [];
    let loadedVault = EMBEDDED_VAULT;
    let activeKeyring = null;
    let decryptedBundle = null;
    let lastMediaUrl = null;

    /* ========================================================================
       INLINE PURE-JS BLAKE2b + RFC 9106 ARGON2ID (OFFLINE RECOVERY ENGINE)
       ======================================================================== */
    const B2_IV_LO = new Uint32Array([0xf3bcc908,0x84caa73b,0xfe94f82b,0x5f1d36f1,0xade682d1,0x2b3e6c1f,0xfb41bd6b,0x137e2179]);
    const B2_IV_HI = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
    const B2_SIGMA = [
      [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15],[14,10,4,8,9,15,13,6,1,12,0,2,11,7,5,3],
      [11,8,12,0,5,2,15,13,10,14,3,6,7,1,9,4],[7,9,3,1,13,12,11,14,2,6,5,10,4,0,15,8],
      [9,0,5,7,2,4,10,15,14,1,11,12,6,8,3,13],[2,12,6,10,0,11,8,3,4,13,7,5,15,14,1,9],
      [12,5,1,15,14,13,4,10,0,7,6,3,9,2,8,11],[13,11,7,14,12,1,3,9,5,0,15,4,8,6,2,10],
      [6,15,14,9,11,3,0,8,12,2,13,7,1,4,10,5],[10,2,8,4,7,6,1,5,15,11,9,14,3,12,13,0]
    ];
    const b2vLo = new Uint32Array(16), b2vHi = new Uint32Array(16), b2mLo = new Uint32Array(16), b2mHi = new Uint32Array(16);

    function b2G(a,b,c,d,x,y){
      let al=b2vLo[a],ah=b2vHi[a],bl=b2vLo[b],bh=b2vHi[b],cl=b2vLo[c],ch=b2vHi[c],dl=b2vLo[d],dh=b2vHi[d];
      let lo=(al+bl)>>>0, car=lo<al?1:0; al=(lo+b2mLo[x])>>>0; car+=al<lo?1:0; ah=(ah+bh+b2mHi[x]+car)>>>0;
      let xl=dl^al, xh=dh^ah; dl=xh; dh=xl;
      lo=(cl+dl)>>>0; ch=(ch+dh+(lo<cl?1:0))>>>0; cl=lo;
      xl=bl^cl; xh=bh^ch; bl=((xl>>>24)|(xh<<8))>>>0; bh=((xh>>>24)|(xl<<8))>>>0;
      lo=(al+bl)>>>0; car=lo<al?1:0; al=(lo+b2mLo[y])>>>0; car+=al<lo?1:0; ah=(ah+bh+b2mHi[y]+car)>>>0;
      xl=dl^al; xh=dh^ah; dl=((xl>>>16)|(xh<<16))>>>0; dh=((xh>>>16)|(xl<<16))>>>0;
      lo=(cl+dl)>>>0; ch=(ch+dh+(lo<cl?1:0))>>>0; cl=lo;
      xl=bl^cl; xh=bh^ch; bl=((xl<<1)|(xh>>>31))>>>0; bh=((xh<<1)|(xl>>>31))>>>0;
      b2vLo[a]=al;b2vHi[a]=ah;b2vLo[b]=bl;b2vHi[b]=bh;b2vLo[c]=cl;b2vHi[c]=ch;b2vLo[d]=dl;b2vHi[d]=dh;
    }

    function blake2bCompress(hLo,hHi,blk,tLo,tHi,isLast){
      for(let i=0;i<8;i++){b2vLo[i]=hLo[i];b2vHi[i]=hHi[i];b2vLo[i+8]=B2_IV_LO[i];b2vHi[i+8]=B2_IV_HI[i];}
      b2vLo[12]^=tLo; b2vHi[12]^=tHi;
      if(isLast){b2vLo[14]=~b2vLo[14]; b2vHi[14]=~b2vHi[14];}
      for(let i=0;i<16;i++){
        const o=i*8;
        b2mLo[i]=(blk[o]|(blk[o+1]<<8)|(blk[o+2]<<16)|(blk[o+3]<<24))>>>0;
        b2mHi[i]=(blk[o+4]|(blk[o+5]<<8)|(blk[o+6]<<16)|(blk[o+7]<<24))>>>0;
      }
      for(let r=0;r<12;r++){
        const s=B2_SIGMA[r%10];
        b2G(0,4,8,12,s[0],s[1]); b2G(1,5,9,13,s[2],s[3]); b2G(2,6,10,14,s[4],s[5]); b2G(3,7,11,15,s[6],s[7]);
        b2G(0,5,10,15,s[8],s[9]); b2G(1,6,11,12,s[10],s[11]); b2G(2,7,8,13,s[12],s[13]); b2G(3,4,9,14,s[14],s[15]);
      }
      for(let i=0;i<8;i++){hLo[i]^=b2vLo[i]^b2vLo[i+8]; hHi[i]^=b2vHi[i]^b2vHi[i+8];}
    }

    function blake2b(inp,outLen=64){
      const hLo=new Uint32Array(B2_IV_LO), hHi=new Uint32Array(B2_IV_HI);
      hLo[0]^=0x01010000^(outLen&0xff);
      const blk=new Uint8Array(128); let off=0,tLo=0,tHi=0;
      while(inp.length-off>128){
        blk.set(inp.subarray(off,off+128),0); off+=128;
        const p=tLo; tLo=(tLo+128)>>>0; if(tLo<p) tHi=(tHi+1)>>>0;
        blake2bCompress(hLo,hHi,blk,tLo,tHi,false);
      }
      const rem=inp.length-off; blk.fill(0);
      if(rem>0){blk.set(inp.subarray(off),0); const p=tLo; tLo=(tLo+rem)>>>0; if(tLo<p) tHi=(tHi+1)>>>0;}
      blake2bCompress(hLo,hHi,blk,tLo,tHi,true);
      const out=new Uint8Array(outLen);
      for(let i=0;i<outLen;i++){const wi=i>>>3, bi=i&7, w=bi<4?hLo[wi]:hHi[wi]; out[i]=(w>>>((bi&3)*8))&0xff;}
      return out;
    }

    function writeLe32(a,o,v){a[o]=v&0xff;a[o+1]=(v>>>8)&0xff;a[o+2]=(v>>>16)&0xff;a[o+3]=(v>>>24)&0xff;}

    function blake2bLong(inp,tau){
      const pre=new Uint8Array(4+inp.length); writeLe32(pre,0,tau); pre.set(inp,4);
      if(tau<=64) return blake2b(pre,tau);
      const out=new Uint8Array(tau), r=Math.ceil(tau/32)-2;
      let v=blake2b(pre,64); out.set(v.subarray(0,32),0);
      for(let i=1;i<r;i++){v=blake2b(v,64); out.set(v.subarray(0,32),i*32);}
      out.set(blake2b(v,tau-32*r),r*32); return out;
    }

    function argonG(b,ai,bi,ci,di){
      let al=b[ai],ah=b[ai+1],bl=b[bi],bh=b[bi+1],cl=b[ci],ch=b[ci+1],dl=b[di],dh=b[di+1];
      let a0=al&0xffff,a1=al>>>16,b0=bl&0xffff,b1=bl>>>16,p00=a0*b0,p01=a0*b1,p10=a1*b0,p11=a1*b1;
      let mid=(p00>>>16)+(p01&0xffff)+(p10&0xffff), pl=(((mid&0xffff)<<16)|(p00&0xffff))>>>0, ph=(p11+(p01>>>16)+(p10>>>16)+(mid>>>16))>>>0;
      let th=((ph<<1)|(pl>>>31))>>>0, tl=(pl<<1)>>>0, lo=(al+bl)>>>0, car=lo<al?1:0;
      al=(lo+tl)>>>0; car+=al<lo?1:0; ah=(ah+bh+th+car)>>>0;
      let xl=dl^al,xh=dh^ah; dl=xh; dh=xl;
      a0=cl&0xffff;a1=cl>>>16;b0=dl&0xffff;b1=dl>>>16;p00=a0*b0;p01=a0*b1;p10=a1*b0;p11=a1*b1;
      mid=(p00>>>16)+(p01&0xffff)+(p10&0xffff); pl=(((mid&0xffff)<<16)|(p00&0xffff))>>>0; ph=(p11+(p01>>>16)+(p10>>>16)+(mid>>>16))>>>0;
      th=((ph<<1)|(pl>>>31))>>>0; tl=(pl<<1)>>>0; lo=(cl+dl)>>>0; car=lo<cl?1:0;
      cl=(lo+tl)>>>0; car+=cl<lo?1:0; ch=(ch+dh+th+car)>>>0;
      xl=bl^cl;xh=bh^ch; bl=((xl>>>24)|(xh<<8))>>>0; bh=((xh>>>24)|(xl<<8))>>>0;
      a0=al&0xffff;a1=al>>>16;b0=bl&0xffff;b1=bl>>>16;p00=a0*b0;p01=a0*b1;p10=a1*b0;p11=a1*b1;
      mid=(p00>>>16)+(p01&0xffff)+(p10&0xffff); pl=(((mid&0xffff)<<16)|(p00&0xffff))>>>0; ph=(p11+(p01>>>16)+(p10>>>16)+(mid>>>16))>>>0;
      th=((ph<<1)|(pl>>>31))>>>0; tl=(pl<<1)>>>0; lo=(al+bl)>>>0; car=lo<al?1:0;
      al=(lo+tl)>>>0; car+=al<lo?1:0; ah=(ah+bh+th+car)>>>0;
      xl=dl^al;xh=dh^ah; dl=((xl>>>16)|(xh<<16))>>>0; dh=((xh>>>16)|(xl<<16))>>>0;
      a0=cl&0xffff;a1=cl>>>16;b0=dl&0xffff;b1=dl>>>16;p00=a0*b0;p01=a0*b1;p10=a1*b0;p11=a1*b1;
      mid=(p00>>>16)+(p01&0xffff)+(p10&0xffff); pl=(((mid&0xffff)<<16)|(p00&0xffff))>>>0; ph=(p11+(p01>>>16)+(p10>>>16)+(mid>>>16))>>>0;
      th=((ph<<1)|(pl>>>31))>>>0; tl=(pl<<1)>>>0; lo=(cl+dl)>>>0; car=lo<cl?1:0;
      cl=(lo+tl)>>>0; car+=cl<lo?1:0; ch=(ch+dh+th+car)>>>0;
      xl=bl^cl;xh=bh^ch; bl=((xl<<1)|(xh>>>31))>>>0; bh=((xh<<1)|(xl>>>31))>>>0;
      b[ai]=al;b[ai+1]=ah;b[bi]=bl;b[bi+1]=bh;b[ci]=cl;b[ci+1]=ch;b[di]=dl;b[di+1]=dh;
    }

    function perm16(b,i0,i1,i2,i3,i4,i5,i6,i7,i8,i9,i10,i11,i12,i13,i14,i15){
      argonG(b,i0,i4,i8,i12);argonG(b,i1,i5,i9,i13);argonG(b,i2,i6,i10,i14);argonG(b,i3,i7,i11,i15);
      argonG(b,i0,i5,i10,i15);argonG(b,i1,i6,i11,i12);argonG(b,i2,i7,i8,i13);argonG(b,i3,i4,i9,i14);
    }

    const cR=new Uint32Array(256),cZ=new Uint32Array(256),zBlk=new Uint32Array(256),aIn=new Uint32Array(256),aMid=new Uint32Array(256),aOut=new Uint32Array(256);
    function compressBlk(xA,xO,yA,yO,oA,oO,xorO){
      for(let i=0;i<256;i++){const r=xA[xO+i]^yA[yO+i];cR[i]=r;cZ[i]=r;}
      for(let r=0;r<8;r++){const o=r*32;perm16(cZ,o,o+2,o+4,o+6,o+8,o+10,o+12,o+14,o+16,o+18,o+20,o+22,o+24,o+26,o+28,o+30);}
      for(let c=0;c<8;c++){const o=c*4;perm16(cZ,o,o+2,o+32,o+34,o+64,o+66,o+96,o+98,o+128,o+130,o+160,o+162,o+192,o+194,o+224,o+226);}
      if(xorO){for(let i=0;i<256;i++)oA[oO+i]^=cR[i]^cZ[i];} else {for(let i=0;i<256;i++)oA[oO+i]=cR[i]^cZ[i];}
    }

    function argon2idRaw(pwBytes,saltBytes,memoryKiB,timeCost){
      const t=Math.max(1,Number(timeCost)||2), mRaw=Math.max(8,Number(memoryKiB)||16384), q=Math.floor(mRaw/4)*4, seg=q/4;
      const h0In=new Uint8Array(40+pwBytes.length+saltBytes.length); let p=0;
      writeLe32(h0In,p,1);p+=4;writeLe32(h0In,p,32);p+=4;writeLe32(h0In,p,mRaw);p+=4;writeLe32(h0In,p,t);p+=4;
      writeLe32(h0In,p,0x13);p+=4;writeLe32(h0In,p,2);p+=4;writeLe32(h0In,p,pwBytes.length);p+=4;
      h0In.set(pwBytes,p);p+=pwBytes.length;writeLe32(h0In,p,saltBytes.length);p+=4;h0In.set(saltBytes,p);p+=saltBytes.length;
      writeLe32(h0In,p,0);p+=4;writeLe32(h0In,p,0);
      const H0=blake2b(h0In,64), mem=new Uint32Array(q*256), seed=new Uint8Array(72); seed.set(H0,0);
      for(let bi=0;bi<2;bi++){
        writeLe32(seed,64,bi);writeLe32(seed,68,0);
        const bb=blake2bLong(seed,1024);
        for(let i=0;i<256;i++){const o=i*4;mem[bi*256+i]=(bb[o]|(bb[o+1]<<8)|(bb[o+2]<<16)|(bb[o+3]<<24))>>>0;}
      }
      for(let pass=0;pass<t;pass++){
        for(let sl=0;sl<4;sl++){
          const di=pass===0&&sl<2; let ac=0;
          if(di){aIn.fill(0);aIn[0]=pass;aIn[4]=sl;aIn[6]=q;aIn[8]=t;aIn[10]=2;}
          for(let idx=0;idx<seg;idx++){
            if(pass===0&&sl===0&&idx<2) continue;
            const cur=sl*seg+idx, prv=cur===0?q-1:cur-1;
            let j1;
            if(di){
              const oa=idx&127;
              if(oa===0||(pass===0&&sl===0&&idx===2)){ac++;aIn[12]=ac;compressBlk(zBlk,0,aIn,0,aMid,0,false);compressBlk(zBlk,0,aMid,0,aOut,0,false);}
              j1=aOut[oa*2];
            } else { j1=mem[prv*256]; }
            const rsz=pass===0?sl*seg+idx-1:q-seg+idx-1;
            const x=Math.floor((j1*j1)/4294967296), y=Math.floor((rsz*x)/4294967296);
            const rPos=rsz-1-y, sPos=(pass===0||sl===3)?0:(sl+1)*seg, ref=(sPos+rPos)%q;
            compressBlk(mem,prv*256,mem,ref*256,mem,cur*256,pass>0);
          }
        }
      }
      const fin=new Uint8Array(1024);
      for(let i=0;i<256;i++) writeLe32(fin,i*4,mem[(q-1)*256+i]);
      mem.fill(0);
      return blake2bLong(fin,32);
    }

    /* ========================================================================
       WEB CRYPTO UTILITIES (PBKDF2, AES-256-GCM AAD, HMAC SHARDS, PENC .ENC)
       ======================================================================== */
    function b64ToBytes(b64){
      const clean=String(b64||'').replace(/\\s+/g,'');
      const bin=atob(clean), out=new Uint8Array(bin.length);
      for(let i=0;i<bin.length;i++) out[i]=bin.charCodeAt(i);
      return out;
    }
    function hexToBytes(hex){
      const clean=String(hex||'').replace(/[^0-9a-fA-F]/g,'').toLowerCase();
      const out=new Uint8Array(clean.length/2);
      for(let i=0;i<out.length;i++) out[i]=parseInt(clean.slice(i*2,i*2+2),16);
      return out;
    }
    function bytesToHex(bytes){
      return Array.from(bytes, (b) => b.toString(16).padStart(2,'0')).join('');
    }
    function setStatus(msg,cls,id='status-box'){
      const box=document.getElementById(id);
      box.className='status'+(cls?' '+cls:'');
      box.textContent=msg;
    }

    async function derivePbkdf2(password,saltB64,iterations){
      const base=await crypto.subtle.importKey('raw',textEncoder.encode(password),{name:'PBKDF2'},false,['deriveKey']);
      return crypto.subtle.deriveKey(
        {name:'PBKDF2',salt:b64ToBytes(saltB64),iterations:Number(iterations)||250000,hash:'SHA-256'},
        base,{name:'AES-GCM',length:256},true,['encrypt','decrypt','wrapKey','unwrapKey']
      );
    }

    async function deriveSlotKek(password,slot){
      if(String(slot.kdf||'').toLowerCase()==='argon2id'){
        const raw=argon2idRaw(textEncoder.encode(password),b64ToBytes(slot.salt),slot.memoryKiB||16384,slot.timeCost||2);
        const key=await crypto.subtle.importKey('raw',raw,{name:'AES-GCM',length:256},false,['unwrapKey']);
        raw.fill(0);
        return key;
      }
      return derivePbkdf2(password,slot.salt,slot.iterations||250000);
    }

    async function unwrapDek(wrappedB64,ivB64,kek){
      return crypto.subtle.unwrapKey(
        'raw',b64ToBytes(wrappedB64),kek,{name:'AES-GCM',iv:b64ToBytes(ivB64)},
        {name:'AES-GCM',length:256},true,['decrypt','unwrapKey']
      );
    }

    async function decryptRaw(ivB64,cipherB64,key,aad){
      const algo=aad
        ? {name:'AES-GCM',iv:b64ToBytes(ivB64),additionalData:textEncoder.encode(aad)}
        : {name:'AES-GCM',iv:b64ToBytes(ivB64)};
      const buf=await crypto.subtle.decrypt(algo,key,b64ToBytes(cipherB64));
      return textDecoder.decode(buf);
    }

    async function decryptPayload(payload,keyring,aad){
      if(typeof payload!=='string') return '';
      if(!payload.startsWith('ENC:AES256GCM:')) return payload;
      const parts=payload.split(':');
      const candidates=[keyring.dek,keyring.legacyKey].filter(Boolean);

      if(payload.startsWith('ENC:AES256GCM:v3:')&&parts.length===5){
        for(const k of candidates){ try{return await decryptRaw(parts[3],parts[4],k,aad);}catch{} }
        throw new Error('AAD integrity mismatch');
      }
      if(payload.startsWith('ENC:AES256GCM:v2:')&&parts.length===5){
        for(const k of candidates){ try{return await decryptRaw(parts[3],parts[4],k,'');}catch{} }
        throw new Error('Failed to decrypt v2');
      }
      if(payload.startsWith('ENC:AES256GCM:v1:')){
        const hasSalt=parts.length===6, iv=hasSalt?parts[4]:parts[3], ct=hasSalt?parts[5]:parts[4];
        for(const k of candidates){ try{return await decryptRaw(iv,ct,k,'');}catch{} }
        if(hasSalt&&keyring.password){
          const derived=await derivePbkdf2(keyring.password,parts[3],250000);
          return await decryptRaw(iv,ct,derived,'');
        }
      }
      throw new Error('Unsupported ciphertext');
    }

    async function decryptDoubleLock(payload,secondPass,aad){
      const prefix='DLOCK:PBKDF2:AES256GCM:v1:';
      if(typeof payload!=='string'||!payload.startsWith(prefix)) return payload;
      if(!secondPass) return '[Double-Locked — enter optional 2nd passphrase above to unseal]';
      const parts=payload.slice(prefix.length).split(':');
      if(parts.length!==3) throw new Error('Malformed Double-Lock payload');
      const key=await derivePbkdf2(secondPass,parts[0],250000);
      return await decryptRaw(parts[1],parts[2],key,aad);
    }

    async function buildCloakShardLookup(dek){
      const rawDek=new Uint8Array(await crypto.subtle.exportKey('raw',dek));
      const tag=textEncoder.encode('perpetual:v1:hmac-shard-key:');
      const combined=new Uint8Array(tag.length+rawDek.length);
      combined.set(tag,0); combined.set(rawDek,tag.length);
      const hmacBytes=await crypto.subtle.digest('SHA-256',combined);
      const hmacKey=await crypto.subtle.importKey('raw',hmacBytes,{name:'HMAC',hash:'SHA-256'},false,['sign']);
      const map=new Map();
      for(let m=1;m<=12;m++){
        for(let d=1;d<=DAYS_IN_MONTH[m-1];d++){
          const mmdd=String(m).padStart(2,'0')+'-'+String(d).padStart(2,'0');
          const sig=await crypto.subtle.sign('HMAC',hmacKey,textEncoder.encode('perpetual:v1:day-shard:'+mmdd));
          const hex24=bytesToHex(new Uint8Array(sig)).slice(0,24);
          map.set(hex24+'.enc',mmdd);
          map.set(hex24,mmdd);
        }
      }
      return map;
    }

    async function unlockOfflineVault(secret,vm){
      if(!vm) throw new Error('Please load vault.json to unlock encrypted entries.');
      if(Number(vm.version)===2&&Array.isArray(vm.keySlots)){
        for(const slot of vm.keySlots.filter((s)=>s&&s.type==='password')){
          try{
            const kek=await deriveSlotKek(secret,slot);
            const dek=await unwrapDek(slot.wrappedDek,slot.iv,kek);
            const check=await decryptPayload(vm.canary,{dek},'');
            if(check===CANARY_OK){
              let legacyKey=null;
              if(vm.wrappedLegacyKey&&vm.wrappedLegacyKey.wrappedKey){
                try{legacyKey=await unwrapDek(vm.wrappedLegacyKey.wrappedKey,vm.wrappedLegacyKey.iv,dek);}catch{}
              }
              return {dek,legacyKey,password:secret};
            }
          }catch{}
        }
        const cleanHex=String(secret||'').replace(/[^0-9a-fA-F]/g,'').toUpperCase();
        if(/^[0-9A-F]{64}$/.test(cleanHex)){
          const recKek=await crypto.subtle.importKey('raw',hexToBytes(cleanHex),{name:'AES-GCM',length:256},false,['unwrapKey']);
          for(const slot of vm.keySlots.filter((s)=>s&&s.type==='recovery')){
            try{
              const dek=await unwrapDek(slot.wrappedDek,slot.iv,recKek);
              const check=await decryptPayload(vm.canary,{dek},'');
              if(check===CANARY_OK){
                let legacyKey=null;
                if(vm.wrappedLegacyKey&&vm.wrappedLegacyKey.wrappedKey){
                  try{legacyKey=await unwrapDek(vm.wrappedLegacyKey.wrappedKey,vm.wrappedLegacyKey.iv,dek);}catch{}
                }
                return {dek,legacyKey,password:null};
              }
            }catch{}
          }
        }
        throw new Error('Incorrect master password or recovery key.');
      }

      const legacyKey=await derivePbkdf2(secret,vm.salt,vm.iterations||250000);
      const check=await decryptPayload(vm.canary||vm.canaryCipher,{legacyKey,password:secret},'');
      if(check!==CANARY_OK) throw new Error('Incorrect password.');
      return {dek:null,legacyKey,password:secret};
    }

    async function decryptPencMedia(bytes,keyring,aadPath){
      const magic=[0x50,0x45,0x4e,0x43];
      if(bytes.length<=34) throw new Error('Encrypted .enc blob is truncated.');
      for(let i=0;i<4;i++) if(bytes[i]!==magic[i]) throw new Error('Unrecognized PENC media header.');
      const flags=bytes[5], aadBound=Boolean(flags&0x01), iv=bytes.subarray(6,18), ct=bytes.subarray(18);
      const normSub=String(aadPath||'').replace(/^\\/+/,'').replace(/^data\\//i,'');
      const algo=aadBound&&normSub
        ? {name:'AES-GCM',iv,additionalData:textEncoder.encode('perpetual:v3:media:'+normSub)}
        : {name:'AES-GCM',iv};
      const candidates=[keyring.dek,keyring.legacyKey].filter(Boolean);
      let plainBuf=null;
      for(const k of candidates){ try{plainBuf=await crypto.subtle.decrypt(algo,k,ct); break;}catch{} }
      if(!plainBuf) throw new Error('Failed to decrypt .enc media (check AAD media subpath or password).');
      const pb=new Uint8Array(plainBuf);
      const metaLen=(pb[0]<<8)|pb[1];
      let mime='image/webp';
      try{const m=JSON.parse(textDecoder.decode(pb.subarray(2,2+metaLen))); if(m&&m.mime) mime=m.mime;}catch{}
      return {bytes:pb.slice(2+metaLen),mime};
    }

    document.getElementById('archive-files').addEventListener('change',(e)=>{
      selectedDiaryFiles=Array.from(e.target.files||[]);
      setStatus('Selected '+selectedDiaryFiles.length+' file(s). Ready to decrypt.','ok');
    });

    document.getElementById('vault-file').addEventListener('change',async(e)=>{
      const f=e.target.files[0]; if(!f) return;
      loadedVault=JSON.parse(await f.text());
      setStatus('Loaded vault metadata: '+f.name,'ok');
    });

    document.getElementById('media-enc-file').addEventListener('change',(e)=>{
      const f=e.target.files[0]; if(!f) return;
      const aadInput=document.getElementById('media-aad-path');
      if(!aadInput.value.trim()) aadInput.value='media/'+f.name;
    });

    document.getElementById('decrypt-btn').addEventListener('click',async()=>{
      try{
        if(selectedDiaryFiles.length===0) throw new Error('Select one or more archive/day/shard files first.');
        const secret=document.getElementById('secret-input').value.trim();
        const doubleLockPass=document.getElementById('doublelock-input').value;
        setStatus('Deriving key (Argon2id may take ~1–2s)…','');
        await new Promise((r)=>setTimeout(r,20));

        if(secret){
          activeKeyring=await unlockOfflineVault(secret,loadedVault);
        }

        let shardMap=null;
        const daysMap={};

        for(const f of selectedDiaryFiles){
          const txt=await f.text();
          const parsed=JSON.parse(txt);

          if(parsed&&parsed.format==='perpetual-cloaked-index-v1'&&parsed.payload){
            if(!activeKeyring) throw new Error('Enter password or recovery key to decrypt index.enc.');
            const idxPlain=await decryptPayload(parsed.payload,activeKeyring,'perpetual:v3:manifest:index');
            setStatus('Decrypted index.enc ('+Object.keys(JSON.parse(idxPlain).days||{}).length+' indexed days).','ok');
            continue;
          }

          if(parsed&&parsed.format==='perpetual-cloaked-shard-v1'&&parsed.payload){
            if(!activeKeyring||!activeKeyring.dek) throw new Error('Enter password or recovery key to unseal cloaked shard '+f.name);
            if(!shardMap) shardMap=await buildCloakShardLookup(activeKeyring.dek);
            const matchedDay=shardMap.get(f.name)||shardMap.get(f.name.replace(/\\.enc$/,''));
            if(!matchedDay) throw new Error('Could not match HMAC shard filename: '+f.name);
            const plainDoc=JSON.parse(await decryptPayload(parsed.payload,activeKeyring,'perpetual:v3:shard:'+matchedDay));
            daysMap[matchedDay]=plainDoc;
            continue;
          }

          if(parsed&&parsed.days&&typeof parsed.days==='object'){
            Object.assign(daysMap,parsed.days);
          } else if(parsed&&parsed.day){
            daysMap[parsed.day]=parsed;
          }
        }

        const outDays={};
        const stage=document.getElementById('output-stage');
        stage.innerHTML='';
        let okCount=0;

        for(const dayStr of Object.keys(daysMap).sort()){
          const doc=daysMap[dayStr];
          const decEntries={}, decComments=[];
          const block=document.createElement('article');
          block.className='day-block';
          block.innerHTML='<h2 class="day-heading">CALENDAR DAY · '+dayStr+'</h2>';

          for(const yr of Object.keys(doc.entries||{}).sort()){
            const e=doc.entries[yr];
            const expectedDate=yr+'-'+dayStr;
            let body=e.body||'', title=e.title||'', tamperMsg='';

            if(e.encrypted||String(body).startsWith('ENC:AES256GCM:')){
              if(!activeKeyring){
                body='[Encrypted — enter master password or recovery key above]';
                title=title?'[Encrypted]':'';
              } else {
                try{
                  body=await decryptPayload(e.body,activeKeyring,'perpetual:v3:entry:'+expectedDate+':'+yr+':body');
                  title=e.title?await decryptPayload(e.title,activeKeyring,'perpetual:v3:entry:'+expectedDate+':'+yr+':title'):'';
                }catch(err){
                  tamperMsg=err.message; body='[Decryption failed: '+err.message+']';
                }
              }
            }

            if(String(body).startsWith('DLOCK:PBKDF2:AES256GCM:v1:')){
              try{
                body=await decryptDoubleLock(body,doubleLockPass,'perpetual:v1:doublelock:'+expectedDate+':'+yr+':body');
                if(String(title).startsWith('DLOCK:PBKDF2:AES256GCM:v1:')){
                  title=await decryptDoubleLock(title,doubleLockPass,'perpetual:v1:doublelock:'+expectedDate+':'+yr+':title');
                }
              }catch(err){
                tamperMsg=err.message; body='[Double-Lock decryption failed]';
              }
            }

            if(!tamperMsg) okCount++;
            decEntries[yr]={...e,title,body,encrypted:false,doubleLocked:false};

            const card=document.createElement('div');
            card.className='entry-card';
            const metaLine=[e.diaryDate||expectedDate,e.mood?'mood: '+e.mood:'',e.location||'',e.weather||''].filter(Boolean).join(' · ');
            card.innerHTML=
              '<div class="entry-meta"></div>'+
              (title?'<div class="entry-title"></div>':'')+
              (tamperMsg?'<div class="tamper"></div>':'')+
              '<div class="entry-body"></div>';
            card.querySelector('.entry-meta').textContent=metaLine;
            if(title) card.querySelector('.entry-title').textContent=title;
            if(tamperMsg) card.querySelector('.tamper').textContent='⚠ '+tamperMsg;
            card.querySelector('.entry-body').textContent=body;
            block.appendChild(card);
          }

          for(const c of doc.comments||[]){
            let cBody=c.body||'';
            if(c.encrypted||String(cBody).startsWith('ENC:AES256GCM:')){
              if(activeKeyring){
                try{cBody=await decryptPayload(c.body,activeKeyring,'perpetual:v3:comment:'+dayStr+':'+c.id+':body');}
                catch{cBody='[Comment decryption failed]';}
              } else { cBody='[Encrypted comment]'; }
            }
            decComments.push({...c,body:cBody,encrypted:false});
          }

          outDays[dayStr]={day:dayStr,entries:decEntries,comments:decComments};
          stage.appendChild(block);
        }

        decryptedBundle={decryptedAt:new Date().toISOString(),days:outDays};
        document.getElementById('export-md-btn').disabled=false;
        document.getElementById('export-json-btn').disabled=false;
        setStatus('Successfully decrypted '+okCount+' entry/entries offline across '+Object.keys(outDays).length+' day(s).','ok');
      }catch(err){
        setStatus(err.message||'Decryption failed.','err');
      }
    });

    document.getElementById('decrypt-media-btn').addEventListener('click',async()=>{
      try{
        const file=document.getElementById('media-enc-file').files[0];
        if(!file) throw new Error('Choose an encrypted .enc media file first.');
        const secret=document.getElementById('secret-input').value.trim();
        if(!activeKeyring){
          if(!secret) throw new Error('Enter your Master Password or Paper Recovery Key in Section 1 first.');
          activeKeyring=await unlockOfflineVault(secret,loadedVault);
        }
        const aadPath=document.getElementById('media-aad-path').value.trim()||('media/'+file.name);
        const rawBytes=new Uint8Array(await file.arrayBuffer());
        const res=await decryptPencMedia(rawBytes,activeKeyring,aadPath);

        if(lastMediaUrl) URL.revokeObjectURL(lastMediaUrl);
        lastMediaUrl=URL.createObjectURL(new Blob([res.bytes],{type:res.mime}));

        const dlLink=document.getElementById('download-media-link');
        dlLink.href=lastMediaUrl;
        dlLink.download=file.name.replace(/\\.enc$/i,'');
        dlLink.style.display='inline';

        const prev=document.getElementById('media-preview');
        prev.innerHTML='';
        if(res.mime.startsWith('image/')){
          const img=document.createElement('img'); img.src=lastMediaUrl; img.alt='Decrypted photo'; prev.appendChild(img);
        } else if(res.mime.startsWith('audio/')){
          const aud=document.createElement('audio'); aud.controls=true; aud.src=lastMediaUrl; prev.appendChild(aud);
        }
        setStatus('Decrypted '+file.name+' ('+res.mime+', '+res.bytes.length+' bytes).','ok','media-status-box');
      }catch(err){
        setStatus(err.message||'Media decryption failed.','err','media-status-box');
      }
    });

    function triggerDownload(name,text,mime){
      const a=document.createElement('a');
      const url=URL.createObjectURL(new Blob([text],{type:mime}));
      a.href=url; a.download=name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    }

    document.getElementById('export-json-btn').addEventListener('click',()=>{
      if(!decryptedBundle) return;
      triggerDownload('perpetual-diary-decrypted.json',JSON.stringify(decryptedBundle,null,2),'application/json');
    });

    document.getElementById('export-md-btn').addEventListener('click',()=>{
      if(!decryptedBundle) return;
      const lines=['# Perpetual Diary — Offline Decrypted Export',''];
      for(const d of Object.keys(decryptedBundle.days).sort()){
        lines.push('## '+d,'');
        const doc=decryptedBundle.days[d];
        for(const yr of Object.keys(doc.entries).sort()){
          const e=doc.entries[yr];
          lines.push('### '+yr+(e.title?' — '+e.title:''),'',e.body,'');
        }
        if(doc.comments.length){
          lines.push('#### Margin Notes','');
          for(const c of doc.comments) lines.push('- **'+(c.author||'Self')+'**: '+c.body);
          lines.push('');
        }
      }
      triggerDownload('perpetual-diary-decrypted.md',lines.join('\\n'),'text/markdown');
    });
  </script>
</body>
</html>`;
}
