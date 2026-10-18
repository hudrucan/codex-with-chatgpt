import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanup, makeTmpDir, write } from "./helpers.js";
import fs from "node:fs";

const entry = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
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

  it.each(["session", "record", "asset"])("rejects removed %s commands without changing legacy state", (command) => {
    const legacy = write(state, "sessions/old.json", '{"url":"https://chatgpt.com/c/old"}');
    const before = fs.readFileSync(legacy, "utf8");
    const result = cli([command]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/unknown command/i);
    expect(fs.readFileSync(path.resolve(legacy), "utf8")).toBe(before);
  });
});
