import { execFile } from "node:child_process";
import { JevError } from "./state.js";

export function cloudflaredEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(["PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot", "WINDIR", "TEMP", "TMP"]
    .flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
}

export function cloudflared(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("cloudflared", ["tunnel", "--no-autoupdate", ...args], {
      encoding: "utf8", timeout: 30_000, maxBuffer: 262_144, windowsHide: true, env: cloudflaredEnvironment(),
    }, (error, stdout) => {
      // Never surface credential-bearing output, arguments, or inherited environment.
      if (error) reject(new JevError(`cloudflared ${args[0]} failed (${error.code ?? "unknown exit"}); saved intent retained. Inspect the exact resource before retrying.`));
      else resolve(stdout);
    });
  });
}
