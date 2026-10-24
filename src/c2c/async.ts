import { startController, type Options, type AuditBrowser, type AuditUI } from "./controller.js";
import { localAccess } from "./local.js";

export { AUDIT_START, AUDIT_END, type AuditResult, type AuditTab, type AuditBrowser, type AuditUI } from "./controller.js";

/** Normal Node entrypoint; browser REPLs use the separately bundled repl.mjs. */
export function startAsyncC2C(options: Options, browser: AuditBrowser, ui: AuditUI) {
  return startController(options, browser, ui, localAccess);
}
