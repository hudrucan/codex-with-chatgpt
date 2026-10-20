import { fixtureHub, fixtureWorkspace } from "../helpers.js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge, type Bridge } from "../../src/bridge/server.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { nullLogger } from "../../src/logger/index.js";
import { WorkspaceRegistry } from "../../src/workspace/registry.js";
import { cleanup, isolateStateDir, makeGitRepo, makeTmpDir, write } from "../helpers.js";

let state: string;
let root: string;
let bridge: Bridge | undefined;
let client: Client | undefined;
const ownershipDirectories = ["hubs", "workspace-registries"];
const workspaceCalls = [
  ["workspace_info", {}], ["list_directory", {}], ["read_file", { path: "hello.txt" }],
  ["read_image", { path: "pixel.png" }], ["search_workspace", { query: "Hello" }],
  ["git_status", {}], ["git_diff", {}],
] as const;

beforeEach(() => { state = isolateStateDir(); root = makeTmpDir("mcp-hub-context"); });
afterEach(async () => {
  await client?.close();
  await bridge?.close();
  client = undefined;
  bridge = undefined;
  [root, state].forEach(cleanup);
  delete process.env.C2C_STATE_DIR;
});

// Include directory timestamps to detect even transient lock/temp-file writes.
function ownershipSnapshot(): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const visit = (relative: string): void => {
    const file = path.join(state, relative);
    if (!fs.existsSync(file)) { result[relative] = null; return; }
    const stat = fs.statSync(file, { bigint: true });
    result[relative] = {
      mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs),
      ...(stat.isFile() ? { content: fs.readFileSync(file, "base64") } : {}),
    };
    if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.join(relative, name));
  };
  ownershipDirectories.forEach(visit);
  return result;
}

async function start(): Promise<void> {
  makeGitRepo(root);
  fs.writeFileSync(path.join(root, "pixel.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  bridge = await startBridge({ hubId: fixtureHub(root).hubId, port: 0, persistRuntime: false });
}

async function connect(): Promise<void> {
  const token = bridge!.authStore.issueTokens({ clientId: "hub-context", scopes: ["workspace.read", "workspace.search", "git.read"] }).accessToken;
  client = new Client({ name: "hub-context", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${bridge!.localBaseUrl()}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client!.callTool({ name, arguments: args });
  return { result, data: JSON.parse((result.content as { text: string }[])[0].text) };
}

async function expectWorkspaceReads(): Promise<void> {
  expect((await client!.listTools()).tools).toHaveLength(8);
  expect((await call("list_workspaces")).data.workspaces).toHaveLength(1);
  for (const [name, args] of workspaceCalls) {
    const { result, data } = await call(name, args);
    expect(result.isError ?? false, `${name}: ${JSON.stringify(data)}`).toBe(false);
    if (name === "workspace_info") expect(data.workspaceId).toBe(fixtureWorkspace(bridge!).id);
    if (name === "read_file") expect(data.content).toContain("Hello from Codex with ChatGPT");
  }
}

describe("MCP uses the Hub resolved at startup", () => {
  it("requires an explicit matching Hub context without creating ownership state", async () => {
    const hubId = `hub-${randomUUID()}`;
    const registry = new WorkspaceRegistry(hubId);
    const before = ownershipSnapshot();
    expect(() => createMcpServer({ hubId: `hub-${randomUUID()}`, registry, logger: nullLogger }))
      .toThrow(expect.objectContaining({ code: "INVALID_WORKSPACE_OWNER" }));
    const server = createMcpServer({ hubId, registry, logger: nullLogger });
    await server.close();
    expect(ownershipSnapshot()).toEqual(before);
    expect(fs.readdirSync(state)).toEqual([]);
  });

  it.each(["locked", "malformed"])("serves all tools without scanning or mutating %s Hub identity state", async (kind) => {
    await start();
    if (kind === "locked") write(state, "hubs/.lock", "control-plane-operation");
    if (kind === "malformed") write(state, "hubs/unrelated.json", "{malformed control-plane state");
    const before = ownershipSnapshot();
    await connect();
    await expectWorkspaceReads();
    expect(ownershipSnapshot()).toEqual(before);
  });

  it("does not recreate missing Hub or registry ownership state", async () => {
    await start();
    for (const directory of ownershipDirectories) fs.rmSync(path.join(state, directory), { recursive: true, force: true });
    const before = ownershipSnapshot();
    await connect();
    expect((await call("list_workspaces")).data).toEqual({ workspaces: [] });
    for (const [name, args] of workspaceCalls) {
      const { result, data } = await call(name, args);
      expect(result.isError, name).toBe(true);
      expect(data.error, name).toBe("WORKSPACE_NOT_FOUND");
    }
    expect(ownershipSnapshot()).toEqual(before);
  });
});
