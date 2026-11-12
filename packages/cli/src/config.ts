import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Everything contexter keeps on this machine lives under one directory.
// CONTEXTER_HOME overrides it (handy for running several members on one machine).
export const home = process.env.CONTEXTER_HOME ?? join(homedir(), ".config", "contexter");

export interface Config {
  url?: string;
  publishableKey?: string;
  activeWorkspace?: { id: string; slug: string };
}

const configPath = join(home, "config.json");
const authPath = join(home, "auth.json");

function ensureHome() {
  if (!existsSync(home)) mkdirSync(home, { recursive: true, mode: 0o700 });
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writePrivate(path: string, data: unknown) {
  ensureHome();
  writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function loadConfig(): Config {
  return {
    ...readJson<Config>(configPath, {}),
    ...(process.env.CONTEXTER_URL ? { url: process.env.CONTEXTER_URL } : {}),
    ...(process.env.CONTEXTER_KEY ? { publishableKey: process.env.CONTEXTER_KEY } : {}),
  };
}

export function saveConfig(patch: Partial<Config>) {
  writePrivate(configPath, { ...readJson<Config>(configPath, {}), ...patch });
}

// Auth session storage for supabase-js. A file readable only by this user for now;
// moving it to the OS keychain is tracked in PLAN.md.
export const authStorage = {
  getItem(key: string): string | null {
    return readJson<Record<string, string>>(authPath, {})[key] ?? null;
  },
  setItem(key: string, value: string) {
    writePrivate(authPath, { ...readJson<Record<string, string>>(authPath, {}), [key]: value });
  },
  removeItem(key: string) {
    const all = readJson<Record<string, string>>(authPath, {});
    delete all[key];
    writePrivate(authPath, all);
  },
};
