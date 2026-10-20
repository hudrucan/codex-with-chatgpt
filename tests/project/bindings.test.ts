import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createHub } from "../../src/hub/store.js";
import { WorkspaceRegistry } from "../../src/workspace/registry.js";
import { saveWorkspaceDisplayName } from "../../src/config/naming.js";
import { writeLastEndpoint, readLastEndpoint } from "../../src/config/endpoint.js";
import { bindProject, projectInstructions, projectStatus, unbindProject } from "../../src/project/bindings.js";
import { acquireHubLock, destroyHub, lifecycleFile } from "../../src/lifecycle/hub.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "../helpers.js";

const a = "https://chatgpt.com/g/g-p-6ad414a9a390819194cd6a676854de21-project-a/project";
const b = "https://chatgpt.com/g/g-p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-project-b/project";
const c = "https://chatgpt.com/g/g-p-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-project-c/project";
const projectId = (url: string) => url.match(/g-p-[a-f0-9]{32}/)![0];
let state: string, root: string, hubId: string, registry: WorkspaceRegistry;
let frontend: string, backend: string, infra: string;
beforeEach(() => {
  state = isolateStateDir(); root = makeTmpDir("project-repos"); hubId = createHub("Desk").hubId;
  registry = new WorkspaceRegistry(hubId);
  [frontend, backend, infra] = ["frontend", "backend", "infra"].map(name => {
    const dir = path.join(root, name); fs.mkdirSync(dir);
    return registry.add(dir, `${name}-generated-0123456789ab`).workspaceId;
  });
  verifiedEndpoint(hubId);
});
afterEach(() => { [state, root].forEach(cleanup); delete process.env.C2C_STATE_DIR; });
function verifiedEndpoint(id: string, name = "Codex with ChatGPT · Foundation") {
  writeLastEndpoint({ hubId: id, port: 48765, publicUrl: "https://code.example.com", mcpUrl: "https://code.example.com/mcp",
    desiredConnectorName: name, connectorName: name,
    boundMcpUrl: "https://code.example.com/mcp", bindingVersion: 1, connectorId: "connector_verified" });
}
function file(url = a, id = hubId) { return path.join(state, "project-bindings", id, `${projectId(url)}.json`); }
function acknowledge(url = a, workspace?: string) {
  return bindProject(hubId, url, projectInstructions(hubId, url, workspace).instructionHash, workspace);
}

it("supports a single-repo Project with explicit routing, deterministic hash and Project-keyed persistence", () => {
  expect(projectStatus(hubId, a)).toMatchObject({ status: "unbound", binding: null, projectVerification: "not_checked" });
  const preview = projectInstructions(hubId, a, frontend);
  expect(fs.existsSync(path.dirname(file()))).toBe(false);
  expect(preview.instructionHash).toBe(createHash("sha256").update(preview.instructions).digest("hex"));
  expect(preview.instructions).toContain(`- frontend -> workspace="${frontend}"`);
  expect(preview.instructions).toContain("Connector: Codex with ChatGPT · Foundation");
  expect(preview.instructions).toContain("Always use this connector for repositories in this block.");
  expect(preview.instructions.startsWith(`[desk-c2c hub="${hubId}"]\n`)).toBe(true);
  expect(preview.instructions.endsWith(`\n[/desk-c2c hub="${hubId}"]`)).toBe(true);
  for (const hidden of ["connector_verified", "https://code.example.com", "Instruction version:", "frontend-generated-"]) expect(preview.instructions).not.toContain(hidden);
  expect(() => bindProject(hubId, a, "0".repeat(64), frontend)).toThrow("PROJECT_INSTRUCTIONS_CHANGED");
  expect(fs.existsSync(file())).toBe(false);
  const binding = acknowledge(a, frontend);
  expect(binding).toMatchObject({ version: 2, hubId, projectId: projectId(a), workspaceIds: [frontend], instructionVersion: 3 });
  expect(JSON.parse(fs.readFileSync(file(), "utf8"))).toEqual(binding);
  expect(Object.keys(binding).sort()).toEqual(["version", "hubId", "projectId", "projectUrl", "workspaceIds", "instructionVersion", "appliedInstructionHash", "updatedAt"].sort());
  expect(projectStatus(hubId, a).status).toBe("current");
  acknowledge(a.replace("project-a", "renamed"), frontend);
  expect(fs.readdirSync(path.dirname(file()))).toEqual([`${projectId(a)}.json`]);
});

it("supports many-to-many memberships and removes only the selected Project's membership", () => {
  acknowledge(a, frontend); acknowledge(a, backend);
  acknowledge(b, backend); acknowledge(b, infra); acknowledge(c, frontend);
  expect(projectInstructions(hubId, a).repositories.map(repo => repo.name)).toEqual(["backend", "frontend"]);
  expect(projectInstructions(hubId, b).repositories.map(repo => repo.name)).toEqual(["backend", "infra"]);
  expect(projectInstructions(hubId, c).repositories.map(repo => repo.name)).toEqual(["frontend"]);
  const preserved = [b, c].map(url => ({ url, bytes: fs.readFileSync(file(url)) }));
  unbindProject(hubId, a, backend);
  expect(projectInstructions(hubId, a).repositories.map(repo => repo.workspaceId)).toEqual([frontend]);
  expect(projectStatus(hubId, a).status).toBe("sync_required");
  for (const other of preserved) {
    expect(fs.readFileSync(file(other.url))).toEqual(other.bytes);
    expect(projectStatus(hubId, other.url).status).toBe("current");
  }
  acknowledge(a);
  expect(projectStatus(hubId, a).status).toBe("current");
  expect(() => unbindProject(hubId, a, backend)).toThrow("PROJECT_MEMBERSHIP_NOT_FOUND");
});

it("previews additions without writing and orders aggregate routing independently of membership insertion or Project ID", () => {
  acknowledge(a, frontend);
  const before = fs.readFileSync(file()), preview = projectInstructions(hubId, a, backend);
  expect(fs.readFileSync(file())).toEqual(before);
  expect(projectInstructions(hubId, a).repositories).toHaveLength(1);
  acknowledge(a, backend); acknowledge(b, backend); acknowledge(b, frontend);
  expect(projectInstructions(hubId, a).instructions).toBe(preview.instructions);
  expect(projectInstructions(hubId, b).instructionHash).toBe(preview.instructionHash);
  expect(projectInstructions(hubId, a, backend).instructionHash).toBe(preview.instructionHash);
  for (const policy of ["Never omit workspace and never use list_workspaces() to choose a repository.",
    "Choose repositories from the user's request and conversation context.",
    "For cross-repository work, inspect every relevant repository through its block's connector.",
    "If the target connector or repository is ambiguous, ask before reading.", 'workspace_info(workspace="<id>")']) expect(preview.instructions).toContain(policy);
});

it("binds the same Project and root independently across Hubs with separate routing blocks and locks", () => {
  acknowledge(a, frontend);
  const other = createHub("Other").hubId; verifiedEndpoint(other);
  expect(new WorkspaceRegistry(other).add(registry.resolve(frontend).root, "shared").workspaceId).toBe(frontend);
  const own = projectInstructions(hubId, a), sameConnector = projectInstructions(other, a, frontend);
  expect(sameConnector.repositories).toEqual(own.repositories);
  expect(sameConnector.instructionHash).not.toBe(own.instructionHash);
  expect(sameConnector.instructions.replaceAll(other, hubId)).toBe(own.instructions);
  verifiedEndpoint(other, "Codex with ChatGPT · Other");
  const otherPreview = projectInstructions(other, a, frontend), original = fs.readFileSync(file());
  const release = acquireHubLock(hubId);
  try {
    expect(() => acknowledge(a, backend)).toThrow("LIFECYCLE_BUSY");
    expect(() => unbindProject(hubId, a, frontend)).toThrow("LIFECYCLE_BUSY");
    bindProject(other, a, otherPreview.instructionHash, frontend);
  } finally { release(); }
  expect(fs.readFileSync(file())).toEqual(original);
  expect(fs.existsSync(file(a, other))).toBe(true);
  expect(otherPreview.instructions).toContain(`[desk-c2c hub="${other}"]\nConnector: Codex with ChatGPT · Other`);
  expect(otherPreview.instructions).toContain(`[/desk-c2c hub="${other}"]`);
  const renamed = a.replace("project-a", "another-slug");
  bindProject(other, renamed, otherPreview.instructionHash, frontend);
  acknowledge(renamed, frontend);
  for (const owner of [hubId, other]) {
    expect(fs.readdirSync(path.dirname(file(a, owner)))).toEqual([`${projectId(a)}.json`]);
    expect(projectStatus(owner, a)).toMatchObject({ status: "current", binding: { projectId: projectId(a), projectUrl: renamed } });
  }
  const preserved = fs.readFileSync(file(a, other));
  acknowledge(a, backend); unbindProject(hubId, a, frontend); acknowledge(a);
  expect(fs.readFileSync(file(a, other))).toEqual(preserved);
  expect(projectStatus(other, a)).toMatchObject({ status: "current", binding: { workspaceIds: [frontend] } });
});

it("drops unregistered workspaces from routing while retaining explicit stale membership metadata", () => {
  acknowledge(a, frontend); acknowledge(a, backend); acknowledge(b, backend);
  const other = fs.readFileSync(file(b)); registry.remove(backend);
  const preview = projectInstructions(hubId, a);
  expect(preview.repositories.map(repo => repo.workspaceId)).toEqual([frontend]); expect(preview.instructions).not.toContain(backend);
  expect(projectStatus(hubId, a)).toMatchObject({ status: "sync_required", staleWorkspaceIds: [backend] });
  expect(() => projectInstructions(hubId, a, backend)).toThrow("WORKSPACE_NOT_FOUND");
  unbindProject(hubId, a, backend); acknowledge(a);
  expect(projectStatus(hubId, a).status).toBe("current");
  expect(fs.readFileSync(file(b))).toEqual(other);
  expect(projectStatus(hubId, b)).toMatchObject({ status: "sync_required", staleWorkspaceIds: [backend] });
  acknowledge(b);
  expect(projectStatus(hubId, b)).toMatchObject({ status: "stale", reason: "WORKSPACE_NOT_REGISTERED", staleWorkspaceIds: [backend] });
});

it("keeps an empty Project record available for syncing after its final membership is removed", () => {
  acknowledge(a, frontend); unbindProject(hubId, a, frontend);
  expect(projectInstructions(hubId, a).repositories).toEqual([]);
  expect(projectStatus(hubId, a)).toMatchObject({ status: "sync_required", binding: { workspaceIds: [] } });
  acknowledge(a); expect(projectStatus(hubId, a).status).toBe("current");
});

it("ignores alias, connector ID/URL, PID and port changes but requires sync for a verified connector name change", () => {
  acknowledge(a, frontend); const before = projectInstructions(hubId, a);
  registry.add(registry.resolve(frontend).root, "renamed-alias");
  const endpoint = readLastEndpoint(hubId)!;
  writeLastEndpoint({ ...endpoint, connectorId: "another_verified_connector",
    port: 55555, publicUrl: "https://changed.example.com", mcpUrl: "https://changed.example.com/mcp", boundMcpUrl: "https://changed.example.com/mcp" });
  write(state, `runtime/${hubId}.json`, JSON.stringify({ hubId, pid: 1234, port: 55555 }));
  const after = projectInstructions(hubId, a);
  expect(after.instructions).toBe(before.instructions); expect(after.instructionHash).toBe(before.instructionHash);
  expect(after.connector).not.toEqual(before.connector); expect(projectStatus(hubId, a).status).toBe("current");
  writeLastEndpoint({ ...readLastEndpoint(hubId)!, connectorName: "Renamed", desiredConnectorName: "Renamed" });
  const renamed = projectInstructions(hubId, a);
  expect(renamed.instructions).toContain("Connector: Renamed");
  expect(renamed.instructionHash).not.toBe(before.instructionHash);
  expect(projectStatus(hubId, a).status).toBe("sync_required");
  expect(() => bindProject(hubId, a, before.instructionHash)).toThrow("PROJECT_INSTRUCTIONS_CHANGED");
  acknowledge(a); expect(projectStatus(hubId, a).status).toBe("current");
});

it("requires sync for repository label changes and rejects stale acknowledgement hashes", () => {
  const original = acknowledge(a, frontend);
  saveWorkspaceDisplayName(registry.resolve(frontend), "Chosen frontend");
  expect(projectStatus(hubId, a).status).toBe("sync_required");
  expect(() => bindProject(hubId, a, original.appliedInstructionHash)).toThrow("PROJECT_INSTRUCTIONS_CHANGED");
  acknowledge(a); expect(projectStatus(hubId, a).status).toBe("current");
});

it("blocks direct Project mutation during pending destroy while retaining diagnostics", async () => {
  const binding = acknowledge(a, frontend), before = fs.readFileSync(file()), { plan } = await destroyHub(hubId);
  write(state, `lifecycle/${hubId}.json`, JSON.stringify({ version: 1, hubId, plan,
    accessStopped: false, connectorRemoved: true, desiredConnectorAbsent: false, dnsRemoved: false, tunnelRemoved: false, localCleanup: false }));
  expect(() => bindProject(hubId, a, binding.appliedInstructionHash, backend)).toThrow("DESTROY_PENDING");
  expect(() => unbindProject(hubId, a, frontend)).toThrow("DESTROY_PENDING");
  expect(projectStatus(hubId, a).status).toBe("current");
  expect(projectInstructions(hubId, a).instructionHash).toBe(binding.appliedInstructionHash);
  expect(fs.readFileSync(file())).toEqual(before); expect(fs.existsSync(lifecycleFile(hubId))).toBe(true);
});

it("rejects malformed/foreign Project records and unregistered workspace additions without writing", () => {
  const original = acknowledge(a, frontend);
  expect(() => projectInstructions(hubId, b, "0123456789ab")).toThrow("WORKSPACE_NOT_FOUND");
  expect(() => projectInstructions(hubId, b, registry.resolve(frontend).root)).toThrow("WORKSPACE_NOT_FOUND");
  for (const raw of ["{", JSON.stringify({ ...original, hubId: createHub("Foreign").hubId }),
    JSON.stringify({ ...original, projectId: projectId(b) }), JSON.stringify({ ...original, workspaceIds: [frontend, frontend] })]) {
    fs.writeFileSync(file(), raw);
    expect(() => projectStatus(hubId, a)).toThrow("PROJECT_BINDING_INVALID");
    expect(() => bindProject(hubId, a, original.appliedInstructionHash, backend)).toThrow("PROJECT_BINDING_INVALID");
    expect(() => unbindProject(hubId, a, frontend)).toThrow("PROJECT_BINDING_INVALID");
    expect(fs.readFileSync(file(), "utf8")).toBe(raw);
  }
});

it("fails closed on unavailable member roots or unverified connector state", () => {
  acknowledge(a, frontend); const endpoint = readLastEndpoint(hubId)!;
  writeLastEndpoint({ ...endpoint, desiredConnectorName: "Unverified rename" });
  expect(projectStatus(hubId, a)).toMatchObject({ status: "stale", reason: "PROJECT_CONNECTOR_UNVERIFIED" });
  expect(() => projectInstructions(hubId, a)).toThrow("PROJECT_CONNECTOR_UNVERIFIED");
  writeLastEndpoint(endpoint); cleanup(registry.resolve(frontend).root);
  expect(projectStatus(hubId, a)).toMatchObject({ status: "stale", reason: "WORKSPACE_UNAVAILABLE" });
});

it("rejects invalid Project URLs and symlinked binding paths before mutation", () => {
  const binding = acknowledge(a, frontend), before = fs.readFileSync(file());
  for (const url of [a.replace("https:", "http:"), a.replace("/project", "/c/chat"), a + "?secret=none", a + "#chat", a.replace("chatgpt.com", "chatgpt.com.evil.example")]) {
    expect(() => bindProject(hubId, url, binding.appliedInstructionHash, frontend)).toThrow("INVALID_PROJECT_URL");
  }
  expect(fs.readFileSync(file())).toEqual(before);
  const target = write(state, "retained.json", JSON.stringify(binding)); fs.unlinkSync(file()); fs.symlinkSync(target, file());
  expect(() => unbindProject(hubId, a, frontend)).toThrow(/symlink/);
  fs.unlinkSync(file()); fs.rmdirSync(path.dirname(file())); fs.symlinkSync(root, path.dirname(file()), "dir");
  expect(() => bindProject(hubId, a, binding.appliedInstructionHash, frontend)).toThrow(/symlink/);
  expect(fs.readFileSync(target, "utf8")).toBe(JSON.stringify(binding));
});
