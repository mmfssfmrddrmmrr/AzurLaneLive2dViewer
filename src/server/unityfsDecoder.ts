import { DecoderManager, load } from "unityfs-js";
import { decode_astc } from "texture2ddecoder-wasm";
import { writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { mkdir } from "node:fs/promises";
import type { namecodeMap } from "./namecode.js";
import { replaceNameCode } from "./namecode.js";
DecoderManager.registerTextureDecoder(
  "astc_rgb_4x4",
  async (blocks: any, width: any, height: any) => {
    const bgra = await decode_astc(blocks, width, height, 4, 4);

    if (!bgra || bgra.length !== width * height * 4) {
      throw new Error("ASTC decoder returned invalid pixel data");
    }

    const rgba = new Uint8Array(bgra.length);
    for (let i = 0; i < bgra.length; i += 4) {
      rgba[i] = bgra[i + 2]!;
      rgba[i + 1] = bgra[i + 1]!;
      rgba[i + 2] = bgra[i]!;
      rgba[i + 3] = bgra[i + 3]!;
    }
    return rgba;
  },
);

// Now load the bundle and call processLive2DModel(...)
import { processLive2DModel } from 'unityfs-js/exporters/live2dExporter.js';

export async function decodeLive2d(
    data: Uint8Array,
    outputDir: string,
    nameCode: namecodeMap
): Promise<string[]> {
    const mng = await load(data);
    const monoBehaviours: any[] = mng.getObjectInfosByClass('MonoBehaviour')
    const models = monoBehaviours.filter((info) => {
        const data = (info.assetFile ?? mng.primaryAssetFile)
            ?.getObjectUsingTreeJSON(info);
        return data?._moc != null && data?.m_GameObject != null;
    });

    const modelFiles: string[] = [];
    const outputRoot = resolve(outputDir);
    for (const moc3Carrier of models) {
        const res = await processLive2DModel(moc3Carrier, mng)
        // 返回的 result 结构：
        // {
        //   name: "character_model",
        //   files: {
        //     "character_model.moc3": ArrayBuffer,
        //     "character_model.model3.json": string/ArrayBuffer,
        //     "Textures/texture_00.png": Uint8Array,
        //     "Motions/idle.motion3.json": ArrayBuffer,
        //     ...
        //   }
        // }
        const modelPath = `${res.name}.model3.json`;
        const model3 = JSON.parse(String(res.files[modelPath]));

        const motions = Object.values(model3.FileReferences.Motions ?? {}).flat();
        const uniqueMotions = [...new Map(motions.map((motion: any) => [motion.File, motion])).values()];

        model3.FileReferences.Motions = Object.fromEntries(
        uniqueMotions.map((motion) => {
            const group = motion.File
            .split("/")
            .at(-1)!
            .replace(/\.motion3\.json$/i, "");
            return [group, [motion]];
        }),
        );

        res.files[modelPath] = JSON.stringify(model3, null, 4);
        for (const [path, data] of Object.entries(res.files)) {
            const parts = path.replace(/\\/g, "/").split("/");
            if (parts.some((part) => !part || part === "." || part === "..")) {
                throw new Error(`Invalid Live2D output path: ${path}`);
            }
            const fullPath = resolve(outputRoot, ...parts);
            if (!fullPath.startsWith(`${outputRoot}${sep}`)) {
                throw new Error(`Live2D output path escapes destination: ${path}`);
            }
            if (typeof data !== "string" && !(data instanceof Uint8Array)) {
                throw new Error(`Unsupported Live2D output data for ${path}`);
            }
            await mkdir(dirname(fullPath), { recursive: true });

            await writeFile(
                fullPath,
                typeof data === "string" ? 
                replaceNameCode(data, nameCode)
                : data,
            );
        }
        modelFiles.push(modelPath);
        console.log("---")
    }
    return modelFiles;
}