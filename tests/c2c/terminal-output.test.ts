import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { decodeTerminalOutput, TERMINAL_OUTPUT_LIMIT } from "../../src/c2c/terminal-output.js";
import { formatTerminalResult } from "../../src/c2c/terminal-result.js";

const response = { ok: true, value: { ticket: {
  hubId: "hub-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", workspaceId: "abcdef012345", taskId: "authorized-task",
  attemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", handoffId: "b".repeat(64), capability: "a".repeat(64),
}, remainingMs: 600000, expiresAt: 1800000000000 } };

it.each([false, true])("preserves the complete compact ticket through tty=%s", async tty => {
  const output = formatTerminalResult(response, tty);
  expect(await decodeTerminalOutput(output)).toEqual(response);
  if (tty) expect(output.split(/\r?\n/).every(line => line.length <= 64)).toBe(true);
  else expect(output).toBe(JSON.stringify(response) + "\n");
});

it("preserves Unicode audit findings without returning the handoff", async () => {
  const result = { ok: true, value: { status: "FIX", complete: true, summary: "Audit 🪟", findings: [
    { file: "src/index.ts", line: 1, evidence: "Unicode evidence 🪟".repeat(50), fix: "Scoped fix" },
  ], canContinue: true } };
  expect(await decodeTerminalOutput(formatTerminalResult(result, true))).toEqual(result);
});

it.each([20, 37, 63, 80])("survives simulated %i-column wrapping and terminal controls without changing the envelope", async columns => {
  const wrap = (text: string) => text.split(/\r?\n/).map(line => line.match(new RegExp(`.{1,${columns}}`, "g"))?.join("\r\n") ?? "").join("\r\n");
  const captured = "\x1b[2J\x1b[m\x1b[H\x1b]0;Fixture terminal\x07" + wrap(formatTerminalResult(response, true)) + "\x1b[K";
  expect(await decodeTerminalOutput(captured)).toEqual(response);
  await expect(decodeTerminalOutput(wrap(formatTerminalResult(response, false)))).rejects.toThrow("ASYNC_TERMINAL_OUTPUT_INVALID");
});

it("accepts ConPTY row padding and carriage returns only after verifying the complete frame", async () => {
  const output = formatTerminalResult(response, true).split("\r\n")
    .map(line => "\r" + line.padEnd(80, " ") + "\b").join("\r\n");
  expect(await decodeTerminalOutput(output)).toEqual(response);
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
  const error = { ok: false, error: "ASYNC_CALLBACK_TRANSPORT_UNAVAILABLE: EPERM" };
  expect(await decodeTerminalOutput(formatTerminalResult(error, true))).toEqual(error);
  await expect(decodeTerminalOutput('{"ok":true,"value":')).rejects.toThrow("ASYNC_TERMINAL_OUTPUT_INVALID");
});

it("frames short fix authorization and error responses on TTYs as well", async () => {
  const verified = { ok: true, value: { canAutoFix: true } };
  expect(formatTerminalResult(verified, true)).toContain("C2C_JSON_V1_OK");
  expect(await decodeTerminalOutput(formatTerminalResult(verified, true))).toEqual(verified);
  expect(formatTerminalResult({ ok: false, error: "ASYNC_TIMEOUT" }, true)).toContain("C2C_JSON_V1_ERROR");
});
