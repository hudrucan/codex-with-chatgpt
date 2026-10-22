import { fixtureHub, fixtureWorkspace, fixtureAuthFile } from "../helpers.js";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { WorkspaceRegistry } from "../../src/workspace/registry.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Logger } from "../../src/logger/index.js";
import { AuthStore } from "../../src/auth/store.js";
import { startBridge, type Bridge } from "../../src/bridge/server.js";
import { callGitDiffReady, makeTmpDir, cleanup, write, makeGitRepo, git, isolateStateDir, pkceVerifierAndChallenge } from "../helpers.js";

vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

let root: string;
let bridge: Bridge;
let client: Client;
let accessToken: string;
let stateDir: string;
let authFile: string;

type ToolResponse = Awaited<ReturnType<Client["callTool"]>>;

function textOf(result: ToolResponse): string {
  const content = result.content as { type: string; text: string }[];
  return content?.[0]?.text ?? "";
}

function jsonOf<T = Record<string, unknown>>(result: ToolResponse): T {
  return JSON.parse(textOf(result)) as T;
}

function structuredJsonOf<T = Record<string, unknown>>(result: ToolResponse): T {
  const parsed = jsonOf<T>(result);
  expect(result.structuredContent).toEqual(parsed);
  return parsed;
}

function expectToolOutputSchema(
  tools: Awaited<ReturnType<Client["listTools"]>>["tools"],
  name: string,
  properties: string[]
): void {
  const schema = tools.find((tool) => tool.name === name)?.outputSchema as
    | { type?: string; properties?: Record<string, unknown> }
    | undefined;
  expect(schema?.type).toBe("object");
  expect(Object.keys(schema?.properties ?? {})).toEqual(expect.arrayContaining(properties));
}

beforeAll(async () => {
  stateDir = isolateStateDir();
  root = makeTmpDir("mcp-ws");
  makeGitRepo(root);
  write(root, "package.json", JSON.stringify({ name: "demo", scripts: { test: "vitest run" }, dependencies: { react: "^19.0.0" } }));
  write(root, ".env", "API_KEY=supersecret\n");
  fs.writeFileSync(path.join(root, "pixel.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
  // an uncommitted change so git_diff has content
  write(root, "src/index.ts", "export const answer = 43; // changed\n");

  authFile = path.join(makeTmpDir("auth"), "store.json");
  bridge = await startBridge({
    hubId: fixtureHub(root).hubId,
    port: 0,
    persistRuntime: false,
    logger: new Logger({ file: path.join(stateDir, "mcp-http.log"), console: true, level: "debug" }),
    authStoreFile: fixtureAuthFile(fixtureHub(root).hubId, authFile),
  });
  const tokens = bridge.authStore.issueTokens({
    clientId: "it-client",
    scopes: ["workspace.read", "workspace.search", "git.read"],
  });
  accessToken = tokens.accessToken;

  client = new Client({ name: "c2c-test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  });
  await client.connect(transport);
});

afterAll(async () => {
  await client.close();
  await bridge.close();
  cleanup(root);
  cleanup(stateDir);
  cleanup(path.dirname(authFile));
});

describe("MCP tools over Streamable HTTP", () => {
  it("lists ten read-only bridge tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "git_diff",
      "git_log",
      "git_show",
      "git_status",
      "list_directory",
      "list_workspaces",
      "read_file",
      "read_image",
      "search_workspace",
      "workspace_info",
    ]);
    // Remote access is read-only.
    for (const forbidden of ["write_file", "delete_file", "execute_shell", "git_commit", "install_package"]) {
      expect(names).not.toContain(forbidden);
    }

    expectToolOutputSchema(tools, "workspace_info", ["workspaceId", "workspaceName", "projectType", "git"]);
    expectToolOutputSchema(tools, "list_directory", ["path", "entries", "total", "offset", "limit", "hasMore", "truncated"]);
    expectToolOutputSchema(tools, "read_file", ["path", "content", "startLine", "endLine", "nextStartLine"]);
    expectToolOutputSchema(tools, "read_image", ["path", "sizeBytes", "mimeType"]);
    expectToolOutputSchema(tools, "search_workspace", ["matches", "matchCount", "truncated", "engine"]);
    expectToolOutputSchema(tools, "git_status", ["isRepo", "branch", "staged", "unstaged", "untracked", "hidden"]);
    expectToolOutputSchema(tools, "git_diff", ["isRepo", "mode", "diff", "hasMore", "nextOffset"]);
    expectToolOutputSchema(tools, "git_log", ["commits", "hasMore"]);
    expect(tools.find(tool => tool.name === "git_log")?.outputSchema).toMatchObject({
      properties: { commits: { maxItems: 100, items: {
        required: expect.arrayContaining(["sha", "subject", "subjectTruncated", "date", "paths", "pathsTruncated"]),
        properties: { subject: { maxLength: 256 }, date: { format: "date-time" }, paths: { maxItems: 20, items: { maxLength: 512 } } },
      } } },
    });
    expectToolOutputSchema(tools, "git_show", ["commit", "comparison", "diff", "truncated", "returnedBytes"]);
  });

  it("traces authenticated and rejected MCP requests without recording request secrets", async () => {
    const marker = "private-request-payload-do-not-log";
    const response = await fetch(`${bridge.localBaseUrl()}/mcp`, {
      method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 551, method: "unknown", params: { secret: marker } }),
    });
    await response.text();
    const id = response.headers.get("x-request-id");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const unauthorized = await fetch(`${bridge.localBaseUrl()}/mcp`, { method: "POST" });
    await unauthorized.text();
    expect(unauthorized.status).toBe(401);
    const logs = fs.readFileSync(path.join(stateDir, "mcp-http.log"), "utf8");
    const entries = logs.split("\n").filter(line => line.includes(id!));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toContain("MCP HTTP received");
    expect(entries[1]).toContain('"responseComplete":true');
    expect(entries[1]).toContain('"rpcMethod":"unknown"');
    expect(logs).not.toContain(marker);
    expect(logs).not.toContain(accessToken);
  });

  it("documents git_diff pagination with its output field names", async () => {
    const { tools } = await client.listTools();
    const description = tools.find((tool) => tool.name === "git_diff")?.description;
    expect(description).toContain("hasMore");
    expect(description).toContain("nextOffset");
    expect(description).not.toContain("has_more");
    expect(description).not.toContain("next_offset");
  });

  it("workspace_info returns identity and project detection", async () => {
    const result = await client.callTool({ name: "workspace_info", arguments: {} });
    const info = structuredJsonOf<{ workspaceId: string; projectType: string; frameworks: string[]; git: { isRepo: boolean; branch: string } }>(result);
    expect(info.workspaceId).toBe(fixtureWorkspace(bridge).id);
    expect(info.projectType).toBe("node");
    expect(info.frameworks).toContain("React");
    expect(info.git.isRepo).toBe(true);
    expect(info.git.branch).toBe("main");
  });

  it("read_file returns hello.txt", async () => {
    const result = await client.callTool({ name: "read_file", arguments: { path: "hello.txt" } });
    const file = structuredJsonOf<{ content: string; totalLines: number }>(result);
    expect(file.content).toContain("Hello from Codex with ChatGPT!");
  });

  it("returns typed range and regex errors through MCP instead of generic or successful results", async () => {
    for (const [name, args, error] of [
      ["read_file", { path: "hello.txt", start_line: 3, end_line: 2 }, "INVALID_RANGE"],
      ["search_workspace", { query: "([", regex: true }, "INVALID_REGEX"],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true); expect(jsonOf(result)).toMatchObject({ error });
    }
  });

  it("read_file returns FILE_TOO_LARGE without content for a file over 16 MiB", async () => {
    const marker = "oversized-mcp-content-must-not-leak";
    const file = write(root, "oversized-mcp.txt", marker);
    fs.truncateSync(file, 16 * 1024 * 1024 + 1);
    try {
      const result = await client.callTool({ name: "read_file", arguments: { path: "oversized-mcp.txt", end_line: 1 } });
      expect(result.isError).toBe(true);
      expect(jsonOf(result)).toEqual({ error: "FILE_TOO_LARGE", message: expect.any(String) });
      expect(textOf(result)).not.toContain(marker);
      expect(result.structuredContent).toBeUndefined();
    } finally { fs.unlinkSync(file); }
  });

  it("read_image returns metadata and image content", async () => {
    const result = await client.callTool({ name: "read_image", arguments: { path: "pixel.png" } });
    expect(result.structuredContent).toEqual({ path: "pixel.png", sizeBytes: 11, mimeType: "image/png" });
    const content = result.content as { type: string; mimeType?: string }[];
    expect(content.some((item) => item.type === "image" && item.mimeType === "image/png")).toBe(true);
  });

  it("read_file denies .env with ACCESS_DENIED_SENSITIVE_FILE and no content", async () => {
    const result = await client.callTool({ name: "read_file", arguments: { path: ".env" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("ACCESS_DENIED_SENSITIVE_FILE");
    expect(textOf(result)).not.toContain("supersecret");
  });

  it("read_file denies paths outside the workspace", async () => {
    const result = await client.callTool({ name: "read_file", arguments: { path: "../../etc/hosts" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("PATH_OUTSIDE_WORKSPACE");
  });

  it("list_directory lists the tree", async () => {
    const result = await client.callTool({ name: "list_directory", arguments: { path: ".", depth: 2 } });
    const listing = structuredJsonOf<{ entries: { path: string }[]; total: number; hasMore: boolean; truncated: boolean }>(result);
    expect(listing).toMatchObject({ total: listing.entries.length, hasMore: false, truncated: false });
    const paths = listing.entries.map((entry) => entry.path);
    expect(paths).toContain("hello.txt");
    expect(paths).toContain("src/index.ts");
    expect(paths).not.toContain(".env");
  });

  it("discovers OAuth, registers and pairs with PKCE, then routes authenticated MCP reads without logging credentials", async () => {
    const base = bridge.localBaseUrl();
    const other = makeTmpDir("oauth-explicit-repo");
    const registry = new WorkspaceRegistry(bridge.hubId);
    write(other, "hello.txt", "explicit OAuth repository\n");
    write(other, ".env", "denied-credential-content\n");
    const entry = registry.add(other, "oauth-repo");
    const oauthClient = new Client({ name: "oauth-mcp-integration", version: "1.0.0" });
    const output: string[] = [];
    const capture = [process.stdout, process.stderr].map(stream => vi.spyOn(stream, "write").mockImplementation(chunk => {
      output.push(String(chunk)); return true;
    }));
    try {
      const unauthorized = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
      expect(unauthorized.status).toBe(401);
      const metadataUrl = unauthorized.headers.get("www-authenticate")?.match(/resource_metadata="([^"]+)"/)?.[1];
      expect(metadataUrl).toBe(`${base}/.well-known/oauth-protected-resource/mcp`);
      const metadataResponse = await fetch(metadataUrl!);
      expect(metadataResponse.status).toBe(200);
      const resource = await metadataResponse.json() as { resource: string; authorization_servers: string[] };
      expect(resource).toMatchObject({ resource: `${base}/mcp`, authorization_servers: [base] });
      const discovery = await fetch(`${resource.authorization_servers[0]}/.well-known/oauth-authorization-server`);
      expect(discovery.status).toBe(200);
      const metadata = await discovery.json() as { authorization_endpoint: string; token_endpoint: string;
        registration_endpoint: string; scopes_supported: string[]; code_challenge_methods_supported: string[] };
      expect(metadata).toMatchObject({ authorization_endpoint: `${base}/oauth/authorize`, token_endpoint: `${base}/oauth/token`,
        registration_endpoint: `${base}/oauth/register`, code_challenge_methods_supported: ["S256"] });

      const redirectUri = "http://127.0.0.1:19876/callback";
      const registered = await fetch(metadata.registration_endpoint, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "OAuth MCP integration", redirect_uris: [redirectUri] }) });
      expect(registered.status).toBe(201);
      const registration = await registered.json() as { client_id: string };
      const { verifier, challenge } = pkceVerifierAndChallenge();
      const authorize = new URL(metadata.authorization_endpoint);
      authorize.search = new URLSearchParams({ client_id: registration.client_id, redirect_uri: redirectUri,
        response_type: "code", state: "integration-state", code_challenge: challenge, code_challenge_method: "S256",
        scope: metadata.scopes_supported.join(" ") }).toString();
      const page = await fetch(authorize, { redirect: "manual" });
      expect(page.status).toBe(200);
      const requestId = (await page.text()).match(/name="request_id" value="([a-f0-9]+)"/)?.[1];
      expect(Boolean(requestId)).toBe(true);
      const pairingResponse = await fetch(`${base}/admin/pairing`, { method: "POST",
        headers: { authorization: `Bearer ${bridge.adminToken}` } });
      expect(pairingResponse.status).toBe(200);
      const pairing = await pairingResponse.json() as { code: string };
      const approval = await fetch(metadata.authorization_endpoint, { method: "POST", redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ request_id: requestId!, pairing_code: pairing.code }) });
      expect(approval.status).toBe(302);
      const redirect = new URL(approval.headers.get("location")!);
      expect(redirect.origin + redirect.pathname).toBe(redirectUri);
      expect(redirect.searchParams.get("state")).toBe("integration-state");
      const code = redirect.searchParams.get("code")!;
      expect(Boolean(code)).toBe(true);
      const exchange = await fetch(metadata.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier,
          client_id: registration.client_id, redirect_uri: redirectUri }) });
      expect(exchange.status).toBe(200);
      const tokens = await exchange.json() as { access_token: string; refresh_token: string };
      expect(Boolean(tokens.access_token)).toBe(true);
      expect(Boolean(tokens.refresh_token)).toBe(true);

      await oauthClient.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } },
      }));
      const info = await oauthClient.callTool({ name: "workspace_info", arguments: { workspace: entry.workspaceId } });
      expect(info.isError ?? false).toBe(false);
      expect(structuredJsonOf(info).workspaceId).toBe(entry.workspaceId);
      const file = await oauthClient.callTool({ name: "read_file", arguments: { workspace: entry.workspaceId, path: "hello.txt" } });
      expect(structuredJsonOf(file).content).toBe("explicit OAuth repository");
      const denied = await oauthClient.callTool({ name: "read_file", arguments: { workspace: entry.workspaceId, path: ".env" } });
      expect(denied.isError).toBe(true);
      expect(jsonOf(denied)).toMatchObject({ error: "ACCESS_DENIED_SENSITIVE_FILE" });
      expect(textOf(denied).includes("denied-credential-content")).toBe(false);

      const log = fs.readFileSync(path.join(stateDir, "mcp-http.log"), "utf8");
      expect(log.includes("Pairing verified")).toBe(true);
      expect(log.includes("Issued access token")).toBe(true);
      expect(output.join("").includes("Issued access token")).toBe(true);
      for (const secret of [tokens.access_token, tokens.refresh_token, code, verifier, pairing.code, bridge.adminToken]) {
        // Boolean assertions keep even a failing test from printing credentials.
        expect(log.includes(secret)).toBe(false);
        expect(output.join("").includes(secret)).toBe(false);
      }
      expect(/c2c_(?:at|rt|ac|admin)_/.test(log + output.join(""))).toBe(false);
    } finally {
      try { await oauthClient.close(); }
      finally {
        capture.forEach(spy => spy.mockRestore());
        registry.remove(entry.workspaceId); cleanup(other);
      }
    }
  });

  it("search_workspace finds matches", async () => {
    const result = await client.callTool({ name: "search_workspace", arguments: { query: "answer" } });
    const search = structuredJsonOf<{ matches: { path: string; line: number }[] }>(result);
    expect(search.matches.some((match) => match.path === "src/index.ts")).toBe(true);
  });

  it("git_status reports the dirty file", async () => {
    const result = await client.callTool({ name: "git_status", arguments: {} });
    const status = structuredJsonOf<{ isRepo: boolean; unstaged: { path: string }[] }>(result);
    expect(status.isRepo).toBe(true);
    expect(status.unstaged.some((entry) => entry.path === "src/index.ts")).toBe(true);
  });

  it("polls repeated preparing responses across HTTP calls without rerunning Git", async () => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const release = path.join(stateDir, "release-snapshot");
    const callsBefore = vi.mocked(spawn).mock.calls.length;
    vi.mocked(spawn).mockImplementation((_, args, options) => actual.spawn(process.execPath, ["-e", args?.includes("--name-status")
      ? 'process.stdout.write("M\\0hello.txt\\0")'
      : `const fs = require("node:fs"); const timer = setInterval(() => {
          if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(timer); process.stdout.write("background patch\\n"); }
        }, 10);`], options));
    let poll: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const workspace = fixtureWorkspace(bridge).id;
      const first = structuredJsonOf<{ status: string; snapshotId: string }>(await client.callTool({
        name: "git_diff", arguments: { workspace },
      }));
      expect(first.status).toBe("preparing");
      const callTool = client.callTool.bind(client);
      let preparing = 0;
      poll = vi.spyOn(client, "callTool").mockImplementation(async (...args) => {
        expect(args[0].arguments).toMatchObject({ workspace, snapshot_id: first.snapshotId });
        const result = await callTool(...args);
        if (result.structuredContent?.status === "preparing" && ++preparing === 2) write(stateDir, "release-snapshot", "ready");
        return result;
      });
      const ready = structuredJsonOf<{ status: string; snapshotId: string; diff: string }>(await callGitDiffReady(client, {
        workspace, snapshot_id: first.snapshotId,
      }));
      expect(preparing).toBeGreaterThanOrEqual(2);
      expect(ready).toMatchObject({ status: "ready", snapshotId: first.snapshotId, diff: "background patch\n" });
      expect(vi.mocked(spawn).mock.calls.length - callsBefore).toBe(2);
    } finally {
      poll?.mockRestore();
      write(stateDir, "release-snapshot", "ready");
      vi.mocked(spawn).mockImplementation(actual.spawn);
    }
  });

  it("bounds polling time and preserves snapshot identity and scope on every retry", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      const callTool = vi.fn().mockResolvedValue({ structuredContent: {
        status: "preparing", snapshotId: "pending-snapshot", retryAfterMs: 100,
      } });
      const args = { workspace: "registered-workspace", mode: "head", path: "src", offset: 1024, snapshot_id: "pending-snapshot" };
      const assertion = expect(callGitDiffReady({ callTool }, args, 300)).rejects.toThrow("git_diff did not become ready within 300 ms");
      await vi.advanceTimersByTimeAsync(300);
      await assertion;
      expect(callTool.mock.calls.length).toBeGreaterThan(1);
      for (const [request, , options] of callTool.mock.calls) {
        expect(request.arguments).toEqual(args);
        expect(options.timeout).toBeGreaterThan(0);
        expect(options.timeout).toBeLessThanOrEqual(300);
      }
    } finally { vi.useRealTimers(); }
  });

  it("returns a sanitized snapshot I/O error through MCP when a cache file disappears", async () => {
    const args = { mode: "unstaged" };
    const first = structuredJsonOf<{ snapshotId: string }>(await callGitDiffReady(client, args));
    const base = path.join(stateDir, "diff-snapshots");
    const directory = fs.readdirSync(base).find(name => fs.existsSync(path.join(base, name, first.snapshotId)))!;
    const file = path.join(base, directory, first.snapshotId);
    fs.unlinkSync(file);
    const result = await client.callTool({ name: "git_diff", arguments: { ...args, snapshot_id: first.snapshotId } });
    expect(result.isError).toBe(true);
    expect(jsonOf(result)).toEqual({ error: "DIFF_SNAPSHOT_IO_ERROR", message: "Cannot access the diff snapshot." });
    const response = JSON.stringify(result);
    for (const localPath of [file, stateDir, root]) expect(response).not.toContain(localPath);
  });

  it("git_diff shows the change", async () => {
    const result = await callGitDiffReady(client, { mode: "unstaged" });
    const diff = structuredJsonOf<{ diff: string; hasMore: boolean }>(result);
    expect(diff.diff).toContain("answer = 43");
    expect(diff.hasMore).toBe(false);
  });

  it("git_log and git_show expose structured bounded history and reject revision expressions", async () => {
    const id = git(root, "rev-parse", "HEAD").trim();
    const log = await client.callTool({ name: "git_log", arguments: { path: "src", limit: 1 } });
    expect(structuredJsonOf(log)).toEqual({ commits: [{
      sha: id, subject: "initial commit", subjectTruncated: false,
      date: new Date(git(root, "show", "-s", "--format=%cI", id).trim()).toISOString(),
      paths: ["src/index.ts"], pathsTruncated: false,
    }], hasMore: false });
    const patch = await client.callTool({ name: "git_show", arguments: { commit: id, path: "src", max_bytes: 1024 } });
    expect(structuredJsonOf(patch)).toMatchObject({ commit: id, comparison: "root", truncated: false, diff: expect.stringContaining("answer = 42") });
    for (const [name, args] of [
      ["git_show", { commit: "HEAD" }], ["git_log", { limit: 101 }], ["git_show", { commit: id, max_bytes: 262145 }],
    ] as const) expect((await client.callTool({ name, arguments: args })).isError).toBe(true);
  });

  it.each(["git_log", "git_show"])("%s rechecks changed workspace policy before returning history", async name => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const id = git(root, "rev-parse", "HEAD").trim();
    vi.mocked(spawn).mockImplementation((command, args, options) => {
      if ((args as string[]).includes("log")) write(root, ".c2cignore", "hello.txt\n");
      return actual.spawn(command, args, options);
    });
    try {
      const result = await client.callTool({ name, arguments: { commit: id } });
      expect(result.isError).toBe(true);
      expect(jsonOf(result)).toMatchObject({ error: "GIT_HISTORY_POLICY_CHANGED" });
      expect(textOf(result)).not.toContain("Hello from Codex");
    } finally {
      fs.rmSync(path.join(root, ".c2cignore"), { force: true });
      vi.mocked(spawn).mockImplementation(actual.spawn);
    }
  });

  it("git_diff paginates large diffs", async () => {
    const big = Array.from({ length: 20000 }, (_, i) => `content line ${i}`).join("\n");
    write(root, "big-change.txt", big);
    git(root, "add", "big-change.txt");
    const first = structuredJsonOf<{ snapshotId: string; status: string; hasMore: boolean; nextOffset: number; totalBytes: number; returnedBytes: number }>(
      await callGitDiffReady(client, { mode: "staged", max_bytes: 4096 })
    );
    expect(first.status).toBe("ready");
    expect(first.hasMore).toBe(true);
    expect(first.returnedBytes).toBeLessThanOrEqual(4096);
    const second = structuredJsonOf<{ offset: number; diff: string }>(
      await callGitDiffReady(client, { mode: "staged", snapshot_id: first.snapshotId, max_bytes: 4096, offset: first.nextOffset })
    );
    expect(second.offset).toBe(first.nextOffset);
    expect(second.diff.length).toBeGreaterThan(0);
    git(root, "reset", "big-change.txt");
  });

  it("enforces scopes per tool", async () => {
    const limited = bridge.authStore.issueTokens({ clientId: "limited", scopes: ["workspace.read"] });
    const limitedClient = new Client({ name: "limited", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${limited.accessToken}` } },
    });
    await limitedClient.connect(transport);
    const denied = await limitedClient.callTool({ name: "git_diff", arguments: {} });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain("INSUFFICIENT_SCOPE");
    for (const name of ["git_log", "git_show"]) {
      const result = await limitedClient.callTool({ name, arguments: { commit: "0".repeat(40) } });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("INSUFFICIENT_SCOPE");
    }
    const searchDenied = await limitedClient.callTool({ name: "search_workspace", arguments: { query: "hello" } });
    expect(searchDenied.isError).toBe(true);
    expect(textOf(searchDenied)).toContain("INSUFFICIENT_SCOPE");
    const allowed = await limitedClient.callTool({ name: "read_file", arguments: { path: "hello.txt" } });
    expect(allowed.isError ?? false).toBe(false);
    await limitedClient.close();
  });

  it("git_diff over MCP excludes sensitive files like .npmrc and service-account*.json", async () => {
    write(root, ".npmrc", "//registry.npmjs.org/:_authToken=supersecret-npm-token\n");
    write(root, "service-account-test.json", '{"private_key": "supersecret-sa-key"}\n');
    write(root, "src/visible.ts", "export const visible = 'safe-change';\n");

    git(root, "add", "-f", ".npmrc", "service-account-test.json", "src/visible.ts");

    const result = jsonOf<{ diff: string; isRepo: boolean }>(
      await callGitDiffReady(client, { mode: "staged" })
    );

    expect(result.isRepo).toBe(true);
    expect(result.diff).toContain("safe-change");
    expect(result.diff).not.toContain("supersecret-npm-token");
    expect(result.diff).not.toContain("supersecret-sa-key");

    git(root, "rm", "-f", "--cached", ".npmrc", "service-account-test.json", "src/visible.ts");
  });

  it("git_diff over MCP blocks sensitive-to-safe renames from leaking original content", async () => {
    write(root, ".npmrc", "//registry.npmjs.org/:_authToken=mcp-secret-token-123\n");
    git(root, "add", "-f", ".npmrc");
    git(root, "commit", "-m", "add secret to rename");

    git(root, "mv", ".npmrc", "public_harmless.txt");

    const result = jsonOf<{ diff: string; isRepo: boolean }>(
      await callGitDiffReady(client, { mode: "staged" })
    );

    expect(result.isRepo).toBe(true);
    expect(result.diff).not.toContain("mcp-secret-token-123");
    expect(result.diff).not.toContain("public_harmless.txt");

    git(root, "reset", "--hard", "HEAD");
  });

  it("git_diff over MCP with path='src' blocks cross-boundary rename leaks from root secrets", async () => {
    write(root, ".npmrc", "//registry.npmjs.org/:_authToken=root-mcp-scoped-secret\n");
    git(root, "add", "-f", ".npmrc");
    git(root, "commit", "-m", "add root secret for scoped test");

    // Rename root .npmrc to src/public.txt
    git(root, "mv", ".npmrc", "src/public.txt");

    const result = jsonOf<{ diff: string; isRepo: boolean }>(
      await callGitDiffReady(client, { mode: "staged", path: "src" })
    );

    expect(result.isRepo).toBe(true);
    expect(result.diff).not.toContain("root-mcp-scoped-secret");
    expect(result.diff).not.toContain("src/public.txt");

    git(root, "reset", "--hard", "HEAD");
  });
});
