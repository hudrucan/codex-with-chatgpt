import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge, type Bridge } from "../../src/bridge/server.js";
import { Workspace } from "../../src/workspace/manager.js";
import { WorkspaceRegistry } from "../../src/workspace/registry.js";
import { cleanup, isolateStateDir, makeGitRepo, makeTmpDir, write, legacyAuthFixture } from "../helpers.js";

async function connect(bridge: Bridge, existingToken?: string): Promise<Client> {
  const token = existingToken ?? bridge.authStore.issueTokens({
    clientId: "owner-isolation", scopes: ["workspace.read", "workspace.search", "git.read"],
  }).accessToken;
  const client = new Client({ name: "owner-isolation", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  return { result, data: JSON.parse((result.content as { text: string }[])[0].text) };
}

it("isolates the grants of two simultaneously running bridge owners in the same state directory", async () => {
  const state = isolateStateDir();
  const ownerRoots = [makeTmpDir("owner-a"), makeTmpDir("owner-b")];
  const repoRoots = [makeTmpDir("owner-a-repo"), makeTmpDir("owner-b-repo")];
  const bridges: Bridge[] = [];
  const clients: Client[] = [];
  try {
    repoRoots.forEach((root, index) => {
      makeGitRepo(root);
      write(root, "hello.txt", `owner-${index} isolated-marker\n`);
      fs.writeFileSync(path.join(root, "pixel.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    });
    // Unowned grants must never be imported into either legacy bridge.
    const legacyFile = write(state, "workspace-registry.json", JSON.stringify({ version: 1, workspaces: repoRoots.map((root) => ({
      workspaceId: new Workspace(root).id, alias: `legacy-${new Workspace(root).id}`, root,
    })) }));
    const legacyContents = fs.readFileSync(legacyFile, "utf8");
    const legacyOwned = ownerRoots.map((root, index) => {
      const owner = new Workspace(root);
      const file = write(state, `workspace-registries/${owner.id}.json`, JSON.stringify({
        version: 1, ownerWorkspaceId: owner.id,
        workspaces: [{ workspaceId: owner.id, alias: `legacy-owner-${index}`, root }],
      }));
      return { file, contents: fs.readFileSync(file, "utf8"), token: legacyAuthFixture(state, owner.id).accessToken };
    });
    for (const root of ownerRoots) bridges.push(await startBridge({ workspaceRoot: root, port: 0, persistRuntime: false }));
    for (let index = 0; index < bridges.length; index++) clients.push(await connect(bridges[index], legacyOwned[index].token));
    expect(bridges[0].port).not.toBe(bridges[1].port);
    const registries = bridges.map((bridge) => WorkspaceRegistry.forWorkspace(bridge.workspace));
    for (let index = 0; index < 2; index++) {
      const { data } = await call(clients[index], "list_workspaces");
      expect(data).toEqual({ workspaces: registries[index].choices() });
      expect(data.workspaces).toHaveLength(1);
      expect(data.workspaces[0].workspaceId).toBe(bridges[index].workspace.id);
      expect((await call(clients[index], "workspace_info")).data.workspaceId).toBe(bridges[index].workspace.id);
      expect((await call(clients[index], "workspace_info", { workspace: new Workspace(repoRoots[index]).id })).data.error).toBe("WORKSPACE_NOT_FOUND");
    }
    const entries = registries.map((registry, index) => registry.add(repoRoots[index], `repo-${index}`));
    const tools = [
      ["workspace_info", {}], ["list_directory", {}], ["read_file", { path: "hello.txt" }],
      ["read_image", { path: "pixel.png" }], ["search_workspace", { query: "isolated-marker" }],
      ["git_status", {}], ["git_diff", {}],
    ] as const;
    for (let index = 0; index < 2; index++) {
      const foreign = 1 - index;
      const { data } = await call(clients[index], "list_workspaces");
      expect(data).toEqual({ workspaces: registries[index].choices() });
      expect(data.workspaces).toHaveLength(2);
      const required = (await call(clients[index], "workspace_info")).data;
      expect(required.error).toBe("WORKSPACE_REQUIRED");
      expect(required.workspaces).toEqual(data.workspaces);
      for (const [name, args] of tools) {
        const own = await call(clients[index], name, { ...args, workspace: entries[index].alias });
        expect(own.result.isError ?? false, name).toBe(false);
        for (const selector of [entries[foreign].alias, entries[foreign].workspaceId, bridges[foreign].workspace.id]) {
          const denied = await call(clients[index], name, { ...args, workspace: selector });
          expect(denied.result.isError, name).toBe(true);
          expect(denied.data.error, name).toBe("WORKSPACE_NOT_FOUND");
        }
      }
      expect((await call(clients[index], "read_file", { workspace: entries[index].workspaceId, path: "hello.txt" })).data.content).toBe(`owner-${index} isolated-marker`);
    }
    // Aliases have owner-local namespaces; identical aliases resolve independently.
    registries.forEach((registry, index) => registry.add(repoRoots[index], "repo"));
    const reads = await Promise.all(clients.map((client) => call(client, "read_file", { workspace: "repo", path: "hello.txt" })));
    reads.forEach(({ data }, index) => expect(data.content).toBe(`owner-${index} isolated-marker`));
    registries[0].remove("repo");
    expect((await call(clients[0], "read_file", { workspace: "repo", path: "hello.txt" })).data.error).toBe("WORKSPACE_NOT_FOUND");
    expect((await call(clients[1], "read_file", { workspace: "repo", path: "hello.txt" })).data.content).toBe("owner-1 isolated-marker");
    expect(registries[0].hubId).not.toBe(registries[1].hubId);
    for (let index = 0; index < 2; index++) {
      expect(fs.readFileSync(legacyOwned[index].file, "utf8")).toBe(legacyOwned[index].contents);
    }
    expect(fs.readFileSync(legacyFile, "utf8")).toBe(legacyContents);
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    await Promise.allSettled(bridges.map((bridge) => bridge.close()));
    for (const dir of [...ownerRoots, ...repoRoots, state]) cleanup(dir);
    delete process.env.C2C_STATE_DIR;
  }
});
