import process from "node:process";
import { localAccess } from "./local.js";

// One-shot local operations only; no browser, server or arbitrary command input.
try {
  const [operation, first, second] = process.argv.slice(2);
  let value: unknown;
  if (operation === "claim" && /^[a-zA-Z0-9_-]{1,128}$/.test(first ?? "")) value = localAccess.claimTask(first);
  else if (operation === "fingerprint" && first && /^[a-f0-9]{12}$/.test(second ?? "")) value = localAccess.sourceFingerprint(first, second);
  else if (operation === "project" && /^[a-f0-9]{12}$/.test(first ?? "")) value = await localAccess.resolveProject(first, second);
  else throw new Error("ASYNC_LOCAL_REQUEST_INVALID");
  process.stdout.write(JSON.stringify({ ok: true, value: value ?? null }) + "\n");
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) + "\n");
  process.exitCode = 1;
}
