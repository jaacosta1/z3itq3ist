/**
 * js/argon2-worker.js — Zero-Dependency RFC 9106 Argon2id + BLAKE2b Web Worker
 * Phase 10:
 * Performs genuine memory-hard Argon2id key derivation (type=2, version=0x13)
 * off the main UI thread so the diary stays responsive while resisting offline GPU cracking.
 */

// BLAKE2b-512 64-bit Initialization Vector stored as [lo32, hi32] pairs
const BLAKE2B_IV_LO = new Uint32Array([
  0xf3bcc908, 0x84caa73b, 0xfe94f82b, 0x5f1d36f1,
  0xade682d1, 0x2b3e6c1f, 0xfb41bd6b, 0x137e2179,
]);

const BLAKE2B_IV_HI = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const BLAKE2B_SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

// Scratch buffers for BLAKE2b compression (avoids GC churn in inner loops)
const b2vLo = new Uint32Array(16);
const b2vHi = new Uint32Array(16);
const b2mLo = new Uint32Array(16);
const b2mHi = new Uint32Array(16);

function b2G(a, b, c, d, xIdx, yIdx) {
  let al = b2vLo[a];
  let ah = b2vHi[a];
  let bl = b2vLo[b];
  let bh = b2vHi[b];
  let cl = b2vLo[c];
  let ch = b2vHi[c];
  let dl = b2vLo[d];
  let dh = b2vHi[d];

  // a = a + b + m[x]
  let lo = (al + bl) >>> 0;
  let carry = lo < al ? 1 : 0;
  al = (lo + b2mLo[xIdx]) >>> 0;
  carry += al < lo ? 1 : 0;
  ah = (ah + bh + b2mHi[xIdx] + carry) >>> 0;

  // d = rotr64(d ^ a, 32)
  let xl = dl ^ al;
  let xh = dh ^ ah;
  dl = xh;
  dh = xl;

  // c = c + d
  lo = (cl + dl) >>> 0;
  ch = (ch + dh + (lo < cl ? 1 : 0)) >>> 0;
  cl = lo;

  // b = rotr64(b ^ c, 24)
  xl = bl ^ cl;
  xh = bh ^ ch;
  bl = ((xl >>> 24) | (xh << 8)) >>> 0;
  bh = ((xh >>> 24) | (xl << 8)) >>> 0;

  // a = a + b + m[y]
  lo = (al + bl) >>> 0;
  carry = lo < al ? 1 : 0;
  al = (lo + b2mLo[yIdx]) >>> 0;
  carry += al < lo ? 1 : 0;
  ah = (ah + bh + b2mHi[yIdx] + carry) >>> 0;

  // d = rotr64(d ^ a, 16)
  xl = dl ^ al;
  xh = dh ^ ah;
  dl = ((xl >>> 16) | (xh << 16)) >>> 0;
  dh = ((xh >>> 16) | (xl << 16)) >>> 0;

  // c = c + d
  lo = (cl + dl) >>> 0;
  ch = (ch + dh + (lo < cl ? 1 : 0)) >>> 0;
  cl = lo;

  // b = rotr64(b ^ c, 63)
  xl = bl ^ cl;
  xh = bh ^ ch;
  bl = ((xl << 1) | (xh >>> 31)) >>> 0;
  bh = ((xh << 1) | (xl >>> 31)) >>> 0;

  b2vLo[a] = al;
  b2vHi[a] = ah;
  b2vLo[b] = bl;
  b2vHi[b] = bh;
  b2vLo[c] = cl;
  b2vHi[c] = ch;
  b2vLo[d] = dl;
  b2vHi[d] = dh;
}

function blake2bCompress(hLo, hHi, block, tLo, tHi, isLast) {
  for (let i = 0; i < 8; i += 1) {
    b2vLo[i] = hLo[i];
    b2vHi[i] = hHi[i];
    b2vLo[i + 8] = BLAKE2B_IV_LO[i];
    b2vHi[i + 8] = BLAKE2B_IV_HI[i];
  }

  b2vLo[12] ^= tLo;
  b2vHi[12] ^= tHi;
  if (isLast) {
    b2vLo[14] = ~b2vLo[14];
    b2vHi[14] = ~b2vHi[14];
  }

  for (let i = 0; i < 16; i += 1) {
    const off = i * 8;
    b2mLo[i] =
      (block[off] |
        (block[off + 1] << 8) |
        (block[off + 2] << 16) |
        (block[off + 3] << 24)) >>>
      0;
    b2mHi[i] =
      (block[off + 4] |
        (block[off + 5] << 8) |
        (block[off + 6] << 16) |
        (block[off + 7] << 24)) >>>
      0;
  }

  for (let r = 0; r < 12; r += 1) {
    const s = BLAKE2B_SIGMA[r % 10];
    b2G(0, 4, 8, 12, s[0], s[1]);
    b2G(1, 5, 9, 13, s[2], s[3]);
    b2G(2, 6, 10, 14, s[4], s[5]);
    b2G(3, 7, 11, 15, s[6], s[7]);
    b2G(0, 5, 10, 15, s[8], s[9]);
    b2G(1, 6, 11, 12, s[10], s[11]);
    b2G(2, 7, 8, 13, s[12], s[13]);
    b2G(3, 4, 9, 14, s[14], s[15]);
  }

  for (let i = 0; i < 8; i += 1) {
    hLo[i] ^= b2vLo[i] ^ b2vLo[i + 8];
    hHi[i] ^= b2vHi[i] ^ b2vHi[i + 8];
  }
}

function blake2b(inputBytes, outLen = 64) {
  const hLo = new Uint32Array(BLAKE2B_IV_LO);
  const hHi = new Uint32Array(BLAKE2B_IV_HI);
  hLo[0] ^= 0x01010000 ^ (outLen & 0xff);

  const block = new Uint8Array(128);
  const totalLen = inputBytes.length;
  let offset = 0;
  let tLo = 0;
  let tHi = 0;

  while (totalLen - offset > 128) {
    block.set(inputBytes.subarray(offset, offset + 128), 0);
    offset += 128;
    const prevLo = tLo;
    tLo = (tLo + 128) >>> 0;
    if (tLo < prevLo) tHi = (tHi + 1) >>> 0;
    blake2bCompress(hLo, hHi, block, tLo, tHi, false);
  }

  const rem = totalLen - offset;
  block.fill(0);
  if (rem > 0) {
    block.set(inputBytes.subarray(offset), 0);
    const prevLo = tLo;
    tLo = (tLo + rem) >>> 0;
    if (tLo < prevLo) tHi = (tHi + 1) >>> 0;
  }
  blake2bCompress(hLo, hHi, block, tLo, tHi, true);

  const out = new Uint8Array(outLen);
  for (let i = 0; i < outLen; i += 1) {
    const wordIdx = i >>> 3;
    const byteInWord = i & 7;
    const word = byteInWord < 4 ? hLo[wordIdx] : hHi[wordIdx];
    out[i] = (word >>> ((byteInWord & 3) * 8)) & 0xff;
  }
  return out;
}

function writeLe32(arr, offset, val) {
  arr[offset] = val & 0xff;
  arr[offset + 1] = (val >>> 8) & 0xff;
  arr[offset + 2] = (val >>> 16) & 0xff;
  arr[offset + 3] = (val >>> 24) & 0xff;
}

/**
 * Variable-length BLAKE2b hash H'(X, tau) per RFC 9106 Section 3.3.
 */
function blake2bLong(inputBytes, tau) {
  const prefixed = new Uint8Array(4 + inputBytes.length);
  writeLe32(prefixed, 0, tau);
  prefixed.set(inputBytes, 4);

  if (tau <= 64) {
    return blake2b(prefixed, tau);
  }

  const out = new Uint8Array(tau);
  const r = Math.ceil(tau / 32) - 2;
  let v = blake2b(prefixed, 64);
  out.set(v.subarray(0, 32), 0);

  for (let i = 1; i < r; i += 1) {
    v = blake2b(v, 64);
    out.set(v.subarray(0, 32), i * 32);
  }

  const lastLen = tau - 32 * r;
  const vLast = blake2b(v, lastLen);
  out.set(vLast, r * 32);
  return out;
}

/**
 * Argon2 BlaMka quarter-round G(a, b, c, d) over 256-uint32 block state (128 × 64-bit words).
 */
function argonG(block, aIdx, bIdx, cIdx, dIdx) {
  let al = block[aIdx];
  let ah = block[aIdx + 1];
  let bl = block[bIdx];
  let bh = block[bIdx + 1];
  let cl = block[cIdx];
  let ch = block[cIdx + 1];
  let dl = block[dIdx];
  let dh = block[dIdx + 1];

  // fBlaMka(a, b) = a + b + 2 * lo32(a) * lo32(b)
  let a0 = al & 0xffff;
  let a1 = al >>> 16;
  let b0 = bl & 0xffff;
  let b1 = bl >>> 16;
  let p00 = a0 * b0;
  let p01 = a0 * b1;
  let p10 = a1 * b0;
  let p11 = a1 * b1;
  let mid = (p00 >>> 16) + (p01 & 0xffff) + (p10 & 0xffff);
  let prodLo = (((mid & 0xffff) << 16) | (p00 & 0xffff)) >>> 0;
  let prodHi = (p11 + (p01 >>> 16) + (p10 >>> 16) + (mid >>> 16)) >>> 0;
  let twoHi = ((prodHi << 1) | (prodLo >>> 31)) >>> 0;
  let twoLo = (prodLo << 1) >>> 0;

  let lo = (al + bl) >>> 0;
  let carry = lo < al ? 1 : 0;
  al = (lo + twoLo) >>> 0;
  carry += al < lo ? 1 : 0;
  ah = (ah + bh + twoHi + carry) >>> 0;

  // d = rotr64(d ^ a, 32)
  let xl = dl ^ al;
  let xh = dh ^ ah;
  dl = xh;
  dh = xl;

  // fBlaMka(c, d)
  a0 = cl & 0xffff;
  a1 = cl >>> 16;
  b0 = dl & 0xffff;
  b1 = dl >>> 16;
  p00 = a0 * b0;
  p01 = a0 * b1;
  p10 = a1 * b0;
  p11 = a1 * b1;
  mid = (p00 >>> 16) + (p01 & 0xffff) + (p10 & 0xffff);
  prodLo = (((mid & 0xffff) << 16) | (p00 & 0xffff)) >>> 0;
  prodHi = (p11 + (p01 >>> 16) + (p10 >>> 16) + (mid >>> 16)) >>> 0;
  twoHi = ((prodHi << 1) | (prodLo >>> 31)) >>> 0;
  twoLo = (prodLo << 1) >>> 0;

  lo = (cl + dl) >>> 0;
  carry = lo < cl ? 1 : 0;
  cl = (lo + twoLo) >>> 0;
  carry += cl < lo ? 1 : 0;
  ch = (ch + dh + twoHi + carry) >>> 0;

  // b = rotr64(b ^ c, 24)
  xl = bl ^ cl;
  xh = bh ^ ch;
  bl = ((xl >>> 24) | (xh << 8)) >>> 0;
  bh = ((xh >>> 24) | (xl << 8)) >>> 0;

  // fBlaMka(a, b)
  a0 = al & 0xffff;
  a1 = al >>> 16;
  b0 = bl & 0xffff;
  b1 = bl >>> 16;
  p00 = a0 * b0;
  p01 = a0 * b1;
  p10 = a1 * b0;
  p11 = a1 * b1;
  mid = (p00 >>> 16) + (p01 & 0xffff) + (p10 & 0xffff);
  prodLo = (((mid & 0xffff) << 16) | (p00 & 0xffff)) >>> 0;
  prodHi = (p11 + (p01 >>> 16) + (p10 >>> 16) + (mid >>> 16)) >>> 0;
  twoHi = ((prodHi << 1) | (prodLo >>> 31)) >>> 0;
  twoLo = (prodLo << 1) >>> 0;

  lo = (al + bl) >>> 0;
  carry = lo < al ? 1 : 0;
  al = (lo + twoLo) >>> 0;
  carry += al < lo ? 1 : 0;
  ah = (ah + bh + twoHi + carry) >>> 0;

  // d = rotr64(d ^ a, 16)
  xl = dl ^ al;
  xh = dh ^ ah;
  dl = ((xl >>> 16) | (xh << 16)) >>> 0;
  dh = ((xh >>> 16) | (xl << 16)) >>> 0;

  // fBlaMka(c, d)
  a0 = cl & 0xffff;
  a1 = cl >>> 16;
  b0 = dl & 0xffff;
  b1 = dl >>> 16;
  p00 = a0 * b0;
  p01 = a0 * b1;
  p10 = a1 * b0;
  p11 = a1 * b1;
  mid = (p00 >>> 16) + (p01 & 0xffff) + (p10 & 0xffff);
  prodLo = (((mid & 0xffff) << 16) | (p00 & 0xffff)) >>> 0;
  prodHi = (p11 + (p01 >>> 16) + (p10 >>> 16) + (mid >>> 16)) >>> 0;
  twoHi = ((prodHi << 1) | (prodLo >>> 31)) >>> 0;
  twoLo = (prodLo << 1) >>> 0;

  lo = (cl + dl) >>> 0;
  carry = lo < cl ? 1 : 0;
  cl = (lo + twoLo) >>> 0;
  carry += cl < lo ? 1 : 0;
  ch = (ch + dh + twoHi + carry) >>> 0;

  // b = rotr64(b ^ c, 63)
  xl = bl ^ cl;
  xh = bh ^ ch;
  bl = ((xl << 1) | (xh >>> 31)) >>> 0;
  bh = ((xh << 1) | (xl >>> 31)) >>> 0;

  block[aIdx] = al;
  block[aIdx + 1] = ah;
  block[bIdx] = bl;
  block[bIdx + 1] = bh;
  block[cIdx] = cl;
  block[cIdx + 1] = ch;
  block[dIdx] = dl;
  block[dIdx + 1] = dh;
}

function permute16(b, i0, i1, i2, i3, i4, i5, i6, i7, i8, i9, i10, i11, i12, i13, i14, i15) {
  argonG(b, i0, i4, i8, i12);
  argonG(b, i1, i5, i9, i13);
  argonG(b, i2, i6, i10, i14);
  argonG(b, i3, i7, i11, i15);
  argonG(b, i0, i5, i10, i15);
  argonG(b, i1, i6, i11, i12);
  argonG(b, i2, i7, i8, i13);
  argonG(b, i3, i4, i9, i14);
}

const compR = new Uint32Array(256);
const compZ = new Uint32Array(256);
const zeroBlock = new Uint32Array(256);
const addrInput = new Uint32Array(256);
const addrMid = new Uint32Array(256);
const addrOut = new Uint32Array(256);

/**
 * Argon2 compression function G(X, Y) -> out (all represented as 256-uint32 views).
 */
function compressBlock(xArr, xOff, yArr, yOff, outArr, outOff, xorOut) {
  for (let i = 0; i < 256; i += 1) {
    const r = xArr[xOff + i] ^ yArr[yOff + i];
    compR[i] = r;
    compZ[i] = r;
  }

  // Row-wise permutation (8 rows of 16 × 64-bit words)
  for (let row = 0; row < 8; row += 1) {
    const o = row * 32;
    permute16(
      compZ,
      o, o + 2, o + 4, o + 6, o + 8, o + 10, o + 12, o + 14,
      o + 16, o + 18, o + 20, o + 22, o + 24, o + 26, o + 28, o + 30
    );
  }

  // Column-wise permutation (8 pairs of columns across 8 rows)
  for (let col = 0; col < 8; col += 1) {
    const c = col * 4;
    permute16(
      compZ,
      c, c + 2, c + 32, c + 34, c + 64, c + 66, c + 96, c + 98,
      c + 128, c + 130, c + 160, c + 162, c + 192, c + 194, c + 224, c + 226
    );
  }

  if (xorOut) {
    for (let i = 0; i < 256; i += 1) {
      outArr[outOff + i] ^= compR[i] ^ compZ[i];
    }
  } else {
    for (let i = 0; i < 256; i += 1) {
      outArr[outOff + i] = compR[i] ^ compZ[i];
    }
  }
}

function bytesToBlockU32(bytes, dst, dstOff) {
  for (let i = 0; i < 256; i += 1) {
    const o = i * 4;
    dst[dstOff + i] =
      (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0;
  }
}

function blockU32ToBytes(src, srcOff) {
  const out = new Uint8Array(1024);
  for (let i = 0; i < 256; i += 1) {
    writeLe32(out, i * 4, src[srcOff + i]);
  }
  return out;
}

/**
 * Pure RFC 9106 Argon2id (parallelism = 1, version = 0x13, type = 2).
 */
function argon2idDerive(passwordBytes, saltBytes, { memoryKiB = 16384, timeCost = 2, hashLen = 32 } = {}) {
  const p = 1;
  const t = Math.max(1, Number(timeCost) || 2);
  const mRaw = Math.max(8, Number(memoryKiB) || 16384);
  const mPrime = Math.floor(mRaw / 4) * 4;
  const q = mPrime;
  const segLen = q / 4;

  // Build H0 input buffer
  const h0In = new Uint8Array(40 + passwordBytes.length + saltBytes.length);
  let pos = 0;
  writeLe32(h0In, pos, p); pos += 4;
  writeLe32(h0In, pos, hashLen); pos += 4;
  writeLe32(h0In, pos, mRaw); pos += 4;
  writeLe32(h0In, pos, t); pos += 4;
  writeLe32(h0In, pos, 0x13); pos += 4; // Version 1.3
  writeLe32(h0In, pos, 2); pos += 4;    // Argon2id
  writeLe32(h0In, pos, passwordBytes.length); pos += 4;
  h0In.set(passwordBytes, pos); pos += passwordBytes.length;
  writeLe32(h0In, pos, saltBytes.length); pos += 4;
  h0In.set(saltBytes, pos); pos += saltBytes.length;
  writeLe32(h0In, pos, 0); pos += 4; // secret len
  writeLe32(h0In, pos, 0);           // associated data len

  const H0 = blake2b(h0In, 64);

  // Allocate full memory matrix B (mPrime × 1024 bytes)
  const mem = new Uint32Array(q * 256);

  const seedBuf = new Uint8Array(72);
  seedBuf.set(H0, 0);
  writeLe32(seedBuf, 64, 0);
  writeLe32(seedBuf, 68, 0);
  bytesToBlockU32(blake2bLong(seedBuf, 1024), mem, 0);

  writeLe32(seedBuf, 64, 1);
  writeLe32(seedBuf, 68, 0);
  bytesToBlockU32(blake2bLong(seedBuf, 1024), mem, 256);

  for (let pass = 0; pass < t; pass += 1) {
    for (let slice = 0; slice < 4; slice += 1) {
      const dataIndependent = pass === 0 && slice < 2;
      let addrCounter = 0;

      if (dataIndependent) {
        addrInput.fill(0);
        addrInput[0] = pass;
        addrInput[2] = 0; // lane 0
        addrInput[4] = slice;
        addrInput[6] = mPrime;
        addrInput[8] = t;
        addrInput[10] = 2; // Argon2id
      }

      for (let idx = 0; idx < segLen; idx += 1) {
        if (pass === 0 && slice === 0 && idx < 2) continue;

        const currIdx = slice * segLen + idx;
        const prevIdx = currIdx === 0 ? q - 1 : currIdx - 1;

        let j1;
        if (dataIndependent) {
          const offsetInAddr = idx & 127;
          if (offsetInAddr === 0 || (pass === 0 && slice === 0 && idx === 2)) {
            addrCounter += 1;
            addrInput[12] = addrCounter;
            compressBlock(zeroBlock, 0, addrInput, 0, addrMid, 0, false);
            compressBlock(zeroBlock, 0, addrMid, 0, addrOut, 0, false);
          }
          j1 = addrOut[offsetInAddr * 2];
        } else {
          j1 = mem[prevIdx * 256];
        }

        const refAreaSize =
          pass === 0 ? slice * segLen + idx - 1 : q - segLen + idx - 1;

        // Exact RFC 9106 Section 3.4.2 relative position
        const x = Math.floor((j1 * j1) / 4294967296);
        const y = Math.floor((refAreaSize * x) / 4294967296);
        const relPos = refAreaSize - 1 - y;
        const startPos = pass === 0 || slice === 3 ? 0 : (slice + 1) * segLen;
        const refIdx = (startPos + relPos) % q;

        compressBlock(
          mem,
          prevIdx * 256,
          mem,
          refIdx * 256,
          mem,
          currIdx * 256,
          pass > 0
        );
      }
    }
  }

  const finalBlockBytes = blockU32ToBytes(mem, (q - 1) * 256);
  // Zero memory buffer before returning derived key
  mem.fill(0);
  return blake2bLong(finalBlockBytes, hashLen);
}

self.onmessage = (event) => {
  const { id, passwordBytes, saltBytes, memoryKiB, timeCost, hashLen } = event.data || {};
  try {
    const t0 = performance.now();
    const derived = argon2idDerive(
      new Uint8Array(passwordBytes),
      new Uint8Array(saltBytes),
      { memoryKiB, timeCost, hashLen }
    );
    const elapsedMs = Math.round(performance.now() - t0);
    self.postMessage(
      { id, ok: true, keyBytes: derived.buffer, elapsedMs },
      [derived.buffer]
    );
  } catch (err) {
    self.postMessage({
      id,
      ok: false,
      error: err?.message || 'Argon2id key derivation failed in worker.',
    });
  }
};
