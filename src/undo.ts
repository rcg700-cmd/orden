import path from "node:path";

import { isInside, moveFile, pathExists, removeEmptyDirs, uniquePath } from "./fsutil.ts";
import { writeJournal, type Journal } from "./journal.ts";

export type UndoResult = {
  restored: number;
  missing: number;
  failed: { from: string; to: string; error: string }[];
};

/** Revierte los movimientos en orden inverso. No borra nada si el origen ya está ocupado. */
export async function undoJournal(journal: Journal): Promise<UndoResult> {
  const result: UndoResult = { restored: 0, missing: 0, failed: [] };

  for (const move of [...journal.moves].reverse()) {
    try {
      if (!isInside(journal.root, move.from) || !isInside(journal.root, move.to)) {
        throw new Error("ruta fuera de la raíz del diario");
      }
      if (!(await pathExists(move.to))) {
        result.missing += 1;
        continue;
      }
      const target = (await pathExists(move.from))
        ? uniquePath(path.dirname(move.from), path.basename(move.from))
        : move.from;
      await moveFile(move.to, target);
      result.restored += 1;
    } catch (error) {
      result.failed.push({ from: move.from, to: move.to, error: (error as Error).message });
    }
  }

  journal.status = "undone";
  journal.undoneAt = new Date().toISOString();
  await writeJournal(journal.root, journal);
  await removeEmptyDirs(journal.root);

  return result;
}
