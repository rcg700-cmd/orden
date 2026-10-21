import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";

import { isIgnored } from "./glob.ts";

export const INTERNAL_DIR = ".declutter";

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export function isInside(root: string, candidate: string): boolean {
  const rootAbs = path.resolve(root);
  const targetAbs = path.resolve(candidate);
  const compare = process.platform === "win32" ? (value: string) => value.toLowerCase() : (value: string) => value;
  const a = compare(rootAbs);
  const b = compare(targetAbs);
  if (a === b) return true;
  const prefix = a.endsWith(path.sep) ? a : a + path.sep;
  return b.startsWith(prefix);
}

/** Devuelve una ruta libre, añadiendo ` (1)`, ` (2)`… sin sobrescribir nada. */
export function uniquePath(dir: string, filename: string): string {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  for (let attempt = 0; ; attempt += 1) {
    const name = attempt === 0 ? filename : `${base} (${attempt})${ext}`;
    const candidate = path.join(dir, name);
    if (!existsSync(candidate)) return candidate;
  }
}

export async function moveFile(from: string, to: string): Promise<void> {
  await fs.mkdir(path.dirname(to), { recursive: true });
  try {
    await fs.rename(from, to);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EXDEV") {
      await fs.copyFile(from, to);
      await fs.unlink(from);
      return;
    }
    throw error;
  }
}

export async function removeEmptyDirs(root: string): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === INTERNAL_DIR) continue;
    const child = path.join(root, entry.name);
    await removeEmptyDirs(child);
    try {
      await fs.rmdir(child);
    } catch {
      // No está vacío: se queda.
    }
  }
}

export type WalkedFile = {
  abs: string;
  rel: string;
  size: number;
  mtimeMs: number;
};

export type WalkOptions = {
  ignore?: string[];
  includeHidden?: boolean;
};

/** Recorre el árbol sin seguir symlinks (evita ciclos y salidas de la raíz). */
export async function walkFiles(root: string, options: WalkOptions = {}): Promise<WalkedFile[]> {
  const ignore = options.ignore ?? [];
  const includeHidden = options.includeHidden ?? false;
  const files: WalkedFile[] = [];

  async function visit(dir: string, relDir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = entry.name;
      if (entry.isSymbolicLink()) continue;
      if (name === INTERNAL_DIR || name === ".git") continue;
      if (!includeHidden && name.startsWith(".")) continue;

      const rel = relDir === "" ? name : `${relDir}/${name}`;
      if (isIgnored(ignore, rel)) continue;
      const abs = path.join(dir, name);

      if (entry.isDirectory()) {
        await visit(abs, rel);
        continue;
      }
      if (!entry.isFile()) continue;

      const stats = await fs.stat(abs);
      files.push({ abs, rel, size: stats.size, mtimeMs: stats.mtimeMs });
    }
  }

  await visit(root, "");
  return files;
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(file);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}
