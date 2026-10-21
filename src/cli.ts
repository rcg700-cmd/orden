#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";

import { applyPlan } from "./apply.ts";
import {
  CONFIG_FILENAME,
  defaultConfig,
  loadConfig,
  resolveRoot,
  type LoadedConfig,
} from "./config.ts";
import { findDuplicates } from "./dupes.ts";
import { ConfigError, UserError } from "./errors.ts";
import {
  bold,
  cyan,
  dim,
  green,
  humanSize,
  parseSize,
  red,
  table,
  truncate,
  yellow,
} from "./format.ts";
import { pathExists } from "./fsutil.ts";
import { latestJournal, listJournals, type JournalEntry } from "./journal.ts";
import { buildPlan, type Plan } from "./scan.ts";
import { undoJournal } from "./undo.ts";

const HELP = `${bold("orden")} — ordena tus archivos con plan previo y vuelta atrás.

${bold("Uso")}
  orden init [--force]              Crea ${CONFIG_FILENAME} en el directorio actual
  orden scan [ruta] [--json]        Muestra qué movería y a dónde (no toca nada)
  orden apply [ruta] [--yes]        Ejecuta el plan y guarda un diario reversible
  orden undo [--id <id>] [--list]   Deshace el último apply (o uno concreto)
  orden dupes [ruta] [--min-size 1mb]  Busca duplicados por SHA-256

${bold("Opciones")}
  --config <ruta>   Archivo de configuración (por defecto: ./${CONFIG_FILENAME})
  --root <ruta>     Directorio a ordenar (por defecto: el del config)
  --json            Salida JSON (scan, dupes)
  --verbose         Muestra todos los elementos, sin recortar
  --yes, -y         No preguntar confirmación
  --dry-run, -n     Con apply: muestra el plan y no mueve nada
  --min-size <n>    Tamaño mínimo para dupes (ej: 512k, 10mb)
  --limit <n>       Máximo de filas a mostrar
  -h, --help        Esta ayuda
  --version         Versión

${bold("Ejemplos")}
  orden init
  orden scan ~/Downloads
  orden apply ~/Downloads
  orden undo --list

${dim("Nada se mueve sin confirmación. Todo apply se puede deshacer con undo.")}
`;

type FlagType = "boolean" | "string";
type FlagSpec = Record<string, FlagType>;
type Flags = Record<string, string | boolean | undefined>;

type ParsedArgs = {
  positional: string[];
  flags: Flags;
};

const ALIASES: Record<string, string> = {
  y: "yes",
  n: "dry-run",
  h: "help",
  v: "verbose",
  j: "json",
};

function splitOnce(value: string, separator: string): [string, string | undefined] {
  const index = value.indexOf(separator);
  if (index === -1) return [value, undefined];
  return [value.slice(0, index), value.slice(index + 1)];
}

function parseFlags(argv: string[], spec: FlagSpec): ParsedArgs {
  const flags: Flags = {};
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--") {
      positional.push(...argv.slice(index + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      positional.push(arg);
      continue;
    }

    const [rawName, inlineValue] = splitOnce(arg.replace(/^--?/, ""), "=");
    const name = ALIASES[rawName] ?? rawName;
    const type = spec[name];
    if (!type) {
      throw new UserError(`opción desconocida: ${arg}\n\nUsa "orden --help" para ver las opciones.`);
    }

    if (type === "boolean") {
      if (inlineValue !== undefined) throw new UserError(`--${name} no lleva valor`);
      flags[name] = true;
      continue;
    }

    const value = inlineValue ?? argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new UserError(`--${name} necesita un valor`);
    }
    flags[name] = value;
    if (inlineValue === undefined) index += 1;
  }

  return { positional, flags };
}

function stringFlag(flags: Flags, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

function numberFlag(flags: Flags, name: string, fallback: number): number {
  const raw = stringFlag(flags, name);
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) throw new UserError(`--${name} debe ser un número`);
  return value;
}

async function openContext(flags: Flags): Promise<{ loaded: LoadedConfig; rootAbs: string }> {
  const loaded = await loadConfig(stringFlag(flags, "config"));
  const rootAbs = resolveRoot(loaded, stringFlag(flags, "root"));

  if (!(await pathExists(rootAbs))) throw new UserError(`no existe el directorio: ${rootAbs}`);
  const stats = await fs.stat(rootAbs);
  if (!stats.isDirectory()) throw new UserError(`no es un directorio: ${rootAbs}`);

  return { loaded, rootAbs };
}

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [s/N] `);
    return /^(s|si|sí|y|yes)$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function requireConfirmation(question: string, skip: boolean): Promise<boolean> {
  if (skip) return true;
  if (!process.stdin.isTTY) {
    throw new UserError("no hay una terminal interactiva para confirmar; repite con --yes");
  }
  return confirm(question);
}

function renderPlan(plan: Plan, options: { verbose: boolean; limit: number }): void {
  const movers = plan.items.length;
  console.log(bold(`Plan para ${plan.root}`));
  console.log(
    `  ${plan.scanned} archivos revisados · ${bold(String(movers))} por mover (${humanSize(plan.totalBytes)}) · ` +
      `${plan.alreadyInPlace} ya en su sitio · ${plan.unmatched} sin regla`,
  );

  if (movers === 0) {
    console.log(green("\nNada que mover."));
    return;
  }

  const byRule = new Map<string, { count: number; bytes: number }>();
  for (const item of plan.items) {
    const entry = byRule.get(item.rule) ?? { count: 0, bytes: 0 };
    entry.count += 1;
    entry.bytes += item.size;
    byRule.set(item.rule, entry);
  }

  console.log("");
  for (const [rule, entry] of byRule) {
    console.log(`  ${cyan(rule)}  ${entry.count} archivo(s) · ${humanSize(entry.bytes)}`);
  }

  const visible = options.verbose ? plan.items : plan.items.slice(0, options.limit);
  console.log("");
  console.log(
    table(
      ["archivo", "destino", "tamaño"],
      visible.map((item) => [
        truncate(item.relSource, 44),
        truncate(item.relDest, 44),
        humanSize(item.size),
      ]),
    ),
  );

  const remaining = plan.items.length - visible.length;
  if (remaining > 0) {
    console.log(dim(`  … y ${remaining} más (usa --verbose para verlos todos)`));
  }
}

function printSummary(result: Awaited<ReturnType<typeof applyPlan>>): void {
  console.log("");
  console.log(
    green(`✔ ${result.moves} archivo(s) movidos`) +
      (result.failed.length > 0 ? ` · ${red(`${result.failed.length} con error`)}` : ""),
  );

  for (const failure of result.failed) {
    console.log(`  ${red("✖")} ${failure.relSource}: ${failure.error}`);
  }

  console.log(dim(`  diario: ${result.file}`));
  console.log(dim("  para deshacer: orden undo"));
}

async function commandInit(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv, { force: "boolean" });
  const file = path.join(process.cwd(), CONFIG_FILENAME);

  if ((await pathExists(file)) && flags.force !== true) {
    throw new UserError(`${file} ya existe (usa --force para sobrescribirlo)`);
  }

  await fs.writeFile(file, `${JSON.stringify(defaultConfig(), null, 2)}\n`, "utf8");
  console.log(green(`✔ Creado ${file}`));
  console.log(dim("  Revisa las reglas y prueba: orden scan ."));
  return 0;
}

async function commandScan(argv: string[]): Promise<number> {
  const { positional, flags } = parseFlags(argv, {
    config: "string",
    root: "string",
    json: "boolean",
    verbose: "boolean",
    limit: "string",
  });

  if (positional.length > 1) throw new UserError("scan acepta como máximo una ruta");
  const { loaded, rootAbs } = await openContext({ ...flags, root: positional[0] ?? stringFlag(flags, "root") });
  const plan = await buildPlan(loaded.config, rootAbs);

  if (flags.json === true) {
    console.log(
      JSON.stringify(
        {
          root: plan.root,
          scanned: plan.scanned,
          alreadyInPlace: plan.alreadyInPlace,
          unmatched: plan.unmatched,
          itemCount: plan.items.length,
          totalBytes: plan.totalBytes,
          items: plan.items.map((item) => ({
            source: item.relSource,
            destination: item.relDest,
            rule: item.rule,
            size: item.size,
          })),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  renderPlan(plan, { verbose: flags.verbose === true, limit: numberFlag(flags, "limit", 25) });
  if (plan.items.length > 0) {
    console.log(dim("\nNada se ha movido. Aplica el plan con: orden apply"));
  }
  return 0;
}

async function commandApply(argv: string[]): Promise<number> {
  const { positional, flags } = parseFlags(argv, {
    config: "string",
    root: "string",
    yes: "boolean",
    "dry-run": "boolean",
    verbose: "boolean",
    limit: "string",
  });

  if (positional.length > 1) throw new UserError("apply acepta como máximo una ruta");
  const { loaded, rootAbs } = await openContext({ ...flags, root: positional[0] ?? stringFlag(flags, "root") });
  const plan = await buildPlan(loaded.config, rootAbs);

  renderPlan(plan, { verbose: flags.verbose === true, limit: numberFlag(flags, "limit", 25) });

  if (plan.items.length === 0) return 0;
  if (flags["dry-run"] === true) {
    console.log(yellow("\n(dry-run: no se movió nada)"));
    return 0;
  }

  const confirmed = await requireConfirmation(
    `\n¿Mover ${plan.items.length} archivo(s) (${humanSize(plan.totalBytes)})?`,
    flags.yes === true,
  );
  if (!confirmed) {
    console.log(yellow("Cancelado. No se movió nada."));
    return 0;
  }

  const result = await applyPlan(plan);
  printSummary(result);
  return result.failed.length > 0 ? 1 : 0;
}

async function commandUndo(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv, {
    root: "string",
    id: "string",
    list: "boolean",
    yes: "boolean",
  });

  const rootAbs = path.resolve(process.cwd(), stringFlag(flags, "root") ?? ".");

  if (flags.list === true) {
    const entries = await listJournals(rootAbs);
    if (entries.length === 0) {
      console.log(dim(`Sin diarios en ${rootAbs}`));
      return 0;
    }
    console.log(
      table(
        ["id", "fecha", "estado", "movimientos"],
        entries.map((entry) => [
          entry.journal.id,
          new Date(entry.journal.createdAt).toLocaleString(),
          entry.journal.status,
          String(entry.journal.moves.length),
        ]),
      ),
    );
    return 0;
  }

  const entries = await listJournals(rootAbs);
  let entry: JournalEntry | undefined;

  const wantedId = stringFlag(flags, "id");
  if (wantedId) {
    entry = entries.find(
      (candidate) => candidate.journal.id === wantedId || candidate.journal.id.startsWith(wantedId),
    );
    if (!entry) throw new UserError(`no encuentro un diario con id "${wantedId}"`);
  } else {
    entry = await latestJournal(rootAbs);
    if (!entry) throw new UserError(`no hay diarios pendientes en ${rootAbs} (usa --list para verlos)`);
  }

  if (entry.journal.status === "undone") {
    throw new UserError(`el diario ${entry.journal.id} ya se deshizo`);
  }

  console.log(bold(`Deshacer ${entry.journal.id}`));
  console.log(`  ${entry.journal.moves.length} movimiento(s) · ${new Date(entry.journal.createdAt).toLocaleString()}`);

  const confirmed = await requireConfirmation("¿Restaurar los archivos a su posición original?", flags.yes === true);
  if (!confirmed) {
    console.log(yellow("Cancelado."));
    return 0;
  }

  const result = await undoJournal(entry.journal);
  console.log("");
  console.log(green(`✔ ${result.restored} archivo(s) restaurados`));
  if (result.missing > 0) console.log(yellow(`  ${result.missing} ya no existían en el destino`));
  for (const failure of result.failed) {
    console.log(`  ${red("✖")} ${failure.to}: ${failure.error}`);
  }
  return result.failed.length > 0 ? 1 : 0;
}

async function commandDupes(argv: string[]): Promise<number> {
  const { positional, flags } = parseFlags(argv, {
    config: "string",
    root: "string",
    json: "boolean",
    "min-size": "string",
    limit: "string",
  });

  if (positional.length > 1) throw new UserError("dupes acepta como máximo una ruta");

  let loaded: LoadedConfig | undefined;
  try {
    loaded = await loadConfig(stringFlag(flags, "config"));
  } catch (error) {
    if (error instanceof ConfigError && stringFlag(flags, "config") === undefined) loaded = undefined;
    else throw error;
  }

  const rootAbs = positional[0]
    ? path.resolve(process.cwd(), positional[0])
    : loaded
      ? resolveRoot(loaded, stringFlag(flags, "root"))
      : path.resolve(process.cwd(), stringFlag(flags, "root") ?? ".");

  if (!(await pathExists(rootAbs))) throw new UserError(`no existe el directorio: ${rootAbs}`);

  const defaults = defaultConfig();
  const minSizeBytes = stringFlag(flags, "min-size")
    ? parseSize(stringFlag(flags, "min-size")!)
    : 1024 * 1024;

  const report = await findDuplicates(rootAbs, {
    ignore: loaded?.config.ignore ?? defaults.ignore,
    includeHidden: loaded?.config.includeHidden ?? false,
    minSizeBytes,
  });

  if (flags.json === true) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }

  console.log(bold(`Duplicados en ${rootAbs}`));
  console.log(
    `  ${report.scanned} archivos revisados · ${report.groups.length} grupo(s) · ` +
      `${bold(humanSize(report.wasted))} recuperables`,
  );

  if (report.groups.length === 0) {
    console.log(green("\nSin duplicados por encima del tamaño mínimo."));
    return 0;
  }

  const limit = numberFlag(flags, "limit", 20);
  for (const group of report.groups.slice(0, limit)) {
    console.log("");
    console.log(`${cyan(humanSize(group.size))} cada uno · ${dim(group.hash.slice(0, 16))}`);
    for (const file of group.files) {
      console.log(`  ${truncate(file, 90)}`);
    }
  }

  if (report.groups.length > limit) {
    console.log(dim(`\n… y ${report.groups.length - limit} grupo(s) más (usa --limit)`));
  }
  return 0;
}

async function printVersion(): Promise<number> {
  const file = path.join(import.meta.dirname, "..", "package.json");
  const pkg = JSON.parse(await fs.readFile(file, "utf8")) as { version?: string };
  console.log(`orden ${pkg.version ?? "0.0.0"}`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (argv.includes("-h") || argv.includes("--help") || command === undefined || command === "help") {
    console.log(HELP);
    return 0;
  }
  if (command === "--version" || command === "version") {
    return printVersion();
  }

  switch (command) {
    case "init":
      return commandInit(rest);
    case "scan":
      return commandScan(rest);
    case "apply":
      return commandApply(rest);
    case "undo":
      return commandUndo(rest);
    case "dupes":
      return commandDupes(rest);
    default:
      throw new UserError(`comando desconocido: ${command}\n\nUsa "orden --help" para ver la ayuda.`);
  }
}

// Un pipe cerrado (`| head`) no es un fallo real de la app.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof UserError) {
    console.error(`${red("error:")} ${error.message}`);
    process.exitCode = error.exitCode;
  } else {
    console.error(`${red("error inesperado:")} ${(error as Error).stack ?? String(error)}`);
    process.exitCode = 1;
  }
}
