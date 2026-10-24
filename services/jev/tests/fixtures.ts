import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initialize, type Config, credentialsSchema, readPrivate } from "../src/state.js";
import { MODEL } from "../src/evaluate.js";

export function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jev-test-"));
  const directory = path.join(root, "state");
  const config: Config = { version: 1, service: "jev-mcp", mcpName: "jev-test", publicUrl: "https://jev.example.com", port: 49873 };
  initialize(directory, config);
  const credentials = readPrivate(path.join(directory, "credentials.json"), credentialsSchema);
  return { directory, config, credentials, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

export const response = () => ({ model: MODEL, answers: {
  helps_reads: { type: "noul", noul: 0.95 },
  tradeoff: { type: "choice", choice: "memory", confidence: 0.7, probabilities: { memory: 0.8, disk: 0.2 } },
  evidence: { type: "score", score: 0.8, confidence: 0.6, probabilities: { "0": 0.2, "1": 0.8 }, legend: { "0": "No tradeoff described", "1": "An explicit benefit and cost are described" } },
}, usage: { input_tokens: 123, output_tokens: 12 } });
