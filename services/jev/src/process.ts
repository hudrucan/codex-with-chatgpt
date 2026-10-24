import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { apiKeySchema, type Config, JevError, lockState, privateFile, readPrivate, writePrivate } from "./state.js";
import { createApp } from "./http.js";
import { runTunnel } from "./tunnel.js";
import { verify } from "./verify.js";

const runtimeSchema = z.object({ version: z.literal(1), service: z.literal("jev-mcp"), instanceId: z.string(), pid: z.number().int(), port: z.number().int() }).strict();

export async function admin(directory: string, config: Config, approvalSecret: string, stop = false) {
  const runtime = readPrivate(path.join(directory, "runtime.json"), runtimeSchema);
  if (runtime.port !== config.port) throw new JevError("Jev runtime port conflict.");
  const response = await fetch(`http://127.0.0.1:${config.port}/admin/info`, {
    headers: { Authorization: `Bearer ${approvalSecret}` }, signal: AbortSignal.timeout(3000), redirect: "error",
  });
  const info = await response.json();
  if (!response.ok || info.service !== "jev-mcp" || info.instanceId !== runtime.instanceId || info.pid !== runtime.pid) {
    throw new JevError("Jev runtime ownership is uncertain; no process was changed.");
  }
  if (stop) {
    const stopped = await fetch(`http://127.0.0.1:${config.port}/admin/shutdown`, {
      method: "POST", headers: { Authorization: `Bearer ${approvalSecret}` }, signal: AbortSignal.timeout(3000), redirect: "error",
    });
    if (!stopped.ok) throw new JevError("Jev shutdown failed.");
  }
  return info;
}

export async function start(directory: string, config: Config, approvalSecret: string) {
  if (fs.existsSync(path.join(directory, "runtime.json"))) return { ...await admin(directory, config, approvalSecret), spawned: false };
  const key = apiKeySchema.safeParse(process.env.TYPESAFE_API_KEY);
  if (!key.success) throw new JevError("Set TYPESAFE_API_KEY before starting the detached Jev daemon.");
  const log = path.join(directory, "service.log");
  if (fs.existsSync(log)) privateFile(log);
  const out = fs.openSync(log, "a", 0o600);
  const entry = fileURLToPath(new URL("./index.js", import.meta.url));
  const child = spawn(process.execPath, [entry, "serve", "--state-dir", directory], {
    detached: true, stdio: ["ignore", out, out, "ipc"],
    // Match C2C's detached daemon environment inheritance, including local TLS/proxy settings.
    env: { ...process.env, TYPESAFE_API_KEY: key.data },
  });
  fs.closeSync(out);
  child.unref();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.disconnect(); reject(new JevError("Jev startup timed out; inspect its private log before retrying.")); }, 20_000);
    child.once("message", (message) => { clearTimeout(timer); resolve(message); });
    child.once("error", () => { clearTimeout(timer); reject(new JevError("Cannot spawn the Jev daemon.")); });
    child.once("exit", (code) => { clearTimeout(timer); if (code !== 0) reject(new JevError("Jev daemon exited before readiness; inspect its private log.")); });
  });
}

export async function serve(directory: string, config: Config, approvalSecret: string): Promise<void> {
  const parsed = apiKeySchema.safeParse(process.env.TYPESAFE_API_KEY);
  if (!parsed.success) throw new JevError("Set TYPESAFE_API_KEY in the local process environment.");
  const unlock = lockState(directory);
  const file = path.join(directory, "runtime.json");
  const runtime = { version: 1 as const, service: "jev-mcp" as const, instanceId: randomBytes(16).toString("hex"), pid: process.pid, port: config.port };
  let published = false;
  process.once("exit", () => { if (published) fs.unlinkSync(file); unlock(); });
  const controller = new AbortController();
  let stopping = false;
  const app = createApp(config, directory, approvalSecret, parsed.data, fetch, { instanceId: runtime.instanceId, stop: () => stop() });
  const server = app.listen(config.port, "127.0.0.1");
  const stop = () => {
    if (stopping) return;
    stopping = true;
    controller.abort();
    server.close();
    server.closeAllConnections();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", () => reject(new JevError("Jev listener failed; port or ownership conflict.")));
  });
  if (fs.existsSync(file)) { stop(); throw new JevError("Existing Jev runtime state must be reconciled explicitly."); }
  writePrivate(file, runtime);
  published = true;
  try {
    await verify(directory, `http://127.0.0.1:${config.port}`, approvalSecret);
    const ready = { service: "jev-mcp", name: config.mcpName, endpoint: `http://127.0.0.1:${config.port}/mcp`, authentication: "passed", spawned: true };
    console.log(JSON.stringify(ready));
    if (process.send) process.send(ready, () => process.disconnect());
    if (fs.existsSync(path.join(directory, "tunnel-state.json"))) {
      void runTunnel(directory, config, approvalSecret, controller.signal).catch(() => {
        if (!stopping) { console.error("Jev tunnel failed; stopping this Jev process. Inspect its independent state."); stop(); process.exitCode = 1; }
      });
    }
  } catch (error) { stop(); throw error; }
}
