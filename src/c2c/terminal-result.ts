import { createHash } from "node:crypto";
import { TERMINAL_OUTPUT_BEGIN, TERMINAL_OUTPUT_END, TERMINAL_OUTPUT_LIMIT } from "./terminal-output.js";

/** Pipes retain JSONL; PTYs use bounded ASCII frames instead of long JSON strings. */
export function formatTerminalResult(result: unknown, tty: boolean): string {
  const json = JSON.stringify(result);
  if (!tty || (json.length <= 64 && /^[\x20-\x7e]*$/.test(json))) return json + "\n";
  const bytes = Buffer.from(json);
  if (bytes.length > TERMINAL_OUTPUT_LIMIT) throw new Error("ASYNC_TERMINAL_OUTPUT_INVALID");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const ok = (result as { ok?: unknown } | null)?.ok;
  if (typeof ok !== "boolean") throw new Error("ASYNC_TERMINAL_OUTPUT_INVALID");
  return ["", TERMINAL_OUTPUT_BEGIN + (ok ? "_OK" : "_ERROR"), String(bytes.length), digest,
    ...bytes.toString("base64url").match(/.{1,64}/g)!, TERMINAL_OUTPUT_END, ""].join("\r\n");
}
