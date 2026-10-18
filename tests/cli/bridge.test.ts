import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanup, makeTmpDir } from "../helpers.js";

const entry = fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url));
let state: string;
beforeAll(() => { state = makeTmpDir("bridge-cli"); });
afterAll(() => cleanup(state));
function cli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", entry, ...args], {
    env: { ...process.env, C2C_STATE_DIR: state }, encoding: "utf8", timeout: 10_000,
  });
}

describe("bridge-first CLI surface", () => {
  it("advertises bridge/lifecycle commands with Desk C2C Hub branding", () => {
    const result = cli(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Desk C2C Hub");
    expect(result.stdout).not.toMatch(/planning brain|ChatGPT thinks|Codex works/i);
    for (const command of ["setup", "connector", "doctor", "disconnect", "destroy", "start", "stop", "restart", "status", "pair", "unpair", "logs", "workspace", "tunnel", "prefs", "sandbox-allow", "update", "update-check"]) {
      expect(result.stdout).toMatch(new RegExp(`^  ${command}(?: |$)`, "m"));
    }
  });
});
