import type { Rule } from "./config.ts";
import { globToRegExp } from "./glob.ts";

export type FileFacts = {
  rel: string;
  ext: string;
  size: number;
  mtimeMs: number;
};

/** Todas las condiciones presentes deben cumplirse; dentro de una lista basta una. */
export function matchesRule(rule: Rule, file: FileFacts, now = Date.now()): boolean {
  const match = rule.match;

  if (match.ext && match.ext.length > 0) {
    if (!match.ext.includes(file.ext)) return false;
  }

  if (match.glob && match.glob.length > 0) {
    if (!match.glob.some((pattern) => globToRegExp(pattern).test(file.rel))) return false;
  }

  if (match.olderThanDays !== undefined) {
    if (file.mtimeMs > now - match.olderThanDays * 86_400_000) return false;
  }

  if (match.minSizeBytes !== undefined && file.size < match.minSizeBytes) return false;

  return true;
}

/** Gana la primera regla habilitada que coincida. */
export function firstMatch(rules: Rule[], file: FileFacts, now = Date.now()): Rule | undefined {
  return rules.find((rule) => !rule.disabled && matchesRule(rule, file, now));
}
