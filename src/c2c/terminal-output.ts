// Short ASCII lines survive Windows PTY wrapping; the digest detects missing or altered bytes.
export const TERMINAL_OUTPUT_LIMIT = 512 * 1024;
export const TERMINAL_OUTPUT_BEGIN = "C2C_JSON_V1";
export const TERMINAL_OUTPUT_END = "C2C_JSON_END";

/** Decode one complete controller response. Never print the returned callback envelope. */
export async function decodeTerminalOutput(output: string): Promise<unknown> {
  const invalid = () => new Error("ASYNC_TERMINAL_OUTPUT_INVALID");
  if (output.length > 2 * TERMINAL_OUTPUT_LIMIT) throw invalid();
  const text = output
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trim();
  const lines = text.split(/\r?\n/);
  const starts = lines.flatMap((line, i) => line.startsWith(TERMINAL_OUTPUT_BEGIN) ? [i] : []);
  const begin = starts[0] ?? -1, end = lines.indexOf(TERMINAL_OUTPUT_END);
  if (begin < 0) {
    if (end >= 0) throw invalid();
    try { return JSON.parse(text); } catch { throw invalid(); }
  }
  if (starts.length !== 1 || ![TERMINAL_OUTPUT_BEGIN + "_OK", TERMINAL_OUTPUT_BEGIN + "_ERROR"].includes(lines[begin]) ||
      lines.lastIndexOf(TERMINAL_OUTPUT_END) !== end || end < begin + 4)
    throw invalid();
  const [length, digest, ...chunks] = lines.slice(begin + 1, end);
  if (!/^[1-9]\d{0,5}$/.test(length) || Number(length) > TERMINAL_OUTPUT_LIMIT || !/^[a-f0-9]{64}$/.test(digest) ||
      !chunks.length || chunks.some((chunk, i) => !/^[A-Za-z0-9_-]{1,64}$/.test(chunk) || (i < chunks.length - 1 && chunk.length !== 64)))
    throw invalid();
  const encoded = chunks.join("");
  if (encoded.length !== Math.ceil(Number(length) * 4 / 3)) throw invalid();
  let bytes: Uint8Array<ArrayBuffer>;
  try { bytes = Uint8Array.from(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0)); }
  catch { throw invalid(); }
  if (bytes.length !== Number(length)) throw invalid();
  const checksum = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
  if (checksum !== digest) throw invalid();
  try {
    const result: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (typeof result !== "object" || result === null || (result as { ok?: unknown }).ok !== (lines[begin] === TERMINAL_OUTPUT_BEGIN + "_OK"))
      throw invalid();
    return result;
  }
  catch { throw invalid(); }
}
