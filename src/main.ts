import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, realpath } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { Live2dManager, MODEL_ROOT } from "./server/live2dManager.js";
const PORT = 3000;

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



