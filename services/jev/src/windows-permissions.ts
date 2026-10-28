import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(new URL("../dist/windows-permissions.exe", import.meta.url));

/** Restriction is used only immediately after exclusive directory creation. */
export function windowsPrivatePermissions(file: string, restrict = false): boolean {
  const result = spawnSync(helper, [restrict ? "restrict" : "check", file], {
    encoding: "utf8", timeout: 10_000, maxBuffer: 16_384, windowsHide: true,
    env: { SystemRoot: process.env.SystemRoot },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return !result.error && result.status === 0;
}
