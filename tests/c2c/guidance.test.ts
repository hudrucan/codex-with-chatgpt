import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { cleanup, makeTmpDir } from "../helpers.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const guidance = (name: string) => fs.readFileSync(path.join(root, "skill", name), "utf8").replace(/\s+/g, " ");

it("keeps host/mode guidance reachable inside a standalone installed Skill", () => {
  const temp = makeTmpDir("c2c-installed-guidance");
  try {
    const installed = path.join(temp, "codex-with-chatgpt");
    fs.cpSync(path.join(root, "skill"), installed, { recursive: true });
    const manifest = path.join(installed, "SKILL.md");
    const checkout = path.join(temp, "checkout with spaces");
    fs.mkdirSync(checkout);
    const original = fs.readFileSync(manifest, "utf8");
    expect(original.match(/<ACTUAL_CHECKOUT_PATH>/g)).toHaveLength(1);
    fs.writeFileSync(manifest, original.replace("<ACTUAL_CHECKOUT_PATH>", checkout));
    expect(fs.readFileSync(manifest, "utf8")).toContain(`Checkout: \`${checkout}\``);
    const visit = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const source = path.join(directory, entry.name);
        if (entry.isDirectory()) { visit(source); continue; }
        if (!source.endsWith(".md")) continue;
        for (const [, target] of fs.readFileSync(source, "utf8").matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
          if (target.includes("://")) continue;
          const [file, fragment] = target.split("#");
          const resolved = fs.realpathSync(file ? path.resolve(directory, file) : source);
          expect(path.relative(installed, resolved).startsWith(".."), target).toBe(false);
          expect(fs.statSync(resolved).isFile(), target).toBe(true);
          if (fragment) {
            const headings = [...fs.readFileSync(resolved, "utf8").matchAll(/^#+ (.+)$/gm)]
              .map(([, heading]) => heading.toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, "").replace(/ /g, "-"));
            expect(headings, target).toContain(fragment);
          }
        }
      }
    };
    visit(installed);
    // Procedures remain reachable after installation without eagerly loading setup for handoffs.
    const entry = fs.readFileSync(manifest, "utf8");
    const localTargets = [...entry.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map(([, target]) => target);
    expect(localTargets).toEqual(expect.arrayContaining([
      "references/setup.md", "references/workflow.md", "references/workflow-web.md", "references/workflow-async.md",
    ]));
    expect(entry).not.toContain("c2c setup -w");
    expect(entry).not.toContain("c2c connector bind --name");
    const setup = fs.readFileSync(path.join(installed, "references/setup.md"), "utf8");
    expect(setup).toContain("c2c setup -w");
    expect(setup).toContain("c2c connector bind --name");
    const common = guidance("references/workflow.md");
    expect(common).toContain("works without Lazier");
    expect(common).toContain("workflow-web.md");
    expect(common).toContain("workflow-async.md");
    expect(common).toContain("Manual Codex handoffs need no sender/receiver reference");
    expect(common).not.toContain("callback register");
    expect(guidance("references/workflow-web.md")).not.toContain("createBrowserSender");
  } finally { cleanup(temp); }
});

it("keeps repository backlinks valid after moving connection procedures", () => {
  for (const name of ["docs/lifecycle.md", "docs/troubleshooting.md", "README.md"]) {
    const source = path.join(root, name);
    for (const [, target] of fs.readFileSync(source, "utf8").matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      if (target.includes("://") || target.startsWith("#")) continue;
      const [file, fragment] = target.split("#");
      const resolved = path.resolve(path.dirname(source), file);
      expect(fs.statSync(resolved).isFile(), target).toBe(true);
      if (fragment) {
        const headings = [...fs.readFileSync(resolved, "utf8").matchAll(/^#+ (.+)$/gm)]
          .map(([, heading]) => heading.toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, "").replace(/ /g, "-"));
        expect(headings, target).toContain(fragment);
      }
    }
  }
});

it("preserves marker, routing, context and concise handoff boundaries", () => {
  const common = guidance("references/workflow.md");
  for (const requirement of [
    "exact first line", "[C2C Plan]", "[C2C Task]", "[C2C Fix]", "[C2C Commit]", "[C2C Handoff]",
    "full base/HEAD SHAs", "staged, unstaged and untracked scope",
    "guidance already read and still valid in this session",
    "matching connector/workspace routing block", "Never borrow another routing block's Hub",
    "separating verified findings, assumptions and open questions", "inspect current source before editing",
    "Preserve routing and an already-selected `async=true`", "Never switch to manual",
    "Markers execute nothing and grant no permissions", "unrun checks", "observed acceptance",
    "without browser, Hub, claim or callback state access", "callback envelope stays complete",
  ]) expect(common, requirement).toContain(requirement);
  const receiver = guidance("references/workflow-web.md");
  for (const requirement of [
    "triggers an audit through C2C MCP without a separate audit request",
    "explicit registered workspace on every call", "workspace_info", "git_status", "git_log",
    'mode="head"', "read_file", "git_show", "full SHAs", "first parent", "pagination/snapshot",
    "Trust Codex's local validation for the tested revision", "specific uncovered risk",
    "no code changes", "Missing evidence", "not retry", "C2C_CALLBACK", "submit_audit_result",
    "unchanged from this new ticket", "first repository-read MCP failure", "`status`", "`complete:true`",
    "`summary`", "`findings`", "`PASS`", "`FIX`", "`BLOCKED`", "`ERROR`",
    "positive integer `line`", "16,384 UTF-8 bytes", "accepted:true", "matching terminal receipt",
    "no legacy audit frames, ACKs or Fix/Commit prompts", "Do not repeat the same result",
  ]) expect(receiver, requirement).toContain(requirement);
});

it("reuses only permission evidence while retaining every async attempt gate", () => {
  const sender = guidance("references/workflow-async.md");
  for (const requirement of [
    "runtime identity, Hub owner, connector and permissions are known unchanged",
    "Probe again after restart/rollout", "permission or connector changes", "permission errors",
    "missing/uncertain evidence", "never a ticket/capability", "every attempt still registers",
    "ownership, permission, source, deadline, claim and send-once checks",
    "each repository with its own correctly routed workspace/root", "A fingerprint for one repository proves nothing about another",
    "do not extend the controller for batch work", "tty=true", "write_stdin", "READY",
    "Only then may delivery start", "complete envelope", "C2C_CALLBACK", "exactly once",
    "verifySourceForFix", "canAutoFix:true", "same process", "three audits/two fixes",
    "180-second maximum deadline", "acknowledgement never restarts it", "Lost sessions cannot resume",
    "without resending", "accepted:true", "matching result", "EPERM", "denial keeps async disabled",
    "Do not change sandbox settings", "newline alone does not complete", "explicit reauthorization",
  ]) expect(sender, requirement).toContain(requirement);
});
