import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { applyPlan } from "../src/apply.ts";
import type { Config } from "../src/config.ts";
import { resolveDest } from "../src/dest.ts";
import { findDuplicates } from "../src/dupes.ts";
import { UserError } from "../src/errors.ts";
import { humanSize, parseSize } from "../src/format.ts";
import { existsSync } from "node:fs";
import { pathExists, uniquePath } from "../src/fsutil.ts";
import { globToRegExp, isIgnored, isSafeRelative } from "../src/glob.ts";
import { listJournals } from "../src/journal.ts";
import { matchesRule } from "../src/rules.ts";
import { buildPlan } from "../src/scan.ts";
import { undoJournal } from "../src/undo.ts";

const TEST_CONFIG: Config = {
  root: ".",
  includeHidden: false,
  ignore: ["node_modules/**"],
  rules: [
    { name: "Imágenes", dest: "Imagenes/{year}", match: { ext: ["jpg", "png"] } },
    { name: "Viejos", dest: "Antiguos", match: { ext: ["log"], olderThanDays: 30 } },
  ],
};

const OLD_DATE = new Date("2020-01-01T00:00:00Z");

async function makeFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "orden-test-"));
  await mkdir(path.join(root, "sub"), { recursive: true });
  await writeFile(path.join(root, "a.jpg"), "aaa");
  await writeFile(path.join(root, "b.PNG"), "bbb");
  await writeFile(path.join(root, "sub", "c.png"), "ccc");
  await writeFile(path.join(root, "old.log"), "old");
  await writeFile(path.join(root, "notes.md"), "notes");
  await utimes(path.join(root, "old.log"), OLD_DATE, OLD_DATE);
  return root;
}

test("glob: patrones básicos y `**`", () => {
  assert.equal(globToRegExp("*.tmp").test("x.tmp"), true);
  assert.equal(globToRegExp("*.tmp").test("dir/x.tmp"), false);
  assert.equal(globToRegExp("node_modules/**").test("node_modules/a/b.js"), true);
  assert.equal(globToRegExp("**/*.log").test("a/b/c.log"), true);
  assert.equal(globToRegExp("file?.txt").test("file1.txt"), true);
  assert.equal(isIgnored(["node_modules/**"], "node_modules"), true);
  assert.equal(isIgnored(["node_modules/**"], "src/index.ts"), false);
});

test("rutas relativas seguras", () => {
  assert.equal(isSafeRelative("Imagenes/{year}"), true);
  assert.equal(isSafeRelative("../fuera"), false);
  assert.equal(isSafeRelative("a/../../fuera"), false);
  assert.equal(isSafeRelative("C:/Windows"), false);
  assert.equal(isSafeRelative("/etc"), false);
  assert.equal(isSafeRelative("  "), false);
});

test("format: tamaños legibles y parseo", () => {
  assert.equal(humanSize(0), "0 B");
  assert.equal(humanSize(1024), "1.0 KB");
  assert.equal(humanSize(1536), "1.5 KB");
  assert.equal(humanSize(1024 ** 3), "1.0 GB");
  assert.equal(parseSize("1mb"), 1024 * 1024);
  assert.equal(parseSize("512k"), 512 * 1024);
  assert.throws(() => parseSize("mucho"));
});

test("reglas: AND entre condiciones, OR dentro de una lista", () => {
  const rule = TEST_CONFIG.rules[0]!;
  const base = { rel: "foto.JPG", ext: "jpg", size: 10, mtimeMs: Date.now() };
  assert.equal(matchesRule(rule, base), true);
  assert.equal(matchesRule(rule, { ...base, ext: "pdf" }), false);

  const old = TEST_CONFIG.rules[1]!;
  assert.equal(matchesRule(old, { rel: "x.log", ext: "log", size: 1, mtimeMs: OLD_DATE.getTime() }), true);
  assert.equal(matchesRule(old, { rel: "x.log", ext: "log", size: 1, mtimeMs: Date.now() }), false);

  const big = { name: "Grandes", dest: "Big", match: { ext: ["bin"], minSizeBytes: 1000 } };
  assert.equal(matchesRule(big, { rel: "a.bin", ext: "bin", size: 999, mtimeMs: Date.now() }), false);
  assert.equal(matchesRule(big, { rel: "a.bin", ext: "bin", size: 1000, mtimeMs: Date.now() }), true);
});

test("destino: expande tokens y rechaza salir de la raíz", () => {
  const mtimeMs = new Date("2024-03-15T12:00:00Z").getTime();
  const root = path.resolve("/tmp/orden");
  const target = resolveDest(root, "Imagenes/{year}/{month}", { ext: "jpg", mtimeMs });
  assert.equal(target, path.resolve(root, "Imagenes/2024/03"));
  assert.throws(() => resolveDest(root, "../evil", { ext: "jpg", mtimeMs }), UserError);
});

test("uniquePath no sobrescribe archivos existentes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orden-unique-"));
  try {
    await writeFile(path.join(root, "x.txt"), "1");
    assert.equal(path.basename(uniquePath(root, "x.txt")), "x (1).txt");
    await writeFile(path.join(root, "x (1).txt"), "2");
    assert.equal(path.basename(uniquePath(root, "x.txt")), "x (2).txt");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plan: clasifica, ignora desconocidos y respeta lo ya colocado", async () => {
  const root = await makeFixture();
  try {
    await mkdir(path.join(root, "Imagenes", "2026"), { recursive: true });
    await writeFile(path.join(root, "Imagenes", "2026", "ya.jpg"), "presente");

    const plan = await buildPlan(TEST_CONFIG, root);

    assert.equal(plan.items.length, 4);
    assert.equal(plan.alreadyInPlace, 1);
    assert.equal(plan.unmatched, 1);
    assert.equal(plan.scanned, 6);

    const destinations = plan.items.map((item) => item.relDest).sort();
    assert.deepEqual(destinations, [
      "Antiguos/old.log",
      `Imagenes/${new Date().getFullYear()}/a.jpg`,
      `Imagenes/${new Date().getFullYear()}/b.PNG`,
      `Imagenes/${new Date().getFullYear()}/c.png`,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("apply + undo devuelven todo a su sitio", async () => {
  const root = await makeFixture();
  try {
    const plan = await buildPlan(TEST_CONFIG, root);
    const result = await applyPlan(plan);

    assert.equal(result.moves, 4);
    assert.equal(result.failed.length, 0);
    assert.equal(await pathExists(path.join(root, "a.jpg")), false);
    assert.equal(await pathExists(path.join(root, "Imagenes", String(new Date().getFullYear()), "a.jpg")), true);
    assert.equal(await pathExists(path.join(root, "Antiguos", "old.log")), true);

    const journals = await listJournals(root);
    assert.equal(journals.length, 1);
    assert.equal(journals[0]!.journal.status, "done");

    const undo = await undoJournal(result.journal);
    assert.equal(undo.restored, 4);
    assert.equal(undo.missing, 0);
    assert.equal(undo.failed.length, 0);

    assert.equal(await readFile(path.join(root, "a.jpg"), "utf8"), "aaa");
    assert.equal(await readFile(path.join(root, "sub", "c.png"), "utf8"), "ccc");
    assert.equal(await pathExists(path.join(root, "Imagenes")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("apply nunca sobrescribe: usa sufijo (1)", async () => {
  const root = await makeFixture();
  try {
    const year = new Date().getFullYear();
    const targetDir = path.join(root, "Imagenes", String(year));
    await mkdir(targetDir, { recursive: true });
    await writeFile(path.join(targetDir, "a.jpg"), "original");

    const plan = await buildPlan(TEST_CONFIG, root);
    const result = await applyPlan(plan);

    assert.ok(result.moves >= 1);
    assert.equal(await readFile(path.join(targetDir, "a.jpg"), "utf8"), "original");
    assert.equal(await readFile(path.join(targetDir, "a (1).jpg"), "utf8"), "aaa");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dupes agrupa solo contenidos idénticos", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orden-dupes-"));
  try {
    await writeFile(path.join(root, "uno.txt"), "mismo contenido");
    await writeFile(path.join(root, "dos.txt"), "mismo contenido");
    await writeFile(path.join(root, "tres.txt"), "otra cosa igual");

    const report = await findDuplicates(root, { minSizeBytes: 1 });
    assert.equal(report.groups.length, 1);
    assert.equal(report.groups[0]!.files.length, 2);
    assert.equal(report.wasted, "mismo contenido".length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dupes respeta el tamaño mínimo", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orden-dupes-min-"));
  try {
    await writeFile(path.join(root, "a.bin"), "x");
    await writeFile(path.join(root, "b.bin"), "x");
    const report = await findDuplicates(root, { minSizeBytes: 1024 });
    assert.equal(report.groups.length, 0);
    assert.equal(report.wasted, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("el diario guarda las rutas absolutas usadas", async () => {
  const root = await makeFixture();
  try {
    const plan = await buildPlan(TEST_CONFIG, root);
    const result = await applyPlan(plan);
    const saved = JSON.parse(await readFile(result.file, "utf8")) as { root: string; moves: unknown[] };
    assert.equal(saved.root, root);
    assert.equal(saved.moves.length, 4);
    const stats = await stat(result.file);
    assert.ok(stats.size > 0);
    assert.equal(existsSync(result.file), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
