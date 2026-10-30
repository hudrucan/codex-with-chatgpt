import { createInterface } from "node:readline";
import { z } from "zod";
import { AuditSession, sessionOptionsSchema } from "./session.js";
import { formatTerminalResult } from "./terminal-result.js";

const commandSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("prepare"), handoff: z.string(), options: sessionOptionsSchema.optional() }).strict(),
  z.object({ operation: z.literal("verifySourceForFix") }).strict(),
]);
// A handoff byte can expand to six JSON characters (\u0000), plus the command envelope.
const MAX_INPUT_BYTES = 6 * 48 * 1024 + 1024;

/** JSONL input and framed TTY output; no daemon, IPC listener or persisted session. */
export async function runSessionCommand() {
  // Codex keeps stdin open with tty=true. Raw mode prevents echo and canonical
  // terminal truncation of long handoff lines; restore this process's TTY on exit.
  const raw = process.stdin.isTTY && !process.stdin.isRaw;
  if (raw) process.stdin.setRawMode(true);
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const output = (value: unknown) => process.stdout.write(formatTerminalResult({ ok: true, value }, !!process.stdout.isTTY));
  let session: AuditSession | undefined;
  let completed = false, interrupted = false;
  const stop = () => {
    if (completed) return;
    interrupted = true;
    void session?.close(); lines.close();
  };
  const control = (data: Buffer) => { if (data.includes(3) || data.includes(4)) stop(); };
  process.stdin.on("data", control);
  lines.on("close", stop);
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    for await (const line of lines) {
      if (interrupted) throw new Error("ASYNC_INTERRUPTED");
      if (Buffer.byteLength(line) > MAX_INPUT_BYTES) throw new Error("ASYNC_LOCAL_REQUEST_INVALID");
      const input: unknown = JSON.parse(line);
      const command = commandSchema.parse(input);
      if (command.operation === "verifySourceForFix") {
        if (!session) throw new Error("ASYNC_FIX_NOT_AVAILABLE");
        output(await session.verifySourceForFix());
      } else {
        if (!session) session = new AuditSession(command.options);
        else if (command.options) throw new Error("ASYNC_OPTIONS_ALREADY_SET");
        const prepared = await session.prepare(command.handoff);
        if (interrupted) throw new Error("ASYNC_INTERRUPTED");
        output(prepared);
        const value = await session.wait();
        if (interrupted) throw new Error("ASYNC_INTERRUPTED");
        output(value);
        if (!value.canContinue) { completed = true; break; }
      }
    }
    if (interrupted || !completed) throw new Error("ASYNC_INTERRUPTED");
  } finally {
    completed = true;
    lines.off("close", stop); lines.close();
    process.stdin.off("data", control);
    if (raw) process.stdin.setRawMode(false);
    process.stdin.destroy();
    process.off("SIGINT", stop); process.off("SIGTERM", stop);
    await session?.close();
  }
}
