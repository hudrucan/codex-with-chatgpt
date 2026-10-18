import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createHub } from "../../src/hub/store.js";
import { WorkspaceRegistry } from "../../src/workspace/registry.js";
import { saveWorkspaceDisplayName } from "../../src/config/naming.js";
import { writeLastEndpoint, readLastEndpoint } from "../../src/config/endpoint.js";
import { bindProject, projectInstructions, projectStatus, unbindProject } from "../../src/project/bindings.js";
import { destroyHub, lifecycleFile } from "../../src/lifecycle/hub.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "../helpers.js";

const projectUrl = "https://chatgpt.com/g/g-p-6ad414a9a390819194cd6a676854de21-desk-home/project";
let state: string, root: string, hubId: string, workspaceId: string, registry: WorkspaceRegistry;
beforeEach(() => {
  state = isolateStateDir(); root = makeTmpDir("project-repo");
  hubId = createHub("Desk").hubId; registry = new WorkspaceRegistry(hubId);
  workspaceId = registry.add(root, "backend").workspaceId;
  verifiedEndpoint(hubId);
});
afterEach(() => { [state, root].forEach(cleanup); delete process.env.C2C_STATE_DIR; });
function verifiedEndpoint(id: string) {
  writeLastEndpoint({ hubId: id, port: 48765, publicUrl: "https://code.example.com", mcpUrl: "https://code.example.com/mcp",
    desiredConnectorName: "Desk C2C Hub · Foundation", connectorName: "Desk C2C Hub · Foundation",
    boundMcpUrl: "https://code.example.com/mcp", bindingVersion: 1, connectorId: "connector_verified" });
}
function file(id = hubId) { return path.join(state, "project-bindings", id, `${workspaceId}.json`); }
function acknowledge() { return bindProject(hubId, "backend", projectUrl, projectInstructions(hubId, workspaceId).instructionHash); }

it("generates deterministic instructions and acknowledges only the current verified hash", () => {
  expect(projectStatus(hubId, "backend")).toMatchObject({ status: "unbound", binding: null, projectVerification: "not_checked" });
  expect(fs.existsSync(path.dirname(file()))).toBe(false);
  const intended = projectInstructions(hubId, "backend");
  expect(projectInstructions(hubId, workspaceId)).toEqual(intended);
  expect(intended.instructionHash).toBe(createHash("sha256").update(intended.instructions).digest("hex"));
  expect(intended.instructions.split("\n")[0]).toBe("--- BEGIN DESK C2C HUB WORKSPACE BINDING ---");
  expect(intended.instructions.split("\n").at(-1)).toBe("--- END DESK C2C HUB WORKSPACE BINDING ---");
  expect(intended.instructions).toContain(`workspace_info(workspace="${workspaceId}")`);
  expect(intended.instructions).toContain('For every workspace-scoped MCP tool, use workspace="' + workspaceId + '".');
  expect(() => bindProject(hubId, "backend", projectUrl, "0".repeat(64))).toThrow("PROJECT_INSTRUCTIONS_CHANGED");
  expect(fs.existsSync(file())).toBe(false);
  const binding = acknowledge();
  expect(JSON.parse(fs.readFileSync(file(), "utf8"))).toEqual(binding);
  expect(Object.keys(binding).sort()).toEqual(["version", "hubId", "workspaceId", "projectUrl", "instructionVersion", "appliedInstructionHash", "updatedAt"].sort());
  expect(projectStatus(hubId, "backend")).toMatchObject({ status: "current", binding, projectVerification: "not_checked" });
  expect(bindProject(hubId, workspaceId, projectUrl.replace("desk-home", "renamed-project"), intended.instructionHash))
    .toMatchObject({ hubId, workspaceId, appliedInstructionHash: intended.instructionHash });
  unbindProject(hubId, "backend");
  expect(projectStatus(hubId, workspaceId).status).toBe("unbound");
});

it.each(["same Hub", "another Hub"])("refuses assigning the same Project identity to a second workspace in %s", scope => {
  const original = acknowledge(), before = fs.readFileSync(file());
  const targetHub = scope === "same Hub" ? hubId : createHub("Other").hubId;
  if (targetHub !== hubId) verifiedEndpoint(targetHub);
  const extra = path.join(root, "another-repo"); fs.mkdirSync(extra);
  const target = new WorkspaceRegistry(targetHub).add(extra, "other");
  const hash = projectInstructions(targetHub, target.workspaceId).instructionHash;
  for (const url of [projectUrl, projectUrl.replace("desk-home", "different-title-and-slug")]) {
    expect(() => bindProject(targetHub, target.workspaceId, url, hash)).toThrow("PROJECT_BINDING_CONFLICT");
  }
  expect(fs.readFileSync(file())).toEqual(before);
  expect(projectStatus(targetHub, target.workspaceId).status).toBe("unbound");
  expect(projectStatus(hubId, workspaceId).binding).toEqual(original);
});

it("blocks direct mutation during pending destroy while keeping diagnostics available", async () => {
  const binding = acknowledge(), before = fs.readFileSync(file());
  const { plan } = await destroyHub(hubId);
  write(state, `lifecycle/${hubId}.json`, JSON.stringify({ version: 1, hubId, plan,
    accessStopped: false, connectorRemoved: true, desiredConnectorAbsent: false, dnsRemoved: false, tunnelRemoved: false, localCleanup: false }));
  expect(() => bindProject(hubId, workspaceId, projectUrl, binding.appliedInstructionHash)).toThrow("DESTROY_PENDING");
  expect(() => unbindProject(hubId, workspaceId)).toThrow("DESTROY_PENDING");
  expect(projectStatus(hubId, workspaceId).status).toBe("current");
  expect(projectInstructions(hubId, workspaceId).instructionHash).toBe(binding.appliedInstructionHash);
  expect(fs.readFileSync(file())).toEqual(before);
  expect(fs.existsSync(lifecycleFile(hubId))).toBe(true);
});

it("keeps instructions current through runtime restarts, port changes and restoration of the same MCP URL", () => {
  acknowledge();
  const before = projectInstructions(hubId, workspaceId);
  write(state, `runtime/${hubId}.json`, JSON.stringify({ hubId, pid: 12345, port: 1234, startedAt: new Date().toISOString() }));
  writeLastEndpoint({ ...readLastEndpoint(hubId)!, port: 54321, savedAt: new Date().toISOString(), publicUrl: "https://code.example.com",
    mcpUrl: "https://CODE.example.com/mcp/", boundMcpUrl: "https://CODE.example.com/mcp/" });
  expect(projectInstructions(hubId, workspaceId)).toEqual(before);
  expect(projectStatus(hubId, workspaceId).status).toBe("current");
});

it.each(["alias", "display name", "connector name", "connector ID", "MCP URL", "instruction version"])("requires explicit sync when %s changes", change => {
  const binding = acknowledge();
  if (change === "alias") registry.add(root, "api");
  else if (change === "display name") saveWorkspaceDisplayName(registry.resolve(workspaceId), "Backend API");
  else if (change === "instruction version") {
    write(state, `project-bindings/${hubId}/${workspaceId}.json`, JSON.stringify({ ...binding, instructionVersion: 2 }));
  } else {
    const endpoint = readLastEndpoint(hubId)!;
    writeLastEndpoint({ ...endpoint,
      ...(change === "connector name" ? { connectorName: "Renamed connector", desiredConnectorName: "Renamed connector" } : {}),
      ...(change === "connector ID" ? { connectorId: "connector_other_verified" } : {}),
      ...(change === "MCP URL" ? { mcpUrl: "https://new.example.com/mcp", boundMcpUrl: "https://new.example.com/mcp", publicUrl: "https://new.example.com" } : {}),
    });
  }
  expect(projectStatus(hubId, workspaceId).status).toBe("sync_required");
  if (change !== "instruction version") {
    expect(() => bindProject(hubId, workspaceId, projectUrl, binding.appliedInstructionHash)).toThrow("PROJECT_INSTRUCTIONS_CHANGED");
  }
  bindProject(hubId, workspaceId, projectUrl, projectInstructions(hubId, workspaceId).instructionHash);
  expect(projectStatus(hubId, workspaceId).status).toBe("current");
});

it("reports missing/unregistered roots as stale and permits explicit local unbind by ID", () => {
  acknowledge(); cleanup(root);
  expect(projectStatus(hubId, workspaceId)).toMatchObject({ status: "stale", reason: "WORKSPACE_UNAVAILABLE" });
  registry.remove(workspaceId);
  expect(projectStatus(hubId, workspaceId)).toMatchObject({ status: "stale", reason: "WORKSPACE_NOT_REGISTERED", binding: { projectUrl } });
  expect(() => projectInstructions(hubId, workspaceId)).toThrow("PROJECT_BINDING_STALE");
  expect(() => bindProject(hubId, workspaceId, projectUrl, "0".repeat(64))).toThrow("PROJECT_BINDING_STALE");
  expect(fs.existsSync(file())).toBe(true);
  expect(unbindProject(hubId, workspaceId).unbound).toBe(true);
  expect(fs.existsSync(file())).toBe(false);
});

it("isolates Hubs and rejects foreign ownership, unknown grants and malformed binding state", () => {
  const binding = acknowledge(), other = createHub("Other").hubId;
  verifiedEndpoint(other);
  for (const operation of [projectStatus, projectInstructions]) expect(() => operation(other, workspaceId)).toThrow("WORKSPACE_NOT_FOUND");
  new WorkspaceRegistry(other).add(root, "backend");
  expect(projectStatus(other, workspaceId).status).toBe("unbound");
  for (const invalid of [{ ...binding }, { ...binding, hubId: other, workspaceId: "0123456789ab" }, { ...binding, hubId: other, session: "forbidden" }]) {
    write(state, `project-bindings/${other}/${workspaceId}.json`, JSON.stringify(invalid));
    expect(() => projectStatus(other, workspaceId)).toThrow("PROJECT_BINDING_INVALID");
    expect(() => bindProject(other, workspaceId, projectUrl, binding.appliedInstructionHash)).toThrow("PROJECT_BINDING_INVALID");
    expect(() => unbindProject(other, workspaceId)).toThrow("PROJECT_BINDING_INVALID");
    expect(() => bindProject(hubId, workspaceId, projectUrl, binding.appliedInstructionHash)).toThrow("PROJECT_BINDING_INVALID");
  }
  expect(projectStatus(hubId, workspaceId)).toMatchObject({ status: "current", binding });
  expect(() => projectStatus("hub-550e8400-e29b-41d4-a716-446655440000", workspaceId)).toThrow("HUB_NOT_CONFIGURED");
});

it("fails closed until the Hub connector's exact binding is verified", () => {
  acknowledge();
  const endpoint = readLastEndpoint(hubId)!;
  for (const patch of [{ desiredConnectorName: "Unverified rename" }, { mcpUrl: "https://changed.example.com/mcp" }, { connectorId: undefined }, { mcpUrl: null }]) {
    writeLastEndpoint({ ...endpoint, ...patch });
    expect(projectStatus(hubId, workspaceId)).toMatchObject({ status: "stale", reason: "PROJECT_CONNECTOR_UNVERIFIED" });
    expect(() => projectInstructions(hubId, workspaceId)).toThrow("PROJECT_CONNECTOR_UNVERIFIED");
  }
});

it("rejects non-Project URLs without overwriting an acknowledged binding", () => {
  const binding = acknowledge();
  for (const url of ["http://chatgpt.com/g/g-p-6ad414a9a390819194cd6a676854de21-desk-home/project", "https://chatgpt.com/c/chat", projectUrl.replace("/project", "/c/chat"),
    projectUrl.replace("chatgpt.com", "chatgpt.com.evil.example"), projectUrl + "?token=secret", projectUrl + "#chat", projectUrl.replace("https://", "https://user@"), "https://chatgpt.com/g/example/project"]) {
    expect(() => bindProject(hubId, workspaceId, url, binding.appliedInstructionHash)).toThrow("INVALID_PROJECT_URL");
  }
  expect(projectStatus(hubId, workspaceId).binding).toEqual(binding);
});

it("refuses symlinks at either binding path level before reading, replacing or deleting", () => {
  const binding = acknowledge(), target = write(state, "outside.json", JSON.stringify(binding));
  fs.rmSync(file()); fs.symlinkSync(target, file());
  expect(() => projectStatus(hubId, workspaceId)).toThrow(/symlink/);
  expect(() => unbindProject(hubId, workspaceId)).toThrow(/symlink/);
  fs.rmSync(file()); fs.rmdirSync(path.dirname(file()));
  fs.symlinkSync(root, path.dirname(file()), "dir");
  expect(() => bindProject(hubId, workspaceId, projectUrl, binding.appliedInstructionHash)).toThrow(/symlink/);
  expect(fs.readFileSync(target, "utf8")).toBe(JSON.stringify(binding));
});
