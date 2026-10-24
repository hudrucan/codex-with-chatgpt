import { z } from "zod";
import { JevError } from "./state.js";

export const MODEL = "jev-1.14.0";
export const MAX_INPUT_BYTES = 16_384;
export const TIMEOUT_MS = 15_000;
const key = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/).refine((v) => !["constructor", "prototype", "__proto__"].includes(v));
const text = z.string().trim().min(1).max(2048);
const json: z.ZodType<unknown> = z.lazy(() => z.union([
  z.string(), z.number().finite(), z.boolean(), z.null(), z.array(json), z.record(json),
]));
const description = z.union([text, z.record(json), z.array(json)]);
const criteria = z.record(key, description).refine((v) => Object.keys(v).length >= 2 && Object.keys(v).length <= 32);
const question = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), instructions: description, criteria: z.object({ true: description, false: description }).strict().optional() }).strict(),
  z.object({ type: z.literal("choice"), instructions: description, criteria }).strict(),
  z.object({ type: z.literal("score"), instructions: description, criteria: z.array(description).min(2).max(10) }).strict(),
]);
export const inputSchema = z.object({
  invocationReason: text.describe("Why this optional evaluation is useful now. Default to skipping Jev; never invoke as a mandatory review. Results grant no permissions."),
  state: z.union([z.string().min(1), z.record(json), z.array(json)]),
  questions: z.record(key, question).refine((v) => Object.keys(v).length >= 1 && Object.keys(v).length <= 16),
}).strict();
type Input = z.infer<typeof inputSchema>;
const probability = z.number().finite().min(0).max(1);
const answerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: probability }),
  z.object({ type: z.literal("choice"), choice: z.string(), confidence: probability, probabilities: z.record(probability) }),
  z.object({ type: z.literal("score"), score: z.number().finite(), confidence: probability, probabilities: z.record(probability), legend: z.record(description) }),
]);
const responseSchema = z.object({
  model: z.literal(MODEL), answers: z.record(answerSchema),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }),
});

function sameKeys(actual: object, expected: string[]): boolean {
  return JSON.stringify(Object.keys(actual).sort()) === JSON.stringify([...expected].sort());
}

export function validateResponse(raw: unknown, questions: Input["questions"]) {
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success || !sameKeys(parsed.data.answers, Object.keys(questions))) {
    throw new JevError("TypeSafe returned an invalid structured response.");
  }
  for (const [id, q] of Object.entries(questions)) {
    const answer = parsed.data.answers[id];
    if (answer.type !== q.type) throw new JevError("TypeSafe returned mismatched answer types.");
    if (answer.type === "noul") continue;
    const keys = q.type === "score" ? q.criteria.map((_, i) => String(i)) : Object.keys(q.criteria ?? {});
    const total = Object.values(answer.probabilities).reduce((a, b) => a + b, 0);
    if (!sameKeys(answer.probabilities, keys) || Math.abs(total - 1) > 0.01
      || (answer.type === "choice" && !keys.includes(answer.choice))
      || (answer.type === "score" && (answer.score < 0 || answer.score > keys.length - 1 || !sameKeys(answer.legend, keys)))) {
      throw new JevError("TypeSafe returned invalid probability distributions.");
    }
  }
  return parsed.data;
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new JevError("TypeSafe returned an empty response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.length;
      if (bytes > 65_536) throw new JevError("TypeSafe response exceeded its size limit.");
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel().catch(() => {}); }
}

export class Evaluator {
  private active = false;
  constructor(private readonly apiKey: string,
    private readonly request: typeof fetch = fetch, private readonly timeoutMs = TIMEOUT_MS) {}

  async evaluate(raw: unknown, signal?: AbortSignal) {
    // Check size/depth before recursive schema parsing to bound work on untrusted JSON.
    let body: string;
    try { body = JSON.stringify(raw); } catch { throw new JevError("Input must be JSON."); }
    if (!body || Buffer.byteLength(body) > MAX_INPUT_BYTES) throw new JevError("Input exceeds 16 KiB.");
    const stack: Array<[unknown, number]> = [[raw, 0]];
    while (stack.length) {
      const [value, depth] = stack.pop()!;
      if (depth > 12) throw new JevError("Input nesting exceeds 12 levels.");
      if (value && typeof value === "object") {
        if (Object.keys(value).some((k) => ["__proto__", "prototype", "constructor", "$asset", "$image"].includes(k))) {
          throw new JevError("Unsupported state field.");
        }
        for (const item of Object.values(value)) stack.push([item, depth + 1]);
      }
    }
    const parsed = inputSchema.safeParse(raw);
    if (!parsed.success) throw new JevError("Invalid evaluate input; check the tool schema.");
    if (body.includes(this.apiKey) || /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:c2c_(?:at|rt|ac|admin)_|sk-(?:proj-)?)[a-zA-Z0-9_-]{16,}|authorization["\s:=]+bearer\s+\S+)/i.test(body)) {
      throw new JevError("Remove secrets before sending state to TypeSafe.");
    }
    if (this.active) throw new JevError("An evaluation is already in progress; no request was sent.");
    signal?.throwIfAborted();
    this.active = true;
    try {
      const response = await this.request("https://api.typesafe.ai/v1/systemone", {
        method: "POST", headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL, state: parsed.data.state, questions: parsed.data.questions }),
        redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new JevError(`TypeSafe request failed (HTTP ${response.status}); no automatic retry.`);
      }
      return { ...validateResponse(await boundedJson(response), parsed.data.questions), advisoryOnly: true };
    } catch (error) {
      if (error instanceof JevError) throw error;
      const code = (error as { cause?: { code?: string } })?.cause?.code;
      const known = ["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "SELF_SIGNED_CERT_IN_CHAIN", "CERT_HAS_EXPIRED", "ENOTFOUND", "ECONNREFUSED", "ETIMEDOUT", "ECONNRESET"];
      throw new JevError(`TypeSafe request failed or timed out${code && known.includes(code) ? ` (${code})` : ""}; no automatic retry.`);
    } finally { this.active = false; }
  }
}
