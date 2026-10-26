import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHub, withHubLock } from "../../src/hub/store.js";
import { withHubResource } from "../../src/hub/resource-state.js";
import { cleanup, isolateStateDir } from "../helpers.js";

let state: string, hubId: string;
beforeEach(() => { state = isolateStateDir(); hubId = createHub("Lock fixture").hubId; });
afterEach(() => { vi.restoreAllMocks(); cleanup(state); delete process.env.C2C_STATE_DIR; });

const schema = z.object({ hubId: z.string() }).passthrough();
const scopes = ["hub", "tunnel", "endpoint"] as const;
type Scope = typeof scopes[number];
const lockPath = (scope: Scope) => scope === "hub"
  ? path.join(state, "hubs", ".lock")
  : path.join(state, `${scope}s`, `${hubId}.json.lock`);
const locked = (scope: Scope, operation: () => unknown) => scope === "hub"
  ? withHubLock(operation)
  : withHubResource(hubId, scope, schema, operation);

it.each(scopes)("retains another writer's %s lock and reports contention", scope => {
  const file = lockPath(scope), operation = vi.fn();
  fs.writeFileSync(file, "existing writer", { mode: 0o600 });
  expect(() => locked(scope, operation)).toThrow(`${scope.toUpperCase()}_STATE_BUSY`);
  expect(operation).not.toHaveBeenCalled();
  expect(fs.readFileSync(file, "utf8")).toBe("existing writer");
  if (scope !== "hub") expect(fs.existsSync(lockPath("hub"))).toBe(false);
});

it.each(scopes.flatMap(scope => ["EPERM", "EACCES", "ENOSPC"].map(code => ({ scope, code }))))(
  "reports $code accurately for a $scope lock without running the operation", ({ scope, code }) => {
    const error = Object.assign(new Error(`fixture ${code}`), { code });
    const file = lockPath(scope), open = fs.openSync, operation = vi.fn();
    vi.spyOn(fs, "openSync").mockImplementation((target, ...args) => {
      if (String(target) === file) throw error;
      return open(target, ...args);
    });
    let caught: unknown;
    try { locked(scope, operation); } catch (failure) { caught = failure; }
    if (code === "ENOSPC") expect(caught).toBe(error);
    else {
      expect(caught).toMatchObject({ cause: error });
      expect(String(caught)).toContain(`${scope.toUpperCase()}_STATE_ACCESS_DENIED`);
      expect(String(caught)).toContain(code);
    }
    expect(operation).not.toHaveBeenCalled();
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(lockPath("hub"))).toBe(false);
  },
);

it.each(scopes)("releases the owned %s lock after success or operation failure", scope => {
  expect(locked(scope, () => "done")).toBe("done");
  expect(fs.existsSync(lockPath(scope))).toBe(false);
  const error = new Error("fixture operation failed");
  expect(() => locked(scope, () => { throw error; })).toThrow(error);
  expect(fs.existsSync(lockPath(scope))).toBe(false);
  expect(fs.existsSync(lockPath("hub"))).toBe(false);
});
