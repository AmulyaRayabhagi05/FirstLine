import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** Default location of the worker's .env: agents/.env */
export const DEFAULT_ENV_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".env");

/**
 * Load KEY=VALUE lines from a .env file into process.env without overriding values already
 * set. Returns false if the file does not exist. Values are never logged.
 */
export function loadEnvFile(path: string = DEFAULT_ENV_PATH): boolean {
  if (!existsSync(path)) return false;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let value = m[2]!;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[m[1]!] === undefined) process.env[m[1]!] = value;
  }
  return true;
}
