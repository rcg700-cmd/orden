/**
 * Glob mínimo y predecible: `*`, `**`, `?`, `[abc]`.
 * Nada de llaves ni negaciones: lo que no se entiende se escapa literal.
 */
export function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` consume cero o más segmentos completos.
        if (pattern[i + 2] === "/") {
          source += "(?:[^/]+/)*";
          i += 2;
        } else {
          source += ".*";
          i += 1;
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    if (char === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end === -1) {
        source += "\\[";
        continue;
      }
      const body = pattern.slice(i + 1, end).replace(/\\/g, "\\\\");
      source += `[${body.startsWith("!") ? "^" + body.slice(1) : body}]`;
      i = end;
      continue;
    }
    source += char.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "i");
}

export function isIgnored(patterns: string[], relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  for (const raw of patterns) {
    const pattern = raw.replace(/^\.\//, "");
    if (globToRegExp(pattern).test(normalized)) return true;
    // `carpeta/**` también ignora la carpeta misma, para no descender en ella.
    if (pattern.endsWith("/**") && globToRegExp(pattern.slice(0, -3)).test(normalized)) return true;
  }
  return false;
}

/** Rechaza rutas absolutas, unidades de Windows y cualquier segmento `..`. */
export function isSafeRelative(value: string): boolean {
  if (value.trim() === "") return false;
  if (value.includes("\0")) return false;
  if (/^[a-zA-Z]:/.test(value)) return false;
  if (value.startsWith("/") || value.startsWith("\\")) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return false;
  const segments = value.split(/[\\/]+/);
  return segments.every((segment) => segment !== "..");
}
