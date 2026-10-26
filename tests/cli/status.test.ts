import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createHub } from "../../src/hub/store.js";
import { startBridge, type Bridge } from "../../src/bridge/server.js";
import { writeRuntimeState } from "../../src/bridge/runtime.js";
import { cleanup, isolateStateDir, makeTmpDir } from "../helpers.js";

const entry = fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url));
const execute = promisify(execFile);
let state: string, scratch: string, hubId: string, hook: string, bridge: Bridge | undefined;
beforeEach(() => {
  state = isolateStateDir(); scratch = makeTmpDir("status-read-only");
  hubId = createHub("Status fixture").hubId;
  hook = path.join(scratch, "deny-state-writes.cjs");
  fs.writeFileSync(hook, `
    const fs = require('node:fs'), path = require('node:path');
    const root = process.env.C2C_STATE_DIR;
    const deny = target => {
      if (typeof target !== 'string') return;
      const relative = path.relative(root, path.resolve(target));
      if (relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)))
        throw new Error('TEST_STATE_WRITE_ATTEMPT');
    };
    for (const name of ['mkdirSync', 'writeFileSync', 'appendFileSync', 'unlinkSync', 'rmSync', 'rmdirSync', 'chmodSync', 'utimesSync', 'truncateSync']) {
      const original = fs[name]; fs[name] = (target, ...args) => { deny(target); return original(target, ...args); };
    }
    const open = fs.openSync;
    fs.openSync = (target, flags, ...args) => {
      if (flags !== 'r' && flags !== 'rs' && flags !== 0) deny(target);
      return open(target, flags, ...args);
    };
    for (const name of ['renameSync', 'copyFileSync', 'linkSync']) {
      const original = fs[name]; fs[name] = (from, to, ...args) => { deny(from); deny(to); return original(from, to, ...args); };
    }
    require('node:module').syncBuiltinESMExports();
  `);
});
afterEach(async () => {
  await bridge?.close(); bridge = undefined;
  cleanup(state); cleanup(scratch); delete process.env.C2C_STATE_DIR;
});
function snapshot(directory = state): unknown {
  return fs.readdirSync(directory).sort().map(name => {
    const file = path.join(directory, name), stat = fs.lstatSync(file);
    return [name, stat.mode, stat.mtimeMs, stat.isSymbolicLink() ? fs.readlinkSync(file)
      : stat.isDirectory() ? snapshot(file) : fs.readFileSync(file).toString("hex")];
  });
}
async function status(selector = hubId) {
  const before = snapshot();
  const result = await execute(process.execPath, ["--require", hook, "--import", "tsx", entry, "status", "--hub", selector, "--json"], {
    env: process.env, timeout: 10_000,
  }).then(value => ({ code: 0, ...value }), error => ({ code: error.code, stdout: error.stdout as string, stderr: error.stderr as string }));
  expect(result.stdout + result.stderr).not.toContain("TEST_STATE_WRITE_ATTEMPT");
  expect(snapshot()).toEqual(before);
  return { code: result.code, value: JSON.parse(result.stdout) };
}

it("reports a healthy bridge without writes even while writer locks exist", async () => {
  bridge = await startBridge({ hubId, port: 0 });
  fs.writeFileSync(path.join(state, "hubs", ".lock"), "another writer");
  for (const resource of ["tunnels", "endpoints"])
    fs.writeFileSync(path.join(state, resource, `${hubId}.json.lock`), "another writer");
  expect(await status()).toMatchObject({ code: 0, value: { ok: true, running: true, hubId, connectorAction: "none" } });
  // The running fixture needs its normal writer locks for shutdown.
  fs.unlinkSync(path.join(state, "hubs", ".lock"));
  for (const resource of ["tunnels", "endpoints"]) fs.unlinkSync(path.join(state, resource, `${hubId}.json.lock`));
});

it("reports stopped without creating a runtime directory", async () => {
  expect(await status()).toEqual({ code: 0, value: { ok: false, running: false } });
  expect(fs.existsSync(path.join(state, "runtime"))).toBe(false);
});

it("keeps an unreachable runtime unknown without rewriting or removing it", async () => {
  writeRuntimeState({ stateVersion: 1, service: "c2c-bridge", version: "fixture", hubId, pid: process.pid,
    port: 1, adminToken: "fixture-only", publicUrl: null, startedAt: new Date().toISOString() });
  expect(await status()).toMatchObject({ code: 0, value: { ok: false, running: null, state: "unknown", reason: "probe_failed" } });
});

it.each(["tunnels", "endpoints"])("fails closed on invalid %s state without attempting writes", async resource => {
  const file = path.join(state, resource, `${hubId}.json`), original = fs.readFileSync(file);
  for (const kind of ["malformed", "foreign", "missing", "symlink"] as const) {
    fs.rmSync(file, { force: true });
    if (kind === "malformed") fs.writeFileSync(file, "{");
    if (kind === "foreign") fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(original.toString()), hubId: "hub-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }));
    if (kind === "symlink") {
      const target = path.join(scratch, "state.json"); fs.writeFileSync(target, original); fs.symlinkSync(target, file);
    }
    const result = await status();
    expect(result.code).toBe(1);
    expect(result.value.error).toContain(kind === "symlink" ? "STATE_PATH_INVALID" : `${resource === "tunnels" ? "TUNNEL" : "ENDPOINT"}_STATE_CONFLICT`);
  }
});

it("does not create missing state or adopt a foreign Hub", async () => {
  expect((await status("hub-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).value.error).toContain("HUB_NOT_CONFIGURED");
  fs.rmSync(state, { recursive: true }); fs.mkdirSync(state);
  expect((await status()).value.error).toContain("HUB_NOT_CONFIGURED");
  expect(fs.readdirSync(state)).toEqual([]);
});
