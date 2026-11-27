import { createWriteStream } from "node:fs";
import { pipeline } from 'node:stream/promises';
import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from "node:path";

const CONCURRENCY = 16;

export interface DownloadTask {
  name: string;
  url: string;
}

async function downloadOne(task: DownloadTask) {
    const { name, url } = task;
    const tmp = name + ".tmp"
    await fs.mkdir(
        path.dirname(name),
        { recursive: true }
    );

    const res = await fetch(url, {
    signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    if (!res.body) throw new Error('no body');

    try {
        await pipeline(
            Readable.fromWeb(res.body), 
            createWriteStream(tmp)
        );
        await fs.rename(tmp, name);
    } catch (e) {
        console.error('下载失败:', e);
        await fs.rm(tmp, {
            force: true
        });
    }
}

export async function downloadAll(tasks: DownloadTask[]) {
  let index = 0;
  async function worker() {
    while (index < tasks.length) {
      const task = tasks[index++];
      if (!task) continue;
      try {
        console.log(`开始下载: ${task.name}`);

        await downloadOne(task);

        console.log(`下载完成: ${task.name}`);
      } catch (error) {
        console.error(`下载失败: ${task.name}`, error);
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(CONCURRENCY, tasks.length) },
      () => worker()
    )
  );
}