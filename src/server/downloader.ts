import net from "node:net";
import { Buffer } from "node:buffer";
import fsp from "node:fs/promises";
import { parse } from "csv-parse/sync";
import type { DownloadTask } from "./utils.js";
import { downloadAll } from "./utils.js";
const CONFIG_FILE = "config.json";
const VERSION_FILE = "hashVersion.json";
const LOCAL_FILES = "localFiles.json";

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

    line_index: 3,

    base_hash_url:
        "https://line{}-patch-blhx.bilibiligame.net/android/hash/",

    base_resource_url:
        "https://line{}-patch-blhx.bilibiligame.net/android/resource/",

    white_hash_names: [
        "hashes.json",
        "hashes-live2d.json"
    ],

    white_list: [
        "^live2d/.*",
        "^sharecfgdata/ship_skin_template",
        "^scripts32"
    ]
};



export class Downloader {
    private hashIP = '203.107.54.123';
    private hashPort = 80;
    public latestVersion: string[] = []; 
    // 实际上是每个hash文件的url后缀，前面还要加上 base_hash_url

    public localFileNames: string[] = [];
    public config = DEFAULT_CONFIG;

    private resolved_base_hash_url: string = "";
    private resolved_base_resource_url: string = "";

    private tasks: DownloadTask[] = [];
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

        this.localFileNames = JSON.parse(await fsp.readFile(
            LOCAL_FILES,
            "utf8"
        ).catch(() => "[]"));

        const {
            line_index,
            base_hash_url,
            base_resource_url
        } = this.config;
        this.resolved_base_hash_url = 
            base_hash_url.replace(
                "{}", 
                line_index.toString()
            );
        this.resolved_base_resource_url =
            base_resource_url.replace(
                "{}", 
                line_index.toString()
            );

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
    async checkUpdate() {
        // return true if local version is not latest
        try {

            const text =
                await fsp.readFile(
                    VERSION_FILE,
                    "utf8"
                );

            const localVersion = JSON.parse(text);

            return JSON.stringify(localVersion) !== JSON.stringify(this.latestVersion);

        } catch {
            return true;
        }
    }

    async update(force = false) {
        if (
            force ||
            await this.checkUpdate()
        ) {

            console.log(
                "Updating..."
            );

            

            await this.handle();

            await fsp.writeFile(
                VERSION_FILE,
                JSON.stringify(
                    this.latestVersion,
                    null,
                    2
                )
            );

            await fsp.writeFile(
                LOCAL_FILES,
                JSON.stringify(
                    this.localFileNames,
                    null,
                    2
                )
            );

        } else {

            console.log(
                "Version is the latest"
            );
        }
    }
    async parseHashFile(i: number) {
        //i is the index of hash file in config.hash_names
        const {white_list} = this.config;
        
        const url = this.resolved_base_hash_url + this.latestVersion[i];
        const response = await fetch(url);
        const text = await response.text();

        const white_list_regexes: RegExp[] = [];
        white_list.forEach(pattern => {
            const regex = new RegExp(pattern);
            white_list_regexes.push(regex);
        });

        /* 
        text(csv format):
            name,id,value
            ...
            ...
        */
        const parser = parse(text, {
            skip_empty_lines: true
        }) as string[][];

        
        parser.forEach((row: string[]) => {
            const hashName = row[0];
            const hashValue = row[2];
            if (
                !hashName ||
                !hashValue)
                return;

            if (
                white_list_regexes.some(regex => regex.test(hashName))
            ) {
                this.tasks.push({
                    name: hashName,
                    url: this.resolved_base_resource_url + hashValue
                });
            }
        });
    }

    async handle() {

        const {
            hash_names,
            white_hash_names,
        } = this.config;

        const HashParsingPromises: Promise<void>[] = [];
        for (
            let i = 0;
            i < hash_names.length;
            i++
        ) {

            const hashName = hash_names[i]!;

            if (!white_hash_names.includes(hashName)) 
                continue;
            

            console.log(`handling ${hashName}...`);
            HashParsingPromises.push(this.parseHashFile(i));
        }

        await Promise.all(HashParsingPromises);
        
        this.tasks = this.tasks.flat();
        console.log(
            `Total ${this.tasks.length} files to download`
        );
        console.log(this.tasks)
        await downloadAll(this.tasks).then(() => {
            console.log("All files downloaded.");
        });
    }
    async download(hashName: string, sourceName: string): Promise<Uint8Array> {
        if (!this.inited) throw new Error("not inited")
        console.log("wanna download:", sourceName)
        const {
            hash_names,
        } = this.config;
        const i = hash_names.indexOf(hashName);
        const url = this.resolved_base_hash_url + this.latestVersion[i];
        const response = await fetch(url);
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
                hashName === sourceName || hashName.split('/').includes(sourceName)
            ) {
                console.log("downloading", hashName);
                const res = await (await fetch(this.resolved_base_resource_url + hashValue)).bytes();
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