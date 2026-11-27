import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, writeFile, realpath, readdir } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { decodeLive2d } from "./server/unityfsDecoder.js";
import { restoreSharecfgToString } from "./server/sharecfgdataDecoder.js";
import { extractShipSkins } from "./server/shipSkinExtractor.js";
import type { shipSkin } from "./server/shipSkinExtractor.js";
import { Downloader} from "./server/downloader.js";
import { decodeScripts32 } from "./server/scripts32Decoder.js";
import { universalExtract } from "./server/shipSkinExtractor.js";
import type { namecodeMap } from "./server/namecode.js";

const PORT = 3000;
const MODEL_ROOT = resolve("models");
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
async function findFile(dir: string, end: string) {
  const entries = await readdir(dir, {withFileTypes: true});
  const e = entries.filter((e) => e.isFile() && e.name.endsWith(end))[0]
  if (!e) throw new Error("Couldn't find file");
  return join(dir, e.name);
}

class Live2dManager {
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
    let modelFile = (await readdir(outputDir, {withFileTypes: true}))
      .filter((e)=>e.isFile() && e.name.endsWith(".model3.json"))
      [0]?.name 
      ?? ""
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

const manager = new Live2dManager();
let startupError: unknown;
const initialization = manager.init().catch((error: unknown) => {
  startupError = error;
  console.error("Backend initialization failed:", error);
});

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function serveModelFile(pathname: string, res: ServerResponse): Promise<void> {
  const encodedParts = pathname.slice("/models/".length).split("/");
  let parts: string[];
  try {
    parts = encodedParts.map(decodeURIComponent);
  } catch {
    sendJson(res, 400, { error: "Invalid model file path" });
    return;
  }

  if (parts.length < 1 || parts.some(
    (part) => !part || part === "." || part === ".." || part.includes("\\"),
  )) {
    sendJson(res, 400, { error: "Invalid model file path" });
    return;
  }

  const filePath = resolve(MODEL_ROOT, ...parts);
  if (!filePath.startsWith(`${MODEL_ROOT}${sep}`)) {
    sendJson(res, 400, { error: "Invalid model file path" });
    return;
  }

  try {
    const [realModelRoot, realFilePath] = await Promise.all([
      realpath(MODEL_ROOT),
      realpath(filePath),
    ]);
    if (!realFilePath.startsWith(`${realModelRoot}${sep}`)) {
      sendJson(res, 400, { error: "Invalid model file path" });
      return;
    }
    const data = await readFile(realFilePath);
    const contentType = extname(filePath).toLowerCase() === ".json"
      ? "application/json; charset=utf-8"
      : extname(filePath).toLowerCase() === ".png"
        ? "image/png"
        : "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      sendJson(res, 404, { error: "Model file not found" });
      return;
    }
    throw error;
  }
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  try {
    if (!req.url) {
      sendJson(res, 400, { error: "Missing request URL" });
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    if (req.method === "GET" && url.pathname === "/") {
      const html = await readFile("index.html", "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/skins") {
      await initialization;
      if (startupError) {
        sendJson(res, 503, { error: "Backend initialization failed" });
        return;
      }
      sendJson(res, 200, manager.live2dList);
      return;
    }

    const downloadMatch = url.pathname.match(/^\/api\/skins\/(\d+)\/download$/);
    if (req.method === "POST" && downloadMatch) {
      await initialization;
      if (startupError) {
        sendJson(res, 503, { error: "Backend initialization failed" });
        return;
      }

      const skinId = Number(downloadMatch[1]);
      if (!Number.isSafeInteger(skinId)) {
        sendJson(res, 400, { error: "Invalid skin ID" });
        return;
      }
      if (!manager.live2dList.some((skin) => skin.id === skinId)) {
        sendJson(res, 404, { error: "Unknown Live2D skin" });
        return;
      }

      const result = await manager.downloadLive2d(skinId);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/models/")) {
      await serveModelFile(url.pathname, res);
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    console.error("Request failed:", error);
    if (!res.headersSent) {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : "Internal server error",
      });
    } else {
      res.destroy();
    }
  }
});

server.listen(PORT, "localhost", () => {
  console.log(`Server listening at http://localhost:${PORT}`);
});



