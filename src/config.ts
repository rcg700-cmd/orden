import { promises as fs } from "node:fs";
import path from "node:path";

import { ConfigError } from "./errors.ts";
import { isSafeRelative } from "./glob.ts";
import { pathExists } from "./fsutil.ts";

export const CONFIG_FILENAME = "orden.config.json";

export type Match = {
  ext?: string[];
  glob?: string[];
  olderThanDays?: number;
  minSizeBytes?: number;
};

export type Rule = {
  name: string;
  dest: string;
  disabled?: boolean;
  match: Match;
};

export type Config = {
  root: string;
  includeHidden: boolean;
  ignore: string[];
  rules: Rule[];
};

export type LoadedConfig = {
  config: Config;
  dir: string;
  file: string;
};

export function defaultConfig(): Config {
  return {
    root: ".",
    includeHidden: false,
    ignore: ["node_modules/**", ".git/**", "*.tmp", "*.part"],
    rules: [
      {
        name: "Imágenes",
        dest: "Imagenes/{year}",
        match: { ext: ["png", "jpg", "jpeg", "gif", "webp", "svg", "heic", "bmp", "tiff"] },
      },
      {
        name: "Documentos",
        dest: "Documentos",
        match: { ext: ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "txt", "md"] },
      },
      {
        name: "Comprimidos",
        dest: "Comprimidos",
        match: { ext: ["zip", "rar", "7z", "tar", "gz", "bz2", "xz"] },
      },
      {
        name: "Instaladores",
        dest: "Instaladores",
        match: { ext: ["exe", "msi", "msix", "dmg", "pkg", "deb", "rpm", "appimage"] },
      },
      {
        name: "Vídeo",
        dest: "Video",
        match: { ext: ["mp4", "mkv", "avi", "mov", "webm", "wmv", "flv"] },
      },
      {
        name: "Audio",
        dest: "Audio",
        match: { ext: ["mp3", "wav", "flac", "ogg", "m4a", "aac", "wma"] },
      },
      {
        name: "Código",
        dest: "Codigo",
        match: { ext: ["ts", "tsx", "js", "jsx", "py", "java", "kt", "go", "rs", "rb", "c", "cpp", "h", "cs", "sh"] },
      },
    ],
  };
}

function asStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new ConfigError(`${field} debe ser una lista de textos`);
  }
  return value as string[];
}

function validateMatch(raw: unknown, ruleName: string): Match {
  if (raw === undefined) throw new ConfigError(`la regla "${ruleName}" necesita un objeto "match"`);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`match de "${ruleName}" debe ser un objeto`);
  }
  const source = raw as Record<string, unknown>;
  const match: Match = {};

  const ext = asStringArray(source.ext, `match.ext de "${ruleName}"`);
  if (ext) match.ext = ext.map((value) => value.toLowerCase().replace(/^\./, ""));
  const glob = asStringArray(source.glob, `match.glob de "${ruleName}"`);
  if (glob) match.glob = glob;

  for (const key of ["olderThanDays", "minSizeBytes"] as const) {
    const value = source[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new ConfigError(`match.${key} de "${ruleName}" debe ser un número >= 0`);
    }
    match[key] = value;
  }

  const hasCondition =
    (match.ext?.length ?? 0) > 0 ||
    (match.glob?.length ?? 0) > 0 ||
    match.olderThanDays !== undefined ||
    match.minSizeBytes !== undefined;
  if (!hasCondition) {
    throw new ConfigError(`la regla "${ruleName}" no tiene condiciones: movería todo`);
  }
  return match;
}

function validateRule(raw: unknown, index: number, seen: Set<string>): Rule {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`rules[${index}] debe ser un objeto`);
  }
  const source = raw as Record<string, unknown>;
  if (typeof source.name !== "string" || source.name.trim() === "") {
    throw new ConfigError(`rules[${index}] necesita un "name" no vacío`);
  }
  const name = source.name.trim();
  if (seen.has(name.toLowerCase())) {
    throw new ConfigError(`nombre de regla duplicado: "${name}"`);
  }
  seen.add(name.toLowerCase());

  if (typeof source.dest !== "string" || !isSafeRelative(source.dest)) {
    throw new ConfigError(`"dest" de "${name}" debe ser una ruta relativa dentro del directorio ordenado`);
  }
  if (source.disabled !== undefined && typeof source.disabled !== "boolean") {
    throw new ConfigError(`"disabled" de "${name}" debe ser true o false`);
  }

  return {
    name,
    dest: source.dest,
    ...(source.disabled === undefined ? {} : { disabled: source.disabled }),
    match: validateMatch(source.match, name),
  };
}

export function validateConfig(raw: unknown): Config {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError("el archivo de configuración debe contener un objeto JSON");
  }
  const source = raw as Record<string, unknown>;

  const root = source.root === undefined ? "." : source.root;
  if (typeof root !== "string" || root.trim() === "") {
    throw new ConfigError(`"root" debe ser una ruta`);
  }
  if (!path.isAbsolute(root) && !isSafeRelative(root)) {
    throw new ConfigError(`"root" debe ser una ruta relativa simple o absoluta`);
  }

  if (source.includeHidden !== undefined && typeof source.includeHidden !== "boolean") {
    throw new ConfigError(`"includeHidden" debe ser true o false`);
  }

  const ignore = asStringArray(source.ignore, "ignore") ?? [];
  if (!Array.isArray(source.rules) || source.rules.length === 0) {
    throw new ConfigError(`"rules" debe ser una lista con al menos una regla`);
  }
  const seen = new Set<string>();
  const rules = source.rules.map((rule, index) => validateRule(rule, index, seen));

  return { root, includeHidden: source.includeHidden === true, ignore, rules };
}

export async function loadConfig(explicitPath?: string): Promise<LoadedConfig> {
  const file = explicitPath
    ? path.resolve(process.cwd(), explicitPath)
    : path.join(process.cwd(), CONFIG_FILENAME);

  if (!(await pathExists(file))) {
    throw new ConfigError(
      `no encuentro ${path.basename(file)} en ${path.dirname(file)}. Crea uno con: orden init`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    throw new ConfigError(`no pude leer ${file}: ${(error as Error).message}`);
  }

  return { config: validateConfig(raw), dir: path.dirname(file), file };
}

export function resolveRoot(loaded: LoadedConfig, override?: string): string {
  if (override) return path.resolve(process.cwd(), override);
  return path.resolve(loaded.dir, loaded.config.root);
}

export type Context = {
  config: Config;
  configFile: string | null;
  root: string;
};

/**
 * Resuelve configuración y raíz en un solo paso:
 * - `--config` explícito: manda ese archivo; la raíz es `--root` o la del config.
 * - Carpeta objetivo: se usa su `orden.config.json` si existe; si no, reglas por defecto.
 * - Sin carpeta: exige `orden.config.json` en el directorio actual.
 */
export async function resolveConfigContext(
  rootOverride?: string,
  explicitConfig?: string,
): Promise<Context> {
  if (explicitConfig) {
    const loaded = await loadConfig(explicitConfig);
    return {
      config: loaded.config,
      configFile: loaded.file,
      root: resolveRoot(loaded, rootOverride),
    };
  }

  if (rootOverride) {
    const root = path.resolve(process.cwd(), rootOverride);
    const file = path.join(root, CONFIG_FILENAME);
    if (await pathExists(file)) {
      const loaded = await loadConfig(file);
      return { config: loaded.config, configFile: file, root };
    }
    return { config: defaultConfig(), configFile: null, root };
  }

  const loaded = await loadConfig();
  return { config: loaded.config, configFile: loaded.file, root: resolveRoot(loaded) };
}
