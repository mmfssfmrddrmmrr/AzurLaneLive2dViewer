import net from "node:net";
import { Buffer } from "node:buffer";
import fsp from "node:fs/promises";
import { parse } from "csv-parse/sync";
const CONFIG_FILE = "config.json";

const DEFAULT_CONFIG = {
    hash_names: [
        "hashes.json",
        "hashes-cv.json",
        "hashes-live2d.json",
        "hashes-pic.json",
        "hashes-bgm.json",
        "hashes-painting.json",
        "hashes-manga.json",
        "hashes-cipher.json"
    ],

    all_lines: [3, 1, 4],

    base_hash_url:
        "https://line{}-patch-blhx.bilibiligame.net/android/hash/",

    base_resource_url:
        "https://line{}-patch-blhx.bilibiligame.net/android/resource/"
};



export class Downloader {
    private hashIP = '203.107.54.123';
    private hashPort = 80;
    public latestVersion: string[] = []; 
    // 实际上是每个hash文件的url后缀，前面还要加上 base_hash_url

    public config = DEFAULT_CONFIG;

    public inited = false;
    constructor() {
    }
    async init() {
        this.latestVersion = await this.getHash();
        try {
            this.config = JSON.parse(await fsp.readFile(
                CONFIG_FILE,
                "utf8"
            ));
        } catch {
            await fsp.writeFile(
                CONFIG_FILE,
                JSON.stringify(DEFAULT_CONFIG, null, 2)
            );
            this.config = DEFAULT_CONFIG;
        }

        this.inited = true;
    }

    getHash(): Promise<string[]> {
        return new Promise((resolve, reject) => {
            const socket = net.createConnection({
                host: this.hashIP,
                port: this.hashPort
            });

            const buffer =
            Buffer.from(
                "000a002a300000083d120130",
                "hex"
            );

            socket.on("connect", () => {
                socket.write(buffer);
            });

            socket.on("data", data => {

                const text = data.toString(
                    "utf8"
                );

                const groups = [...text.matchAll(/(\$.*?hash.*?)"/g)].map(m => m[1]!);
                socket.destroy();

                resolve(groups);
            });

            socket.on("error", reject);
        })
    }
    private async _fetch(base: string, hash: string) {
        const {all_lines} = this.config;
        for (const lineIndex of all_lines) {
            const resolved = base.replace("{}", lineIndex.toString());
            const url = resolved + hash;
            try {
                const resp = await fetch(
                    url,
                    {signal: AbortSignal.timeout(5000)}
                );
                if (!resp.ok) {
                    console.warn(`Network error ${resp.status, resp.statusText}, retrying...`);
                    continue
                }
                console.log(`Successfully downloaded ${hash}`);
                return resp;
            } catch (error) {
                if (error instanceof Error && error.name === "TimeoutError") {
                    console.log("Timeout, retrying...");
                    continue
                }
                throw error
            };
        }
        throw new Error("All lines failed")
    }

    private async fetchResource(hash: string) {
        const {base_resource_url} = this.config;
        return await this._fetch(base_resource_url, hash);
    }

    private async fetchHash(hash: string) {
        const {base_hash_url} = this.config;
        return await this._fetch(base_hash_url, hash);
    }

    async download(hashName: string, sourceName: string): Promise<Uint8Array> {
        if (!this.inited) throw new Error("not inited")
        console.log("wanna download:", sourceName)
        const {
            hash_names,
        } = this.config;
        const i = hash_names.indexOf(hashName);
        if (!this.latestVersion[i]) throw new Error("Bad index")
        const response = await this.fetchHash(this.latestVersion[i]);
        const text = await response.text();

        const parser = parse(text, {
            skip_empty_lines: true
        }) as string[][];

        for (const row of parser) {
            const hashName = row[0];
            const hashValue = row[2];
            if (!hashName || !hashValue)
                continue;
            if (
                hashName === sourceName 
                ||
                hashName.split('/').includes(sourceName)
            ) {
                console.log("downloading", hashName);
                const resp = await this.fetchResource(hashValue);
                const res = await resp.bytes();
                console.log("download completed");
                return res;
                    
            }
        };
        return new Uint8Array();
    }
}

export async function testDownload(hashName: string, sourceName: string) {
    const d = new Downloader();
    await d.init();
    return await d.download(hashName, sourceName);
}