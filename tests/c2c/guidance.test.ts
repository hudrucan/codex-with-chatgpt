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
    "unchanged from this new ticket", "unrecovered repository-read MCP failure", "`status`", "`complete:true`",
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
    "await decodeTerminalOutput(fullPrepareOutput)", "response.ok === true", "ASYNC_TERMINAL_OUTPUT_INVALID", "await sender.send(response.value, originalHandoff)",
    "handoffId", "verifySourceForFix", "canAutoFix:true", "three audits/two fixes",
    "600-second maximum deadline", "two source fingerprints", "Lost sessions cannot resume",
    "(workspaceId,taskId)", "ten minutes", "64-entry", "authenticated, invalidated FIX ticket",
    "accepted:true", "matching result", "EPERM", "official terminal escalation", "original complete handoff", "exactly once",
    "`not_sent`", "`uncertain`", "`sent`", "BrowserSendError",
    "workflow.md#codex--web", "operations.md#local-callback-helpers",
  ]) expect(sender, requirement).toContain(requirement);
  for (const requirement of [
    /Before starting[^.]*terminal[^.]*source hashing[^.]*callback registration[^.]*require an existing browser and selected ChatGPT conversation/,
    /If the browser or selected conversation is genuinely missing[^.]*return the original manual \`\[C2C Handoff\]\` without resetting or preparing an attempt/,
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
    /Do not retry[^.]*registration[^.]*sending[^.]*callback waiting/,
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

it("requires bounded stale-binding recovery before fallback without enabling delivery retries", () => {
  const common = guidance("references/workflow.md");
  const sender = guidance("references/workflow-async.md");
  const initialization = sender.split("## Initialization recovery")[1].split("## Prepare and send")[0];
  const fallback = sender.split("## Manual fallback")[1];

  for (const text of [common, initialization]) {
    expect(text).toContain("`browser.user is unavailable`");
    expect(text).toContain("`ASYNC_BROWSER_BINDING_STALE`");
  }
  expect(common).toContain("workflow-async.md#initialization-recovery");
  expect(common).toMatch(/genuinely missing[^.]*without resetting or preparing an attempt/);
  expect(initialization).toContain("one CUA REPL reset/rebind is required before manual fallback");
  expect(sender.split("Import `<checkout>")[0]).not.toMatch(/Otherwise[^.]*return/);
  expect(fallback).toMatch(/apply \[initialization recovery\][^.]*before entering this fallback/);
  expect(fallback).toContain("genuinely missing browser or conversation does not authorize reset");

  for (const requirement of [
    "No controller, source hashing or callback registration has started; no attempt is active",
    "REPL-only reset preserves tabs and user drafts", "browser/tab IDs and conversation URL are known and can be verified",
    "Verify matching IDs, live URL and empty composer before starting the controller",
    "Keep reset outside `bindExistingBrowser` and the C2C browser module",
    "Retain that identity only in memory", "Never open tabs, navigate or clear a draft", "No second reset",
    "alone does not authorize recovery", "Delivery retries remain forbidden",
    "Never reset or recreate a sender after controller creation",
  ]) expect(initialization, requirement).toContain(requirement);
  expect(initialization).toContain("If any condition is unmet or recovery fails, return `not_sent` with the blocker");
  expect(fallback).toMatch(/Do not retry registration, sending or callback waiting/);
});

it("limits receiver recovery to identical reads and ambiguous callbacks within the original deadline", () => {
  const receiver = guidance("references/workflow-web.md");
  const recovery = receiver.split("## Bounded recovery")[1].split("## Manual result")[0];
  for (const requirement of [
    "retry a read-only MCP audit call once", "same connector, workspace and arguments",
    "Retain and verify the original revision/snapshot", "known `snapshot_id` and the same offset",
    "without a snapshot ID cannot be retried safely", "Do not retry tool error results, unknown errors",
    "one exact `submit_audit_result` retry", "within the original `C2C_DEADLINE`",
    "same ticket and serialized result", "Check the deadline immediately before retrying",
    "deadline is absent, unverifiable or expired, stop", "No retry after `accepted:true`",
    "tool error/denial or a second transport failure", "Never retry browser sending, callback waiting or registration",
  ]) expect(recovery, requirement).toContain(requirement);
  expect(receiver).not.toContain("first repository-read MCP failure");
  const sender = guidance("references/workflow-async.md");
  expect(sender).toContain("receiver's exceptions](workflow-web.md#bounded-recovery)");
  expect(sender).toContain("After fill or Enter, stop on failure without retrying reads or delivery");
});
