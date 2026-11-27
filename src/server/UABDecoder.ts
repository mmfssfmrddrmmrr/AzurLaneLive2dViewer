// DigitalSea_Scipio.ts
// 从 C++ 翻译而来，用于解密 IL2CPP 游戏资源
// 原 C++ 代码使用指针运算模拟 Il2CppArray 结构，TS 中用 Uint8Array 等价替代

const key_bytes = new Uint8Array([
  0xBC, 0x4B, 0x77, 0x1D, 0xE8, 0xC0, 0x96, 0x00, 0x8C, 0xA2, 0x69, 0x00, 0xB9, 0xCB, 0xDA, 0x35,
  0xC2, 0xCE, 0x63, 0x00, 0xA5, 0x6B, 0x5A, 0x00, 0x2E, 0x71, 0x92, 0x14, 0x19, 0xDE, 0x92, 0x00,
  0x93, 0x62, 0x0B, 0x00, 0x46, 0x56, 0xDF, 0x03, 0xC2, 0x63, 0x50, 0x00, 0xD5, 0x93, 0x72, 0x00,
  0xA3, 0x5B, 0x5E, 0x00, 0xCB, 0xAF, 0xC3, 0x30, 0x76, 0xA6, 0x1C, 0x01, 0xAD, 0x4E, 0x78, 0x00,
  0x02, 0xB9, 0x4B, 0x00, 0x8C, 0xF4, 0x49, 0x00, 0x54, 0x39, 0x81, 0x05
]);

/** 模拟 Il2CppArray：maxLength + 数据区 */
class FByteArray {
  maxLength: number;
  items: Uint8Array;

  constructor(maxLength: number) {
    this.maxLength = maxLength;
    this.items = new Uint8Array(maxLength);
  }
}

/** 模拟 NewSpecific：分配指定元素个数的数组（元素大小由调用方决定） */
function newSpecific(elementSize: number, n: number): FByteArray {
  // 原 C++ 分配 n*elementSize + 16 字节，数据从偏移 16 开始
  // TS 中直接用 n*elementSize 长度的 Uint8Array，等价于数据区
  return new FByteArray(n * elementSize);
}

/** 从 Uint8Array 读取 32 位小端无符号整数 */
function readU32LE(data: Uint8Array, offset: number): number {
  return (data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16) | (data[offset + 3]! << 24)) >>> 0;
}

/**
 * 主解密函数
 * @param input 加密的 FByteArray（对应原 C++ 中的 FByteArray* _AssertArrayIn）
 * @returns 解密后的 FByteArray
 */
export function digitalSeaScipio(input: FByteArray): FByteArray {
  const totalLen = input.maxLength;
  const data = input.items;

  // ---- 1. 读取末尾 4 字节作为 wrapper_size ----
  const bufLast = data[totalLen - 1]!;
  const buf2ndLast = data[totalLen - 2]!;
  const buf3rdLast = data[totalLen - 3]!;
  const buf4thLast = data[totalLen - 4]!;
  const wrapperSize = (bufLast + (buf2ndLast << 8)) | (buf3rdLast << 16) | (buf4thLast << 24);

  const decBufSize = totalLen - 4 - wrapperSize;
  const decBuf = new FByteArray(decBufSize);

  // ---- 2. 准备 19 个 uint32 密钥 ----
  const decKeyItems = new Uint32Array(19);
  for (let i = 0; i < 19; i++) {
    decKeyItems[i] = readU32LE(key_bytes, i * 4);
  }

  // ---- 3. 如果 wrapper_size > 0，截取并 XOR 解密 ----
  if (wrapperSize > 0) {
    const gcBuffer = new FByteArray(wrapperSize);
    // 原 C++: v187 = *p_max_length - 4 - wrapper_size; v185 = ptr + *p_max_length + 12 - wrapper_size
    // 即从输入数组的 decBufSize 位置开始，长度 wrapperSize
    const startOff = decBufSize;
    for (let i = 0; i < wrapperSize; i++) {
      gcBuffer.items[i] = data[startOff + i]!;
    }

    // XOR 解密循环
    let v29 = 235;
    for (let i = 0; i < gcBuffer.maxLength; i++) {
      const gcByte = gcBuffer.items[i]!;
      const decByte = gcByte ^ ((v29 >>> 8) & 0xFF);
      const v38 = (v29 + gcByte) >>> 0;
      v29 = ((205 * v38) + 207) >>> 0;
      gcBuffer.items[i] = decByte & 0xFF;
    }
  }

  // ---- 4. 分配 v184（2 个 uint32） ----
  const v184_u32 = new Uint32Array(2);

  // ---- 5. 主循环：每次处理 8 字节 ----
  let v45 = 0;
  let v47 = 0;
  const decBufSizeMinus8 = decBufSize - 8;
  let v177 = 0;   // 新增：提升到循环外
  let v178 = 0;   // 新增：提升到循环外
  if (decBufSize !== 8) {
    do {
      v177 = v47;       // 当前块索引 0..3
      v178 = v45;       // 当前块起始偏移

      // 读取当前 8 字节（小端组装为两个 uint32）
      const v54 = readU32LE(data, v45);
      const v63 = readU32LE(data, v45 + 4);
      v184_u32[0] = v54;
      v184_u32[1] = v63;

      // 输出索引
      const v169 = v45 | 1;
      const v170 = v45 | 2;
      const v172 = v45 | 3;
      const v171 = v45 | 4;
      const v173 = v45 | 5;
      const v174 = v45 | 6;
      const v175 = v45 | 7;

      // ---- 根据 v177 选择解密分支 ----
      if (v177) {
        if (v177 > 1) {
          if (v177 === 3) {
            // 分支 3：XXTEA 变体（只执行一轮）
            let v190 = v184_u32[0];
            let v104 = v184_u32[1];
            let v105 = 234846730;
            let v106 = 5;
            let v203: number;

            do {
              const v198 = v104;
              const v107 = (v105 >>> 11) & 3;
              v203 = v105;

              // v104 = v198 - ((v190 + (16*v190 ^ (v190>>5))) ^ (v105 + decKey[v107]))
              const t1 = (v190 + (((16 * v190) >>> 0) ^ (v190 >>> 5))) >>> 0;
              const t2 = (v105 + decKeyItems[v107]!) >>> 0;
              v104 = (v198 - ((t1 ^ t2) >>> 0)) >>> 0;

              // v190 -= (v104 + (16*v104 ^ (v104>>5))) ^ (v105 + decKey[v106--] - 117423365)
              const t3 = (v104 + (((16 * v104) >>> 0) ^ (v104 >>> 5))) >>> 0;
              const t4 = (v105 + decKeyItems[(v106--) - 4]! - 117423365) >>> 0;
              v190 = (v190 - ((t3 ^ t4) >>> 0)) >>> 0;

              v105 = (v105 - 117423365) >>> 0;
            } while (v203 !== 117423365);

            v184_u32[0] = v190;
            v184_u32[1] = v104;
          } else {
            // 分支 2
            const v191 = v184_u32[0];
            const v116 = decKeyItems[13]; // dec_key[17] => m_Items[13]
            v184_u32[0] = (v116! ^ v178 ^ v191) >>> 0;

            const v121 = v184_u32[1];
            const v123 = decKeyItems[2];  // dec_key[6] => m_Items[2]
            v184_u32[1] = (v123! ^ v178 ^ v121) >>> 0;
          }
        } else {
          // 分支 1：XXTEA 加密轮
          let v68 = v184_u32[0];
          let v70 = v184_u32[1];
          const v201 = decKeyItems[0]; // dec_key[4]
          const v196 = decKeyItems[1]; // dec_key[5]
          const v75 = decKeyItems[2];  // dec_key[6]
          const v188 = decKeyItems[3]; // dec_key[7]
          let v77 = 234846730;

          do {
            // v70 -= (v75 + 16*v68) ^ (v77 + v68) ^ (v188 + (v68>>5))
            const a = ((v75! + ((16 * v68) >>> 0)) ^ (v77 + v68) ^ (v188! + (v68 >>> 5))) >>> 0;
            v70 = (v70 - a) >>> 0;

            // v68 -= (v201 + 16*v70) ^ (v77 + v70) ^ (v196 + (v70>>5))
            const b = ((v201! + ((16 * v70) >>> 0)) ^ (v77 + v70) ^ (v196! + (v70 >>> 5))) >>> 0;
            v68 = (v68 - b) >>> 0;

            v77 = (v77 - 117423365) >>> 0;
          } while (v77 !== 0);

          v184_u32[0] = v68;
          v184_u32[1] = v70;
        }
      } else {
        // 分支 0：标准 XXTEA 解密
        let v202 = v184_u32[0];
        const v183 = 1; // maxLength - 1 = 1
        const v180 = 0; // maxLength - 2 = 0
        let v83 = 234846730;
        let v84 = 2;
        let v182: number;
        do {
          v182 = v84;
          const v186 = v83;
          const v189 = (v83 >>> 2) & 3;
          let v85 = v180; // 0

          while (v85 !== -1) {
            const v86 = v85 + 1;
            const v89 = v184_u32[v85];
            const v197 = v189 ^ (v86 & 3);

            // v184[v86] -= ((v89>>5 ^ 4*v202) + (v202>>3 ^ 16*v89)) ^ ((v186 ^ v202) + (decKey[v197] ^ v89))
            const t1 = (((v89! >>> 5) ^ ((4 * v202) >>> 0)) + ((v202 >>> 3) ^ ((16 * v89!) >>> 0))) >>> 0;
            const t2 = ((v186 ^ v202) + (decKeyItems[v197]! ^ v89!)) >>> 0;
            const v93 = (v184_u32[v86]! - ((t1 ^ t2) >>> 0)) >>> 0;

            v184_u32[v86] = v93;
            v202 = v93;
            v85--;
          }

          const v96 = v184_u32[v183]; // v184_u32[1]
          // v184[0] -= ((v96>>5 ^ 4*v202) + (v202>>3 ^ 16*v96)) ^ ((v186 ^ v202) + (decKey[v189] ^ v96))
          const t1 = (((v96 >>> 5) ^ ((4 * v202) >>> 0)) + ((v202 >>> 3) ^ ((16 * v96) >>> 0))) >>> 0;
          const t2 = ((v186 ^ v202) + (decKeyItems[v189]! ^ v96)) >>> 0;
          const v100: number = (v184_u32[0]! - ((t1 ^ t2) >>> 0)) >>> 0;

          v184_u32[0] = v100;
          v83 = (v186 - 117423365) >>> 0;
          v84 = v182 - 1;
          v202 = v100;
        } while (v182 !== 1);
      }

      // ---- 写入解密后的 8 字节到 decBuf ----
      const v128 = v184_u32[0];
      decBuf.items[v178] = v128 & 0xFF;
      decBuf.items[v169] = (v128 >>> 8) & 0xFF;
      decBuf.items[v170] = (v128 >>> 16) & 0xFF;
      decBuf.items[v172] = (v128 >>> 24) & 0xFF;

      const v146 = v184_u32[1];
      decBuf.items[v171] = v146 & 0xFF;
      decBuf.items[v173] = (v146 >>> 8) & 0xFF;
      decBuf.items[v174] = (v146 >>> 16) & 0xFF;
      decBuf.items[v175] = (v146 >>> 24) & 0xFF;

      // ---- 推进 ----
      v47 = (v177 + 1) & 3;
      v45 = v178 + 8;
    } while (v178 + 8 < decBufSizeMinus8);
  }

  // ---- 6. 复制剩余未处理的字节 ----
  for (; v45 < decBufSize; v45++) {
    decBuf.items[v45] = data[v45]!;
  }

  return decBuf;
}

// ==================== 使用示例 ====================
//
// import * as fs from 'fs';
//
// const raw = fs.readFileSync('encrypted.bin');
// const input = new FByteArray(raw.length);
// input.items.set(raw);
//
// const decrypted = digitalSeaScipio(input);
// fs.writeFileSync('decrypted.bin', decrypted.items);
//
// =================================================
export function UABDecode(data: Uint8Array) {
    const input = new FByteArray(data.length);
    input.items.set(data);

    const decrypted = digitalSeaScipio(input);
    return decrypted.items
}