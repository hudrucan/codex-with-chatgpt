import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { afterAll, describe, expect, it, beforeAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge } from "../../src/bridge/server.js";
import { decodeTerminalOutput } from "../../src/c2c/terminal-output.js";
import { sourceFingerprint } from "../../src/c2c/source.js";
import { Workspace } from "../../src/workspace/manager.js";
import { buildC2C } from "../../scripts/build-c2c.mjs";
import { cleanup, fixtureHub, makeGitRepo, makeTmpDir, write } from "../helpers.js";

describe.runIf(process.platform === "win32")("native Windows ConPTY with local OAuth MCP (no ChatGPT browser)", () => {
  let temporary: string, executable: string, wrapper: string;
  beforeAll(async () => {
    temporary = makeTmpDir("ConPTY Unicode 🪟 spaces");
    executable = path.join(temporary, "console.exe"); wrapper = path.join(temporary, "controller.mjs");
    const compiler = path.join(process.env.SystemRoot!, "Microsoft.NET", process.arch === "ia32" ? "Framework" : "Framework64", "v4.0.30319/csc.exe");
    const compiled = spawnSync(compiler, ["/nologo", "/target:exe", `/out:${executable}`,
      path.resolve("tests/integration/fixtures/windows-conpty.cs")], { encoding: "utf8", windowsHide: true });
    expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);
    const bundle = path.join(temporary, "bundle"); await buildC2C(bundle);
    fs.writeFileSync(wrapper, `
if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('A real console is required');
process.stdin.setRawMode(true);
process.stdout.write('C2C_TEST_READY\\r\\n');
await import(${JSON.stringify(pathToFileURL(path.join(bundle, "local.mjs")).href)});
`);
  });
  afterAll(() => { if (temporary) cleanup(temporary); });

  it.each([ ["cmd", 20], ["cmd", 80], ["powershell", 20], ["powershell", 80] ] as const)(
    "%s receives the matching callback at %i columns after a native resize before prepare", async (shell, columns) => {
      const state = path.join(temporary, `${shell}-${columns}-state`), root = path.join(temporary, `${shell}-${columns}-repo`);
      fs.mkdirSync(root); makeGitRepo(root); process.env.C2C_STATE_DIR = state;
      // Exercise a moderately sized inventory and raw CRLF/Unicode bytes, without time assertions.
      for (let i = 0; i < 500; i++) write(root, `source files/file ${i}.txt`, "Unicode 🪟\r\n");
      const workspaceId = new Workspace(root).id, scanStart = performance.now();
      sourceFingerprint(root, workspaceId);
      const fingerprintMs = Math.round(performance.now() - scanStart);
      const bridge = await startBridge({ hubId: fixtureHub(root).hubId, port: 0 });
      const client = new Client({ name: "conpty-fixture", version: "1" });
      const token = bridge.authStore.issueTokens({ clientId: "conpty-fixture", scopes: ["audit.submit"] }).accessToken;
      await client.connect(new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }));
      const initialColumns = columns === 20 ? 80 : 20;
      const child = spawn(executable, [shell, process.execPath, wrapper, String(initialColumns)], {
        env: { ...process.env, C2C_STATE_DIR: state }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      });
      const closed = once(child, "close");
      let buffer = "", stderr = "", ready!: () => void;
      const started = new Promise<void>(resolve => { ready = resolve; });
      const frames: string[] = [], readers: Array<(frame: string) => void> = [];
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.stdout.setEncoding("utf8").on("data", chunk => {
        buffer += chunk;
        if (buffer.includes("C2C_TEST_READY")) ready();
        let end: number;
        while ((end = buffer.indexOf("C2C_JSON_END")) >= 0) {
          const frame = buffer.slice(0, end + "C2C_JSON_END".length); buffer = buffer.slice(end + "C2C_JSON_END".length);
          const reader = readers.shift(); if (reader) reader(frame); else frames.push(frame);
        }
      });
      const read = () => Promise.race([
        frames.length ? Promise.resolve(frames.shift()!) : new Promise<string>(resolve => readers.push(resolve)),
        closed.then(() => { throw new Error(`Console exited before its response: ${stderr}`); }),
      ]);
      try {
        await Promise.race([started, closed.then(() => { throw new Error(`Console startup failed: ${stderr}`); })]);
        const prepareStart = performance.now();
        child.stdin.write(`C2C_TEST_RESIZE ${columns}\n`);
        child.stdin.write(JSON.stringify({ operation: "prepare", handoff: "[C2C Handoff]\nUnicode 🪟 native fixture",
          options: { hubId: bridge.hubId, workspaceId, workspaceRoot: root, taskId: "conpty-fixture", timeoutMs: 15_000 } }) + "\n");
        const firstFrame = await read();
        const prepared = await decodeTerminalOutput(firstFrame) as any;
        expect(prepared.ok).toBe(true);
        const prepareMs = Math.round(performance.now() - prepareStart);
        const receiptStart = performance.now();
        const result = { status: "PASS", complete: true, summary: "Local native callback 🪟", findings: [] };
        const accepted = await client.callTool({ name: "submit_audit_result", arguments: { ...prepared.value.ticket, result } });
        expect(accepted.structuredContent).toEqual({ accepted: true });
        const receipt = await decodeTerminalOutput(await read()) as any;
        const { capability: _capability, ...identity } = prepared.value.ticket;
        expect(receipt).toEqual({ ok: true, value: { ...identity, ...result, canContinue: false } });
        expect((await closed)[0], stderr).toBe(0);
        console.info(JSON.stringify({ shell, initialColumns, columns, files: 502, fingerprintMs, prepareMs,
          callbackReceiptMs: Math.round(performance.now() - receiptStart) }));
      } finally {
        child.kill(); await closed; await client.close(); await bridge.close(); delete process.env.C2C_STATE_DIR;
      }
    },
  );
});
