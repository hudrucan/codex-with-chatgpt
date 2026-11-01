import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AuditSession, sessionOptionsSchema } from "./session.js";
import { formatTerminalResult } from "./terminal-result.js";
import { createCdpSender, CdpSendError, conversationUrl } from "./cdp.js";
import { resolveCdpEndpoint } from "./cdp-profile.js";

const commandSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("prepare"), handoff: z.string(),
    options: sessionOptionsSchema.extend({ taskId: sessionOptionsSchema.shape.taskId.optional() }).optional(),
    auto: z.literal(true).optional(), conversation: z.string().min(1).optional(),
  }).strict(),
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
  let sender: Awaited<ReturnType<typeof createCdpSender>> | undefined;
  let delivery: "not_sent" | "uncertain" | "sent" = "not_sent";
  let completed = false, interrupted = false, resultReceived = false;
  const startup = new AbortController();
  const stop = () => {
    if (completed) return;
    interrupted = true;
    startup.abort();
    sender?.interrupt();
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
        if (!session) {
          const options = command.options && { ...command.options, taskId: command.options.taskId ?? randomUUID() };
          if (command.auto) {
            if (!command.conversation) throw new CdpSendError("ASYNC_THREAD_REQUIRED", "not_sent");
            conversationUrl(command.conversation);
            const { hubId, workspaceId } = sessionOptionsSchema.parse(options);
            const endpoint = await resolveCdpEndpoint({ hubId, workspaceId }, startup.signal);
            if (startup.signal.aborted) throw new CdpSendError("ASYNC_INTERRUPTED", "not_sent");
            sender = await createCdpSender(command.conversation, endpoint);
          } else if (command.conversation) throw new Error("ASYNC_LOCAL_REQUEST_INVALID");
          session = new AuditSession(options);
        } else if (command.options || command.auto || command.conversation) throw new Error("ASYNC_OPTIONS_ALREADY_SET");
        if (interrupted) throw new Error("ASYNC_INTERRUPTED");
        resultReceived = false;
        const prepared = await session.prepare(command.handoff);
        if (interrupted) throw new Error("ASYNC_INTERRUPTED");
        let value;
        if (sender) {
          const waiting = session.wait();
          const receipt = waiting.then(value => ({ value }), error => ({ error }));
          try { await sender.send(prepared, command.handoff); delivery = "sent"; }
          catch (error) { await session.close(); await receipt; throw error; }
          const result = await receipt;
          if ("error" in result) throw result.error;
          value = result.value;
        } else { output(prepared); value = await session.wait(); }
        resultReceived = true;
        if (interrupted) throw new Error("ASYNC_INTERRUPTED");
        output(value);
        if (!value.canContinue) { completed = true; break; }
      }
    }
    if (interrupted || !completed) throw new Error("ASYNC_INTERRUPTED");
  } catch (error) {
    if (sender && !(error instanceof CdpSendError))
      throw new CdpSendError(error instanceof Error && /^ASYNC_[A-Z_]+(?:: [A-Z_]+)?$/.test(error.message) ? error.message : "ASYNC_CDP_FAILED", delivery);
    throw error;
  } finally {
    completed = true;
    lines.off("close", stop); lines.close();
    process.stdin.off("data", control);
    if (raw) process.stdin.setRawMode(false);
    process.stdin.destroy();
    process.off("SIGINT", stop); process.off("SIGTERM", stop);
    if (interrupted) sender?.interrupt();
    await session?.close();
    await sender?.close({ completed: resultReceived });
  }
}
