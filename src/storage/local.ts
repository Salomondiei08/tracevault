/** Local folder backend: useful for testing, air-gapped machines, or syncing with another tool. */
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { Storage } from "./index";

export class LocalStorage implements Storage {
  constructor(private readonly dir: string) {}

  describe(): string {
    return this.dir;
  }

  async put(key: string, body: Buffer): Promise<void> {
    const path = join(this.dir, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }

  async get(key: string): Promise<Buffer> {
    return readFile(join(this.dir, key));
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (d: string): Promise<void> => {
      let names: string[];
      try {
        names = await readdir(d);
      } catch {
        return;
      }
      for (const n of names) {
        const p = join(d, n);
        if ((await stat(p)).isDirectory()) await walk(p);
        else out.push(relative(this.dir, p));
      }
    };
    await walk(join(this.dir, prefix));
    return out.sort();
  }
}
