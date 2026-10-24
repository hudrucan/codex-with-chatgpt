import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import ts from "typescript";
import { buildC2C } from "../../scripts/build-c2c.mjs";
import { localAccess } from "../../src/c2c/local.js";
import { Workspace } from "../../src/workspace/manager.js";
import { cleanup, makeGitRepo, makeTmpDir } from "../helpers.js";

it("builds only the self-contained local helper and rejects async before creating task state", async () => {
  const temp = makeTmpDir("c2c-local-build");
  try {
    const out = path.join(temp, "bundle"), root = path.join(temp, "repo"), state = path.join(temp, "state");
    fs.mkdirSync(root); makeGitRepo(root);
    await buildC2C(out);
    expect(fs.readdirSync(out)).toEqual(["local.mjs"]);
    const helper = path.join(out, "local.mjs");
    const file = ts.createSourceFile("local.mjs", fs.readFileSync(helper, "utf8"), ts.ScriptTarget.Latest, true);
    const imports: string[] = [];
    function visit(node: ts.Node) {
      if (ts.isImportDeclaration(node)) imports.push((node.moduleSpecifier as ts.StringLiteral).text);
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
        imports.push(ts.isStringLiteral(node.arguments[0]) ? node.arguments[0].text : "dynamic-package");
      ts.forEachChild(node, visit);
    }
    visit(file);
    expect(imports.every(value => value.startsWith("node:")), imports.join(", ")).toBe(true);
    const run = (operation: string, args: string[] = [], input?: unknown) => spawnSync(process.execPath, [helper, operation, ...args], {
      cwd: temp, env: { ...process.env, C2C_STATE_DIR: state }, encoding: "utf8", input: JSON.stringify(input), timeout: 10_000,
    });
    for (const options of [{ async: true }, { async: false }, {}]) {
      const response = run("async", [], options);
      expect(response.status, response.stderr).toBe("async" in options && options.async ? 1 : 0);
      const parsed = JSON.parse(response.stdout);
      if ("async" in options && options.async) {
        expect(parsed.ok).toBe(false);
        expect(parsed.error).toContain("ASYNC_CALLBACK_UNAVAILABLE");
      } else expect(parsed).toEqual({ ok: true, value: null });
      expect(fs.existsSync(state)).toBe(false);
    }
    const workspaceId = new Workspace(root).id;
    const source = run("fingerprint", [root, workspaceId]);
    expect(source.status, source.stderr).toBe(0);
    expect(JSON.parse(source.stdout).value).toBe(localAccess.sourceFingerprint(root, workspaceId));
    expect(run("claim", ["helper-task"]).status).toBe(0);
    const duplicate = run("claim", ["helper-task"]);
    expect(duplicate.status).toBe(1);
    expect(JSON.parse(duplicate.stdout).error).toContain("ASYNC_RESUME_UNSUPPORTED");
  } finally { cleanup(temp); }
});
