import { promises as fs } from "node:fs";
import path from "node:path";

import { UserError } from "./errors.ts";
import { pathExists } from "./fsutil.ts";

export const JOURNAL_DIR = path.join(".declutter", "journal");

export type JournalStatus = "running" | "done" | "aborted" | "undone";

export type JournalMove = {
  from: string;
  to: string;
  rule: string;
  size: number;
};

export type Journal = {
  id: string;
  createdAt: string;
  root: string;
  status: JournalStatus;
  moves: JournalMove[];
  failed?: { relSource: string; error: string }[];
  undoneAt?: string;
};

export type JournalEntry = {
  file: string;
  journal: Journal;
};

export function newJournalId(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

export function journalDir(root: string): string {
  return path.join(root, JOURNAL_DIR);
}

/** Escritura atómica: el diario nunca queda a medias en disco. */
export async function writeJournal(root: string, journal: Journal): Promise<string> {
  const dir = journalDir(root);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${journal.id}.json`);
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
  await fs.rename(temp, file);
  return file;
}

function parseJournal(raw: string, file: string): Journal {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new UserError(`diario inválido ${file}: ${(error as Error).message}`);
  }
  const journal = value as Partial<Journal>;
  if (
    typeof journal.id !== "string" ||
    typeof journal.root !== "string" ||
    !Array.isArray(journal.moves) ||
    journal.moves.some((move) => typeof move?.from !== "string" || typeof move?.to !== "string")
  ) {
    throw new UserError(`diario inválido ${file}: faltan campos esperados`);
  }
  return journal as Journal;
}

export async function listJournals(root: string): Promise<JournalEntry[]> {
  const dir = journalDir(root);
  if (!(await pathExists(dir))) return [];

  const entries: JournalEntry[] = [];
  const names = await fs.readdir(dir);
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    const journal = parseJournal(await fs.readFile(file, "utf8"), file);
    entries.push({ file, journal });
  }
  return entries.sort((a, b) => b.journal.id.localeCompare(a.journal.id));
}

export async function latestJournal(root: string): Promise<JournalEntry | undefined> {
  const entries = await listJournals(root);
  return entries.find((entry) => entry.journal.status !== "undone");
}
