import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createPrivateWindowsFile } from "./windows-permissions.js";

/**
 * State directory resolution, following OS conventions.
 * Override with C2C_STATE_DIR (used heavily by tests).
 */
export function getStateDir(): string {
  const override = process.env.C2C_STATE_DIR;
  if (override && override.trim() !== "") return path.resolve(override);
  const home = os.homedir();
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", "codex-with-chatgpt");
    case "win32":
      return path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "codex-with-chatgpt");
    default: {
      const base = process.env.XDG_STATE_HOME ?? path.join(home, ".local", "state");
      return path.join(base, "codex-with-chatgpt");
    }
  }
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function stateSubdir(name: string): string {
  return ensureDir(path.join(getStateDir(), name));
}

/** Atomically write 0600 JSON; opt into a native Windows DACL for plaintext secrets. */
export function writeSecureJson(file: string, data: unknown, options: { windowsAcl?: boolean } = {}): void {
  ensureDir(path.dirname(file));
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const privateWindows = process.platform === "win32" && options.windowsAcl;
    if (privateWindows) createPrivateWindowsFile(temporary);
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { mode: 0o600, flag: privateWindows ? "r+" : "wx" });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best effort on platforms without chmod semantics
  }
}

export function readJsonIfExists<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export const DEFAULT_PORT = 48765;
export const DEFAULT_HOST = "127.0.0.1";
