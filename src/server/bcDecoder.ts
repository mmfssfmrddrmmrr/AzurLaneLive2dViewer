const BYTECODE_HEADER = [0x1b, 0x4c, 0x4a, 0x02] as const;
const FLAG_BIG_ENDIAN = 0x01;
const FLAG_STRIP = 0x02;
const FLAG_FFI = 0x04;
const FLAG_FR2 = 0x08;
const MAX_CONSTANTS = 1_000_000;

const OPCODE_MAP = Uint8Array.from([
  12, 13, 14, 15, 16, 17, 39, 40, 41, 42, 43, 44, 77, 78, 79, 80, 81, 82, 83,
  84, 85, 86, 87, 88, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 65, 66, 67, 68,
  69, 70, 71, 72, 18, 19, 20, 21, 73, 74, 75, 76, 22, 23, 24, 25, 26, 27, 28,
  29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 45, 46, 47, 48, 49, 50, 51, 52, 53,
  54, 55, 56, 57, 58, 59, 64, 60, 61, 62, 63, 96, 89, 90, 91, 92, 93, 94, 95,
]);

type Cursor = {
  data: Uint8Array;
  offset: number;
  end: number;
};

type KgcEntry = {
  bytes: Uint8Array;
  child?: Prototype;
};

type Prototype = {
  flags: number;
  numparams: number;
  framesize: number;
  sizeuv: number;
  instructions: Uint8Array;
  upvalues: Uint8Array;
  kgc: KgcEntry[];
  knum: Uint8Array;
  sizekn: number;
};

class ByteWriter {
  private readonly chunks: Uint8Array[] = [];
  private size = 0;

  writeByte(value: number): void {
    this.write(Uint8Array.of(value & 0xff));
  }

  write(data: Uint8Array): void {
    this.chunks.push(data);
    this.size += data.byteLength;
  }

  writeUleb(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
      throw new Error(`Invalid ULEB128 value: ${value}`);
    }

    while (value >= 0x80) {
      this.writeByte((value & 0x7f) | 0x80);
      value = Math.floor(value / 128);
    }
    this.writeByte(value);
  }

  toUint8Array(): Uint8Array {
    const result = new Uint8Array(this.size);
    let offset = 0;
    for (const chunk of this.chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }
}

function readByte(cursor: Cursor): number {
  if (cursor.offset >= cursor.end) {
    throw new Error("Truncated LuaJIT bytecode");
  }
  return cursor.data[cursor.offset++]!;
}

function readBytes(cursor: Cursor, length: number): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 0 || cursor.offset + length > cursor.end) {
    throw new Error("Truncated LuaJIT bytecode block");
  }
  const result = cursor.data.subarray(cursor.offset, cursor.offset + length);
  cursor.offset += length;
  return result;
}

function readUleb(cursor: Cursor): number {
  let value = 0;
  let shift = 0;
  for (let count = 0; count < 5; count++) {
    const byte = readByte(cursor);
    value += (byte & 0x7f) * 2 ** shift;
    if (byte < 0x80) {
      if (value > 0xffffffff) throw new Error("ULEB128 value exceeds 32 bits");
      return value;
    }
    shift += 7;
  }
  throw new Error("Invalid ULEB128 value");
}

function readUleb33(cursor: Cursor): { value: number; isNumber: boolean } {
  const first = readByte(cursor);
  const isNumber = (first & 1) !== 0;
  let value = first >>> 1;
  if (first >= 0x80) {
    value &= 0x3f;
    let shift = 6;
    for (let count = 0; count < 5; count++) {
      const byte = readByte(cursor);
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) {
        if (value > 0xffffffff) throw new Error("ULEB128_33 value exceeds 32 bits");
        return { value, isNumber };
      }
      shift += 7;
    }
    throw new Error("Invalid ULEB128_33 value");
  }
  return { value, isNumber };
}

function writeUleb33(writer: ByteWriter, value: number, isNumber: boolean): void {
  const firstValue = ((value % 64) << 1) | Number(isNumber);
  value = Math.floor(value / 64);
  if (value === 0) {
    writer.writeByte(firstValue);
    return;
  }

  writer.writeByte(firstValue | 0x80);
  while (value >= 0x80) {
    writer.writeByte((value & 0x7f) | 0x80);
    value = Math.floor(value / 128);
  }
  writer.writeByte(value);
}

function decodeObfuscatedString(data: Uint8Array): Uint8Array {
  const decoded = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    decoded[i] = ~(data[i]! ^ (i & 0xff)) & 0xff;
  }
  return decoded;
}

function readKtabItem(cursor: Cursor, writer: ByteWriter): void {
  const type = readUleb(cursor);
  writer.writeUleb(type);
  if (type > 4) {
    const value = decodeObfuscatedString(readBytes(cursor, type - 5));
    writer.write(value);
  } else if (type === 3) {
    writer.writeUleb(readUleb(cursor));
  } else if (type === 4) {
    writer.writeUleb(readUleb(cursor));
    writer.writeUleb(readUleb(cursor));
  }
}

function readKgcEntry(cursor: Cursor, stack: Prototype[]): KgcEntry {
  const writer = new ByteWriter();
  const type = readUleb(cursor);
  writer.writeUleb(type);

  if (type > 4) {
    const value = decodeObfuscatedString(readBytes(cursor, type - 5));
    writer.write(value);
  } else if (type === 1) {
    const hashCount = readUleb(cursor);
    const arrayCount = readUleb(cursor);
    if (arrayCount > MAX_CONSTANTS || hashCount > MAX_CONSTANTS) {
      throw new Error("LuaJIT constant table exceeds supported size");
    }
    writer.writeUleb(arrayCount);
    writer.writeUleb(hashCount);
    for (let i = 0; i < arrayCount + hashCount * 2; i++) {
      readKtabItem(cursor, writer);
    }
  } else if (type === 2 || type === 3) {
    writer.writeUleb(readUleb(cursor));
    writer.writeUleb(readUleb(cursor));
  } else if (type === 4) {
    for (let i = 0; i < 4; i++) writer.writeUleb(readUleb(cursor));
  }

  if (type === 0) {
    const child = stack.pop();
    if (!child) throw new Error("LuaJIT child prototype stack underflow");
    return { bytes: writer.toUint8Array(), child };
  }
  return { bytes: writer.toUint8Array() };
}

function parsePrototype(
  data: Uint8Array,
  dumpFlags: number,
  bigEndian: boolean,
  stack: Prototype[],
): Prototype {
  const cursor: Cursor = { data, offset: 0, end: data.length };
  const framesize = readByte(cursor);
  const flags = readByte(cursor) ^ framesize;
  const numparams = readByte(cursor) ^ flags;
  const sizeuv = readByte(cursor) ^ numparams;
  const sizekn = readUleb(cursor);
  const sizekgc = readUleb(cursor);
  const bytecodeCount = readUleb(cursor);

  if (flags & ~0x07) throw new Error(`Invalid restored prototype flags: 0x${flags.toString(16)}`);
  if (sizeuv > 0xff || sizekn > MAX_CONSTANTS || sizekgc > MAX_CONSTANTS) {
    throw new Error("LuaJIT prototype exceeds supported limits");
  }

  if (!(dumpFlags & FLAG_STRIP)) {
    const debugSize = readUleb(cursor);
    if (debugSize !== 0) {
      throw new Error("bcDec cannot restore LuaJIT dumps containing debug metadata");
    }
  }

  const instructionBytes = readBytes(cursor, bytecodeCount * 4);
  const instructions = instructionBytes.slice();
  for (let i = 0; i < bytecodeCount; i++) {
    const offset = i * 4;
    if (bigEndian) {
      [instructions[offset], instructions[offset + 3]] = [
        instructions[offset + 3]!,
        instructions[offset]!,
      ];
      [instructions[offset + 1], instructions[offset + 2]] = [
        instructions[offset + 2]!,
        instructions[offset + 1]!,
      ];
    }
    const opcode = instructions[offset]!;
    if (opcode >= OPCODE_MAP.length) {
      throw new Error(`Obfuscated opcode out of range: ${opcode}`);
    }
    instructions[offset] = OPCODE_MAP[opcode]!;
    instructions[offset + 1] = ~instructions[offset + 1]! & 0xff;
    instructions[offset + 3] = instructions[offset + 3]! ^ (i & 0xff);
  }

  const upvalueBytes = readBytes(cursor, sizeuv * 2);
  const upvalues = upvalueBytes.slice();
  if (bigEndian) {
    for (let i = 0; i < upvalues.length; i += 2) {
      [upvalues[i], upvalues[i + 1]] = [upvalues[i + 1]!, upvalues[i]!];
    }
  }

  const knumWriter = new ByteWriter();
  for (let i = 0; i < sizekn; i++) {
    const { value, isNumber } = readUleb33(cursor);
    writeUleb33(knumWriter, value, isNumber);
    if (isNumber) knumWriter.writeUleb(readUleb(cursor));
  }

  const kgc: KgcEntry[] = [];
  for (let i = 0; i < sizekgc; i++) {
    kgc.push(readKgcEntry(cursor, stack));
  }

  if (cursor.offset !== cursor.end) {
    throw new Error(`LuaJIT prototype has ${cursor.end - cursor.offset} trailing byte(s)`);
  }

  const prototype: Prototype = {
    flags,
    numparams,
    framesize,
    sizeuv,
    instructions,
    upvalues,
    kgc,
    knum: knumWriter.toUint8Array(),
    sizekn,
  };
  return prototype;
}

function writePrototype(prototype: Prototype): Uint8Array {
  const body = new ByteWriter();
  body.writeByte(prototype.flags);
  body.writeByte(prototype.numparams);
  body.writeByte(prototype.framesize);
  body.writeByte(prototype.sizeuv);
  body.writeUleb(prototype.kgc.length);
  body.writeUleb(prototype.sizekn);
  body.writeUleb(prototype.instructions.length / 4);
  body.write(prototype.instructions);
  body.write(prototype.upvalues);
  for (const entry of prototype.kgc) body.write(entry.bytes);
  body.write(prototype.knum);
  const result = new ByteWriter();
  const bytes = body.toUint8Array();
  result.writeUleb(bytes.length);
  result.write(bytes);
  return result.toUint8Array();
}

function writePrototypeTree(prototype: Prototype, writer: ByteWriter): void {
  for (let i = prototype.kgc.length - 1; i >= 0; i--) {
    const child = prototype.kgc[i]!.child;
    if (child) writePrototypeTree(child, writer);
  }
  writer.write(writePrototype(prototype));
}

export function decodeAzurLaneBytecode(input: Uint8Array): Uint8Array {
  if (input.length < 5 || BYTECODE_HEADER.some((byte, i) => input[i] !== byte)) {
    throw new Error("Invalid LuaJIT bytecode header");
  }

  const cursor: Cursor = { data: input, offset: BYTECODE_HEADER.length, end: input.length };
  const dumpFlags = readUleb(cursor);
  if (dumpFlags & ~0x0f) throw new Error(`Unknown LuaJIT dump flags: 0x${dumpFlags.toString(16)}`);
  const bigEndian = (dumpFlags & FLAG_BIG_ENDIAN) !== 0;
  if (!(dumpFlags & FLAG_STRIP)) {
    const chunkNameLength = readUleb(cursor);
    readBytes(cursor, chunkNameLength);
  }

  const prototypeStack: Prototype[] = [];
  let root: Prototype | undefined;
  while (cursor.offset < cursor.end) {
    const length = readUleb(cursor);
    if (length === 0) {
      if (cursor.offset !== cursor.end) {
        throw new Error("Unexpected data after LuaJIT dump terminator");
      }
      break;
    }
    const bytes = readBytes(cursor, length);
    const prototype = parsePrototype(bytes, dumpFlags, bigEndian, prototypeStack);
    prototypeStack.push(prototype);
    root = prototype;
  }

  if (!root || prototypeStack.length !== 1 || prototypeStack[0] !== root) {
    throw new Error("LuaJIT dump does not contain exactly one root prototype");
  }

  const output = new ByteWriter();
  for (const byte of BYTECODE_HEADER) output.writeByte(byte);
  output.writeByte(
    FLAG_STRIP |
    ((root.flags & 0x04) ? FLAG_FFI : 0) |
    (dumpFlags & FLAG_FR2),
  );
  writePrototypeTree(root, output);
  output.writeByte(0);
  return output.toUint8Array();
}
