import { createInterface } from "node:readline";
import { z } from "zod";
import { AuditSession } from "./session.js";
import { MAX_AUDIT_MS } from "./protocol.js";

const commandSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("submit"), handoff: z.string(), fixed: z.boolean().default(false) }).strict(),
  z.object({ operation: z.literal("sent"), attemptId: z.string().uuid() }).strict(),
  z.object({ operation: z.literal("verifySourceForFix") }).strict(),
  z.object({ operation: z.literal("abort") }).strict(),
]);
// A handoff byte can expand to six JSON characters (\u0000), plus the command envelope.
const MAX_INPUT_BYTES = 6 * 48 * 1024 + 1024;

/** JSONL over the terminal's existing stdin/stdout; no daemon, IPC listener or persisted session. */
export async function runSessionCommand() {
  // Codex keeps stdin open with tty=true. Raw mode prevents echo and canonical
  // terminal truncation of long handoff lines; restore this process's TTY on exit.
  const raw = process.stdin.isTTY && !process.stdin.isRaw;
  if (raw) process.stdin.setRawMode(true);
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const output = (value: unknown) => process.stdout.write(JSON.stringify({ ok: true, value }) + "\n");
  let session: AuditSession | undefined, timer: ReturnType<typeof setTimeout>;
  let completed = false, interrupted = false;
  const stop = () => {
    if (completed) return;
    interrupted = true;
    void session?.close(); lines.close();
  };
  const inputClosed = () => { if (session) stop(); };
  const control = (data: Buffer) => { if (data.includes(3) || data.includes(4)) stop(); };
  if (raw) process.stdin.on("data", control);
  lines.on("close", inputClosed);
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  timer = setTimeout(stop, MAX_AUDIT_MS);
  try {
    for await (const line of lines) {
      if (interrupted) throw new Error("ASYNC_INTERRUPTED");
      if (Buffer.byteLength(line) > MAX_INPUT_BYTES) throw new Error("ASYNC_LOCAL_REQUEST_INVALID");
      const input: unknown = JSON.parse(line);
      clearTimeout(timer);
      if (!session) {
        if ((input as { async?: unknown })?.async !== true) {
          z.object({ async: z.literal(false).optional() }).strict().parse(input);
          output(null); completed = true; break;
        }
        session = new AuditSession(input);
        output({ status: "READY" });
      } else {
        const command = commandSchema.parse(input);
        if (command.operation === "abort") throw new Error("ASYNC_SEND_UNCERTAIN: Stop without resending; use manual C2C.");
        const value = command.operation === "submit" ? await session.submit(command.handoff, command.fixed)
          : command.operation === "sent" ? await session.sent(command.attemptId) : await session.verifySourceForFix();
        if (interrupted) throw new Error("ASYNC_INTERRUPTED");
        output(value);
        if ("canContinue" in value && !value.canContinue) { completed = true; break; }
      }
      // Each input/fix phase is bounded as well as the Hub's original attempt deadline.
      timer = setTimeout(stop, MAX_AUDIT_MS);
    }
    if (interrupted || !completed) throw new Error("ASYNC_INTERRUPTED");
  } finally {
    completed = true; clearTimeout(timer);
    lines.off("close", inputClosed); lines.close();
    if (raw) { process.stdin.off("data", control); process.stdin.setRawMode(false); }
    process.stdin.destroy();
    process.off("SIGINT", stop); process.off("SIGTERM", stop);
    await session?.close();
  }
}
