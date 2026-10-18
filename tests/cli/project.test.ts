import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createHub } from "../../src/hub/store.js";
import { WorkspaceRegistry } from "../../src/workspace/registry.js";
import { writeLastEndpoint } from "../../src/config/endpoint.js";
import { destroyHub, lifecycleFile } from "../../src/lifecycle/hub.js";
import { writeSecureJson } from "../../src/config/paths.js";
import { cleanup, isolateStateDir, makeTmpDir } from "../helpers.js";

it("exposes Project acknowledgement commands with single/multiple-Hub selection and leaves connection resources unchanged", async () => {
  const state = isolateStateDir(), root = makeTmpDir("project-cli"), hub = createHub("Desk");
  const registration = new WorkspaceRegistry(hub.hubId).add(root, "backend");
  writeLastEndpoint({ hubId: hub.hubId, port: 48765, publicUrl: "https://code.example.com", mcpUrl: "https://code.example.com/mcp",
    connectorName: "Desk", desiredConnectorName: "Desk", connectorId: "connector_verified", boundMcpUrl: "https://code.example.com/mcp", bindingVersion: 1 });
  const immutable = ["auth", "hubs", "tunnels", "endpoints", "workspace-registries"].map(dir => {
    const file = path.join(state, dir, `${hub.hubId}.json`); return { file, bytes: fs.readFileSync(file) };
  });
  const entry = fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url));
  const run = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", entry, "project", ...args, "--json"], {
    env: { ...process.env, C2C_STATE_DIR: state }, cwd: root, encoding: "utf8", timeout: 10000,
  });
  const json = (args: string[]) => { const result = run(args); expect(result.status, result.stdout + result.stderr).toBe(0); return JSON.parse(result.stdout); };
  try {
    expect(json(["status", "--workspace", "backend"]).status).toBe("unbound");
    const instructions = json(["instructions", "--workspace", "backend"]);
    expect(instructions.workspaceId).toBe(registration.workspaceId);
    createHub("Other");
    const ambiguous = run(["status", "--workspace", "backend"]);
    expect(ambiguous.status).toBe(1); expect(JSON.parse(ambiguous.stdout).error).toContain("HUB_SELECTION_REQUIRED");
    expect(json(["bind", "--hub", hub.hubId, "--workspace", "backend", "--project-url", "https://chatgpt.com/g/g-p-6ad414a9a390819194cd6a676854de21-desk-home/project", "--instruction-hash", instructions.instructionHash]).acknowledged).toBe(true);
    expect(json(["--hub", hub.hubId, "status", "--workspace", registration.workspaceId])).toMatchObject({ status: "current", projectVerification: "not_checked" });
    const { plan } = await destroyHub(hub.hubId);
    writeSecureJson(lifecycleFile(hub.hubId), { version: 1, hubId: hub.hubId, plan,
      accessStopped: false, connectorRemoved: true, desiredConnectorAbsent: false, dnsRemoved: false, tunnelRemoved: false, localCleanup: false });
    for (const args of [["unbind"], ["bind", "--project-url", "https://chatgpt.com/g/g-p-6ad414a9a390819194cd6a676854de21-desk-home/project", "--instruction-hash", instructions.instructionHash]]) {
      const result = run([...args, "--hub", hub.hubId, "--workspace", "backend"]);
      expect(result.status).toBe(1); expect(JSON.parse(result.stdout).error).toContain("DESTROY_PENDING");
    }
    expect(json(["status", "--workspace", "backend", "--hub", hub.hubId]).status).toBe("current");
    expect(json(["instructions", "--workspace", "backend", "--hub", hub.hubId]).instructionHash).toBe(instructions.instructionHash);
    fs.rmSync(lifecycleFile(hub.hubId));
    expect(json(["unbind", "--workspace", "backend", "--hub", hub.hubId]).unbound).toBe(true);
    for (const item of immutable) expect(fs.readFileSync(item.file)).toEqual(item.bytes);
    expect(fs.existsSync(path.join(state, "runtime"))).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);
  } finally { [state, root].forEach(cleanup); delete process.env.C2C_STATE_DIR; }
});
