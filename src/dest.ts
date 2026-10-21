import path from "node:path";

import { UserError } from "./errors.ts";
import { isInside } from "./fsutil.ts";

export type DestFacts = {
  ext: string;
  mtimeMs: number;
};

export function expandDest(template: string, file: DestFacts): string {
  const date = new Date(file.mtimeMs);
  return template
    .replaceAll("{ext}", file.ext === "" ? "sin-extension" : file.ext)
    .replaceAll("{year}", String(date.getFullYear()))
    .replaceAll("{month}", String(date.getMonth() + 1).padStart(2, "0"));
}

/** Resuelve el destino y falla cerrado si apunta fuera de la raíz. */
export function resolveDest(rootAbs: string, template: string, file: DestFacts): string {
  const expanded = expandDest(template, file);
  const target = path.resolve(rootAbs, expanded);
  const inside = isInside(rootAbs, target);
  if (!inside) {
    throw new UserError(`el destino "${template}" sale del directorio ordenado (${expanded})`);
  }
  return target;
}
