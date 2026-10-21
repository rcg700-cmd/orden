import { mapLimit, sha256File, walkFiles, type WalkedFile } from "./fsutil.ts";

export type DupeGroup = {
  size: number;
  hash: string;
  files: string[];
};

export type DupeReport = {
  root: string;
  scanned: number;
  groups: DupeGroup[];
  wasted: number;
};

export type DupeOptions = {
  ignore?: string[];
  includeHidden?: boolean;
  minSizeBytes?: number;
  concurrency?: number;
};

/**
 * Duplicados = mismo tamaño (filtro barato) + mismo SHA-256.
 * Dos pasadas evitan hashear archivos que no pueden ser duplicados.
 */
export async function findDuplicates(root: string, options: DupeOptions = {}): Promise<DupeReport> {
  const minSizeBytes = options.minSizeBytes ?? 1024 * 1024;
  const concurrency = options.concurrency ?? 8;

  const files = await walkFiles(root, {
    ignore: options.ignore ?? [],
    includeHidden: options.includeHidden ?? false,
  });

  const bySize = new Map<number, WalkedFile[]>();
  for (const file of files) {
    if (file.size < minSizeBytes) continue;
    const bucket = bySize.get(file.size);
    if (bucket) bucket.push(file);
    else bySize.set(file.size, [file]);
  }

  const candidates = [...bySize.values()].filter((bucket) => bucket.length > 1).flat();
  const hashes = await mapLimit(candidates, concurrency, (file) => sha256File(file.abs));

  const byKey = new Map<string, DupeGroup>();
  candidates.forEach((file, index) => {
    const hash = hashes[index]!;
    const key = `${file.size}:${hash}`;
    const group = byKey.get(key);
    if (group) group.files.push(file.rel);
    else byKey.set(key, { size: file.size, hash, files: [file.rel] });
  });

  const groups = [...byKey.values()]
    .filter((group) => group.files.length > 1)
    .sort((a, b) => b.size * (b.files.length - 1) - a.size * (a.files.length - 1));

  return {
    root,
    scanned: files.length,
    groups,
    wasted: groups.reduce((total, group) => total + group.size * (group.files.length - 1), 0),
  };
}
