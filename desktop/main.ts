import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { appendFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

import { applyPlan } from "../src/apply.ts";
import { resolveConfigContext, type Context as ConfigContext } from "../src/config.ts";
import { UserError } from "../src/errors.ts";
import { latestJournal, listJournals } from "../src/journal.ts";
import { buildPlan } from "../src/scan.ts";
import { undoJournal } from "../src/undo.ts";

const APP_ROOT = path.join(import.meta.dirname, "..");
const UI_FILE = path.join(APP_ROOT, "desktop", "ui", "index.html");
const PRELOAD_FILE = path.join(APP_ROOT, "desktop", "preload.cjs");
function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found?.slice(prefix.length);
}

const SMOKE_ROOT = process.env.ORDEN_SMOKE_ROOT ?? argValue("smoke-root");
const SMOKE_SHOT = process.env.ORDEN_SMOKE_SHOT ?? argValue("smoke-shot");
const SMOKE_LOG = process.env.ORDEN_SMOKE_LOG ?? argValue("smoke-log");
const INITIAL_FOLDER = argValue("folder");
const CAPTURE_ONLY = SMOKE_ROOT === undefined && SMOKE_SHOT !== undefined;

/** En Windows el proceso GUI no siempre tiene stdout válido: con SMOKE_LOG se escribe solo a archivo. */
function log(message: string): void {
  if (SMOKE_LOG) {
    try {
      appendFileSync(SMOKE_LOG, `${message}\n`);
    } catch {
      // sin log, no pasa nada
    }
    return;
  }
  try {
    console.log(message);
  } catch {
    // stdout roto (EPIPE): no es un fallo de la app
  }
}

log(`MAIN_START root=${SMOKE_ROOT ?? "-"} shot=${SMOKE_SHOT ?? "-"}`);

// En Windows, stdout/stderr de un proceso GUI pueden ser pipes cerrados: no son fallos.
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

process.on("uncaughtException", (error) => {
  log(`UNCAUGHT ${(error as Error).stack ?? String(error)}`);
  if ((error as NodeJS.ErrnoException).code !== "EPIPE") app.exit(1);
});
process.on("unhandledRejection", (reason) => {
  log(`UNHANDLED ${String(reason)}`);
});

async function resolveContext(root: string): Promise<ConfigContext> {
  const resolved = path.resolve(root);
  const stats = await fs.stat(resolved).catch(() => undefined);
  if (!stats?.isDirectory()) throw new UserError(`no es una carpeta: ${resolved}`);
  return resolveConfigContext(resolved);
}

function assertString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new UserError(`parámetro inválido: ${name}`);
  }
  return value;
}

function assertStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new UserError(`parámetro inválido: ${name}`);
  }
  return value as string[];
}

/** Nunca se lanza una excepción al renderer: siempre { ok, data | error }. */
function handle(channel: string, handler: (...args: unknown[]) => Promise<unknown>): void {
  ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
    try {
      return { ok: true, data: await handler(...args) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

handle("orden:choose-folder", async () => {
  const result = await dialog.showOpenDialog({
    title: "Elegir carpeta a ordenar",
    properties: ["openDirectory"],
  });
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
});

handle("orden:scan", async (rawRoot) => {
  const context = await resolveContext(assertString(rawRoot, "root"));
  const plan = await buildPlan(context.config, context.root);

  return {
    root: context.root,
    configFile: context.configFile,
    ruleCount: context.config.rules.length,
    scanned: plan.scanned,
    alreadyInPlace: plan.alreadyInPlace,
    unmatched: plan.unmatched,
    totalBytes: plan.totalBytes,
    items: plan.items.map((item) => ({
      source: item.relSource,
      destination: item.relDest,
      rule: item.rule,
      size: item.size,
    })),
  };
});

handle("orden:apply", async (rawRoot, rawSources) => {
  const context = await resolveContext(assertString(rawRoot, "root"));
  const wanted = new Set(assertStringArray(rawSources, "sources"));
  const plan = await buildPlan(context.config, context.root);

  const selected = plan.items.filter((item) => wanted.has(item.relSource));
  if (selected.length === 0) throw new UserError("no hay archivos seleccionados que sigan existiendo");

  const result = await applyPlan({ ...plan, items: selected });
  return {
    moves: result.moves,
    failed: result.failed,
    journalFile: result.file,
  };
});

handle("orden:undo-status", async (rawRoot) => {
  const root = path.resolve(assertString(rawRoot, "root"));
  const entry = await latestJournal(root);
  if (!entry) return null;
  return {
    id: entry.journal.id,
    createdAt: entry.journal.createdAt,
    moves: entry.journal.moves.length,
    status: entry.journal.status,
  };
});

handle("orden:undo", async (rawRoot) => {
  const root = path.resolve(assertString(rawRoot, "root"));
  const entry = await latestJournal(root);
  if (!entry) throw new UserError("no hay ninguna acción que deshacer");
  const result = await undoJournal(entry.journal);
  return { restored: result.restored, missing: result.missing, failed: result.failed, id: entry.journal.id };
});

handle("orden:journals", async (rawRoot) => {
  const root = path.resolve(assertString(rawRoot, "root"));
  const entries = await listJournals(root);
  return entries.map((entry) => ({
    id: entry.journal.id,
    createdAt: entry.journal.createdAt,
    status: entry.journal.status,
    moves: entry.journal.moves.length,
  }));
});

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 860,
    minHeight: 560,
    backgroundColor: "#0f1115",
    title: "orden",
    autoHideMenuBar: true,
    show: SMOKE_ROOT === undefined && !CAPTURE_ONLY,
    webPreferences: {
      preload: PRELOAD_FILE,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      offscreen: SMOKE_ROOT !== undefined || CAPTURE_ONLY,
    },
  });

  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());

  const query = new URLSearchParams();
  if (SMOKE_ROOT !== undefined) query.set("smoke", "1");
  if (INITIAL_FOLDER) query.set("folder", INITIAL_FOLDER);
  const search = query.size > 0 ? `?${query.toString()}` : undefined;
  void win.loadFile(UI_FILE, search ? { search } : {});

  return win;
}

async function waitForReady(win: BrowserWindow, timeoutMs = 8000): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const ready = (await win.webContents.executeJavaScript("Boolean(window.__ordenReady)")) as boolean;
    if (ready) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

async function capture(win: BrowserWindow, suffix: string): Promise<void> {
  if (!SMOKE_SHOT) return;
  const file = SMOKE_SHOT.replace(/\.png$/i, `-${suffix}.png`);
  log(`SMOKE_CAPTURE_START ${suffix}`);
  try {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const image = await win.webContents.capturePage();
    const png = image.toPNG();
    await fs.writeFile(file, png);
    log(`SMOKE_SHOT ${file} bytes=${png.length}`);
  } catch (error) {
    log(`SMOKE_CAPTURE_FAIL ${suffix} ${(error as Error).message}`);
  }
}

async function runSmoke(win: BrowserWindow): Promise<void> {
  try {
    const run = (script: string): Promise<unknown> => win.webContents.executeJavaScript(script);
    const root = JSON.stringify(SMOKE_ROOT);

    log("SMOKE_OPEN");
    await run(`window.__ordenSmoke.open(${root})`);
    const scan = await run("window.__ordenSmoke.state()");
    log(`SMOKE_SCAN ${JSON.stringify(scan)}`);
    await capture(win, "scan");
    log("SMOKE_APPLY_START");
    const applied = await run("window.__ordenSmoke.apply()");
    log(`SMOKE_APPLY_END ${JSON.stringify(applied)}`);
    const afterApply = await run("window.__ordenSmoke.state()");
    log(`SMOKE_APPLIED ${JSON.stringify(applied)}`);
    const undone = await run("window.__ordenSmoke.undo()");
    const afterUndo = await run("window.__ordenSmoke.state()");
    log(`SMOKE_UNDONE ${JSON.stringify(undone)}`);

    const report = { scan, applied, afterApply, undone, afterUndo };
    log(`SMOKE_RESULT ${JSON.stringify(report)}`);

    const ok =
      (applied as { ok?: boolean; moves?: number } | null)?.ok === true &&
      (undone as { ok?: boolean; restored?: number } | null)?.ok === true;
    app.exit(ok ? 0 : 1);
  } catch (error) {
    log(`SMOKE_ERROR ${(error as Error).stack ?? String(error)}`);
    app.exit(1);
  }
}

void app.whenReady().then(() => {
  const win = createWindow();

  if (SMOKE_ROOT !== undefined) {
    win.webContents.on("console-message", (_event, _level, message) => {
      log(`RENDERER ${message}`);
    });
    win.webContents.on("did-fail-load", (_event, code, description, url) => {
      log(`SMOKE_FAIL_LOAD ${code} ${description} ${url}`);
      app.exit(1);
    });
    win.webContents.on("render-process-gone", (_event, details) => {
      log(`SMOKE_RENDER_GONE ${details.reason}`);
      app.exit(1);
    });
    win.webContents.once("did-finish-load", () => {
      log("SMOKE_LOADED");
      void runSmoke(win);
    });
  }

  if (CAPTURE_ONLY) {
    win.webContents.on("console-message", (_event, _level, message) => {
      log(`RENDERER ${message}`);
    });
    win.webContents.once("did-finish-load", () => {
      void (async () => {
        log(`CAPTURE_ONLY_LOADED url=${win.webContents.getURL()}`);
        const ready = await waitForReady(win);
        log(`CAPTURE_ONLY_READY ${ready}`);
        await capture(win, "start");
        log("CAPTURE_ONLY_DONE");
        app.exit(0);
      })();
    });
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
