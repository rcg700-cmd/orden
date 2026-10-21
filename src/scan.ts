import path from "node:path";

import type { Config } from "./config.ts";
import { resolveDest } from "./dest.ts";
import { walkFiles } from "./fsutil.ts";
import { firstMatch } from "./rules.ts";

export type PlanItem = {
  relSource: string;
  absSource: string;
  rule: string;
  relDest: string;
  absDest: string;
  size: number;
};

export type Plan = {
  root: string;
  scanned: number;
  items: PlanItem[];
  totalBytes: number;
  alreadyInPlace: number;
  unmatched: number;
};

function posixDir(rel: string): string {
  const dir = path.posix.dirname(rel);
  return dir === "." ? "" : dir;
}

/**
 * Construye el plan sin tocar el disco: solo lectura.
 * Los archivos que ya están en su carpeta destino se marcan como "in place".
 */
export async function buildPlan(config: Config, rootAbs: string): Promise<Plan> {
  const files = await walkFiles(rootAbs, {
    ignore: config.ignore,
    includeHidden: config.includeHidden,
  });

  const items: PlanItem[] = [];
  const now = Date.now();
  let alreadyInPlace = 0;
  let unmatched = 0;

  for (const file of files) {
    const ext = path.posix.extname(file.rel).slice(1).toLowerCase();
    const facts = { rel: file.rel, ext, size: file.size, mtimeMs: file.mtimeMs };
    const rule = firstMatch(config.rules, facts, now);
    if (!rule) {
      unmatched += 1;
      continue;
    }

    const absDest = resolveDest(rootAbs, rule.dest, facts);
    // absDest es el directorio destino completo, no el archivo.
    const destDirRel = path.relative(rootAbs, absDest).split(path.sep).join("/");
    if (destDirRel === ".." || destDirRel.startsWith("../")) {
      throw new Error(`destino fuera de la raíz: ${rule.dest}`);
    }
    if (destDirRel === posixDir(file.rel)) {
      alreadyInPlace += 1;
      continue;
    }

    items.push({
      relSource: file.rel,
      absSource: file.abs,
      rule: rule.name,
      relDest: destDirRel === "" ? path.posix.basename(file.rel) : `${destDirRel}/${path.posix.basename(file.rel)}`,
      absDest,
      size: file.size,
    });
  }

  items.sort((a, b) => a.relSource.localeCompare(b.relSource));

  return {
    root: rootAbs,
    scanned: files.length,
    items,
    totalBytes: items.reduce((total, item) => total + item.size, 0),
    alreadyInPlace,
    unmatched,
  };
}
