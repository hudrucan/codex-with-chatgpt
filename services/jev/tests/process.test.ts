import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";
import { fixture } from "./fixtures.js";
import { writePrivate } from "../src/state.js";

it("shuts down its verified daemon even when a client leaves a request body open", async () => {
  const f = fixture();
  const reservation = http.createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  writePrivate(path.join(f.directory, "config.json"), { ...f.config, port, dailyAttempts: 1, dailyReservedTokens: 65536 });
  const legacyBudget = "obsolete budget state is no longer parsed";
  fs.writeFileSync(path.join(f.directory, "budget.json"), legacyBudget, { mode: 0o600 });
  const child = spawn(process.execPath, ["--import", "tsx/esm", "services/jev/src/index.ts", "serve", "--state-dir", f.directory], {
    cwd: process.cwd(), env: { ...process.env, TYPESAFE_API_KEY: "test-no-paid-inference" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let socket: net.Socket | undefined;
  const exited = once(child, "exit");
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Jev startup timed out: ${output}`)), 8000);
      child.stdout.on("data", (chunk) => { output += chunk; if (output.includes('"authentication":"passed"')) { clearTimeout(timer); resolve(); } });
      child.once("exit", () => { clearTimeout(timer); reject(new Error("Jev exited before readiness")); });
    });
    socket = net.connect(port, "127.0.0.1");
    socket.on("error", () => {});
    await once(socket, "connect");
    socket.write(`POST /token HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 100\r\n\r\nx=`);
    const stopped = await fetch(`http://127.0.0.1:${port}/admin/shutdown`, { method: "POST", headers: { Authorization: `Bearer ${f.credentials.approvalSecret}` } });
    expect(stopped.status).toBe(200);
    await exited;
    expect(fs.existsSync(path.join(f.directory, "runtime.json"))).toBe(false);
    expect(fs.existsSync(path.join(f.directory, "runtime.lock"))).toBe(false);
    expect(fs.readFileSync(path.join(f.directory, "budget.json"), "utf8")).toBe(legacyBudget);
  } finally {
    socket?.destroy();
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
    f.cleanup();
  }
});
