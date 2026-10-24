import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import ts from "typescript";
import { buildC2C } from "../../scripts/build-c2c.mjs";
import { Workspace } from "../../src/workspace/manager.js";
import { cleanup, makeGitRepo } from "../helpers.js";

it("builds self-contained entries and runs the browser bundle with the REPL's module/global restrictions", async () => {
  const temp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "c2c-repl-")));
  try {
    const out = path.join(temp, "bundle"), root = path.join(temp, "repo"); fs.mkdirSync(root); makeGitRepo(root);
    await buildC2C(out);
    for (const name of ["repl.mjs", "local.mjs"]) {
      const file = ts.createSourceFile(name, fs.readFileSync(path.join(out, name), "utf8"), ts.ScriptTarget.Latest, true);
      const imports: string[] = [];
      function visit(node: ts.Node) {
        if (ts.isImportDeclaration(node)) imports.push((node.moduleSpecifier as ts.StringLiteral).text);
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
          imports.push(ts.isStringLiteral(node.arguments[0]) ? node.arguments[0].text : "dynamic-package");
        ts.forEachChild(node, visit);
      }
      visit(file);
      expect(imports.every(value => value.startsWith("node:")), `${name}: ${imports.join(", ")}`).toBe(true);
      if (name === "repl.mjs") expect(imports).not.toContain("node:process");
    }
    const fixture = fileURLToPath(new URL("./fixtures/repl-runtime.mjs", import.meta.url));
    const result = spawnSync(process.execPath, ["--experimental-vm-modules", fixture,
      path.join(out, "repl.mjs"), path.join(out, "local.mjs"), root, new Workspace(root).id], {
      cwd: temp, env: { ...process.env, C2C_STATE_DIR: path.join(temp, "state") }, encoding: "utf8", timeout: 20_000,
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("REPL compatibility PASS");
  } finally { cleanup(temp); }
});
