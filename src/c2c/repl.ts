import { execFileSync } from "node:child_process";
import { isAbsolute } from "node:path";
import { startController, type Options, type AuditBrowser, type AuditUI, type LocalAccess } from "./controller.js";

export { AUDIT_START, AUDIT_END } from "./controller.js";

export interface LocalHost {
  nodeExecutable: string;
  helperPath: string;
}

/** Use the permitted subprocess API; never import or emulate node:process in the REPL. */
export async function startAsyncC2C(options: Options, browser: AuditBrowser, ui: AuditUI, host: LocalHost) {
  if (options.async !== true) return;
  if (!host || typeof host.nodeExecutable !== "string" || typeof host.helperPath !== "string" ||
      !isAbsolute(host.nodeExecutable) || !isAbsolute(host.helperPath))
    throw new Error("ASYNC_LOCAL_CAPABILITY_UNAVAILABLE: Explicit absolute Node executable and bundled helper paths are required.");
  const call = (operation: string, ...args: string[]): unknown => {
    let stdout: string;
    try {
      stdout = execFileSync(host.nodeExecutable, [host.helperPath, operation, ...args], {
        encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024, windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const output = (error as { stdout?: unknown }).stdout;
      if (typeof output === "string") {
        try { const failure = JSON.parse(output); if (failure.ok === false && typeof failure.error === "string") throw new Error(failure.error); }
        catch (parsed) { if (parsed instanceof Error && !(parsed instanceof SyntaxError)) throw parsed; }
      }
      throw new Error("ASYNC_LOCAL_CAPABILITY_UNAVAILABLE: Local helper could not run; no delivery is allowed.");
    }
    const result = JSON.parse(stdout);
    if (result.ok !== true) throw new Error("ASYNC_LOCAL_CAPABILITY_UNAVAILABLE: Invalid local helper response.");
    return result.value;
  };
  const local: LocalAccess = {
    claimTask: taskId => { call("claim", taskId); },
    sourceFingerprint: (root, workspaceId) => {
      const value = call("fingerprint", root, workspaceId);
      if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("ASYNC_LOCAL_CAPABILITY_UNAVAILABLE: Invalid source fingerprint.");
      return value;
    },
    resolveProject: async (workspaceId, hubId) => {
      const value = call("project", workspaceId, ...(hubId ? [hubId] : []));
      if (typeof value !== "string") throw new Error("ASYNC_LOCAL_CAPABILITY_UNAVAILABLE: Invalid Project result.");
      return value;
    },
  };
  // Verify local source access before claiming the task or touching the browser.
  local.sourceFingerprint(options.workspaceRoot, options.workspaceId);
  return startController(options, browser, ui, local);
}
