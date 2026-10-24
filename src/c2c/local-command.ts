import process from "node:process";
import { localAccess } from "./local.js";
import { callbackLocal } from "./callback-client.js";
import { runSessionCommand } from "./session-command.js";

async function readInput(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 4096) throw new Error("ASYNC_LOCAL_REQUEST_INVALID");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

// Local operations and one bounded task session; no server or arbitrary command input.
try {
  const [operation, first, second] = process.argv.slice(2);
  let value: unknown;
  if (operation === "async") {
    await runSessionCommand();
  }
  else if (operation === "claim" && /^[a-zA-Z0-9_-]{1,128}$/.test(first ?? "")) value = localAccess.claimTask(first);
  else if (operation === "fingerprint" && first && /^[a-f0-9]{12}$/.test(second ?? "")) value = localAccess.sourceFingerprint(first, second);
  else if (operation === "project" && /^[a-f0-9]{12}$/.test(first ?? "")) value = await localAccess.resolveProject(first, second);
  else if (operation === "callback" && (first === "register" || first === "wait" || first === "cancel")) {
    value = await callbackLocal(first, await readInput());
  }
  else throw new Error("ASYNC_LOCAL_REQUEST_INVALID");
  if (operation !== "async") process.stdout.write(JSON.stringify({ ok: true, value: value ?? null }) + "\n");
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) + "\n");
  process.exitCode = 1;
}
