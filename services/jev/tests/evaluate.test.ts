import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Evaluator, MODEL, RESERVED_TOKENS } from "../src/evaluate.js";
import { initialize, lockState, readPrivate, validateStateDir, writePrivate, configSchema } from "../src/state.js";
import { sampleInput } from "../src/verify.js";
import { fixture, response } from "./fixtures.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function setup() { const f = fixture(); cleanups.push(f.cleanup); return f; }
const apiKey = "test-typesafe-api-key-never-return";

describe("Jev evaluation boundary", () => {
  it("batches all primitives against a pinned API and returns only validated structured results", async () => {
    const f = setup();
    const request = vi.fn<typeof fetch>(async () => Response.json({ ...response(), debug: apiKey }));
    const evaluator = new Evaluator(f.directory, f.config, apiKey, request);
    const actual = await evaluator.evaluate(sampleInput);
    expect(actual).toMatchObject({ ...response(), advisoryOnly: true, budget: { attempts: 1, reservedTokens: RESERVED_TOKENS } });
    expect(JSON.stringify(actual)).not.toContain(apiKey);
    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init?.redirect).toBe("error");
    expect(init?.headers).toEqual({ Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" });
    expect(JSON.parse(init!.body as string)).toEqual({ model: MODEL, state: sampleInput.state, questions: sampleInput.questions });
  });

  it.each([
    { ...sampleInput, model: "jev-latest" },
    { ...sampleInput, questions: {} },
    { ...sampleInput, state: "x".repeat(16384) },
    { ...sampleInput, state: apiKey },
    { ...sampleInput, state: "-----BEGIN PRIVATE KEY-----" },
    { ...sampleInput, state: JSON.parse('{"__proto__":"secret"}') },
    { ...sampleInput, state: { $asset: "https://private.example" } },
    { ...sampleInput, questions: { q: { type: "choice", instructions: "Choose", criteria: { one: "one" } } } },
    { ...sampleInput, state: Array.from({ length: 14 }).reduce((a) => [a], [] as unknown[]) },
  ])("rejects invalid/oversized/secret inputs without spending", async (input) => {
    const f = setup();
    const request = vi.fn<typeof fetch>();
    await expect(new Evaluator(f.directory, f.config, apiKey, request).evaluate(input)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(path.join(f.directory, "budget.json"), "utf8")).attempts).toBe(0);
  });

  it.each([429, 500, 302])("does not retry or expose provider bodies on HTTP %i", async (status) => {
    const f = setup();
    const request = vi.fn<typeof fetch>(async () => new Response(apiKey, { status }));
    await expect(new Evaluator(f.directory, f.config, apiKey, request).evaluate(sampleInput)).rejects.toThrow(`HTTP ${status}`);
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(path.join(f.directory, "budget.json"), "utf8")).reservedTokens).toBe(RESERVED_TOKENS);
  });

  it.each(["model", "missing", "probabilities", "choice", "score", "oversized"])("rejects invalid upstream result: %s", async (variant) => {
    const f = setup();
    const raw = response();
    if (variant === "model") raw.model = "jev-latest";
    if (variant === "missing") delete (raw.answers as Record<string, unknown>).helps_reads;
    if (variant === "probabilities") raw.answers.tradeoff.probabilities.memory = 0.1;
    if (variant === "choice") raw.answers.tradeoff.choice = "other";
    if (variant === "score") raw.answers.evidence.score = 9;
    const request = vi.fn<typeof fetch>(async () => variant === "oversized" ? new Response("x".repeat(65537)) : Response.json(raw));
    await expect(new Evaluator(f.directory, f.config, apiKey, request).evaluate(sampleInput)).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("retains spending reservations across timeouts and process restarts", async () => {
    const f = setup();
    const request = vi.fn<typeof fetch>(async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new Error(apiKey)));
    }));
    await expect(new Evaluator(f.directory, { ...f.config, dailyAttempts: 1 }, apiKey, request, 5).evaluate(sampleInput)).rejects.toThrow("reservation retained");
    await expect(new Evaluator(f.directory, { ...f.config, dailyAttempts: 1 }, apiKey, request).evaluate(sampleInput)).rejects.toThrow("Daily Jev spending limit");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("blocks concurrent paid dispatch and fails closed on missing or corrupt budgets", async () => {
    const f = setup();
    let finish!: (response: Response) => void;
    const request = vi.fn<typeof fetch>(async () => new Promise((resolve) => { finish = resolve; }));
    const evaluator = new Evaluator(f.directory, f.config, apiKey, request);
    const first = evaluator.evaluate(sampleInput);
    await expect(evaluator.evaluate(sampleInput)).rejects.toThrow("already in progress");
    finish(Response.json(response()));
    await first;
    fs.unlinkSync(path.join(f.directory, "budget.json"));
    await expect(evaluator.evaluate(sampleInput)).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("Jev state isolation", () => {
  it("rejects initialization inside any Git checkout before writing runtime data", () => {
    const f = setup();
    const root = path.dirname(f.directory);
    fs.mkdirSync(path.join(root, ".git"));
    const target = path.join(root, "other-state");
    expect(() => initialize(target, f.config)).toThrow("outside Git");
    expect(fs.existsSync(target)).toBe(false);
  });

  it("does not adopt existing state, symlinks, permissive credentials, or a second process", () => {
    const f = setup();
    expect(() => initialize(f.directory, f.config)).toThrow();
    const unlock = lockState(f.directory);
    expect(() => lockState(f.directory)).toThrow("locked");
    unlock();
    const alias = path.join(f.directory, "alias");
    fs.symlinkSync(f.directory, alias);
    expect(() => validateStateDir(alias)).toThrow();
    const file = path.join(f.directory, "config.json");
    fs.chmodSync(file, 0o644);
    expect(() => readPrivate(file, configSchema)).toThrow("0600");
    expect(() => writePrivate(file, f.config)).toThrow("0600");
  });
});
