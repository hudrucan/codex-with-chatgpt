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
  for (const name of ["docs/architecture.md", "docs/security.md", "docs/lifecycle.md", "docs/troubleshooting.md", "README.md"]) {
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
    "Preserve routing and an already-selected `auto=true`", "return the original handoff",
    "Markers execute nothing and grant no permissions", "unrun checks", "observed acceptance",
    "without browser, Hub or callback state access", "callback envelope stays complete",
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

it("delivers automatic handoffs directly and returns a safe manual fallback", () => {
  const sender = guidance("references/workflow-async.md");
  for (const requirement of [
    "prepare → send once → MCP callback", "fresh correlation/capability", "audit.submit",
    "hubId", "workspaceId", "workspaceRoot", "task ID", "tty=true", "write_stdin",
    '"operation":"prepare"', "{ticket,expiresAt,remainingMs}", "C2C_JSON_V1_OK", "C2C_JSON_V1_ERROR", "C2C_JSON_END",
    "decodeTerminalOutput", "ok:true", "ASYNC_TERMINAL_OUTPUT_INVALID", "sender.send(response.value, originalHandoff)",
    "handoffId", "verifySourceForFix", "canAutoFix:true", "three audits/two fixes",
    "600-second maximum deadline", "two source fingerprints", "Lost sessions cannot resume",
    "(workspaceId,taskId)", "ten minutes", "64-entry", "authenticated, invalidated FIX ticket",
    "accepted:true", "matching result", "EPERM", "official terminal escalation", "original complete handoff", "exactly once",
    "`not_sent`", "`uncertain`", "`sent`", "BrowserSendError",
    "workflow.md#codex--web", "operations.md#local-callback-helpers",
  ]) expect(sender, requirement).toContain(requirement);
  for (const requirement of [
    /Before starting[^.]*terminal[^.]*source hashing[^.]*callback registration[^.]*require an existing browser and selected ChatGPT conversation/,
    /Otherwise[^.]*return the original manual \`\[C2C Handoff\]\`/,
    /Never launch a browser[^.]*resolve Project bindings[^.]*open tabs[^.]*create conversations/,
    /Only after sender creation succeeds[^.]*prepare → send once/,
    /multi-repo[^.]*each repository[^.]*workspace\/root[^.]*terminal\/sender/,
    /fingerprint for one repository proves nothing about another/,
    /do not[^.]*controller[^.]*batch work/,
    /verifySourceForFix[^.]*immediately before editing/,
    /same process[^.]*omitting immutable options/,
    /timeoutMs[^.]*nothing restarts it/,
    /Input\/fix phases have no [^.]*idle timer/,
    /failure[^.]*stop automation without resending/,
    /Do not retry[^.]*registration[^.]*sending[^.]*callback submission[^.]*waiting/,
    /Do not change sandbox settings[^.]*another transport[^.]*rollout[^.]*re-consent without authorization/,
    /warn outside the handoff[^.]*duplicate an already delivered message/,
    /never label it PASS or claim callback acceptance without evidence/,
    /first line is \`\[C2C Handoff\]\`/,
    /Exclude[^.]*callback ticket[^.]*capability[^.]*credentials/,
    /Hub restart loses both guards and capabilities[^.]*never restart it to retry delivery/,
    /legacy claim files are ignored and left untouched/,
  ]) expect(sender).toMatch(requirement);
  const operations = guidance("references/operations.md");
  for (const requirement of ["callback register", "callback wait", "callback cancel", "fingerprint", "EOF", "4096 bytes", "newline alone does not complete", "shell interpolation and argv"])
    expect(operations, requirement).toContain(requirement);
  for (const file of ["SKILL.md", "references/workflow.md", "references/workflow-async.md", "references/workflow-web.md", "references/setup.md"]) {
    const text = guidance(file);
    expect(text, file).not.toMatch(/permission probe|preflight|permission evidence|async=(?:true|false)/i);
  }
  expect(guidance("references/workflow.md")).toContain("Omitted `auto` or `auto=false` means manual");
  expect(guidance("references/setup.md")).toContain("do not prove `audit.submit` acceptance");
});
