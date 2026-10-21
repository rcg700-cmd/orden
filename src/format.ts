const COLOR_ENABLED = !process.env.NO_COLOR && Boolean(process.stdout.isTTY);

function wrap(code: string): (text: string) => string {
  return (text) => (COLOR_ENABLED ? `\u001b[${code}m${text}\u001b[0m` : text);
}

export const bold = wrap("1");
export const dim = wrap("2");
export const red = wrap("31");
export const green = wrap("32");
export const yellow = wrap("33");
export const cyan = wrap("36");

export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

export function parseSize(input: string): number {
  const match = /^(\d+(?:[.,]\d+)?)\s*(b|k|kb|m|mb|g|gb|t|tb)?$/i.exec(input.trim());
  if (!match) throw new Error(`tamaño inválido: ${input}`);
  const value = Number(match[1]!.replace(",", "."));
  const unit = (match[2] ?? "b").toLowerCase();
  const factors: Record<string, number> = {
    b: 1,
    k: 1024,
    kb: 1024,
    m: 1024 ** 2,
    mb: 1024 ** 2,
    g: 1024 ** 3,
    gb: 1024 ** 3,
    t: 1024 ** 4,
    tb: 1024 ** 4,
  };
  return Math.round(value * (factors[unit] ?? 1));
}

/** Conserva la cola de la ruta: el nombre del archivo importa más que la raíz. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return "…";
  return `…${text.slice(text.length - (max - 1))}`;
}

export function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - text.length));
}

export function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return headers.join("  ");
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length)),
  );
  const render = (cells: string[]): string =>
    cells
      .map((cell, index) => pad(cell, widths[index] ?? 0))
      .join("  ")
      .trimEnd();
  return [render(headers), render(widths.map((width) => "-".repeat(width))), ...rows.map(render)].join("\n");
}
