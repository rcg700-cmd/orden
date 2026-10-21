import path from "node:path";

import { isInside, moveFile, pathExists, uniquePath } from "./fsutil.ts";
import { newJournalId, writeJournal, type Journal } from "./journal.ts";
import type { Plan } from "./scan.ts";

export type ApplyFailure = {
  relSource: string;
  error: string;
};

export type ApplyResult = {
  journal: Journal;
  file: string;
  moves: number;
  failed: ApplyFailure[];
};

/**
 * Ejecuta el plan y deja un diario reescribible: si el proceso muere,
 * los movimientos ya hechos siguen siendo reversibles.
 */
export async function applyPlan(plan: Plan): Promise<ApplyResult> {
  const journal: Journal = {
    id: newJournalId(),
    createdAt: new Date().toISOString(),
    root: plan.root,
    status: "running",
    moves: [],
  };

  let file = await writeJournal(plan.root, journal);
  const failed: ApplyFailure[] = [];

  for (const item of plan.items) {
    try {
      if (!isInside(plan.root, item.absSource) || !isInside(plan.root, item.absDest)) {
        throw new Error("ruta fuera del directorio ordenado");
      }
      if (!(await pathExists(item.absSource))) {
        throw new Error("el archivo ya no existe");
      }

      const targetDir = item.absDest;
      const target = uniquePath(targetDir, path.basename(item.absSource));
      await moveFile(item.absSource, target);
      journal.moves.push({ from: item.absSource, to: target, rule: item.rule, size: item.size });
      file = await writeJournal(plan.root, journal);
    } catch (error) {
      failed.push({ relSource: item.relSource, error: (error as Error).message });
    }
  }

  journal.status = failed.length > 0 && journal.moves.length === 0 ? "aborted" : "done";
  if (failed.length > 0) journal.failed = failed;
  file = await writeJournal(plan.root, journal);

  return { journal, file, moves: journal.moves.length, failed };
}
