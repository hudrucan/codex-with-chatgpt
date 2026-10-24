import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const [bundle, helperPath, root, workspaceId] = process.argv.slice(2);
const allowed = new Set(["node:crypto", "node:path", "node:child_process", "node:timers", "node:perf_hooks", "node:url", "node:buffer"]);
async function load(denyLocal = false) {
  // Match the REPL's absent Node globals and importer-independent resolution.
  const context = vm.createContext({});
  const module = new vm.SourceTextModule(fs.readFileSync(bundle, "utf8"), { context });
  await module.link(async name => {
    assert(allowed.has(name), `Unexpected module dependency: ${name}`);
    const exports = { ...await import(name) };
    if (denyLocal && name === "node:child_process") exports.execFileSync = () => { throw new Error("Local execution denied"); };
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  assert.equal(vm.runInContext("typeof process", context), "undefined");
  assert.equal(vm.runInContext("typeof Buffer", context), "undefined");
  let selected = 0, draft = "";
  const turns = [];
  context.document = { querySelectorAll: () => turns.map(turn => ({
    textContent: turn.user ? "You said:" : "ChatGPT said:", nextElementSibling: { innerText: turn.text },
  })) };
  const locator = {
    fill: async text => { draft = text; }, press: async () => { turns.push({ user: true, text: draft }); draft = ""; },
    innerText: async () => draft, filter() { return this; }, last() { return this; }, waitFor: async () => {},
  };
  const tab = { id: "active", url: async () => "https://chatgpt.com/c/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    playwright: { getByRole: () => locator, locator: () => locator, evaluate: async (fn, arg) => fn(arg) } };
  const browser = { tabs: { selected: async () => { selected++; return tab; } } };
  const ui = { composerName: "Ask ChatGPT", userHeading: "You said:", assistantHeading: "ChatGPT said:",
    openProjectThread: async () => { throw new Error("Hot path must not discover a Project"); } };
  const options = { async: true, taskId: "compat-drift", workspaceRoot: root, workspaceId };
  const host = { nodeExecutable: process.execPath, helperPath };
  const start = (patch = {}, override = host) => module.namespace.startAsyncC2C({ ...options, ...patch }, browser, ui, override);
  const reply = status => {
    const request = JSON.parse(turns.filter(turn => turn.user).at(-1).text.split("\n").find(line => line.startsWith("C2C_REQUEST ")).slice(12));
    turns.push({ user: false, text: `${module.namespace.AUDIT_START}\n${JSON.stringify({ ...request, status, complete: true, summary: "Fixture audit", findings: status === "FIX" ? [{ file: "hello.txt", line: 1, evidence: "Fixture finding", fix: "In-scope correction" }] : [] })}\n${module.namespace.AUDIT_END}` });
  };
  return { start, reply, selected: () => selected };
}

const runtime = await load();
assert.equal(await runtime.start({ async: false }, undefined), undefined);
await assert.rejects(runtime.start({}, { nodeExecutable: "/missing-node", helperPath }), /ASYNC_LOCAL_CAPABILITY_UNAVAILABLE/);
assert.equal(runtime.selected(), 0);
const denied = await load(true);
await assert.rejects(denied.start(), /ASYNC_LOCAL_CAPABILITY_UNAVAILABLE/);
assert.equal(denied.selected(), 0);

const handoff = "[C2C Handoff]\nRepo: fixture; validated local working tree.";
const session = await runtime.start();
await session.submit(handoff); runtime.reply("FIX");
assert.equal((await session.wait()).canAutoFix, false);
assert.equal(session.verifySourceForFix().canAutoFix, true);
fs.writeFileSync(`${root}/hello.txt`, "Authorized fixture fix\n");
await session.submit(`${handoff}\nFix validated.`, true); runtime.reply("FIX"); await session.wait();
fs.writeFileSync(`${root}/hello.txt`, "Unexpected source drift\n");
assert.match(session.verifySourceForFix().summary, /ASYNC_SOURCE_DRIFT/);
const recreated = await load();
await assert.rejects(recreated.start(), /ASYNC_RESUME_UNSUPPORTED/);
assert.equal(recreated.selected(), 0);

const limited = await runtime.start({ taskId: "compat-audit-limit" });
for (let attempt = 0; attempt < 3; attempt++) {
  await limited.submit(`${handoff}\nRevision ${attempt}`, attempt > 0); runtime.reply("FIX"); await limited.wait();
  assert.equal(limited.verifySourceForFix().canAutoFix, attempt < 2);
}
await assert.rejects(limited.submit(handoff, true), /ASYNC_AUDIT_LIMIT/);
console.log("REPL compatibility PASS: no package resolution or process globals; local checks, drift, claims and limits enforced.");
