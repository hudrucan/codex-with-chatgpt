import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8").replace(/\s+/g, " ");

it("keeps standalone Local/Web references reachable without Lazier", () => {
  for (const dir of ["skill", "web-skill"]) {
    for (const name of fs.readdirSync(path.join(root, dir))) {
      if (!name.endsWith(".md")) continue;
      if (dir === "web-skill") continue; // Web references are supplied by the package builder.
      for (const [, target] of read(`${dir}/${name}`).matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        if (target.includes("://")) continue;
        expect(fs.statSync(path.resolve(root, dir, target.split("#")[0])).isFile()).toBe(true);
      }
    }
  }
  expect(read("skill/SKILL.md")).toContain("works without Lazier");
});

it("assigns planning/audit and target selection to Web without repeating audit or approval gates", () => {
  const common = read("skill/references/workflow.md");
  expect(common).toContain("Web owns planning and auditing");
  expect(common).toContain("Codex trusts Web's supplied audit findings");
  expect(common).toContain("before exporting the prompt");
  expect(common).toContain("Codex must not ask again");
  expect(common).toContain("audit PASS grants no deployment permission");
  expect(common).toContain("Do not stop between authorized steps");
  expect(common).toContain("four short lines");
  expect(common).toContain("callback envelope are generated internally");
  expect(common).toContain("Omitted `auto` or `auto=false` means manual");
  for (const file of ["skill/SKILL.md", "web-skill/SKILL.md", "skill/references/workflow-web.md"])
    expect(read(file)).toMatch(/Web owns planning/);
});

it("documents one direct CDP sender with immutable target, internal ticket and terminal callback", () => {
  const sender = read("skill/references/workflow-async.md");
  for (const text of ["C2C_CDP_ENDPOINT", "user's conversation URL/ID", "Codex never asks again", "pins its CDP session and route",
    '"auto":true', "prepare → send once → MCP callback → result", "Tickets never leave the controller",
    "C2C_CALLBACK", "C2C_DEADLINE", "verifySourceForFix", "canAutoFix:true", "three audits/two fixes",
    "600-second maximum deadline", "source fingerprints", "replay guards", "event-driven", "not_sent", "uncertain", "sent",
    "stop automation without resending", "never retry registration, delivery or callback waiting", "matching terminal receipt"])
    expect(sender, text).toContain(text);
  for (const file of ["skill/references/workflow.md", "skill/references/workflow-async.md", "skill/SKILL.md"])
    expect(read(file)).not.toMatch(/browser\.user|createBrowserSender|verifyBinding|initialization recovery|reset\/rebind/);
});

it("preserves receiver correlation, OAuth result schema and bounded MCP recovery", () => {
  const receiver = read("skill/references/workflow-web.md");
  for (const field of ["hubId", "workspaceId", "taskId", "attemptId", "handoffId", "capability", "submit_audit_result",
    "complete:true", "findings", "16,384 UTF-8 bytes", "accepted:true", "matching terminal receipt", "No retry after `accepted:true`"])
    expect(receiver, field).toContain(field);
});
