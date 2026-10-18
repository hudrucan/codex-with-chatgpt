import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { WorkspaceRegistry, type WorkspaceRegistration } from "../src/workspace/registry.js";
import { cleanup, git, isolateStateDir, makeGitRepo, makeTmpDir, write } from "./helpers.js";

let state: string;
let root: string;
let other: string;
let bridge: Bridge;
let client: Client;
let registry: WorkspaceRegistry;
let primary: WorkspaceRegistration;
let secondary: WorkspaceRegistration;
const calls = [
  ["workspace_info", {}],
  ["list_directory", {}],
  ["read_file", { path: "hello.txt" }],
  ["read_image", { path: "pixel.png" }],
  ["search_workspace", { query: "repo-marker" }],
  ["git_status", {}],
  ["git_diff", {}],
] as const;

async function call(name: string, args: Record<string, unknown> = {}, activeClient = client) {
  const result = await activeClient.callTool({ name, arguments: args });
  const data = JSON.parse((result.content as { text: string }[])[0].text);
  return { result, data };
}

async function connect(scopes: string[]): Promise<Client> {
  const token = bridge.authStore.issueTokens({ clientId: "multi-repo-test", scopes }).accessToken;
  const next = new Client({ name: "multi-repo-test", version: "1.0.0" });
  await next.connect(new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  return next;
}

beforeAll(async () => {
  state = isolateStateDir();
  root = makeTmpDir("multi-primary");
  other = makeTmpDir("multi-secondary");
  for (const [dir, marker] of [[root, "primary"], [other, "secondary"]]) {
    makeGitRepo(dir);
    write(dir, "hello.txt", `${marker} repo-marker\n`);
    write(dir, ".env", `${marker}-secret\n`);
    fs.writeFileSync(path.join(dir, "pixel.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  git(other, "checkout", "-b", "secondary-branch");
  // Deliberately track a secret to verify per-repo git filtering as well.
  git(other, "add", "-f", ".env");
  fs.symlinkSync(root, path.join(other, "escape"), "junction");
  bridge = await startBridge({ workspaceRoot: root, port: 0, persistRuntime: false });
  registry = new WorkspaceRegistry(bridge.workspace.id);
  primary = registry.list()[0];
  client = await connect(["workspace.read", "workspace.search", "git.read"]);
});
afterAll(async () => {
  await client?.close();
  await bridge?.close();
  for (const dir of [state, root, other]) cleanup(dir);
  delete process.env.C2C_STATE_DIR;
});

describe("multiple workspaces through one existing MCP connection", () => {
  it("automatically registers the bridge root and preserves single-repo calls", async () => {
    expect(primary.root).toBe(root);
    expect((await call("workspace_info")).data.workspaceId).toBe(bridge.workspace.id);
    const { result, data } = await call("list_workspaces");
    expect(result.structuredContent).toEqual(data);
    expect(data).toEqual({ workspaces: [{ workspaceId: primary.workspaceId, alias: primary.alias }] });
    expect(JSON.stringify(data)).not.toContain(root);
  });

  it("adds optional string selectors to all seven tool schemas without changing scope requirements", async () => {
    const { tools } = await client.listTools();
    for (const [name] of calls) {
      const tool = tools.find((tool) => tool.name === name)!;
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.inputSchema.properties?.workspace).toMatchObject({ type: "string" });
      expect(tool.inputSchema.required ?? []).not.toContain("workspace");
    }
    const limited = await connect(["git.read"]);
    try {
      expect((await call("list_workspaces", {}, limited)).data.error).toBe("INSUFFICIENT_SCOPE");
      expect((await call("workspace_info", {}, limited)).data.error).toBe("INSUFFICIENT_SCOPE");
    } finally { await limited.close(); }
  });

  it("sees new registrations on the running connection and requires selectors on every tool", async () => {
    secondary = registry.add(other, "secondary");
    const choices = registry.choices();
    expect((await call("list_workspaces")).data).toEqual({ workspaces: choices });
    for (const [name, args] of calls) {
      const { result, data } = await call(name, args);
      expect(result.isError, name).toBe(true);
      expect(data).toEqual({ error: "WORKSPACE_REQUIRED", message: expect.any(String), workspaces: choices });
      expect(JSON.stringify(data)).not.toContain(root);
      expect(JSON.stringify(data)).not.toContain(other);
    }
  });

  it("routes all seven tools by alias and ID and keeps output schemas compatible", async () => {
    for (const selector of [secondary.alias, secondary.workspaceId]) {
      for (const [name, args] of calls) {
        const { result, data } = await call(name, { ...args, workspace: selector });
        expect(result.isError ?? false, `${name}: ${JSON.stringify(data)}`).toBe(false);
        expect(result.structuredContent).toEqual(data);
        if (name === "workspace_info") expect(data.workspaceId).toBe(secondary.workspaceId);
        if (name === "list_directory") expect(data.entries).toContainEqual(expect.objectContaining({ path: "hello.txt" }));
        if (name === "read_file") expect(data.content).toBe("secondary repo-marker");
        if (name === "read_image") expect(result.content).toContainEqual(expect.objectContaining({ type: "image", mimeType: "image/png" }));
        if (name === "search_workspace") expect(data.matches).toContainEqual(expect.objectContaining({ path: "hello.txt", text: "secondary repo-marker" }));
        if (name === "git_status") {
          expect(data.branch).toBe("secondary-branch");
          expect(JSON.stringify(data)).not.toContain(".env");
        }
        if (name === "git_diff") expect(data.diff).toContain("secondary repo-marker");
      }
    }
  });

  it("selects independently for concurrent calls without a current-workspace fallback", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => call("read_file", {
      workspace: index % 2 ? secondary.alias : primary.workspaceId, path: "hello.txt",
    })));
    results.forEach(({ data }, index) => expect(data.content).toBe(`${index % 2 ? "secondary" : "primary"} repo-marker`));
    expect((await call("read_file", { path: "hello.txt" })).data.error).toBe("WORKSPACE_REQUIRED");
  });

  it("rejects unregistered selectors on all tools and preserves containment/sensitive/git policies", async () => {
    for (const [name, args] of calls) {
      for (const selector of [other, "../", "unknown"]) {
        expect((await call(name, { ...args, workspace: selector })).data.error).toBe("WORKSPACE_NOT_FOUND");
      }
    }
    for (const [name, args] of [
      ["read_file", { path: ".env" }], ["read_image", { path: ".env" }],
      ["list_directory", { path: ".env" }], ["search_workspace", { query: "secret", path: ".env" }],
      ["git_diff", { path: ".env" }],
    ] as const) {
      expect((await call(name, { ...args, workspace: secondary.alias })).data.error).toBe("ACCESS_DENIED_SENSITIVE_FILE");
    }
    for (const name of ["read_file", "list_directory", "read_image", "search_workspace", "git_diff"]) {
      const args = { workspace: secondary.alias, query: "repo-marker", path: "escape/hello.txt" };
      expect((await call(name, args)).data.error).toBe("PATH_OUTSIDE_WORKSPACE");
    }
    expect(JSON.stringify((await call("search_workspace", { workspace: secondary.alias, query: "secret" })).data)).not.toContain("secondary-secret");
    expect((await call("git_diff", { workspace: secondary.alias, mode: "staged" })).data.diff).not.toContain("secondary-secret");
    // Refresh policies per call, including changes made after registration.
    write(other, ".c2cignore", "private.txt\n");
    write(other, "private.txt", "hidden marker\n");
    expect(JSON.stringify((await call("list_directory", { workspace: secondary.alias })).data)).not.toContain("private.txt");
  });

  it("observes removals immediately and does not re-register the bridge root on each HTTP call", async () => {
    registry.remove(primary.alias);
    expect((await call("workspace_info")).data.workspaceId).toBe(secondary.workspaceId);
    expect((await call("read_file", { workspace: primary.workspaceId, path: "hello.txt" })).data.error).toBe("WORKSPACE_NOT_FOUND");
    registry.remove(secondary.workspaceId);
    expect((await call("list_workspaces")).data).toEqual({ workspaces: [] });
    expect((await call("workspace_info")).data.error).toBe("WORKSPACE_NOT_FOUND");
    expect(registry.list()).toEqual([]);
  });
});
