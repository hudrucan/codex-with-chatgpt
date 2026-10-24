import process from "node:process";
import { localAccess } from "./local.js";
import fs from "node:fs";
import { callbackLocal } from "./callback-client.js";
import { z } from "zod";

function readInput(): unknown {
  const input = fs.readFileSync(0, "utf8");
  if (Buffer.byteLength(input) > 4096) throw new Error("ASYNC_LOCAL_REQUEST_INVALID");
  return JSON.parse(input);
}

// One-shot local operations only; no browser, server or arbitrary command input.
try {
  const [operation, first, second] = process.argv.slice(2);
  let value: unknown;
  if (operation === "async") {
    const options = z.object({ async: z.boolean().default(false) }).strict().parse(readInput());
    if (options.async) throw new Error("ASYNC_CALLBACK_UNAVAILABLE: Automatic C2C delivery is disabled until the callback capability gate passes. Select async=false for manual C2C.");
  }
  else if (operation === "claim" && /^[a-zA-Z0-9_-]{1,128}$/.test(first ?? "")) value = localAccess.claimTask(first);
  else if (operation === "fingerprint" && first && /^[a-f0-9]{12}$/.test(second ?? "")) value = localAccess.sourceFingerprint(first, second);
  else if (operation === "project" && /^[a-f0-9]{12}$/.test(first ?? "")) value = await localAccess.resolveProject(first, second);
  else if (operation === "callback" && (first === "register" || first === "wait" || first === "cancel")) {
    value = await callbackLocal(first, readInput());
  }
  else throw new Error("ASYNC_LOCAL_REQUEST_INVALID");
  process.stdout.write(JSON.stringify({ ok: true, value: value ?? null }) + "\n");
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) + "\n");
  process.exitCode = 1;
}
