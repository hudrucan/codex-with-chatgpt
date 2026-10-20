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

it("previews/adds/syncs/removes memberships in the selected Project without touching other Projects or connection state", async () => {
  const state = isolateStateDir(), root = makeTmpDir("project-cli"), secondRoot = makeTmpDir("second-project-cli"), hub = createHub("Demo Hub");
  const registry = new WorkspaceRegistry(hub.hubId), first = registry.add(root, "frontend"), second = registry.add(secondRoot, "backend");
  const a = "https://chatgpt.com/g/g-p-6ad414a9a390819194cd6a676854de21-project-a/project";
  const b = "https://chatgpt.com/g/g-p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-project-b/project";
  writeLastEndpoint({ hubId: hub.hubId, port: 48765, publicUrl: "https://code.example.com", mcpUrl: "https://code.example.com/mcp",
    connectorName: "Demo Hub", desiredConnectorName: "Demo Hub", connectorId: "connector_verified", boundMcpUrl: "https://code.example.com/mcp", bindingVersion: 1 });
  const immutable = ["auth", "hubs", "tunnels", "endpoints", "workspace-registries"].map(dir => {
    const file = path.join(state, dir, `${hub.hubId}.json`); return { file, bytes: fs.readFileSync(file) };
  });
  const entry = fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url));
  const run = (args: string[], url = a) => spawnSync(process.execPath, ["--import", "tsx", entry, "project", ...args, "--project-url", url, "--json"], {
    env: { ...process.env, C2C_STATE_DIR: state }, cwd: root, encoding: "utf8", timeout: 10000,
  });
  const json = (args: string[], url = a) => { const result = run(args, url); expect(result.status, result.stdout + result.stderr).toBe(0); return JSON.parse(result.stdout); };
  try {
    expect(json(["status"]).status).toBe("unbound");
    const initial = json(["instructions", "--workspace", "frontend"]);
    expect(initial.repositories[0].workspaceId).toBe(first.workspaceId);
    json(["bind", "--workspace", "frontend", "--instruction-hash", initial.instructionHash]);
    const addition = json(["instructions", "--workspace", "backend"]);
    expect(addition.repositories).toHaveLength(2);
    expect(json(["status"]).binding.workspaceIds).toEqual([first.workspaceId]);
    json(["bind", "--workspace", "backend", "--instruction-hash", addition.instructionHash]);
    const other = json(["instructions", "--workspace", "backend"], b);
    json(["bind", "--workspace", "backend", "--instruction-hash", other.instructionHash], b);
    createHub("Other");
    const ambiguous = run(["status"]); expect(ambiguous.status).toBe(1); expect(JSON.parse(ambiguous.stdout).error).toContain("HUB_SELECTION_REQUIRED");
    const selected = ["--hub", hub.hubId];
    json(["unbind", "--workspace", "backend", ...selected]);
    expect(json(["status", ...selected]).status).toBe("sync_required");
    expect(json(["status", ...selected], b)).toMatchObject({ status: "current", binding: { workspaceIds: [second.workspaceId] } });
    const remaining = json(["instructions", ...selected]);
    json(["bind", "--instruction-hash", remaining.instructionHash, ...selected]);
    const { plan } = await destroyHub(hub.hubId);
    writeSecureJson(lifecycleFile(hub.hubId), { version: 1, hubId: hub.hubId, plan,
      accessStopped: false, connectorRemoved: true, desiredConnectorAbsent: false, dnsRemoved: false, tunnelRemoved: false, localCleanup: false });
    for (const args of [["unbind", "--workspace", "frontend"], ["bind", "--instruction-hash", remaining.instructionHash]]) {
      const result = run([...args, ...selected]); expect(result.status).toBe(1); expect(JSON.parse(result.stdout).error).toContain("DESTROY_PENDING");
    }
    expect(json(["status", ...selected]).status).toBe("current");
    expect(json(["instructions", ...selected]).instructionHash).toBe(remaining.instructionHash);
    for (const item of immutable) expect(fs.readFileSync(item.file)).toEqual(item.bytes);
    expect(fs.existsSync(path.join(state, "runtime"))).toBe(false); expect(fs.readdirSync(root)).toEqual([]);
  } finally { [state, root, secondRoot].forEach(cleanup); delete process.env.C2C_STATE_DIR; }
});
