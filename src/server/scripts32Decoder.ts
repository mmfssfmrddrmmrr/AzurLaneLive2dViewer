import { fileURLToPath, pathToFileURL } from "node:url";
import { DecoderManager, load } from "unityfs-js";
import { dirname, join } from "node:path";
import { UABDecode } from "./UABDecoder.js";
import { decompile } from "node-luajit-decompiler-v2";
import { decodeAzurLaneBytecode } from "./bcDecoder.js";

const unityfsEntry = fileURLToPath(import.meta.resolve("unityfs-js"));
const lzmaPath = join(dirname(unityfsEntry), "vendor", "lzma.js");
const { lzmaDecompress } = await import(pathToFileURL(lzmaPath).href) as {
    lzmaDecompress(data: Uint8Array, outputSize: number): Uint8Array;
};
const lzmaDecoder = DecoderManager.decompressors.get(1);
if (typeof lzmaDecoder !== "function") {
    throw new Error("unityfs-js has no registered LZMA decoder");
}
DecoderManager.registerDecompressor(1, (block: Uint8Array, outputSize: number) => {
    try {
        return lzmaDecoder(block, outputSize);
    } catch (error) {
        if (
            error instanceof RangeError &&
            error.message.includes("Maximum memory size exceeded")
        ) {
            return lzmaDecompress(block, outputSize);
        }
        throw error;
    }
});


export async function unityfs2Lua(
  data: Uint8Array,
  whiteList: (RegExp)[]
): Promise<string[]> {


  const manager = await load(data);
  const outputs: string[] = [];

  for (const info of manager.getObjectInfosByClass("TextAsset")) {
    const textAsset = info.object as { name?: unknown; data?: unknown };
    const name = textAsset.name;
    if (typeof name !== "string") {
      continue;
    }
    if (!whiteList.some(re => re.test(name)))
      continue
    const script = textAsset.data;
    const bcData = decodeAzurLaneBytecode(script as Uint8Array);
    const raw = decompile(Buffer.from(bcData));
    outputs.push(raw.toString());
  }

  return outputs;
}

export async function decodeScripts32(data: Uint8Array, whiteList: (RegExp)[]) {
  const uabDecoded = UABDecode(data);
  return await unityfs2Lua(uabDecoded, whiteList);
  
}