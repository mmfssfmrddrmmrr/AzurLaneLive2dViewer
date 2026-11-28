// 使用AI辅助
import { decompile } from "node-luajit-decompiler-v2";
// ============================================================================
// 常量
// ============================================================================
const BCDUMP_HEAD1 = 0x1b;
const BCDUMP_HEAD2 = 0x4c;
const BCDUMP_HEAD3 = 0x4a;
const BCDUMP_VERSION = 2;
const BCDUMP_F_STRIP = 0x02;

const MAX_SIZE_KGC = 100000;
const MAX_SIZE_KNUM = 100000;

const OP_MAP = Uint8Array.from([
  12, 13, 14, 15, 16, 17, 39, 40, 41, 42, 43, 44, 77, 78, 79, 80, 81, 82, 83,
  84, 85, 86, 87, 88, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 65, 66, 67, 68,
  69, 70, 71, 72, 18, 19, 20, 21, 73, 74, 75, 76, 22, 23, 24, 25, 26, 27, 28,
  29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 45, 46, 47, 48, 49, 50, 51, 52, 53,
  54, 55, 56, 57, 58, 59, 64, 60, 61, 62, 63, 96, 89, 90, 91, 92, 93, 94, 95,
]);

export class RestoreError extends Error {}

// ============================================================================
// ByteWriter：动态增长缓冲区，替代 number[] + push(...arr)
// ============================================================================
class ByteWriter {
  private buf: Uint8Array;
  private _len = 0;

  constructor(initial = 4096) {
    this.buf = new Uint8Array(initial);
  }

  private grow(need: number): void {
    if (this._len + need <= this.buf.length) return;
    let cap = this.buf.length || 1;
    while (cap < this._len + need) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this._len));
    this.buf = nb;
  }

  u8(v: number): void {
    if (this._len === this.buf.length) this.grow(1);
    this.buf[this._len++] = v & 0xff;
  }

  bytes(src: Uint8Array): void {
    this.grow(src.length);
    this.buf.set(src, this._len);
    this._len += src.length;
  }

  /** 将 src 每个字节按 (~b ^ i) & 0xff 解密并写入（用于 sharecfgdata 字符串混淆） */
  xorDecrypt(src: Uint8Array): void {
    const n = src.length;
    if (n === 0) return;
    this.grow(n);
    const buf = this.buf;
    let k = this._len;
    for (let i = 0; i < n; i++) buf[k + i] = ~(src[i]! ^ (i & 0xff)) & 0xff;
    this._len += n;
  }

  leb(v: number): void {
    while (v >= 0x80) {
      this.u8((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    this.u8(v);
  }

  leb33(v: number, isnum: boolean): void {
    const first = ((v & 0x3f) << 1) | (isnum ? 1 : 0);
    v = Math.floor(v / 64);
    if (v > 0) {
      this.u8(first | 0x80);
      while (v >= 0x80) {
        this.u8((v & 0x7f) | 0x80);
        v = Math.floor(v / 128);
      }
      this.u8(v);
    } else {
      this.u8(first);
    }
  }

  toUint8Array(): Uint8Array {
    return this.buf.slice(0, this._len);
  }
}

// ============================================================================
// ULEB128 读取
// ============================================================================
function readULEB128(
  data: Uint8Array,
  pos: number,
  pastEndOk = false,
): [number, number] {
  if (pos >= data.length) {
    if (pastEndOk) return [0, pos];
    throw new RestoreError("ULEB128: read past end");
  }
  let p = pos;
  let v = data[p]!;
  p++;
  if (v >= 0x80) {
    v &= 0x7f;
    let sh = 7;
    for (;;) {
      if (p >= data.length) {
        if (pastEndOk) return [v, p];
        throw new RestoreError("ULEB128: read past end");
      }
      const b = data[p]!;
      p++;
      v += (b & 0x7f) * 2 ** sh;
      if (b < 0x80) break;
      sh += 7;
    }
  }
  return [v, p];
}

function readULEB128_33(
  data: Uint8Array,
  pos: number,
  pastEndOk = false,
): [number, number, number] {
  if (pos >= data.length) {
    if (pastEndOk) return [0, 0, pos];
    throw new RestoreError("ULEB128_33: read past end");
  }
  let p = pos;
  const b0 = data[p]!;
  p++;
  const isnum = b0 & 1;
  let v = (b0 >> 1) & 0x3f;
  if (b0 >= 0x80) {
    let sh = 6;
    for (;;) {
      if (p >= data.length) {
        if (pastEndOk) return [v, isnum, p];
        throw new RestoreError("ULEB128_33: continuation past end");
      }
      const b = data[p]!;
      p++;
      v += (b & 0x7f) * 2 ** sh;
      if (b < 0x80) break;
      sh += 7;
    }
  }
  return [v, isnum, p];
}

// ============================================================================
// Proto 头
// ============================================================================
interface ProtoHeader {
  flags: number;
  numparams: number;
  framesize: number;
  sizeuv: number;
}

function restoreProtoHeader(
  data: Uint8Array,
  pos: number,
): [ProtoHeader, number] {
  if (pos + 4 > data.length) throw new RestoreError("proto header truncated");
  const b0 = data[pos]!;
  const b1 = data[pos + 1]!;
  const b2 = data[pos + 2]!;
  const b3 = data[pos + 3]!;
  const framesize = b0;
  const flags = (b1 ^ b0) & 0xff;
  const numparams = (b2 ^ flags) & 0xff;
  const sizeuv = (b3 ^ numparams) & 0xff;
  return [{ flags, numparams, framesize, sizeuv }, pos + 4];
}

// ============================================================================
// Ktabk（table key/val tag + 内容）直接写入 writer
// ============================================================================
function readKtabkInto(data: Uint8Array, pos: number, w: ByteWriter): number {
  let tp: number;
  [tp, pos] = readULEB128(data, pos, true);
  if (tp > 4) {
    const remaining = Math.max(0, data.length - pos);
    const slen = Math.min(tp - 5, remaining);
    w.leb(5 + slen);
    w.xorDecrypt(data.subarray(pos, pos + slen));
    return pos + slen;
  }
  if (tp === 3) {
    let v: number;
    [v, pos] = readULEB128(data, pos);
    w.u8(3);
    w.leb(v);
    return pos;
  }
  if (tp === 4) {
    let lo: number, hi: number;
    [lo, pos] = readULEB128(data, pos);
    [hi, pos] = readULEB128(data, pos);
    w.u8(4);
    w.leb(lo);
    w.leb(hi);
    return pos;
  }
  w.u8(tp);
  return pos;
}

// ============================================================================
// KGC item 直接写入 writer
// ============================================================================
function readKgcItemInto(data: Uint8Array, pos: number, w: ByteWriter): number {
  let tp: number;
  [tp, pos] = readULEB128(data, pos, true);
  if (tp > 4) {
    const remaining = Math.max(0, data.length - pos);
    const slen = Math.min(tp - 5, remaining);
    w.leb(5 + slen);
    w.xorDecrypt(data.subarray(pos, pos + slen));
    return pos + slen;
  }
  if (tp === 1) {
    // 读顺序：nhash 然后 narray；写顺序：narray 然后 nhash
    let nhash: number, narray: number;
    [nhash, pos] = readULEB128(data, pos);
    [narray, pos] = readULEB128(data, pos);
    w.u8(1);
    w.leb(narray);
    w.leb(nhash);

    for (let i = 0; i < narray; i++) pos = readKtabkInto(data, pos, w);

    if (nhash > 0) {
      // 混淆层 4：hash 项逆序。先存后写。
      const hashBufs: Uint8Array[] = [];
      for (let i = 0; i < nhash; i++) {
        const hw = new ByteWriter(48);
        pos = readKtabkInto(data, pos, hw);
        pos = readKtabkInto(data, pos, hw);
        hashBufs.push(hw.toUint8Array());
      }
      for (let i = hashBufs.length - 1; i >= 0; i--) w.bytes(hashBufs[i]!);
    }
    return pos;
  }
  if (tp === 0) {
    w.u8(0);
    return pos;
  }
  if (tp === 4) {
    let a: number, b: number, c: number, d: number;
    [a, pos] = readULEB128(data, pos);
    [b, pos] = readULEB128(data, pos);
    [c, pos] = readULEB128(data, pos);
    [d, pos] = readULEB128(data, pos);
    w.u8(4);
    w.leb(a);
    w.leb(b);
    w.leb(c);
    w.leb(d);
    return pos;
  }
  if (tp === 2 || tp === 3) {
    let lo: number, hi: number;
    [lo, pos] = readULEB128(data, pos);
    [hi, pos] = readULEB128(data, pos);
    w.u8(tp);
    w.leb(lo);
    w.leb(hi);
    return pos;
  }
  throw new RestoreError(`unknown KGC type ${tp}`);
}

// ============================================================================
// Proto 恢复核心
// ============================================================================
function restoreProtoImpl(
  data: Uint8Array,
  dumpFlags: number,
  flags: number,
  numparams: number,
  framesize: number,
  sizeuv: number,
  sizekgc: number,
  sizekn: number,
  sizebcMinus1Orig: number,
  startP: number,
  bodyKnumThenKgc: boolean,
  reverseKgc: boolean,
): Uint8Array {
  if (sizekgc > MAX_SIZE_KGC || sizekn > MAX_SIZE_KNUM) {
    throw new RestoreError("sizekgc/sizekn exceeds cap");
  }
  let p = startP;

  if (!(dumpFlags & BCDUMP_F_STRIP)) {
    let sizedbg: number;
    [sizedbg, p] = readULEB128(data, p);
    if (sizedbg !== 0) {
      p += 4;
      for (let i = 0; i < 5; i++) {
        let _: number;
        [_, p] = readULEB128(data, p);
      }
    }
  }

  const bcCount = sizebcMinus1Orig;
  const bcRawLen = bcCount * 4;
  if (p + bcRawLen > data.length) {
    throw new RestoreError("bytecode block truncated");
  }

  const w = new ByteWriter(1024 + bcRawLen);
  w.u8(flags);
  w.u8(numparams);
  w.u8(framesize);
  w.u8(sizeuv);
  w.leb(sizekgc);
  w.leb(sizekn);
  w.leb(sizebcMinus1Orig);

  // [SUSPECT] Python 版本中 ins0（IFUNC/FUNCF 头指令）被生成但从未拼接到输出。
  // 这里行为保持一致——不生成。
  {
    const base = p;
    const end = p + bcRawLen;
    for (let i = base; i < end; i += 4) {
      const op = data[i]!;
      const a = data[i + 1]!;
      const c = data[i + 2]!;
      const b = data[i + 3]!;
      if (op >= OP_MAP.length) throw new RestoreError(`opcode out of range: ${op}`);
      w.u8(OP_MAP[op]!);
      w.u8(~a & 0xff);
      w.u8(c);
      w.u8((b ^ ((i - base) >> 2)) & 0xff);
    }
    p = end;
  }

  // UV
  const uvLen = 2 * sizeuv;
  const readUv = Math.min(uvLen, Math.max(0, data.length - p));
  w.bytes(data.subarray(p, p + readUv));
  for (let i = readUv; i < uvLen; i++) w.u8(0);
  p += readUv;

  const readKnumBlock = (startPos: number, w: ByteWriter): number => {
    let pos = startPos;
    for (let i = 0; i < sizekn; i++) {
      const prev = pos;
      let lo: number, isnum: number;
      [lo, isnum, pos] = readULEB128_33(data, pos, true);
      if (pos === prev && pos >= data.length && i > 0) {
        for (let j = i; j < sizekn; j++) w.leb33(0, false);
        return pos;
      }
      w.leb33(lo, isnum !== 0);
      if (isnum) {
        let hi: number;
        [hi, pos] = readULEB128(data, pos);
        w.leb(hi);
      }
    }
    return pos;
  };

  const readKgcBlock = (startPos: number, w: ByteWriter): number => {
    let pos = startPos;
    if (!reverseKgc) {
      for (let i = 0; i < sizekgc; i++) {
        const prev = pos;
        pos = readKgcItemInto(data, pos, w);
        if (pos === prev && pos >= data.length && i > 0) {
          for (let j = i; j < sizekgc; j++) w.u8(0);
          break;
        }
      }
      return pos;
    }
    // 需要逆序：先读入临时缓冲区，再倒序写出
    const items: Uint8Array[] = [];
    for (let i = 0; i < sizekgc; i++) {
      const prev = pos;
      const sw = new ByteWriter(64);
      pos = readKgcItemInto(data, pos, sw);
      if (pos === prev && pos >= data.length && i > 0) {
        const zero = Uint8Array.of(0);
        for (let j = i; j < sizekgc; j++) items.push(zero);
        break;
      }
      items.push(sw.toUint8Array());
    }
    for (let i = items.length - 1; i >= 0; i--) w.bytes(items[i]!);
    return pos;
  };

  const kgcWriter = new ByteWriter(128);
  const knumWriter = new ByteWriter(64);

  if (bodyKnumThenKgc) {
    p = readKnumBlock(p, knumWriter);
    p = readKgcBlock(p, kgcWriter);
  } else {
    p = readKgcBlock(p, kgcWriter);
    p = readKnumBlock(p, knumWriter);
  }

  w.bytes(kgcWriter.toUint8Array());
  w.bytes(knumWriter.toUint8Array());

  return w.toUint8Array();
}

function restoreProto(data: Uint8Array, dumpFlags: number): Uint8Array {
  let p = 0;
  let header: ProtoHeader;
  [header, p] = restoreProtoHeader(data, p);
  const { flags, numparams, framesize, sizeuv } = header;

  let u1: number, u2: number, u3: number;
  [u1, p] = readULEB128(data, p);
  [u2, p] = readULEB128(data, p);
  [u3, p] = readULEB128(data, p);

  const sizebcMinus1Orig = u3;
  const startP = p;

  const attempts: ReadonlyArray<{
    sizekgc: number;
    sizekn: number;
    bodyKnumThenKgc: boolean;
    reverseKgc: boolean;
    label: string;
  }> = [
    { sizekgc: u2, sizekn: u1, bodyKnumThenKgc: true,  reverseKgc: false, label: "1" },
    { sizekgc: u1, sizekn: u2, bodyKnumThenKgc: false, reverseKgc: false, label: "2" },
    { sizekgc: u2, sizekn: u1, bodyKnumThenKgc: false, reverseKgc: true,  label: "3" },
  ];

  let lastError: unknown = new RestoreError("no attempts");
  for (const a of attempts) {
    try {
      return restoreProtoImpl(
        data, dumpFlags, flags, numparams, framesize, sizeuv,
        a.sizekgc, a.sizekn, sizebcMinus1Orig, startP,
        a.bodyKnumThenKgc, a.reverseKgc,
      );
    } catch (e) {
      if (!(e instanceof RestoreError)) {
        console.warn(`[restoreProto] attempt ${a.label} threw non-RestoreError:`, e);
      }
      lastError = e;
    }
  }
  throw lastError;
}

// ============================================================================
// sharecfgdata chunk 解析 + 包装
// ============================================================================
function parseSharecfgChunks(data: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let pos = 0;
  while (pos < data.length) {
    const start = pos;
    let length: number;
    [length, pos] = readULEB128(data, pos);
    if (length <= 0) throw new RestoreError(`invalid zero-length chunk at offset ${start}`);
    const end = pos + length;
    if (end > data.length) {
      throw new RestoreError(
        `chunk at offset ${start} claims ${length} bytes, only ${data.length - pos} remain`,
      );
    }
    chunks.push(data.subarray(pos, end));
    pos = end;
  }
  return chunks;
}

function wrapProtoAsBcdump(restoredProto: Uint8Array): Uint8Array {
  const mainProto = Uint8Array.from(restoredProto);
  mainProto[0] = mainProto[0]! | 0x02;

  const w = new ByteWriter(mainProto.length + 16);
  w.u8(BCDUMP_HEAD1);
  w.u8(BCDUMP_HEAD2);
  w.u8(BCDUMP_HEAD3);
  w.u8(BCDUMP_VERSION);
  w.leb(BCDUMP_F_STRIP);
  w.leb(mainProto.length);
  w.bytes(mainProto);
  w.u8(0);
  return w.toUint8Array();
}

/* 
export async function restoreSharecfgFile(
  inputPath: string,
  outputDir: string,
): Promise<number> {
  const data = new Uint8Array(await readFile(inputPath));
  const chunks = parseSharecfgChunks(data);
  await mkdir(outputDir, { recursive: true });

  const width = Math.max(4, String(chunks.length - 1).length);
  const baseName = nodePath.basename(inputPath);
  for (let i = 0; i < chunks.length; i++) {
    const restored = restoreProto(chunks[i] ?? new Uint8Array(0), BCDUMP_F_STRIP);
    const outPath = nodePath.join(
      outputDir,
      `${baseName}__${String(i).padStart(width, "0")}.lj`,
    );
    await writeFile(outPath, wrapProtoAsBcdump(restored));
  }
  return chunks.length;
}*/

export function restoreSharecfgToString(
  data: Uint8Array,
): string {
  let lua = "";
  const ljs = parseSharecfgChunks(data).map((proto, index) => 
    wrapProtoAsBcdump(restoreProto(proto, BCDUMP_F_STRIP)),
  );
  ljs.forEach(lj => {
    lua += decompile(Buffer.from(lj), {
      ignoreDebugInfo: false,
      minimizeDiffs: true,
      unrestrictedAscii: true,
    }).toString()
  });
  return lua;
}
