import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { decodeTerminalOutput, TERMINAL_OUTPUT_LIMIT } from "../../src/c2c/terminal-output.js";
import { formatTerminalResult } from "../../src/c2c/terminal-result.js";

const response = { ok: true, value: { attemptId: "fixture-attempt", message: "[C2C Handoff]\nTiếng Việt 🪟\n".repeat(900), remainingMs: 600000 } };

it.each([false, true])("preserves a complete Unicode envelope through tty=%s", async tty => {
  const output = formatTerminalResult(response, tty);
  expect(await decodeTerminalOutput(output)).toEqual(response);
  if (tty) expect(output.split(/\r?\n/).every(line => line.length <= 64)).toBe(true);
  else expect(output).toBe(JSON.stringify(response) + "\n");
});

it("survives 80-column PTY wrapping and terminal controls without changing the envelope", async () => {
  const wrap = (text: string) => text.split(/\r?\n/).map(line => line.match(/.{1,80}/g)?.join("\r\n") ?? "").join("\r\n");
  const captured = "\x1b[2J\x1b[m\x1b[H\x1b]0;Fixture terminal\x07" + wrap(formatTerminalResult(response, true)) + "\x1b[K";
  expect(await decodeTerminalOutput(captured)).toEqual(response);
  await expect(decodeTerminalOutput(wrap(formatTerminalResult(response, false)))).rejects.toThrow("ASYNC_TERMINAL_OUTPUT_INVALID");
});

it.each(["missing chunk", "changed chunk", "reordered chunks", "missing footer", "duplicate response", "invalid length", "invalid digest", "changed status"])(
  "fails closed on %s without returning a partial envelope", async kind => {
    const output = formatTerminalResult(response, true);
    const lines = output.split("\r\n");
    if (kind === "missing chunk") lines.splice(4, 1);
    if (kind === "changed chunk") lines[4] = (lines[4][0] === "A" ? "B" : "A") + lines[4].slice(1);
    if (kind === "reordered chunks") [lines[4], lines[5]] = [lines[5], lines[4]];
    if (kind === "missing footer") lines.splice(-2, 1);
    if (kind === "duplicate response") lines.push(output);
    if (kind === "invalid length") lines[2] = String(TERMINAL_OUTPUT_LIMIT + 1);
    if (kind === "invalid digest") lines[3] = "0".repeat(64);
    if (kind === "changed status") lines[1] = "C2C_JSON_V1_ERROR";
    await expect(decodeTerminalOutput(lines.join("\r\n"))).rejects.toThrow("ASYNC_TERMINAL_OUTPUT_INVALID");
  },
);

it("rejects oversized output and invalid UTF-8 even when its digest matches", async () => {
  expect(() => formatTerminalResult({ ok: true, value: "a".repeat(TERMINAL_OUTPUT_LIMIT) }, true)).toThrow("ASYNC_TERMINAL_OUTPUT_INVALID");
  await expect(decodeTerminalOutput("a".repeat(2 * TERMINAL_OUTPUT_LIMIT + 1))).rejects.toThrow("ASYNC_TERMINAL_OUTPUT_INVALID");
  const bytes = Buffer.from([0x22, 0xff, 0x22]);
  const invalid = ["C2C_JSON_V1_OK", String(bytes.length), createHash("sha256").update(bytes).digest("hex"), bytes.toString("base64url"), "C2C_JSON_END"].join("\n");
  await expect(decodeTerminalOutput(invalid)).rejects.toThrow("ASYNC_TERMINAL_OUTPUT_INVALID");
});

it("preserves controller error responses and refuses to guess truncated JSON", async () => {
  const error = { ok: false, error: "ASYNC_RESUME_UNSUPPORTED: This task is already claimed; stop async and use the manual workflow." };
  expect(await decodeTerminalOutput(formatTerminalResult(error, true))).toEqual(error);
  await expect(decodeTerminalOutput('{"ok":true,"value":')).rejects.toThrow("ASYNC_TERMINAL_OUTPUT_INVALID");
});

it("keeps short READY responses readable before browser setup", async () => {
  const ready = { ok: true, value: { status: "READY" } };
  expect(formatTerminalResult(ready, true)).toBe(JSON.stringify(ready) + "\n");
  expect(await decodeTerminalOutput(formatTerminalResult(ready, true))).toEqual(ready);
});
