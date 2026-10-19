import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import { Workspace } from "../../src/workspace/manager.js";
import { searchWorkspace, resetRipgrepCache, findRipgrep } from "../../src/workspace/search.js";
import { makeTmpDir, cleanup, write } from "../helpers.js";

vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

let root: string;
let ws: Workspace;
const globMarker = "C2C_GLOB_MARKER";

beforeAll(() => {
  root = makeTmpDir("search-ws");
  write(root, "src/auth.ts", "export function login() { return 'needle-alpha'; }\n");
  write(root, "src/deep/nested.ts", `// needle-alpha appears here too\n${globMarker}\n`);
  write(root, "src/root.ts", `${globMarker}\n`);
  write(root, "root.ts", `${globMarker}\n`);
  write(root, "README.md", "This project contains needle-alpha documentation.\n");
  write(root, "dense.txt", "dense-marker\n".repeat(25));
  write(root, "boundary.txt", "boundary-marker\n".repeat(3));
  write(root, "node_modules/pkg/hidden.txt", "boundary-marker\n");
  write(root, ".env", "NEEDLE-ALPHA=secret\n");
  write(root, "node_modules/pkg/index.js", "needle-alpha in dependencies\n");
  for (let i = 0; i < 30; i++) {
    write(root, `many/file-${i}.txt`, "needle-beta\nneedle-beta\n");
  }
  ws = new Workspace(root);
});

afterAll(() => {
  cleanup(root);
});

afterEach(() => {
  delete process.env.C2C_DISABLE_RG;
  delete process.env.C2C_RG_PATH;
  vi.mocked(spawn).mockReset();
  resetRipgrepCache();
});

function engines(): ("ripgrep" | "node")[] {
  return findRipgrep() ? ["ripgrep", "node"] : ["node"];
}

describe.each(engines())("search engine: %s", (engine) => {
  const configure = (): void => {
    if (engine === "node") process.env.C2C_DISABLE_RG = "1";
    resetRipgrepCache();
  };

  it("finds matches with paths and line numbers", async () => {
    configure();
    const result = await searchWorkspace(ws, { query: "needle-alpha" });
    expect(result.engine).toBe(engine);
    const paths = result.matches.map((match) => match.path);
    expect(paths).toContain("src/auth.ts");
    expect(paths).toContain("src/deep/nested.ts");
    expect(paths).toContain("README.md");
    const authMatch = result.matches.find((match) => match.path === "src/auth.ts");
    expect(authMatch?.line).toBe(1);
  });

  it("returns an empty successful result for no matches", async () => {
    configure();
    expect(await searchWorkspace(ws, { query: "no-such-marker-734982" })).toEqual({
      matches: [], matchCount: 0, truncated: false, engine,
    });
  });

  it.each(["[", "[z-a]"])("rejects invalid regex %s with the same typed error in either engine", async query => {
    configure();
    await expect(searchWorkspace(ws, { query, regex: true })).rejects.toMatchObject({
      name: "SearchError", code: "INVALID_REGEX", message: "Invalid regular expression.",
    });
  });

  it("never returns sensitive or noise files", async () => {
    configure();
    const result = await searchWorkspace(ws, { query: "needle-alpha" });
    const paths = result.matches.map((match) => match.path);
    expect(paths.some((p) => p.includes(".env"))).toBe(false);
    expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
  });

  it("respects the limit", async () => {
    configure();
    const result = await searchWorkspace(ws, { query: "needle-beta", limit: 10 });
    expect(result.matches.length).toBeLessThanOrEqual(10);
    expect(result.truncated).toBe(true);
  });

  it("supports glob filters", async () => {
    configure();
    const result = await searchWorkspace(ws, { query: "needle-alpha", glob: "*.md" });
    const paths = result.matches.map((match) => match.path);
    expect(paths).toContain("README.md");
    expect(paths.some((p) => p.endsWith(".ts"))).toBe(false);
  });

  it("returns more than 20 matches from a single file below the global limit", async () => {
    configure();
    const result = await searchWorkspace(ws, { query: "dense-marker", limit: 50 });
    expect(result.engine).toBe(engine);
    expect(result.matchCount).toBe(25);
    expect(result.matches.map((match) => match.line)).toEqual(
      Array.from({ length: 25 }, (_, i) => i + 1)
    );
    expect(result.truncated).toBe(false);
  });

  it.each([1, 3, 4])("reports truncation only when visible matches exceed limit %i", async (limit) => {
    configure();
    const result = await searchWorkspace(ws, { query: "boundary-marker", limit });
    expect(result.engine).toBe(engine);
    expect(result.matchCount).toBe(Math.min(3, limit));
    expect(result.matches).toHaveLength(Math.min(3, limit));
    expect(result.matches.every((match) => match.path === "boundary.txt")).toBe(true);
    expect(result.truncated).toBe(limit < 3);
  });

  it("reports truncation for a dense file exceeding the global limit", async () => {
    configure();
    const result = await searchWorkspace(ws, { query: "dense-marker", limit: 22 });
    expect(result.engine).toBe(engine);
    expect(result.matchCount).toBe(22);
    expect(result.matches).toHaveLength(22);
    expect(result.truncated).toBe(true);
  });

  it("matches root and nested files for recursive globs", async () => {
    configure();
    const result = await searchWorkspace(ws, { query: globMarker, glob: "**/*.ts" });
    const paths = result.matches.map((match) => match.path).sort();
    expect(paths).toEqual(["root.ts", "src/deep/nested.ts", "src/root.ts"]);
  });

  it("restricts search to a subdirectory", async () => {
    configure();
    const result = await searchWorkspace(ws, { query: "needle-alpha", path: "src" });
    const paths = result.matches.map((match) => match.path);
    expect(paths).toContain("src/auth.ts");
    expect(paths).not.toContain("README.md");
  });
});

describe("ripgrep process failures", () => {
  async function useProcess(script: string) {
    process.env.C2C_RG_PATH = "test-ripgrep";
    resetRipgrepCache();
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    vi.mocked(spawn).mockImplementationOnce((_, args, options) => actual.spawn(process.execPath, ["-e", script], options));
  }
  const match = () => JSON.stringify({ type: "match", data: {
    path: { text: path.join(root, "README.md") }, line_number: 1, lines: { text: "needle-alpha" },
  } });

  it.each([2, 7])("rejects exit %i even after partial output instead of silently falling back", async code => {
    await useProcess(`process.stdout.write(${JSON.stringify(match() + "\n")}); process.exitCode = ${code};`);
    await expect(searchWorkspace(ws, { query: "needle-alpha" })).rejects.toMatchObject({ name: "SearchError", code: "SEARCH_FAILED" });
  });

  it.each(["missing-ripgrep", "invalid\0ripgrep"])("reports spawn failure for %j as a typed error instead of returning Node fallback matches", async binary => {
    process.env.C2C_RG_PATH = path.join(root, binary); resetRipgrepCache();
    await expect(searchWorkspace(ws, { query: "needle-alpha" })).rejects.toMatchObject({ name: "SearchError", code: "SEARCH_FAILED" });
  });

  it("accepts an intentional limit kill but rejects an unsolicited termination", async () => {
    await useProcess(`process.stdout.write(${JSON.stringify(match() + "\n" + match() + "\n")}); setInterval(() => {}, 1000);`);
    expect(await searchWorkspace(ws, { query: "needle-alpha", limit: 1 })).toMatchObject({ engine: "ripgrep", matchCount: 1, truncated: true });
    await useProcess('process.kill(process.pid, "SIGTERM");');
    await expect(searchWorkspace(ws, { query: "needle-alpha" })).rejects.toMatchObject({ name: "SearchError", code: "SEARCH_FAILED" });
  });
});
