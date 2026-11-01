import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as childProcess from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureCdpProfile, resolveCdpEndpoint } from "../../src/c2c/cdp-profile.js";
import { stateFile } from "../../src/config/state-files.js";
import { cleanup, isolateStateDir } from "../helpers.js";

vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof childProcess>(), execFile: vi.fn(), spawn: vi.fn() }));
const owner = { hubId: "hub-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", workspaceId: "abcdef012345" };
let stateDir: string, profile: { hubId: string; workspaceId: string; profileDirectory: string; executable: string };
let metadata: { sid: string; privateAcl: boolean; roots: number[]; listeners: Array<{ address: string; port: number; pid: number }> };

describe.skipIf(process.platform !== "win32")("owned Windows CDP profile bootstrap", () => {
  beforeEach(async () => {
    stateDir = isolateStateDir(); vi.stubEnv("C2C_CDP_ENDPOINT", "");
    const profileDirectory = path.join(stateDir, "edge-profile"), executable = path.join(stateDir, "msedge.exe");
    fs.mkdirSync(profileDirectory); fs.writeFileSync(executable, "fixture");
    profile = { ...owner, profileDirectory, executable };
    fs.writeFileSync(path.join(profileDirectory, ".c2c-profile-owner.json"), JSON.stringify({ ...owner, version: 1, ownerSid: "owner", profileDirectory }));
    fs.writeFileSync(path.join(profileDirectory, "DevToolsActivePort"), "9222\n/devtools/browser/first\n");
    metadata = { sid: "owner", privateAcl: true, roots: [42], listeners: [{ address: "127.0.0.1", port: 9222, pid: 42 }] };
    vi.mocked(childProcess.execFile).mockImplementation(((_file: string, _args: string[], _options: unknown, callback: Function) => {
      const input = new PassThrough(); input.on("finish", () => callback(null, JSON.stringify(metadata), ""));
      return { stdin: input };
    }) as any);
    vi.mocked(childProcess.spawn).mockReset();
    await configureCdpProfile(profile);
  });
  afterEach(() => { vi.unstubAllEnvs(); cleanup(stateDir); delete process.env.C2C_STATE_DIR; });

  it("persists only profile configuration and reads the current endpoint for each controller", async () => {
    expect(JSON.parse(fs.readFileSync(stateFile("cdp", `${owner.hubId}.json`), "utf8"))).toEqual(profile);
    await expect(resolveCdpEndpoint(owner)).resolves.toBe("ws://127.0.0.1:9222/devtools/browser/first");
    fs.writeFileSync(path.join(profile.profileDirectory, "DevToolsActivePort"), "9333\n/devtools/browser/second\n");
    metadata.listeners[0].port = 9333;
    await expect(resolveCdpEndpoint(owner)).resolves.toBe("ws://127.0.0.1:9333/devtools/browser/second");
    expect(childProcess.spawn).not.toHaveBeenCalled(); expect(process.env.C2C_CDP_ENDPOINT).toBe("");
  });

  it("does not inherit incompatible host module paths into inbox PowerShell", async () => {
    vi.stubEnv("PSModulePath", "host-specific-modules");
    await resolveCdpEndpoint(owner);
    const options = vi.mocked(childProcess.execFile).mock.calls.at(-1)![2] as any;
    expect(Object.keys(options.env).some(key => key.toLowerCase() === "psmodulepath")).toBe(false);
  });

  it("starts a stopped owned profile and waits for its endpoint file event without polling", async () => {
    metadata.roots = []; metadata.listeners = [];
    vi.mocked(childProcess.spawn).mockImplementation((() => {
      const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
      queueMicrotask(() => {
        metadata.roots = [42]; metadata.listeners = [{ address: "127.0.0.1", port: 9444, pid: 42 }];
        fs.writeFileSync(path.join(profile.profileDirectory, "DevToolsActivePort"), "9444\n/devtools/browser/started\n");
      });
      return child;
    }) as any);
    await expect(resolveCdpEndpoint(owner)).resolves.toBe("ws://127.0.0.1:9444/devtools/browser/started");
    expect(childProcess.spawn).toHaveBeenCalledExactlyOnceWith(profile.executable,
      [`--user-data-dir=${profile.profileDirectory}`, "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", "about:blank"],
      { stdio: "ignore", detached: true, windowsHide: true });
  });

  it.each(["wrong workspace", "owner marker", "public listener", "busy profile"])("fails closed before launching for %s", async phase => {
    if (phase === "owner marker") fs.unlinkSync(path.join(profile.profileDirectory, ".c2c-profile-owner.json"));
    if (phase === "public listener") metadata.listeners[0].address = "0.0.0.0";
    if (phase === "busy profile") metadata.roots.push(43);
    await expect(resolveCdpEndpoint(phase === "wrong workspace" ? { ...owner, workspaceId: "ffffffffffff" } : owner)).rejects.toHaveProperty("delivery", "not_sent");
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it("aborts startup without another launch, target or send", async () => {
    metadata.roots = []; metadata.listeners = [];
    const abort = new AbortController();
    vi.mocked(childProcess.spawn).mockImplementation((() => {
      queueMicrotask(() => abort.abort());
      return Object.assign(new EventEmitter(), { unref: vi.fn() });
    }) as any);
    await expect(resolveCdpEndpoint(owner, abort.signal)).rejects.toMatchObject({ message: "ASYNC_INTERRUPTED", delivery: "not_sent" });
    expect(childProcess.spawn).toHaveBeenCalledTimes(1);
  });
});
