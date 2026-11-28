import { readFile, writeFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { decodeLive2d } from "./unityfsDecoder.js";
import { restoreSharecfgToString } from "./sharecfgdataDecoder.js";
import { extractShipSkins } from "./shipSkinExtractor.js";
import { Downloader} from "./downloader.js";
import { decodeScripts32 } from "./scripts32Decoder.js";
import { universalExtract } from "./shipSkinExtractor.js";
import type { namecodeMap } from "./namecode.js";
import type { shipSkin } from "./shipSkinExtractor.js";
export const MODEL_ROOT = resolve("models");
const SHIP_LIST_PATH = "shipList.json";
const NAME_CODE_PATH = "namecode.json";

type CachedShipList = {
  version: string;
  live2dList: shipSkin[];
};
type CachedNameCode = {
    version: string;
    map: namecodeMap
}

export class Live2dManager {
  private readonly downloader = new Downloader();
  public live2dList: shipSkin[] = [];
  public namecode: namecodeMap = {};
  async getShipList(hashVersion: string) {
    // 本地已有则复用，否则下载
    let cachedShipList: CachedShipList | undefined;
    try {
      cachedShipList = JSON.parse(await readFile(SHIP_LIST_PATH, "utf8"));
      if (cachedShipList?.version === hashVersion) {
        this.live2dList = cachedShipList.live2dList;
        console.log("Using cached ship list.");
        return;
      }
    } catch (e) {if((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;}

    const skinList = await this.downloader.download(
      "hashes.json",
      "sharecfgdata/ship_skin_template",
    );

    const decodedSkinList = restoreSharecfgToString(skinList);
    this.live2dList = extractShipSkins(decodedSkinList, this.namecode).filter((skin) => skin.isLive2d);
    await writeFile(
      SHIP_LIST_PATH,
      JSON.stringify({ version: hashVersion, live2dList: this.live2dList }, null, 2),
    );
  }
  async getScripts32(hashVersion: string) {
    // 本地已有则复用，否则下载
    let cachednamecode: CachedNameCode
    try {
      cachednamecode = JSON.parse(await readFile(NAME_CODE_PATH, "utf8"));
      if (cachednamecode?.version === hashVersion) {
        this.namecode = cachednamecode.map;
        console.log("Using cached name code.");
        return;
      }
    } catch (e) {if((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;}
    const scripts32 = await this.downloader.download("hashes.json", "scripts32");
    const namecode = (await decodeScripts32(scripts32, [/.*name_code\.lua/]))[0];
    if (namecode)
      this.namecode = universalExtract(namecode, ["name"]) as namecodeMap
    else console.warn("No namecode")
    await writeFile(
      NAME_CODE_PATH, 
      JSON.stringify({ version: hashVersion, map: this.namecode})
    )
  }

  async init(): Promise<void> {
    await this.downloader.init();
    const hashIndex = this.downloader.config.hash_names.indexOf("hashes.json");
    const hashVersion = this.downloader.latestVersion[hashIndex];
    if (hashIndex < 0 || !hashVersion) {
      throw new Error("Could not find hashes.json version");
    }
    await this.getScripts32(hashVersion);
    await this.getShipList(hashVersion);
  }

  async downloadLive2d(skinId: number): Promise<{ modelUrl: string }> {
    const skin = this.live2dList.find((item) => item.id === skinId);
    if (!skin) {
      throw new Error("Unknown Live2D skin");
    }

    const outputDir = join(MODEL_ROOT, String(skin.id));
    let modelFile;
    try {
        modelFile = (await readdir(outputDir, {withFileTypes: true}))
        .filter((e)=>e.isFile() && e.name.endsWith(".model3.json"))
        [0]?.name 
        ?? ""
    } catch (e) {if((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;}
    if (modelFile) {
      console.log(`Using cached Live2D model for skin ${skin.id}.`);
    } else {
      const data = await this.downloader.download("hashes-live2d.json", skin.prefab);

      const modelFiles = await decodeLive2d(data, outputDir, this.namecode);
      modelFile = modelFiles[0] ?? ""
      if (!modelFile) {
        throw new Error(`No Live2D model was produced for ${skin.prefab}`);
      }
    }
    return {
      modelUrl: `/models/${skin.id}/${modelFile}`
    };
  }
}