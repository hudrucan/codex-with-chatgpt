import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { runtimeFile, writeRuntimeState } from "../../src/bridge/runtime.js";
import * as permissions from "../../src/config/windows-permissions.js";
import { SERVICE_NAME, VERSION } from "../../src/version.js";
import { cleanup, makeTmpDir } from "../helpers.js";

let state: string | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  if (state) cleanup(state);
  delete process.env.C2C_STATE_DIR;
});
const runtime = {
  stateVersion: 1 as const, hubId: "hub-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  service: SERVICE_NAME, version: VERSION, pid: process.pid, port: 12345,
  adminToken: "fixture-secret", publicUrl: null, startedAt: new Date().toISOString(),
};

it.runIf(process.platform === "win32")("publishes and replaces a runtime bearer with a native protected owner-only DACL", () => {
  state = makeTmpDir("runtime ACL Unicode 🪟"); process.env.C2C_STATE_DIR = state;
  for (const adminToken of ["first-fixture-secret", "replacement-fixture-secret"]) {
    writeRuntimeState({ ...runtime, adminToken });
    const file = runtimeFile(runtime.hubId);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).adminToken).toBe(adminToken);
    const script = `
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
$acl = [IO.File]::GetAccessControl([Console]::In.ReadToEnd())
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
$owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Equals($sid)
$private = $rules.Count -eq 1 -and $rules[0].IdentityReference.Equals($sid) -and
  $rules[0].AccessControlType -eq 'Allow' -and $rules[0].FileSystemRights -eq 'FullControl'
[Console]::Out.WriteLine("$($acl.AreAccessRulesProtected),$owner,$private")
`;
    const inspected = spawnSync(path.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { input: file, encoding: "utf8", windowsHide: true, timeout: 10_000 });
    expect(inspected.status, inspected.stderr).toBe(0);
    expect(inspected.stdout.trim()).toBe("True,True,True");
    expect(fs.readdirSync(path.dirname(file))).toEqual([path.basename(file)]);
  }
});

it.runIf(process.platform === "win32")("retains previous runtime state and writes no bearer when native ACL creation fails", () => {
  state = makeTmpDir("runtime ACL failure"); process.env.C2C_STATE_DIR = state;
  const file = runtimeFile(runtime.hubId);
  fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, "previous runtime bytes");
  vi.spyOn(permissions, "createPrivateWindowsFile").mockImplementation(() => { throw new Error("STATE_ACL_UNAVAILABLE"); });
  expect(() => writeRuntimeState(runtime)).toThrow("STATE_ACL_UNAVAILABLE");
  expect(fs.readFileSync(file, "utf8")).toBe("previous runtime bytes");
  expect(fs.readdirSync(path.dirname(file))).toEqual([path.basename(file)]);
});

it.runIf(process.platform === "win32")("native ACL creation refuses an existing file without adopting or overwriting it", () => {
  state = makeTmpDir("runtime ACL conflict");
  const file = path.join(state, "existing.json"); fs.writeFileSync(file, "existing owner bytes");
  expect(() => permissions.createPrivateWindowsFile(file)).toThrow("STATE_ACL_UNAVAILABLE");
  expect(fs.readFileSync(file, "utf8")).toBe("existing owner bytes");
});
